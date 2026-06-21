# Deployment & Testing Guide (Google Cloud Run)

## Project structure

```
gopnik-ai/
  public/
    researcher_ai_survey.html
    researcher_ai_survey.js
    paper_text_data.js
    papers/
      font.pdf
      food.pdf
      listing.pdf
  server.js
  package.json
  .env.example
  .gitignore
```

This is a real Node.js + Express app. It is deployed to **Cloud Run**, which runs the container, serves both the static frontend and the `/api/*` routes through the same Express server, and scales it automatically. PDFs and other static files are still served directly by this Express app — the assets bucket created during setup is not used yet.

## Your Google Cloud resources (already created)

| Resource | Value |
|---|---|
| Project ID | `researcher-ai-survey` |
| Region | `us-west1` |
| Experiment-assets bucket | `researcher-ai-survey-assets-tnl22` (unused for now) |
| Participant-data bucket | `researcher-ai-survey-data-tnl22` |
| Firestore | Native mode, database `(default)`, location `us-west1` |

## How storage and assignment work now

- **Submissions**: each completed participant's full data object is written to Cloud Storage as its own JSON file at `submissions/YYYY-MM-DD/<sha256-hash>.json` in `researcher-ai-survey-data-tnl22`. The filename is a SHA-256 hash of the participant's normalized Prolific ID — never the raw ID. The write uses a Cloud Storage creation precondition, so a second write to the same path is rejected by GCS (HTTP 412) instead of overwriting the original file.
- **Assignment**: balanced AI/CT-placement and paper-order assignment is computed in a Firestore transaction, reading and incrementing per-stratum counters at `assignment_counters/{stratum}` and writing a permanent record at `assignments/{sha256-hash}`. Re-requesting an assignment for the same hash always returns the original — counters are not incremented twice.
- **Auth**: both use Application Default Credentials (ADC) — no service-account key file is ever created or committed. Locally, ADC comes from your own `gcloud auth application-default login`. In Cloud Run, ADC comes from the runtime service account you attach to the service.

## 1. Install dependencies

```bash
cd gopnik-ai
npm install
```

## 2. Authenticate locally via Application Default Credentials

Windows (Command Prompt) and Cloud Shell both use the `gcloud` CLI. If you don't have it locally, either install the Google Cloud CLI for Windows, or just do local testing from **Cloud Shell** (https://console.cloud.google.com → the `>_` icon top-right), which has `gcloud` and Node preinstalled.

```bash
gcloud auth login
gcloud config set project researcher-ai-survey
gcloud auth application-default login
```

The last command opens a browser, you sign in, and it writes credentials to a local file that `@google-cloud/storage` and `@google-cloud/firestore` pick up automatically — no key file, no env var needed.

## 3. Test locally against the real GCS bucket and Firestore database

Create a local `.env` (never committed — already in `.gitignore`):

```bash
cp .env.example .env
```

Edit `.env`:

```
OPENAI_API_KEY=sk-...your real key...
ALLOWED_ORIGIN=
PORT=3000
GCS_SUBMISSIONS_BUCKET=researcher-ai-survey-data-tnl22
USE_LOCAL_SUBMISSION_FILE=false
```

Run it:

```bash
npm start
```

Visit `http://localhost:3000`. With `USE_LOCAL_SUBMISSION_FILE=false` and ADC set up from step 2, this is already writing to the real `researcher-ai-survey-data-tnl22` bucket and the real Firestore database — there is no separate "local-only" database. If you'd rather not touch real cloud resources while doing quick UI iteration, set `USE_LOCAL_SUBMISSION_FILE=true` temporarily; assignment still uses real Firestore either way (there is no local substitute for it).

### Test Firestore balancing

Open a few fresh sessions (or use `curl`) and POST to `/api/assign-condition` with different `stable_participant_id` values but the same `research_role`:

```bash
curl -X POST http://localhost:3000/api/assign-condition \
  -H "Content-Type: application/json" \
  -d '{"stable_participant_id":"test-participant-1","research_role":"PhD student"}'
```

Repeat with `test-participant-2`, `test-participant-3`, etc. (same role, so same stratum). After several calls, open the Firestore console (https://console.cloud.google.com/firestore/databases/-default-/data → project `researcher-ai-survey`) and check `assignment_counters/lower` (or `higher`, depending on the role) — `cell_counts` and `paper_combo_counts` should be staying close to even across calls. Re-POST with the *same* `stable_participant_id` you already used and confirm the response is byte-for-byte identical to the first response for that id (idempotent re-assignment).

### Test one full submission end-to-end

Complete one full run of the survey at `http://localhost:3000` through to the final "submitted" screen. Then:

1. Open the Cloud Storage console (https://console.cloud.google.com/storage/browser/researcher-ai-survey-data-tnl22) and look under `submissions/<today's date>/` — you should see one `<hash>.json` file.
2. Open it and confirm it's the full submitted data object.
3. In Firestore, open `assignments/<that same hash>` and confirm `completion_status` is now `"completed"` with a `completed_at` timestamp.

## 4. Create a dedicated Cloud Run runtime service account

Don't use the default compute service account — create one scoped to this app:

```bash
gcloud iam service-accounts create researcher-survey-runner \
  --project=researcher-ai-survey \
  --display-name="Researcher AI Survey Cloud Run runtime"
```

This gives you `researcher-survey-runner@researcher-ai-survey.iam.gserviceaccount.com`.

### Grant it write access to the participant-data bucket

```bash
gcloud storage buckets add-iam-policy-binding gs://researcher-ai-survey-data-tnl22 \
  --member="serviceAccount:researcher-survey-runner@researcher-ai-survey.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator"
```

`roles/storage.objectCreator` grants write/create access only — it deliberately cannot read, overwrite, or delete existing objects in the bucket, which fits "save participant data, never touch it again from the app." If you also want the app itself to ever read submissions back (it doesn't today), you'd add `roles/storage.objectViewer` too.

### Grant it minimal Firestore permissions

```bash
gcloud projects add-iam-policy-binding researcher-ai-survey \
  --member="serviceAccount:researcher-survey-runner@researcher-ai-survey.iam.gserviceaccount.com" \
  --role="roles/datastore.user"
```

`roles/datastore.user` allows reading and writing documents (needed for the assignment transactions and completion updates) but not managing the database itself (no creating/deleting indexes or databases). This is the standard minimal role for an application reading/writing its own Firestore data.

## 5. Store the OpenAI key in Secret Manager

```bash
gcloud services enable secretmanager.googleapis.com --project=researcher-ai-survey

printf "sk-...your real key..." | gcloud secrets create openai-api-key \
  --project=researcher-ai-survey \
  --data-file=-

gcloud secrets add-iam-policy-binding openai-api-key \
  --project=researcher-ai-survey \
  --member="serviceAccount:researcher-survey-runner@researcher-ai-survey.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

If you ever need to rotate the key later:

```bash
printf "sk-...new key..." | gcloud secrets versions add openai-api-key --data-file=-
```

## 6. Deploy from source to Cloud Run

From the `gopnik-ai` directory (containing `server.js`/`package.json`):

```bash
gcloud run deploy researcher-ai-survey \
  --source . \
  --project=researcher-ai-survey \
  --region=us-west1 \
  --service-account=researcher-survey-runner@researcher-ai-survey.iam.gserviceaccount.com \
  --set-env-vars="GCS_SUBMISSIONS_BUCKET=researcher-ai-survey-data-tnl22,USE_LOCAL_SUBMISSION_FILE=false" \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest" \
  --allow-unauthenticated
```

`--source .` builds the container for you (Cloud Build, via the Node buildpack) — no Dockerfile needed. `--allow-unauthenticated` is required so participants (who aren't Google-authenticated) can load the survey. The deploy prints a service URL like `https://researcher-ai-survey-xxxxx-uw.a.run.app`.

### Set ALLOWED_ORIGIN once you know the URL

```bash
gcloud run services update researcher-ai-survey \
  --project=researcher-ai-survey \
  --region=us-west1 \
  --set-env-vars="ALLOWED_ORIGIN=https://researcher-ai-survey-xxxxx-uw.a.run.app"
```

(Combine this into the same `--set-env-vars` list in step 6 once you know the URL in advance, to avoid a second deploy — Cloud Run gives you a predictable URL pattern after the first deploy.)

## 7. Verify the deployed service

```bash
curl -X POST https://researcher-ai-survey-xxxxx-uw.a.run.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"participant_id":"test","condition":"AI","paper_id":"font","study_title":"Test","study_text":"Test study text.","user_message":"Hello","conversation_history":[]}'
```

A healthy response is `{"reply":"..."}`. Then open the deployed URL in a browser and run through the full survey once, the same way as the local end-to-end test in step 3 — confirm the GCS file and the Firestore `completion_status` update both appear, using the deployed bucket/database (same ones, so the same console links apply).

## Downloading all participant JSON files later

```bash
mkdir all_submissions
gcloud storage cp -r gs://researcher-ai-survey-data-tnl22/submissions/* ./all_submissions/
```

This downloads every date folder and every per-participant JSON file underneath it, preserving the `YYYY-MM-DD/<hash>.json` structure, to a local `all_submissions` folder.

## Local development without any GCP project (optional)

If you ever want to iterate on the frontend/UI with zero cloud dependency for submissions, set `USE_LOCAL_SUBMISSION_FILE=true` in `.env` — this restores the old append-only `data/submissions.jsonl` file for completed submissions only. Assignment always requires real Firestore access (ADC), since there is no local-file substitute for the balancing logic.

## Test mode (dev/QA only — NOT for real recruitment)

A developer/tester can force a specific assignment cell + paper order to deliberately exercise each experimental condition and inspect exactly what data gets captured, without touching real participant assignment counters or production submissions.

**Dual gate — both required:**
1. Server env var `ENABLE_TEST_MODE=true` (unset/false by default; see `.env.example`).
2. URL includes `?test=1`.

A URL param alone can never enable test mode — the frontend always confirms with the server (`GET /api/test-mode-status`) before activating. If `ENABLE_TEST_MODE` is not `true`, `?test=1` is silently ignored and the session proceeds as a completely normal participant.

**URL formats:**

```
?test=1&cell=AI_pre
?test=1&cell=AI_post
?test=1&cell=noAI_pre
?test=1&cell=noAI_post
?test=1&cell=AI_pre&papers=font,food
?test=1&cell=noAI_post&papers=listing,font
```

`cell` must be exactly one of `AI_pre`, `AI_post`, `noAI_pre`, `noAI_post`. `papers` (optional) must be exactly two distinct values from `font`, `food`, `listing`; if omitted, a fixed default pair is used. Any invalid value shows a blocking developer-facing error screen instead of silently falling back to an unintended condition.

**How it stays separate from production:**
- Test assignments go through `POST /api/test-assign-condition` (gated by `ENABLE_TEST_MODE`), which never reads/writes `assignment_counters/{stratum}` or `assignments/{hash}` in Firestore.
- Test submissions (`DATA.test_mode === true`) are routed by `/api/submit-survey` to a separate destination: `data/test-submissions.jsonl` locally, or the `test-submissions/` prefix in GCS — never mixed with `data/submissions.jsonl` / `submissions/`.
- Every record carries `test_mode` (`true` for test runs, `false` for real participants), plus `test_condition_override` and `test_paper_override` when set.
- A visible purple banner ("TEST MODE — `<cell>` — `<paper1>` → `<paper2>`") appears fixed at the top of the page whenever test mode is active, and only then.

**Data Audit Summary + exports:** open the existing hidden admin panel (Ctrl+Shift+E, or `?admin=1`) — it shows a live-computed audit summary (test status, assignment fields, page, answered/unanswered-required field counts, AI usage and timing per paper, prompt/response counts, revision/copy/paste/tab-switch/fullscreen-exit counts, quiz answers/score, submission status) plus export buttons. These buttons (now labeled "Download Current Session JSON/CSV", "Export Raw DATA (JSON)", "Export Audit Summary (JSON)", "Export Comparison Row (CSV)") only ever export **this one browser tab's in-memory data** — handy for a quick local check while developing, but not the accumulated dataset. Filenames are sanitized and look like `survey-test-AI_pre-font-food-2026-06-21.json`. For the accumulated, all-participants export, see the next section.

**Four pilot scenarios:**
- **A — AI active-use test:** `?test=1&cell=AI_pre` (or `AI_post`), ask several AI questions, copy from a response, paste into an answer, revise it, then check the transcript/timing/copy-paste/revision fields in the audit summary.
- **B — AI available but unused:** force an AI cell, never open/use the AI tab, confirm AI message counts stay 0 and everything else still works.
- **C — No-AI normal completion:** `?test=1&cell=noAI_pre` (or `noAI_post`), confirm no AI tab/interface appears and no AI records are created.
- **D — Behavioral stress test:** switch tabs, exit fullscreen, paste text, delete/rewrite answers, answer some quiz items wrong — confirm the corresponding behavioral, copy/paste, revision, and quiz fields are all logged.

**Disabling before real recruitment:** set `ENABLE_TEST_MODE=false` (or remove the env var) on the deployed service. With it disabled, `?test=1` has zero effect on any session.

## Admin bulk export (researcher-only, separate from the in-session admin panel)

The Ctrl+Shift+E admin panel's export buttons only ever export the **current browser session's** in-memory data. To pull **all accumulated submissions across every participant** from backend storage (GCS or the local `.jsonl` file, depending on `USE_LOCAL_SUBMISSION_FILE`), use the researcher export page or the underlying routes directly — neither is linked from anywhere in the participant-facing UI:

- **Researcher export page:** `https://<your-deployed-url>/admin/export` — a simple key-entry form with four download buttons (test/production x CSV/JSON). The admin key is typed in, sent only in the `X-Admin-Key` header, and cleared from the field immediately after every request (success or failure). The page itself reveals no record counts, filenames, or other participant data before a valid key is submitted.
- **Underlying routes**, if you'd rather script it:
  ```
  GET /api/admin/export-submissions.json?type=production
  GET /api/admin/export-submissions.json?type=test
  GET /api/admin/export-submissions.csv?type=production
  GET /api/admin/export-submissions.csv?type=test
  ```

- `type` defaults to `production` if omitted. `production` and `test` are always exported separately and never combined.
- Both routes require the header `X-Admin-Key: <your ADMIN_EXPORT_KEY>`. Missing or wrong key → `401`. The key is never accepted as a query parameter and is never present in any frontend file.
- Set `ADMIN_EXPORT_KEY` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) as an env var locally (`.env`) and on Cloud Run:
  ```bash
  gcloud run services update researcher-ai-survey \
    --project=researcher-ai-survey \
    --region=us-west1 \
    --set-env-vars="ADMIN_EXPORT_KEY=your-long-random-value"
  ```
  If it's unset, both routes always return 401 — there's no "open" default.
- **JSON export** returns the full nested record for every accumulated submission, exactly as stored — nothing flattened, renamed, or removed. Treat it as the authoritative archive.
- **CSV export** is one row per participant, built by `lib/export-csv.js` (see `DATA_EXPORT.md` for the full column reference): all current SRL/CT items and quiz answers are discovered dynamically from the data (never a hard-coded expected count); a handful of known duplicate/raw-DOM-id response keys are deliberately excluded as standalone columns (they remain inside `responses_json`, and in full inside the JSON export); each participant's AI chat history is flattened into fixed `paper_1_*`/`paper_2_*` transcript columns (5 exchanges × 4 fields per assigned paper = 40 columns) rather than a raw JSON blob. Each transcript cell is one of three things, never confused: `N/A` for a slot that was never applicable at all (a No-AI participant, or an exchange number the participant never reached); blank (`''`) for a request that was made but failed, where the participant's own prompt/timestamp are still preserved but no AI response is invented; or the actual captured value for a successful exchange — see `DATA_EXPORT.md` for the full rule. No transcript cell is ever the literal string `undefined`/`null`. The CSV does **not** include `ai_message_log_json`, `behavioral_events_json`, or a `raw_record_json` column — those large raw structures are intentionally left out of the CSV and are only available in the JSON export, which remains the complete, nothing-removed archive (including full failure metadata for every AI request). The CSV escaper is hand-written (RFC4180-style: quotes around any cell containing a comma, quote, or newline, with internal quotes doubled) rather than a third-party library, because this sandbox had no npm registry access when this module was built; it is covered by automated tests in `test/export.test.js` and `test/admin-endpoints.test.js`, including multiline text, embedded commas/quotes, and Unicode round-trips.

**Windows PowerShell download commands** (replace `<your-deployed-url>` and `<your-admin-key>`):

```powershell
# Production submissions
Invoke-WebRequest -Uri "https://<your-deployed-url>/api/admin/export-submissions.json?type=production" `
  -Headers @{ "X-Admin-Key" = "<your-admin-key>" } `
  -OutFile "submissions-production.json"

Invoke-WebRequest -Uri "https://<your-deployed-url>/api/admin/export-submissions.csv?type=production" `
  -Headers @{ "X-Admin-Key" = "<your-admin-key>" } `
  -OutFile "submissions-production.csv"

# Test submissions
Invoke-WebRequest -Uri "https://<your-deployed-url>/api/admin/export-submissions.json?type=test" `
  -Headers @{ "X-Admin-Key" = "<your-admin-key>" } `
  -OutFile "submissions-test.json"

Invoke-WebRequest -Uri "https://<your-deployed-url>/api/admin/export-submissions.csv?type=test" `
  -Headers @{ "X-Admin-Key" = "<your-admin-key>" } `
  -OutFile "submissions-test.csv"
```

For local testing against `http://localhost:3000`, just swap the URL.

**Running the export tests locally** (no GCS/Firestore/OpenAI calls — pure local-file fixtures and a throwaway admin key):

```bash
npm run test:export
```

This runs `test/export.test.js` (39 checks against `lib/export-csv.js` directly, using fixture records in `test/fixtures/four-conditions.jsonl` covering all four AI x CT-placement conditions plus two additional records for the "Other" fallback and fixed-transcript-ordering tests, including the N/A-vs-blank transcript distinction) and `test/admin-endpoints.test.js` (8 checks that boot `server.js` itself with `USE_LOCAL_SUBMISSION_FILE=true` and confirm the 401/200 behavior and `/admin/export` page over real HTTP). Re-run this after any future change to `lib/export-csv.js`, `server.js`'s export routes, or `public/admin-export.html`.

## Security checklist

- No service-account JSON key file exists anywhere in this repo or was ever created for this app — both local dev and Cloud Run authenticate via Application Default Credentials only.
- `.env` is git-ignored; only `.env.example` (placeholders, no real bucket secrets needed since bucket names aren't secret) is committed.
- The OpenAI key lives only in Secret Manager and is injected as an env var by Cloud Run at runtime — never in `.env.example`, never in any committed file.
- CORS restricted to `ALLOWED_ORIGIN` once set.
- Cloud Storage write uses `objectCreator` (create-only) IAM, and a creation precondition at the API level, so the app cannot overwrite or read back a participant's existing file even if it tried.
- Raw Prolific IDs are never sent to Firestore or used in a GCS object name — only their SHA-256 hash.

## Testing checklist

- [ ] Local run against real GCS/Firestore (steps 2–3) completes one full submission; file appears in the bucket, `assignments/{hash}` shows `completed`.
- [ ] Repeated `/api/assign-condition` calls with the same `stable_participant_id` return an identical assignment.
- [ ] Several different `stable_participant_id`s with the same role show roughly even `cell_counts` / `paper_combo_counts` in `assignment_counters`.
- [ ] Two assignment requests fired at the same time (e.g. two terminals running `curl` simultaneously) for two *different* ids do not produce a corrupted/incorrect counter (no lost updates) — Firestore's transaction retry handles this automatically; you're just confirming the final counts add up.
- [ ] Submitting twice for the same participant (e.g. retry after a simulated network failure) does not produce two GCS files — the second write gets an HTTP 412 from GCS, logged server-side, and the participant still sees success.
- [ ] Disconnect network mid-submission (or block the deployed URL temporarily) and confirm: the participant stays on the debrief page, sees a clear retry message, the survey data is untouched, and clicking Retry (or restoring the network and clicking Retry) completes the submission and shows the submitted screen.
- [ ] Rapid double-clicking "Finish" does not produce two concurrent submit requests.
- [ ] AI condition / No-AI condition / multi-turn chat / 5-message cap / PDF rendering for all 3 papers — unchanged from before, verify nothing regressed.
- [ ] `/api/chat` still returns the generic unavailable message (not raw error text) if `OPENAI_API_KEY` is briefly removed from Secret Manager access.
