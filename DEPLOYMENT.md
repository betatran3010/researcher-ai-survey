# Deployment & Testing Guide — Google Cloud Run

This guide matches the current Research Scholars Survey codebase:

- one paper per participant;
- four experimental cells: `AI_pre`, `AI_post`, `noAI_pre`, `noAI_post`;
- count-balanced assignment stored in Firestore;
- autosaves stored in Firestore;
- completed submissions stored as JSON objects in Cloud Storage;
- accumulated CSV/JSON exports generated on demand by the backend;
- OpenAI and admin-export secrets kept server-side.

The application is a Node.js + Express service. Cloud Run serves both the static survey files and all `/api/*` routes from the same container.

## 1. Repository files required for deployment

At minimum, the deployed repository must contain:

```text
server.js
package.json
package-lock.json
Dockerfile
.dockerignore
.env.example

lib/
  assignment-balancing.js
  export-csv.js

public/
  researcher_ai_survey.html
  researcher_ai_survey.js
  survey-routing.js
  paper_text_data.js
  admin-export.html
  papers/
    font.pdf
    food.pdf
    listing.pdf

scripts/
  reconcile-assignment-counters.js

test/
  ...
```

The included `Dockerfile` uses Node 20 and runs:

```text
npm ci --omit=dev
node server.js
```

Cloud Run supplies the runtime `PORT`; `server.js` already reads it.

## 2. Choose deployment values

Replace these placeholders throughout the commands below:

```text
PROJECT_ID=your-google-cloud-project-id
REGION=us-west1
SERVICE_NAME=researcher-ai-survey
SERVICE_ACCOUNT_NAME=researcher-survey-runner
BUCKET_NAME=your-participant-data-bucket
```

The runtime service-account email will be:

```text
SERVICE_ACCOUNT_NAME@PROJECT_ID.iam.gserviceaccount.com
```

The Cloud Storage bucket must be in a suitable location for the project. Firestore must be created in Native mode.

## 3. Authenticate and select the project

Run from Google Cloud Shell or a machine with the Google Cloud CLI installed:

```bash
gcloud auth login
gcloud config set project PROJECT_ID
```

For local testing against the real Google Cloud resources, also configure Application Default Credentials:

```bash
gcloud auth application-default login
```

No downloaded service-account JSON key is needed or expected.

## 4. Enable required Google Cloud APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  --project=PROJECT_ID
```

## 5. Create Firestore

Create a Firestore database in **Native mode** if the project does not already have one.

The application uses these collections/documents:

```text
assignments/{hashedParticipantId}
assignment_counters/counts
survey_progress/{participantId}
survey_progress_test/{participantId}
```

The application does not require a composite Firestore index for assignment balancing because it reads the single counter document directly by ID.

## 6. Create the participant-data bucket

Example:

```bash
gcloud storage buckets create gs://BUCKET_NAME \
  --project=PROJECT_ID \
  --location=REGION \
  --uniform-bucket-level-access
```

Completed records are written under:

```text
submissions/YYYY-MM-DD/<sha256-hash>.json
test-submissions/YYYY-MM-DD/<test-id>.json
```

Production and test records remain separate.

## 7. Create a dedicated Cloud Run service account

```bash
gcloud iam service-accounts create SERVICE_ACCOUNT_NAME \
  --project=PROJECT_ID \
  --display-name="Research Scholars Survey Cloud Run runtime"
```

Set a shell variable for convenience:

```bash
SERVICE_ACCOUNT="SERVICE_ACCOUNT_NAME@PROJECT_ID.iam.gserviceaccount.com"
```

### Grant Firestore access

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/datastore.user"
```

This allows the application to:

- create and read permanent assignments;
- read and update `assignment_counters/counts` in transactions;
- write and read autosaves;
- mark an assignment completed after a successful final submission.

### Grant Cloud Storage create access

```bash
gcloud storage buckets add-iam-policy-binding gs://BUCKET_NAME \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectCreator"
```

### Grant Cloud Storage read/list access for accumulated exports

```bash
gcloud storage buckets add-iam-policy-binding gs://BUCKET_NAME \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer"
```

Both roles are needed:

- `objectCreator` allows new final submissions to be written;
- `objectViewer` allows the protected accumulated export routes to list and read stored submission objects.

The current application does not need permission to delete objects.

## 8. Create server-side secrets

Generate two independent secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use one generated value as the admin export key. Use the actual OpenAI API key for the other secret.

### OpenAI key

```bash
printf "YOUR_OPENAI_API_KEY" | gcloud secrets create openai-api-key \
  --project=PROJECT_ID \
  --data-file=-
```

### Admin export key

```bash
printf "YOUR_LONG_RANDOM_ADMIN_KEY" | gcloud secrets create admin-export-key \
  --project=PROJECT_ID \
  --data-file=-
```

Grant the runtime service account access:

```bash
gcloud secrets add-iam-policy-binding openai-api-key \
  --project=PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding admin-export-key \
  --project=PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor"
```

Never commit either value to Git.

## 9. Install dependencies and run the automated checks

From the repository root:

```bash
npm ci
npm run test:export
```

The current full suite covers:

- one-paper assignment behavior;
- balancing and Firestore transaction logic using a fake transaction;
- returning-participant idempotency;
- routing for CT-before and CT-after;
- partial quiz autosaves and final scoring;
- CSV flattening and AI-transcript export;
- admin export authentication;
- viewport and navigation measures;
- response validation;
- AI response-length behavior.

These tests do not replace a real post-deployment Firestore/GCS test.

## 10. Optional local cloud-connected test

Create a local `.env` that is not committed:

```env
OPENAI_API_KEY=...
ADMIN_EXPORT_KEY=...
ALLOWED_ORIGIN=
PORT=3000
GCS_SUBMISSIONS_BUCKET=BUCKET_NAME
USE_LOCAL_SUBMISSION_FILE=false
ENABLE_TEST_MODE=false
GOOGLE_CLOUD_PROJECT=PROJECT_ID
```

Then:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

With `USE_LOCAL_SUBMISSION_FILE=false`, final submissions go to the real bucket and autosaves/assignments go to the real Firestore database.

For UI-only work without GCS, `USE_LOCAL_SUBMISSION_FILE=true` restores local `.jsonl` submission storage. Real assignment still requires Firestore.

## 11. Reconcile assignment counters before recruitment

The current assignment system uses one Firestore counter document:

```text
assignment_counters/counts
```

It balances in two stages:

1. choose the currently least-filled experimental cell;
2. within that cell, choose the currently least-filled paper.

Ties are broken randomly among the tied least-filled options.

Before real recruitment, seed or reconcile the counter document from any assignment records already present.

### Dry run first

```bash
npm run reconcile:counters -- --project=PROJECT_ID --dry-run
```

Review:

- the four cell totals;
- the three paper totals within each cell;
- any malformed assignment documents that were skipped.

### Write the reconciled counters

Only after the dry run looks correct:

```bash
npm run reconcile:counters -- --project=PROJECT_ID --write
```

Do not run write-mode reconciliation while participants may be receiving assignments because the script replaces the counter document with totals derived from its earlier collection read.

If there are no prior assignments, the application can create the missing counter document automatically from zeros. The reconciliation step is still useful for confirming the intended project and existing assignment state.

## 12. Deploy to Cloud Run

From the repository root:

```bash
gcloud run deploy SERVICE_NAME \
  --source . \
  --project=PROJECT_ID \
  --region=REGION \
  --service-account="${SERVICE_ACCOUNT}" \
  --set-env-vars="GCS_SUBMISSIONS_BUCKET=BUCKET_NAME,USE_LOCAL_SUBMISSION_FILE=false,ENABLE_TEST_MODE=false,GOOGLE_CLOUD_PROJECT=PROJECT_ID" \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,ADMIN_EXPORT_KEY=admin-export-key:latest" \
  --allow-unauthenticated
```

The repository includes a `Dockerfile`, so source deployment will build that container.

`--allow-unauthenticated` is necessary because participants are not signed into the Google Cloud project.

Record the printed Cloud Run service URL:

```text
https://YOUR-SERVICE-URL
```

## 13. Restrict CORS to the deployed URL

After the first deployment:

```bash
gcloud run services update SERVICE_NAME \
  --project=PROJECT_ID \
  --region=REGION \
  --update-env-vars="ALLOWED_ORIGIN=https://YOUR-SERVICE-URL"
```

Do not accidentally replace the other environment variables when updating the service. `--update-env-vars` is safer than supplying a partial replacement configuration.

## 14. Test mode for QA only

Test mode requires both:

1. `ENABLE_TEST_MODE=true` on the server;
2. `?test=1` in the URL.

Example one-paper URLs:

```text
https://YOUR-SERVICE-URL/?test=1&cell=AI_pre&papers=font
https://YOUR-SERVICE-URL/?test=1&cell=AI_post&papers=food
https://YOUR-SERVICE-URL/?test=1&cell=noAI_pre&papers=listing
https://YOUR-SERVICE-URL/?test=1&cell=noAI_post&papers=font
```

Valid cells:

```text
AI_pre
AI_post
noAI_pre
noAI_post
```

Valid papers:

```text
font
food
listing
```

The current test endpoint accepts exactly one paper. Old two-paper override URLs are rejected.

Test assignments do not touch the production `assignments` or `assignment_counters` documents. Test autosaves use `survey_progress_test`; completed test records use the `test-submissions/` bucket prefix.

Before real recruitment:

```bash
gcloud run services update SERVICE_NAME \
  --project=PROJECT_ID \
  --region=REGION \
  --update-env-vars="ENABLE_TEST_MODE=false"
```

## 15. Verify the deployed service end to end

Do not begin recruitment until all items below pass.

### Static application

Open:

```text
https://YOUR-SERVICE-URL
```

Confirm:

- the survey page loads;
- all three PDFs can render when assigned;
- browser developer tools show no missing `paper_text_data.js`, routing script, PDF, or other static asset;
- the survey can enter fullscreen and proceed normally.

### Assignment

Use several fresh participant IDs and verify that:

- every participant receives exactly one valid paper;
- assignments span the four experimental cells;
- least-filled cells/papers are favored;
- ties can be resolved randomly;
- repeating the same stable participant ID returns the original assignment;
- repeated requests for the same participant do not increment the counters again.

In Firestore, inspect:

```text
assignments/
assignment_counters/counts
```

The counter document should contain:

```text
cells.AI_pre
cells.AI_post
cells.noAI_pre
cells.noAI_post
```

Each cell should contain:

```text
total
papers.font
papers.food
papers.listing
```

### Autosave

Begin a test session, answer several fields, and wait for an autosave. Confirm a current record appears in:

```text
survey_progress
```

For test mode, confirm it appears in:

```text
survey_progress_test
```

Check that partial quiz answers and the current quiz score are present after answering only some quiz questions.

### Final production submission

Complete one controlled production run.

Confirm:

1. a JSON file appears under `submissions/YYYY-MM-DD/` in the bucket;
2. the object name uses a SHA-256 hash rather than the raw Prolific ID;
3. the JSON contains the complete submitted record;
4. the matching Firestore assignment shows completion metadata;
5. the participant reaches the submitted page only after the storage request succeeds.

A repeated final submission for the same assignment hash should not silently overwrite the existing GCS object.

### AI condition

In an AI condition:

- submit at least one message;
- verify the response is returned;
- verify transcript/log data appear in autosave and final data;
- verify the five-message limit;
- verify the participant-facing response remains concise.

### No-AI condition

Confirm that:

- no AI tab is shown;
- the survey still completes;
- AI-specific usage fields remain blank or false as appropriate.

## 16. Verify accumulated exports

Open the researcher-only page directly:

```text
https://YOUR-SERVICE-URL/admin/export
```

The page is intentionally not linked from the participant interface.

Enter the admin export key and download:

- production CSV;
- production JSON;
- test CSV;
- test JSON.

The backend combines:

- completed records from GCS;
- current autosaves from Firestore.

Records are merged by `participant_id`. A final submission wins over an autosave; otherwise the latest autosave is exported.

The JSON export is the authoritative full archive. The participant-level CSV is an analysis-oriented flattened file. See `DATA_EXPORT.md`.

The separate AI-transcript CSV is available through:

```text
GET /api/admin/export-ai-transcript.csv?type=production
GET /api/admin/export-ai-transcript.csv?type=test
```

with the header:

```text
X-Admin-Key: YOUR_ADMIN_EXPORT_KEY
```

Example PowerShell command:

```powershell
Invoke-WebRequest `
  -Uri "https://YOUR-SERVICE-URL/api/admin/export-ai-transcript.csv?type=production" `
  -Headers @{ "X-Admin-Key" = "YOUR_ADMIN_EXPORT_KEY" } `
  -OutFile "ai-transcript-production.csv"
```

## 17. Production environment checklist

Cloud Run should have:

```text
OPENAI_API_KEY          Secret Manager reference
ADMIN_EXPORT_KEY        Secret Manager reference
GCS_SUBMISSIONS_BUCKET  bucket name
USE_LOCAL_SUBMISSION_FILE=false
ENABLE_TEST_MODE=false
GOOGLE_CLOUD_PROJECT    project ID
ALLOWED_ORIGIN          exact deployed origin
PORT                    supplied automatically by Cloud Run
```

The runtime service account should have:

```text
roles/datastore.user
roles/storage.objectCreator on the data bucket
roles/storage.objectViewer on the data bucket
roles/secretmanager.secretAccessor for both secrets
```

## 18. Final recruitment checklist

- [ ] `npm run test:export` passes.
- [ ] Cloud Run revision is healthy and serving traffic.
- [ ] Unauthenticated access is enabled.
- [ ] `ENABLE_TEST_MODE=false`.
- [ ] Assignment counter reconciliation was reviewed.
- [ ] Same participant ID returns the same assignment.
- [ ] New participants receive one-paper balanced assignments.
- [ ] Firestore autosaves are appearing.
- [ ] Partial quiz progress is present in autosaves.
- [ ] One final production JSON object appears in GCS.
- [ ] The production accumulated CSV and JSON both download successfully.
- [ ] The AI-transcript CSV downloads successfully.
- [ ] The Cloud Run service account can both create and read/list GCS objects.
- [ ] The OpenAI assistant works in an AI condition.
- [ ] A No-AI condition completes without AI fields being required.
- [ ] No API keys or service-account key files are committed.
