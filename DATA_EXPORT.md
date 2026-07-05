# Data Export Reference

This document matches the current one-paper survey implementation in `lib/export-csv.js` and the accumulated export routes in `server.js`.

If this document and the code ever disagree, treat `lib/export-csv.js` and `server.js` as authoritative.

## 1. Accumulated exports versus the in-browser admin panel

The hidden Ctrl+Shift+E browser panel exports only the current tab's in-memory session.

The accumulated researcher exports read backend storage across participants:

```text
GET /api/admin/export-submissions.json?type=production
GET /api/admin/export-submissions.csv?type=production
GET /api/admin/export-ai-transcript.csv?type=production

GET /api/admin/export-submissions.json?type=test
GET /api/admin/export-submissions.csv?type=test
GET /api/admin/export-ai-transcript.csv?type=test
```

The page:

```text
/admin/export
```

provides buttons for accumulated participant-level CSV and JSON exports. The AI-transcript CSV is available through its direct route.

Every accumulated route requires:

```text
X-Admin-Key: <ADMIN_EXPORT_KEY>
```

The key is never accepted in the URL. If `ADMIN_EXPORT_KEY` is absent or wrong, the routes return `401`.

Production and test records are never combined.

## 2. Where accumulated records come from

In Google Cloud production mode:

- completed production submissions are JSON objects under `submissions/` in GCS;
- completed test submissions are JSON objects under `test-submissions/` in GCS;
- current production autosaves are documents in `survey_progress`;
- current test autosaves are documents in `survey_progress_test`.

When an export is requested, the backend:

1. lists and reads all final JSON objects for the selected type;
2. reads all autosave documents for the selected type;
3. merges records by `participant_id`;
4. keeps the latest autosave when there is no final submission;
5. replaces any autosave with the final submission when one exists.

The resulting participant-level export can therefore include both completed participants and in-progress participants.

The `record_source` CSV column indicates:

```text
final_submission
autosave
```

## 3. Three export formats

### Full accumulated JSON

Route:

```text
/api/admin/export-submissions.json
```

This is the authoritative archive.

It returns each selected record without flattening or deleting nested structures. Depending on what was captured, records can include:

- `responses`;
- `timing`;
- `ai_chats`;
- `ai_message_log`;
- `ai_paper_aggregates`;
- `behavioral_events`;
- `copy_events`;
- `paste_events`;
- `revision_log`;
- `logs`;
- `violations`;
- quiz and assignment metadata;
- autosave or completion metadata.

Keep this file even when the CSV is the primary analysis file.

### Participant-level accumulated CSV

Route:

```text
/api/admin/export-submissions.csv
```

This contains one row per merged participant record and uses a fixed one-paper schema.

All columns are scalar values. The CSV does not embed full nested arrays or objects as JSON cells.

The file begins with a UTF-8 BOM for compatibility with Excel.

### AI-transcript CSV

Route:

```text
/api/admin/export-ai-transcript.csv
```

This contains one row per recorded AI exchange rather than one row per participant.

It is most useful for prompt/response analysis and latency checks.

## 4. Participant-level CSV schema

The schema is fixed in `CSV_COLUMNS`. It is not dynamically inferred from incoming records.

When survey questions or exported measures change, `lib/export-csv.js` must be updated explicitly.

### Identification, provenance, and timing

```text
participant_id
prolific_id
record_source
last_saved_at
test_mode
session_start_iso
session_end_iso
total_survey_duration_ms
completion_status
consent_status
media_release_status
screening_exit_reason
```

### Assignment and background

```text
research_role
research_role_years
research_experience_years
research_expertise_stratum
ai_condition
critical_thinking_placement
assigned_paper_id
ay_age
lang
lang_specify
ay_field
reviewed
ai_research_use
ai_hours_per_week
ai_tenure
ai_purpose
ai_purpose_other
ai_understanding
```

Although the current balancing algorithm does not use role or expertise, those fields remain available as participant background variables.

### Raw self-regulated-learning items

```text
srl_goal_setting
srl_strategic_planning
srl_task_strategies
srl_elaboration
srl_self_evaluation
srl_help_seeking
```

### Raw general critical-thinking items

```text
ct_credibility
ct_understand_vs_judge
ct_evidence
ct_alternatives
ct_weaknesses
```

### Raw AI-evaluation items

These are applicable when the participant reports prior research AI use:

```text
ai_eval_summarize_clarify
ai_eval_before_own_judgment
ai_eval_question_assumptions
ai_eval_rely_without_comparing
ai_eval_bias_concern
```

### Analysis-ready scored items

For every SRL, general CT, and AI-evaluation item, the CSV also includes a corresponding:

```text
<item>_scored
```

The exporter performs reverse scoring where specified in the current code.

Current reverse-scored items are:

```text
srl_strategic_planning
srl_self_evaluation
ct_evidence
ai_eval_rely_without_comparing
```

For a valid 1–7 response:

```text
reverse-scored value = 8 - raw value
```

Missing or invalid values remain blank.

### Quality-control fields

```text
attention_check
ai_eval_question_assumptions_repeat
ai_repeat_consistent
```

`ai_repeat_consistent` is populated when both repeated AI-evaluation responses are valid and differ by no more than one scale point.

### Generic one-paper task responses

Each official participant is assigned exactly one paper. The paper identity is stored in `assigned_paper_id`, while task columns use generic names:

```text
strength_response
limitation_response
improvement_response
convincing_rating
confidence_rating
understanding_rating
```

Current records use one textbox for each open-response category.

For compatibility with older records that used `_1`, `_2`, and `_3` fields, the exporter:

1. prefers the current combined field;
2. if that field is missing or blank, joins any nonblank legacy subfields in order with blank lines.

This avoids silently losing legacy response text.

### First-typing timestamps

```text
strength_first_typing_time
limitation_first_typing_time
improvement_first_typing_time
```

These are taken from the corresponding logging entries for the assigned paper.

### Quiz fields

```text
quiz_q1_response
quiz_q2_response
quiz_q3_response
quiz_q4_response
quiz_q5_response
quiz_score
```

Quiz answer fields contain the canonical answer text associated with the participant's displayed selection.

Partial autosaves can contain some quiz responses while later questions remain blank. `quiz_score` reflects the current score at the time of that autosave.

### Per-response process fields

For each of:

```text
strength
limitation
improvement
```

the CSV includes:

```text
<response>_response_length
<response>_keystrokes
<response>_paste_count
<response>_ai_to_answer_paste_count
<response>_revision_event_count
```

`response_length` is a word count, not a character count.

### Assigned-paper timing and navigation

One generic set describes the assigned paper:

```text
task_duration_ms
pdf_exposure_proportion_30s
region_exposed_30s_count
paper_navigation_sequence
backward_transition_count
component_navigation_sequence
component_transition_count
ai_time_to_first_message_ms
ai_prompt_count
```

Important details:

- `pdf_exposure_proportion_30s` uses a strict threshold: exposure must exceed 30,000 ms;
- `region_exposed_30s_count` counts qualifying half-page regions;
- `paper_navigation_sequence` uses the six approved region labels:
  - `P1-Top-Half`
  - `P1-Bottom-Half`
  - `P2-Top-Half`
  - `P2-Bottom-Half`
  - `P3-Top-Half`
  - `P3-Bottom-Half`;
- hidden or unfocused time is excluded from qualifying viewport exposure;
- missing timing data is blank rather than automatically treated as zero;
- genuine measured zero values are preserved.

### Fixed participant-level transcript columns

The participant-level CSV includes the assigned paper title:

```text
assigned_paper_title
```

For turns 1 through 5:

```text
participant_message_1
participant_message_time_1
ai_message_1
ai_message_time_1
...
participant_message_5
participant_message_time_5
ai_message_5
ai_message_time_5
```

Unused or unavailable transcript slots are blank. The CSV does not use a literal `N/A` marker.

`assigned_paper_id` identifies which paper these transcript columns refer to.

### Behavioral summary fields

```text
visibility_hidden_count
fullscreen_exit_count
ai_to_answer_paste_count
answer_to_ai_paste_count
question_to_ai_paste_count
ai_to_ai_paste_count
external_to_answer_paste_count
external_to_ai_paste_count
revision_event_count
questions_revised_count
proportion_of_answer_text_changed_after_ai_paste
total_response_length
total_logged_keystrokes
```

`proportion_of_answer_text_changed_after_ai_paste` is blank when no qualifying AI-to-answer paste baseline is available.

### Derived aggregate fields

```text
srl_composite_mean
ct_composite_mean
ai_eval_composite_mean
any_ai_use
total_copy_count
total_paste_count
questions_with_any_paste
questions_with_ai_to_answer_paste
```

Composite means require all substantive scored items for that scale. If any required item is missing or invalid, the composite is blank.

For participants who report no prior research AI use, AI-evaluation responses and their scored/composite values are blanked in the export.

## 5. AI-transcript CSV schema

The exact columns are:

```text
record_type
participant_id
prolific_id
test_mode
assignment_cell
condition
paper_id
paper_title
turn_number
participant_message
participant_message_timestamp
assistant_message
assistant_message_timestamp
participant_message_length
assistant_message_length
latency_ms
success
```

`record_type` is:

```text
production
test
```

The transcript builder uses the assigned paper order and combines information from:

```text
ai_message_log
ai_chats
```

Where available, `ai_message_log` supplies prompt, response, timestamps, latency, and success. Chat content is used as a fallback when corresponding log content is absent.

A row may represent an unsuccessful request. In that case:

- the participant prompt can still be present;
- the assistant message can be blank;
- `success` is `FALSE`;
- `latency_ms` may be blank or populated depending on the captured log.

## 6. Fields intentionally not included as participant-level CSV columns

The participant-level CSV does not contain raw JSON blob columns such as:

```text
responses_json
timing_json
ai_message_log_json
behavioral_events_json
copy_events_json
paste_events_json
revision_log_json
logs_json
violations_json
raw_record_json
```

It also does not reproduce every top-level assignment or implementation field as a standalone scalar column.

Use the full accumulated JSON export when the analysis requires:

- full raw event arrays;
- every AI request status/error detail;
- all unsummarized timing structures;
- fields not included in `CSV_COLUMNS`;
- complete source records for auditing or reprocessing.

Before analysis, archive the full JSON alongside the CSV.

## 7. CSV cleaning behavior

Before participant-level CSV flattening, the exporter removes these obsolete/dead placeholders from its temporary copy:

```text
draft_history
keystroke_counts
quiz
```

This does not alter stored records.

The full JSON export does not perform this cleaning and therefore preserves the records exactly as stored.

## 8. CSV encoding and escaping

Every CSV cell is quoted.

Internal double quotes are doubled. Null or undefined values become empty quoted cells. Booleans are written as:

```text
TRUE
FALSE
```

The participant-level CSV and AI-transcript CSV include a leading UTF-8 BOM for Excel compatibility.

## 9. Download examples

### Researcher page

Open:

```text
https://YOUR-SERVICE-URL/admin/export
```

Enter the admin key and select the desired participant-level CSV or JSON export.

### PowerShell: participant-level production files

```powershell
Invoke-WebRequest `
  -Uri "https://YOUR-SERVICE-URL/api/admin/export-submissions.json?type=production" `
  -Headers @{ "X-Admin-Key" = "YOUR_ADMIN_EXPORT_KEY" } `
  -OutFile "submissions-production.json"

Invoke-WebRequest `
  -Uri "https://YOUR-SERVICE-URL/api/admin/export-submissions.csv?type=production" `
  -Headers @{ "X-Admin-Key" = "YOUR_ADMIN_EXPORT_KEY" } `
  -OutFile "submissions-production.csv"
```

### PowerShell: production AI transcript

```powershell
Invoke-WebRequest `
  -Uri "https://YOUR-SERVICE-URL/api/admin/export-ai-transcript.csv?type=production" `
  -Headers @{ "X-Admin-Key" = "YOUR_ADMIN_EXPORT_KEY" } `
  -OutFile "ai-transcript-production.csv"
```

Use `type=test` for test records.

## 10. Verification procedure after deployment

1. Start one controlled participant session.
2. Answer only part of the survey and part of the quiz.
3. Download the production or test accumulated CSV.
4. Confirm the row is marked `record_source=autosave`.
5. Confirm answered quiz fields and the current quiz score are present.
6. Complete the participant session.
7. Download the files again.
8. Confirm the same participant is now represented by the final submission rather than the autosave.
9. Confirm the full JSON includes the raw arrays and nested structures.
10. In an AI condition, confirm the AI-transcript CSV contains one row per attempted exchange.

## 11. Tests

Run:

```bash
npm run test:export
```

The current suite tests:

- fixed one-paper columns;
- generic quiz fields, including question 5;
- partial quiz autosave conversion and scoring;
- current and legacy open-response compatibility;
- word-count response lengths;
- scored scale values and composites;
- participant-level transcript fields;
- AI-transcript row structure;
- viewport exports and genuine zero handling;
- production/test separation;
- admin-key authentication;
- `/admin/export` page availability.

Tests that use local storage do not call OpenAI, GCS, or Firestore. Real GCS listing/reading and real Firestore assignment/autosave behavior must still be verified after deployment.
