# Data export reference

This document describes the accumulated researcher export — the backend-wide
CSV/JSON download at `/admin/export` (or the underlying
`GET /api/admin/export-submissions.csv|json` routes) — as opposed to the
Ctrl+Shift+E in-page admin panel, which only ever exports the current browser
tab's in-memory session. See `DEPLOYMENT.md` → "Admin bulk export" for how to
authenticate and download.

The CSV is built by `lib/export-csv.js`, which is unit-tested independently of
Express/GCS/Firestore — see `test/export.test.js` and
`test/admin-endpoints.test.js` (run both with `npm run test:export`).

## Two export formats, two different jobs

- **JSON** (`?type=production|test`, `.json`): every accumulated record
  returned exactly as stored, with nothing flattened, renamed, or removed.
  This is the authoritative archive — it includes the complete
  `ai_message_log`, `behavioral_events`, `responses`, `ai_chats`, `timing`,
  `ai_paper_aggregates`, `copy_events`, `paste_events`, `revision_log`,
  `logs`, `violations`, and all submission/assignment metadata for every
  record. Keep it.
- **CSV** (`.csv`): one row per participant/test record, with one
  analysis-friendly column per variable, built for opening directly in Excel,
  R, SPSS, etc. The CSV deliberately does **not** include a raw
  `ai_message_log_json`, `behavioral_events_json`, or `raw_record_json`
  column — those large raw structures are only in the JSON export. The CSV
  has a UTF-8 BOM prepended (for Excel) and uses `\r\n` line endings.

Production and test records are always exported separately
(`?type=production` vs `?type=test`) and are never combined into one file.

## How the CSV schema is built

- **SRL items** (`srl_*`), **CT items** (`ct_*`), and **quiz answer keys**
  (`quiz_<paper>_<n>`) are all discovered dynamically by scanning every loaded
  record's `responses` — there is no hard-coded expected count. If a new SRL
  or CT item is added to the survey in the future, it will appear as a new
  column automatically the next time this export runs, with no code change
  required. The 3-paper pool (`font`, `food`, `listing`) is the one
  intentional exception — it's a structural constant mirrored from
  `PAPER_COMBOS` in `server.js`, not a "count" in the sense the dynamic
  scanning is meant to avoid hard-coding.
- **`ai_understanding`** (and any other response key not otherwise claimed by
  a named column or the exclusion list below) is picked up automatically by
  the same dynamic mechanism if and only if it exists in at least one loaded
  record. It is never invented as a blank column when no record has it.
- **Per-paper columns** (e.g. `font_q1`, `confidence_food`,
  `listing_ai_prompt_count`) exist for every paper in the fixed 3-paper pool,
  for every row, regardless of which two papers that participant was actually
  assigned. For the participant's unassigned third paper, these columns are
  blank (text fields) or `0`/`false` (counts/booleans) — never missing —
  so every row in the CSV shares the exact same header in the exact same
  order.

## ai_purpose_other ("Other" AI-purpose free text)

`ai_purpose_other` uses this fallback order, computed at export time:

1. `responses.ai_purpose_specify` — the only key the current frontend ever
   actually writes for this field (set by
   `setupSpecifyField('rg-ai-purpose', 'ai_purpose', 'Other')` in
   `public/researcher_ai_survey.js`).
2. otherwise `responses['rg-ai-purpose-specify']` — kept as a defensive
   fallback for any legacy/raw record that might use the DOM-id form as a
   key; the current frontend never produces this key, so this branch is not
   expected to be hit by current submissions.
3. otherwise blank.

Nothing is invented: if neither key has a value, the column is blank. The
original key(s) remain present verbatim in `responses_json` and, completely,
in the JSON export.

## Fixed AI transcript columns (paper_1 / paper_2)

Each participant is assigned exactly two of the three papers, in
`paper_order`. The CSV maps these to fixed positions:

- `paper_1_id`, `paper_1_title` — the first assigned paper (`study_1_id` /
  `study_1_title`).
- `paper_2_id`, `paper_2_title` — the second assigned paper (`study_2_id` /
  `study_2_title`).

For each position and each exchange number 1–5 (the AI condition allows up to
five participant messages per paper), there are exactly four columns:

- `paper_<position>_participant_message_<n>`
- `paper_<position>_participant_message_time_<n>`
- `paper_<position>_ai_message_<n>`
- `paper_<position>_ai_message_time_<n>`

That's 5 exchanges × 4 columns × 2 positions = **40 transcript columns**.
No per-exchange success/latency/error columns are included here — that
technical detail stays in the per-paper summary counts (below) and the JSON
export.

**Mapping rules**, applied per `ai_message_log` entry:

- Each entry is matched to a paper position by its `paper_id` (never
  reordered across papers).
- Within a paper, entries are ordered by `message_number` (the log's
  existing 1-indexed per-paper counter); if that's ever absent, by the
  existing `submit_ts_iso` participant-send timestamp instead.
- `prompt` → `participant_message_<n>`; `submit_ts_iso` (the timestamp
  captured when the participant's send request was issued) →
  `participant_message_time_<n>`.
- `response` → `ai_message_<n>`; `complete_ts_iso` (the timestamp captured
  when that request finished) → `ai_message_time_<n>` — **only when
  `success === true`**.
- A failed request (`success === false`) keeps its participant prompt and
  timestamp, but leaves `ai_message_<n>` and `ai_message_time_<n>` **blank**
  (`''`) — no AI response or timestamp is invented for a request that never
  returned one. This blank is deliberately distinct from `N/A` (below): the
  slot *was* used, the request simply didn't succeed.
- Unused exchange slots — exchange numbers beyond the participant's actual
  message count (they sent fewer than five messages on that paper) — are
  `N/A` in all four columns, never blank and never the literal string
  `undefined`/`null`. `N/A` means "this slot was never applicable," which is
  a genuinely different fact from "a request was made here but failed."
- For No-AI participants, `ai_message_log` is always empty and AI
  interaction was never applicable to their condition, so all 40 transcript
  cells are `N/A` — not blank.

In short: `N/A` = never applicable (No-AI condition, or an exchange slot the
participant never used). Blank (`''`) = applicable but the AI response never
came back (a failed request) — the participant's own prompt/timestamp are
still captured in that case. Actual values = a successful exchange. No
transcript cell is ever the literal string `undefined` or `null`.

## Per-paper and total AI summary columns

These diagnostic columns are retained alongside the transcript columns
(one set of the seven summary columns per paper in the fixed 3-paper pool, plus four
survey-wide totals):

- `<paper>_ai_prompt_count`, `<paper>_ai_successful_message_count`,
  `<paper>_ai_failed_message_count`
- `<paper>_ai_tab_opened`, `<paper>_ai_time_to_first_open_ms`,
  `<paper>_ai_time_to_first_message_ms`, `<paper>_ai_limit_reached`
- `total_participant_ai_prompts` — every AI message the participant sent,
  successful or not.
- `total_assistant_responses` / `total_successful_ai_messages` — count only
  AI exchanges that actually returned a response (`ai_message_log` entries
  with `success: true`). These two columns are always equal.
- `total_failed_ai_messages` — AI requests that failed, counted completely
  separately. A failed exchange never inflates the per-paper 5-message cap,
  but is still counted here so failure rates are visible.

## Fields deliberately excluded as standalone columns

These response keys are excluded from the dynamic flattener so they can never
accidentally reappear as a standalone column, because each duplicates data
that already has a canonical home elsewhere. They remain fully present inside
`responses_json` for every row, and completely inside the JSON export:

| Excluded response key | Why | Canonical column instead |
|---|---|---|
| `ay_role` | Duplicates the participant-selected role | `research_role` |
| `rg-ay-lang-specify` | Raw DOM-id duplicate of the language "Other" field | `lang_specify` |
| `rg-ai-purpose-specify` | Raw DOM-id duplicate of the AI-purpose "Other" field; not actually written by the current frontend (kept as a defensive fallback only) | `ai_purpose_other` |
| `aiInput-font`, `aiInput-food`, `aiInput-listing` | Live, possibly-unsent AI chat input drafts, not a submitted response | (none — these are draft text, not data) |

A small number of dev-only/legacy top-level fields (`expertise_tier`,
`condition`, `ct_scale_placement`, `study_order`, `assignment_version`,
`assignment_id_source`, `paper_order_version`, `role_locked_to_original`,
`test_condition_override`, `test_paper_override_json`,
`assigned_paper_1_id/title`, `assigned_paper_2_id/title`) are likewise
excluded as standalone columns because each has a clearer canonical
equivalent already in the schema (e.g. `research_expertise_stratum`,
`ai_condition`, `critical_thinking_placement`, `paper_order`). All of them
remain inside the JSON export.

Three obsolete placeholder fields are removed from the CSV by cleanRecord(). They are not exposed as CSV columns because the meaningful data already lives elsewhere. The accumulated JSON export returns records exactly as stored, so these legacy placeholders may still appear there if they existed in the original submitted record.

| Dropped field (CSV only) | Real data lives at |
|---|---|
| `quiz` (always `{}`) | `quiz_<paper>_<n>` columns, `quiz_score`, `quiz_total` |
| `draft_history` (always `[]`) | `logs_json` (per-question draft snapshots) |
| `keystroke_counts` (always `{}`) | `logs_json` (per-question keystroke counts) |

## Large raw columns removed from the CSV

The CSV no longer includes these three columns. They were removed because
they duplicate, in large raw JSON form, information the fixed transcript and
summary columns above already expose in analysis-friendly form. They remain
fully present — complete and unmodified — in the JSON export:

- `ai_message_log_json` — replaced for analysis purposes by the 40 fixed
  `paper_1_*`/`paper_2_*` transcript columns plus the per-paper/total AI
  summary counts.
- `behavioral_events_json` — replaced for analysis purposes by the
  behavioral summary counts (below).
- `raw_record_json` — was a complete per-row safety-net copy of the cleaned
  record; removed because it duplicated the entire JSON export inside every
  CSV row. Use the JSON export for anything not covered by a CSV column.

## Other derived/summary columns

- **`paper_order`** / **`paper_order_json`**: the same two-paper assignment
  order, as a readable comma-joined string (`font,food`) and as a JSON array
  (`["font","food"]`) respectively.
- **Paste-pathway columns** (`ai_to_answer_paste_count`,
  `question_to_ai_paste_count`, `external_to_answer_paste_count`,
  `external_to_ai_paste_count`): derived from each paste event's
  `inferred_pathway`.
- **Behavioral columns** (`behavioral_event_count`, `violation_count`,
  `blur_count`, `focus_count`, `visibility_event_count`,
  `visibility_hidden_count`, `visibility_visible_count`,
  `fullscreen_enter_count`, `fullscreen_exit_count`, `copy_event_count`,
  `paste_event_count`): counts of each `behavioral_events[].type` /
  `violations[].type` / `copy_events`/`paste_events` length.
- **Revision/keystroke/draft columns** (`revision_event_count`,
  `questions_revised_count`, `total_chars_inserted_during_revisions`,
  `total_chars_deleted_during_revisions`, `total_logged_keystrokes`,
  `total_logged_pastes`, `questions_with_draft_history`).

## Nested `*_json` columns still retained in the CSV

`responses_json`, `copy_events_json`, `paste_events_json`,
`revision_log_json`, `logs_json`, `timing_json`, `violations_json`, and
`paper_order_json` are kept because each carries information no standalone
column fully captures:

- `responses_json` — the only place every raw response key (including ones
  intentionally excluded as standalone columns, e.g. `ay_role`) survives in
  the CSV.
- `copy_events_json` / `paste_events_json` contain event metadata, including source and target classifications, question or paper identifiers, inferred transfer pathways, timestamps, and other available event attributes. The actual copied or pasted text is not stored.
  and offsets, behind the paste-pathway counts.
- `revision_log_json` — per-edit detail behind the aggregate revision
  counts.
- `logs_json` — full keystroke/draft timelines behind the aggregate totals.
- `timing_json` — the complete per-paper timing object (study/AI start-stop
  pairs) in one place.
- `violations_json` — each violation's type/detail/timestamp behind the
  single `violation_count`.

All of this is also fully present in the JSON export, so removing any of
these from the CSV would not lose data — it would just force a researcher
to switch to the JSON export to recover that one column's detail.

## A note on the CSV escaper

This sandbox had no npm registry access when this module was built (`npm
install csv-stringify` returned a `403`), so `lib/export-csv.js` includes a
small hand-written RFC4180-style escaper instead of a third-party CSV
library: any cell containing a comma, double quote, or newline is wrapped in
double quotes, with internal double quotes doubled. This is covered by
round-trip tests in `test/export.test.js` (multiline answers, embedded commas
and quotes, and non-ASCII/Unicode text), but if a maintainer later gets
registry access, swapping in a vetted library (e.g. `csv-stringify`) for
`csvCell()`/`buildAccumulatedCsv()` would be a reasonable follow-up — the
function boundary is deliberately narrow to make that swap low-risk.

## Where this lives in the codebase

- `lib/export-csv.js` — schema/CSV builder, framework-free, directly testable.
- `server.js` — wires the two `/api/admin/export-submissions.*` routes and
  the `/admin/export` page route to the module above; gates both export
  routes behind `ADMIN_EXPORT_KEY` (see `DEPLOYMENT.md`).
- `public/admin-export.html` — the researcher-facing key-entry export page.
- `test/export.test.js`, `test/admin-endpoints.test.js`,
  `test/fixtures/four-conditions.jsonl` — automated tests; run with
  `npm run test:export`.
