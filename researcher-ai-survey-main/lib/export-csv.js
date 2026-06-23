// lib/export-csv.js — Researcher-facing CSV/JSON export schema and
// serialization for accumulated participant submissions.
//
// This module is deliberately framework-free (no Express, no GCS/Firestore
// imports) so it can be required directly by the test suite (test/export.test.js)
// against plain JSON/JSONL fixtures, with zero network or paid-API calls.
//
// SCOPE: this module only transforms already-stored submission records into
// export formats. It does not change survey wording, consent/screening
// behavior, assignment, AI behavior, or any logging code — none of that
// lives here or is touched by anything in here.

'use strict';

// ---------------------------------------------------------------------------
// 1. Dead top-level field removal (spec point #1)
// ---------------------------------------------------------------------------
// Confirmed by exhaustive grep of public/researcher_ai_survey.js: these three
// top-level DATA fields are written once at initialization and never read or
// written anywhere else. Their real data lives elsewhere:
//   - quiz answers           -> responses['quiz_<paperId>_<qi>']
//   - quiz score/total       -> quiz_score / quiz_total
//   - draft snapshots        -> logs[<fieldId>].drafts
//   - per-question keystrokes-> logs[<fieldId>].keystrokes
// Future submissions stop writing these fields at the source (the DATA
// literal in researcher_ai_survey.js). This cleaner additionally strips them
// defensively from OLDER already-stored records so the CSV's column set is
// consistent across old and new records.
const DEAD_TOP_LEVEL_FIELDS = ['quiz', 'draft_history', 'keystroke_counts'];

function cleanRecord(record) {
  const cleaned = Object.assign({}, record || {});
  DEAD_TOP_LEVEL_FIELDS.forEach((k) => { delete cleaned[k]; });
  return cleaned;
}

// ---------------------------------------------------------------------------
// 2. Small safe accessors
// ---------------------------------------------------------------------------
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function arr(v) { return Array.isArray(v) ? v : []; }
function respVal(record, key) {
  const r = obj(record.responses);
  return Object.prototype.hasOwnProperty.call(r, key) ? r[key] : '';
}
function blankIfNullish(v) {
  return v === null || v === undefined ? '' : v;
}

// The fixed 3-paper pool. Mirrors PAPER_COMBOS / PAPER_IDS already hardcoded
// in server.js and researcher_ai_survey.js — NOT the kind of "expected count"
// the user's correction #1 was about (that correction was specifically about
// not hard-coding the SRL item COUNT, since that scale's item set can change;
// the 3-paper pool is a structural constant used throughout the existing app).
const PAPER_IDS = ['font', 'food', 'listing'];

// ---------------------------------------------------------------------------
// 3. Response keys intentionally excluded from standalone CSV columns
//    (spec points #6, #7, #9, and the user's correction #2/#3).
//    These remain fully recoverable inside responses_json and the complete
//    accumulated JSON export.
// ---------------------------------------------------------------------------
const EXCLUDED_RESPONSE_KEYS = new Set([
  'ay_role', // duplicates research_role (the canonical, server-assigned role)
  'rg-ay-lang-specify', // raw DOM-id duplicate of lang_specify
  'rg-ai-purpose-specify', // raw DOM-id duplicate of ai_purpose_specify (-> ai_purpose_other)
  'aiInput-font', // live/unsent AI-input draft text, not a sent message
  'aiInput-food',
  'aiInput-listing'
]);

// Top-level (non-responses) fields intentionally omitted from the main CSV
// as standalone columns (spec points #6, #7). Still present in the complete
// accumulated JSON export.
const EXCLUDED_TOP_LEVEL_KEYS = new Set([
  'expertise_tier', 'condition', 'ct_scale_placement', // legacy aliases
  'study_order', // duplicates paper_order / study_1_id / study_2_id
  'assigned_paper_1_id', 'assigned_paper_1_title',
  'assigned_paper_2_id', 'assigned_paper_2_title',
  'assignment_version', 'assignment_id_source', 'paper_order_version',
  'role_locked_to_original', 'test_condition_override', 'test_paper_override_json'
]);

// ---------------------------------------------------------------------------
// 4. Derived behavioral/AI summary helpers
// ---------------------------------------------------------------------------
function countBy(events, type) {
  return arr(events).filter((e) => e && e.type === type).length;
}

function paperAiSummary(cleaned, paperId) {
  const agg = obj(obj(cleaned.ai_paper_aggregates)[paperId]);
  const log = arr(cleaned.ai_message_log).filter((m) => m && m.paper_id === paperId);
  const successCount = log.filter((m) => m.success === true).length;
  const failCount = log.filter((m) => m.success === false).length;
  return {
    tab_opened: agg.tab_opened === true,
    time_to_first_open_ms: blankIfNullish(agg.time_to_first_open_ms),
    time_to_first_message_ms: blankIfNullish(agg.time_to_first_message_ms),
    // Prompt count is derived from the actual message log (not the live
    // in-session aggregate counter) so it is robust even if an older stored
    // record predates a given aggregate field.
    prompt_count: log.length,
    successful_message_count: successCount,
    failed_message_count: failCount,
    limit_reached: agg.limit_reached === true
  };
}

function revisionSummary(cleaned) {
  const log = arr(cleaned.revision_log);
  const questionIds = new Set();
  let charsInserted = 0;
  let charsDeleted = 0;
  log.forEach((r) => {
    if (!r) return;
    if (r.question_id) questionIds.add(r.question_id);
    charsInserted += Number(r.chars_inserted) || 0;
    charsDeleted += Number(r.chars_deleted) || 0;
  });
  return {
    revision_event_count: log.length,
    questions_revised_count: questionIds.size,
    total_chars_inserted_during_revisions: charsInserted,
    total_chars_deleted_during_revisions: charsDeleted
  };
}

function logsSummary(cleaned) {
  const logs = obj(cleaned.logs);
  let keystrokes = 0;
  let pastes = 0;
  let withDrafts = 0;
  Object.keys(logs).forEach((id) => {
    const l = obj(logs[id]);
    keystrokes += Number(l.keystrokes) || 0;
    pastes += Number(l.pastes) || 0;
    if (arr(l.drafts).length > 0) withDrafts++;
  });
  return {
    total_logged_keystrokes: keystrokes,
    total_logged_pastes: pastes,
    questions_with_draft_history: withDrafts
  };
}

function pasteSummary(cleaned) {
  const events = arr(cleaned.paste_events);
  return {
    ai_to_answer_paste_count: events.filter((e) => e && e.inferred_pathway === 'ai_response_to_answer').length,
    question_to_ai_paste_count: events.filter((e) => e && e.inferred_pathway === 'question_to_ai').length,
    external_to_answer_paste_count: events.filter((e) => e && e.inferred_pathway === 'external_or_unknown_to_answer').length,
    external_to_ai_paste_count: events.filter((e) => e && e.inferred_pathway === 'external_or_unknown_to_ai').length
  };
}

// ---------------------------------------------------------------------------
// 5. Multi-select response helper (spec point #10)
// ---------------------------------------------------------------------------
function multiSelectJoined(record, key) {
  const v = respVal(record, key);
  if (Array.isArray(v)) return v.join('; ');
  return blankIfNullish(v);
}
function multiSelectJson(record, key) {
  const v = respVal(record, key);
  return JSON.stringify(Array.isArray(v) ? v : (v === '' ? [] : [v]));
}

// ---------------------------------------------------------------------------
// 6. ai_purpose_other (spec point #9 + user correction #5; re-verified
//    against the current frontend for this revision request)
//    Confirmed by inspecting public/researcher_ai_survey.js: the AI-purpose
//    "Other" free text is written by
//    setupSpecifyField('rg-ai-purpose', 'ai_purpose', 'Other'), which stores
//    it at responses['ai_purpose_specify'] — that is the ONLY key the current
//    frontend ever populates for this field. 'rg-ai-purpose-specify' is just
//    the DOM element id of the text input, never a responses{} key written by
//    any current code path. It is kept here as a second-priority fallback
//    purely for robustness against any legacy/raw record that might use the
//    DOM-id form as a key — current submissions are not expected to ever hit
//    it. Nothing is invented: if neither key has a value, this returns ''.
//    The original key(s) remain present verbatim in responses_json and in
//    the complete accumulated JSON export.
// ---------------------------------------------------------------------------
function aiPurposeOther(record) {
  const primary = respVal(record, 'ai_purpose_specify');
  if (!(primary === '' || primary === null || primary === undefined)) {
    return primary;
  }
  return blankIfNullish(respVal(record, 'rg-ai-purpose-specify'));
}

// ---------------------------------------------------------------------------
// 6b. Fixed-width AI transcript flattening (this revision request, point #3/#4)
//    Confirmed by inspecting public/researcher_ai_survey.js (sendAiMessage):
//    each DATA.ai_message_log entry has exactly these fields —
//      paper_id, message_number (1-indexed, incremented before push, so it
//        is a reliable per-paper ordering key — NOT invented here),
//      prompt, response (null on failure),
//      submit_ts_iso  — timestamp captured when the participant's send
//        request was issued (new Date(sendStartTs).toISOString()),
//      complete_ts_iso — timestamp captured when that request finished,
//        success or failure (new Date(sendEndTs).toISOString()),
//      success (boolean), error_type, latency_ms, messages_remaining.
//    Both a participant-send timestamp and a response-completion timestamp
//    genuinely exist on every entry, so no timestamp is invented:
//      participant_message_time_<n> <- submit_ts_iso
//      ai_message_time_<n>          <- complete_ts_iso (successful entries only)
//    On a failed entry, response is null, so ai_message_<n> and
//    ai_message_time_<n> are left blank rather than echoing the generic
//    error_type or completion timestamp as if it were a real AI reply.
// ---------------------------------------------------------------------------
function paperIdForPosition(cleaned, position) {
  // position is 1 or 2. study_1_id/study_2_id are written directly from
  // order[0]/order[1] at assignment time (see researcher_ai_survey.js), so
  // they are the canonical, already-stored source for "the paper at this
  // position" — equivalent to paper_order[position-1] but robust even if
  // paper_order itself were ever missing on an older record.
  return position === 1 ? blankIfNullish(cleaned.study_1_id) : blankIfNullish(cleaned.study_2_id);
}

function orderedPaperLog(cleaned, paperId) {
  if (!paperId) return [];
  const log = arr(cleaned.ai_message_log).filter((m) => m && m.paper_id === paperId);
  return log.slice().sort((a, b) => {
    const an = typeof a.message_number === 'number' ? a.message_number : null;
    const bn = typeof b.message_number === 'number' ? b.message_number : null;
    if (an !== null && bn !== null) return an - bn;
    // Fallback ordering (spec point #4): chronological by the existing
    // participant-send timestamp. Never reorders across papers — this
    // function only ever receives one paper's own entries.
    const at = a.submit_ts_iso ? new Date(a.submit_ts_iso).getTime() : 0;
    const bt = b.submit_ts_iso ? new Date(b.submit_ts_iso).getTime() : 0;
    return at - bt;
  });
}

const MAX_AI_EXCHANGES_PER_PAPER = 5;

// "N/A" literal used ONLY for genuinely unused/inapplicable transcript
// slots — never for a failed AI request (failures stay distinguishable as
// a populated prompt/timestamp with a blank AI-response pair):
//   1. No-AI condition: AI interaction was not applicable at all, so every
//      one of the 40 transcript cells (all positions/exchanges/fields) is
//      "N/A".
//   2. AI condition, but this exchange slot was never used (the participant
//      sent fewer than 5 messages on this paper): all 4 fields for that
//      unused slot are "N/A".
// A successful exchange returns its captured prompt/timestamp/response/
// response-timestamp. A failed exchange returns its captured prompt/
// timestamp but an empty string ('') — not "N/A" — for the AI-response and
// AI-response-timestamp fields, since a request WAS made (this is the
// "applicable but no successful response" case, kept distinguishable from
// "slot never used" per this revision's spec).
const TRANSCRIPT_NOT_APPLICABLE = 'N/A';

function transcriptCell(cleaned, position, exchangeN, field) {
  // Case 1: No-AI condition — AI interaction was not applicable for this
  // participant at all, regardless of exchange slot or field.
  if (cleaned.ai_condition !== 'AI') return TRANSCRIPT_NOT_APPLICABLE;

  const paperId = paperIdForPosition(cleaned, position);
  const ordered = orderedPaperLog(cleaned, paperId);
  const entry = ordered[exchangeN - 1];

  // Case 2: AI condition, but this exchange slot was never used (the
  // participant sent fewer than 5 messages on this paper, or this paper has
  // no AI messages at all).
  if (!entry) return TRANSCRIPT_NOT_APPLICABLE;

  // Case 3/4: a request was made for this slot — always preserve the
  // participant's prompt and send timestamp, whether the request succeeded
  // or failed.
  if (field === 'participant_message') return blankIfNullish(entry.prompt);
  if (field === 'participant_message_time') return blankIfNullish(entry.submit_ts_iso);

  // Case 4: a failed request leaves the AI-response and AI-response-time
  // fields blank ('') — never "N/A" (the slot WAS used/applicable) and
  // never an invented response/timestamp.
  if (entry.success !== true) return '';

  // Case 3: a successful exchange — captured AI response and its
  // completion timestamp.
  if (field === 'ai_message') return blankIfNullish(entry.response);
  if (field === 'ai_message_time') return blankIfNullish(entry.complete_ts_iso);
  return '';
}

// ---------------------------------------------------------------------------
// 7. Dynamic key collection (spec points #1 correction, #8, #16)
//    SRL and CT item sets are discovered from the data itself (never a
//    hard-coded expected count), so future scale changes are picked up
//    automatically.
// ---------------------------------------------------------------------------
function collectResponseKeysMatching(records, prefixRegex) {
  const set = new Set();
  records.forEach((r) => {
    Object.keys(obj(r.responses)).forEach((k) => {
      if (prefixRegex.test(k)) set.add(k);
    });
  });
  return Array.from(set).sort();
}

function collectAllResponseKeys(records) {
  const set = new Set();
  records.forEach((r) => {
    Object.keys(obj(r.responses)).forEach((k) => set.add(k));
  });
  return set;
}

// ---------------------------------------------------------------------------
// 8. Column schema builder
//    Returns { columns } where columns is an ordered array of
//    { key, get(cleanedRecord) } — get() always returns a CSV-cell-ready
//    primitive (string/number/boolean) or '' for missing data; arrays/objects
//    that legitimately belong in a column (the *_json columns) are returned
//    as already-JSON.stringify'd strings.
// ---------------------------------------------------------------------------
function buildColumns(cleanedRecords) {
  const columns = [];
  const claimedResponseKeys = new Set();

  function col(key, getFn) {
    columns.push({ key, get: getFn });
  }
  function responseCol(key, csvKey) {
    claimedResponseKeys.add(key);
    col(csvKey || key, (c) => blankIfNullish(respVal(c, key)));
  }

  // ---- Group 1: participant/session ----
  col('participant_id', (c) => blankIfNullish(c.participant_id));
  col('prolific_id', (c) => blankIfNullish(c.prolific_id));
  col('record_type', (c) => (c.test_mode === true ? 'test' : 'production'));
  col('test_mode', (c) => c.test_mode === true);
  col('session_start_iso', (c) => blankIfNullish(c.session_start_iso));
  col('session_end_iso', (c) => blankIfNullish(c.session_end_iso));
  col('final_submission_timestamp', (c) => blankIfNullish(c.final_submission_timestamp));
  col('total_survey_duration_ms', (c) => {
    if (!c.session_start_iso || !c.session_end_iso) return '';
    const start = new Date(c.session_start_iso).getTime();
    const end = new Date(c.session_end_iso).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    return end - start;
  });
  col('completion_status', (c) => blankIfNullish(c.completion_status));
  col('consent_status', (c) => blankIfNullish(c.consent_status));
  col('media_release_status', (c) => blankIfNullish(c.media_release_status));
  col('screening_exit_reason', (c) => blankIfNullish(c.screening_exit_reason));
  col('submission_status', (c) => blankIfNullish(c.submission_status));
  col('submission_attempted_at', (c) => blankIfNullish(c.submission_attempted_at));
  col('submission_confirmed_at', (c) => blankIfNullish(c.submission_confirmed_at));
  col('submission_error', (c) => blankIfNullish(c.submission_error));

  // ---- Group 2: assignment/condition ----
  col('research_role', (c) => blankIfNullish(c.research_role));
  col('research_expertise_stratum', (c) => blankIfNullish(c.research_expertise_stratum));
  col('ai_condition', (c) => blankIfNullish(c.ai_condition));
  col('critical_thinking_placement', (c) => blankIfNullish(c.critical_thinking_placement));
  col('assignment_cell', (c) => blankIfNullish(c.assignment_cell));
  col('assignment_source', (c) => blankIfNullish(c.assignment_source));
  col('assignment_assigned_at', (c) => blankIfNullish(c.assignment_assigned_at));
  col('stable_assignment_id_hash', (c) => blankIfNullish(c.stable_assignment_id_hash));

  // ---- Group 3: paper IDs/order ----
  col('study_1_id', (c) => blankIfNullish(c.study_1_id));
  col('study_1_title', (c) => blankIfNullish(c.study_1_title));
  col('study_2_id', (c) => blankIfNullish(c.study_2_id));
  col('study_2_title', (c) => blankIfNullish(c.study_2_title));
  col('unassigned_paper_id', (c) => blankIfNullish(c.unassigned_paper_id));
  // Readable + JSON forms of the paper order (user correction #6).
  col('paper_order', (c) => arr(c.paper_order).join(','));
  col('paper_order_json', (c) => JSON.stringify(arr(c.paper_order)));

  // ---- Group 4: demographics/AI-background (explicit canonical fields) ----
  ['ay_age', 'ay_country', 'lang', 'lang_specify', 'ay_field', 'reviewed',
    'ai_hours_per_week', 'ai_tenure'].forEach((k) => responseCol(k));
  // ai_purpose: multi-select -> joined text + json, plus the renamed "Other" field.
  claimedResponseKeys.add('ai_purpose');
  claimedResponseKeys.add('ai_purpose_specify');
  col('ai_purpose', (c) => multiSelectJoined(c, 'ai_purpose'));
  col('ai_purpose_json', (c) => multiSelectJson(c, 'ai_purpose'));
  col('ai_purpose_other', (c) => aiPurposeOther(c));

  // Dynamic: any other demographic/background response field not explicitly
  // named above (e.g. ai_understanding) is included automatically if and only
  // if it actually exists in at least one record's responses — never invented.
  const allResponseKeys = collectAllResponseKeys(cleanedRecords);
  const srlKeys = collectResponseKeysMatching(cleanedRecords, /^srl_/);
  const ctKeys = collectResponseKeysMatching(cleanedRecords, /^ct_/);
  const quizResponseKeys = collectResponseKeysMatching(cleanedRecords, /^quiz_/);
  const perPaperStandardKeys = new Set();
  PAPER_IDS.forEach((p) => {
    ['q1', 'q2', 'q3', 'q4', 'convincing'].forEach((suf) => perPaperStandardKeys.add(p + '_' + suf));
  });
  const perPaperScaleKeys = new Set();
  PAPER_IDS.forEach((p) => { perPaperScaleKeys.add('confidence_' + p); perPaperScaleKeys.add('understood_' + p); });

  const otherDemographicKeys = Array.from(allResponseKeys).filter((k) =>
    !claimedResponseKeys.has(k) &&
    !EXCLUDED_RESPONSE_KEYS.has(k) &&
    !srlKeys.includes(k) &&
    !ctKeys.includes(k) &&
    !quizResponseKeys.includes(k) &&
    !perPaperStandardKeys.has(k) &&
    !perPaperScaleKeys.has(k) &&
    k !== 'ai_engagement' && k !== 'whose_thinking'
  ).sort();
  otherDemographicKeys.forEach((k) => responseCol(k));

  // ---- Group 5: SRL items (dynamic — never a hard-coded expected count) ----
  srlKeys.forEach((k) => responseCol(k));

  // ---- Group 6: CT items (dynamic) ----
  ctKeys.forEach((k) => responseCol(k));

  // ---- Group 7: open-ended paper responses (q1-q4 per assigned paper) ----
  PAPER_IDS.forEach((p) => {
    ['q1', 'q2', 'q3', 'q4'].forEach((suf) => responseCol(p + '_' + suf));
  });

  // ---- Group 8: convincingness/confidence/understanding/engagement/ownership ----
  PAPER_IDS.forEach((p) => responseCol(p + '_convincing'));
  PAPER_IDS.forEach((p) => responseCol('confidence_' + p));
  PAPER_IDS.forEach((p) => responseCol('understood_' + p));
  claimedResponseKeys.add('ai_engagement');
  col('ai_engagement', (c) => multiSelectJoined(c, 'ai_engagement'));
  col('ai_engagement_json', (c) => multiSelectJson(c, 'ai_engagement'));
  responseCol('whose_thinking');

  // ---- Group 9: quiz answers/score ----
  col('quiz_score', (c) => blankIfNullish(c.quiz_score));
  col('quiz_total', (c) => blankIfNullish(c.quiz_total));
  quizResponseKeys.forEach((k) => responseCol(k));

  // ---- Group 10: per-paper timing/AI summaries ----
  PAPER_IDS.forEach((p) => {
    const timing = (c) => obj(obj(c.timing)[p]);
    col(p + '_study_start_iso', (c) => blankIfNullish(timing(c).study_start_iso));
    col(p + '_study_end_iso', (c) => blankIfNullish(timing(c).study_end_iso));
    col(p + '_duration_ms', (c) => blankIfNullish(timing(c).duration_ms));
    col(p + '_ai_tab_opened', (c) => paperAiSummary(c, p).tab_opened);
    col(p + '_ai_time_to_first_open_ms', (c) => paperAiSummary(c, p).time_to_first_open_ms);
    col(p + '_ai_time_to_first_message_ms', (c) => paperAiSummary(c, p).time_to_first_message_ms);
    col(p + '_ai_prompt_count', (c) => paperAiSummary(c, p).prompt_count);
    col(p + '_ai_successful_message_count', (c) => paperAiSummary(c, p).successful_message_count);
    col(p + '_ai_failed_message_count', (c) => paperAiSummary(c, p).failed_message_count);
    col(p + '_ai_limit_reached', (c) => paperAiSummary(c, p).limit_reached);
  });
  col('total_participant_ai_prompts', (c) => arr(c.ai_message_log).length);
  // Per the user's correction #7: an "assistant response" only exists for a
  // successful exchange (a failed request never produces a stored AI reply),
  // so total_assistant_responses and total_successful_ai_messages are both
  // exactly "count of ai_message_log entries with success === true" — failed
  // requests are counted ONLY in total_failed_ai_messages, never here.
  col('total_assistant_responses', (c) => arr(c.ai_message_log).filter((m) => m && m.success === true).length);
  col('total_successful_ai_messages', (c) => arr(c.ai_message_log).filter((m) => m && m.success === true).length);
  col('total_failed_ai_messages', (c) => arr(c.ai_message_log).filter((m) => m && m.success === false).length);

  // ---- Group 10b: fixed-width AI transcript columns (this revision request) ----
  // paper_<position>_id/title identify which assigned paper each block of 20
  // transcript columns belongs to (position 1 = paper_order[0]/study_1,
  // position 2 = paper_order[1]/study_2). Exactly 4 columns per exchange,
  // exchanges 1-5, for both positions = 40 transcript columns total. For
  // No-AI rows ai_message_log is always empty, so every one of these 40
  // cells is "N/A" — never invented and never confused with a failed
  // request (see transcriptCell above).
  [1, 2].forEach((position) => {
    col('paper_' + position + '_id', (c) => paperIdForPosition(c, position));
    col('paper_' + position + '_title', (c) =>
      blankIfNullish(position === 1 ? c.study_1_title : c.study_2_title));
    for (let n = 1; n <= MAX_AI_EXCHANGES_PER_PAPER; n++) {
      col('paper_' + position + '_participant_message_' + n,
        (c) => transcriptCell(c, position, n, 'participant_message'));
      col('paper_' + position + '_participant_message_time_' + n,
        (c) => transcriptCell(c, position, n, 'participant_message_time'));
      col('paper_' + position + '_ai_message_' + n,
        (c) => transcriptCell(c, position, n, 'ai_message'));
      col('paper_' + position + '_ai_message_time_' + n,
        (c) => transcriptCell(c, position, n, 'ai_message_time'));
    }
  });

  // ---- Group 11: behavioral summary counts ----
  col('behavioral_event_count', (c) => arr(c.behavioral_events).length);
  col('violation_count', (c) => arr(c.violations).length); // not treated as confirmed misconduct
  col('blur_count', (c) => countBy(c.behavioral_events, 'blur'));
  col('focus_count', (c) => countBy(c.behavioral_events, 'focus'));
  col('visibility_event_count', (c) => countBy(c.behavioral_events, 'visibility') + countBy(c.behavioral_events, 'visibility_visible'));
  col('visibility_hidden_count', (c) => countBy(c.behavioral_events, 'visibility'));
  col('visibility_visible_count', (c) => countBy(c.behavioral_events, 'visibility_visible'));
  col('fullscreen_enter_count', (c) => countBy(c.behavioral_events, 'fullscreen_enter'));
  col('fullscreen_exit_count', (c) => countBy(c.behavioral_events, 'fullscreen_exit'));
  col('copy_event_count', (c) => arr(c.copy_events).length);
  col('paste_event_count', (c) => arr(c.paste_events).length);
  col('ai_to_answer_paste_count', (c) => pasteSummary(c).ai_to_answer_paste_count);
  col('question_to_ai_paste_count', (c) => pasteSummary(c).question_to_ai_paste_count);
  col('external_to_answer_paste_count', (c) => pasteSummary(c).external_to_answer_paste_count);
  col('external_to_ai_paste_count', (c) => pasteSummary(c).external_to_ai_paste_count);
  col('revision_event_count', (c) => revisionSummary(c).revision_event_count);
  col('questions_revised_count', (c) => revisionSummary(c).questions_revised_count);
  col('total_chars_inserted_during_revisions', (c) => revisionSummary(c).total_chars_inserted_during_revisions);
  col('total_chars_deleted_during_revisions', (c) => revisionSummary(c).total_chars_deleted_during_revisions);
  col('total_logged_keystrokes', (c) => logsSummary(c).total_logged_keystrokes);
  col('total_logged_pastes', (c) => logsSummary(c).total_logged_pastes);
  col('questions_with_draft_history', (c) => logsSummary(c).questions_with_draft_history);

  // ---- Group 12: remaining nested _json columns ----
  // Per this revision request, ai_message_log_json, behavioral_events_json,
  // and raw_record_json are REMOVED from the CSV (they're large, raw, and
  // duplicate what the fixed transcript/summary columns above already
  // expose in analysis-friendly form; the complete originals remain fully
  // available in the accumulated JSON export — the /api/admin/export-submissions.json
  // route returns raw stored records unmodified, independent of this column
  // list). The remaining *_json columns here were inspected and kept because
  // each carries information no standalone column fully captures:
  // responses_json is the only place every raw response key (including ones
  // intentionally excluded as standalone columns, e.g. ay_role) survives in
  // the CSV; copy_events_json/paste_events_json retain each event's exact
  // source text and offsets behind the paste-pathway counts; revision_log_json
  // retains per-edit detail behind the aggregate revision counts; logs_json
  // retains full keystroke/draft timelines behind the aggregate totals;
  // timing_json retains the complete per-paper timing object (study/AI
  // start-stop pairs) in one place; violations_json retains each violation's
  // type/detail/timestamp behind the single violation_count.
  col('responses_json', (c) => JSON.stringify(obj(c.responses)));
  col('copy_events_json', (c) => JSON.stringify(arr(c.copy_events)));
  col('paste_events_json', (c) => JSON.stringify(arr(c.paste_events)));
  col('revision_log_json', (c) => JSON.stringify(arr(c.revision_log)));
  col('logs_json', (c) => JSON.stringify(obj(c.logs)));
  col('timing_json', (c) => JSON.stringify(obj(c.timing)));
  col('violations_json', (c) => JSON.stringify(arr(c.violations)));

  return columns;
}

// ---------------------------------------------------------------------------
// 9. RFC4180-style CSV cell escaping (hand-written — see note in
//    DATA_EXPORT.md about why no third-party CSV library is used: this
//    sandbox has no registry access to install/vet one, so correctness here
//    is instead guaranteed by the export test suite's round-trip checks for
//    commas, quotes, embedded newlines, and Unicode).
// ---------------------------------------------------------------------------
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'boolean' || typeof value === 'number') s = String(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const CSV_BOM = '﻿';

function buildAccumulatedCsv(rawRecords) {
  const cleanedRecords = rawRecords.map(cleanRecord);
  const columns = buildColumns(cleanedRecords);
  const headerLine = columns.map((c) => csvCell(c.key)).join(',');
  const lines = cleanedRecords.map((c) =>
    columns.map((col) => csvCell(col.get(c))).join(',')
  );
  const csv = [headerLine].concat(lines).join('\r\n') + '\r\n';
  return CSV_BOM + csv;
}

module.exports = {
  DEAD_TOP_LEVEL_FIELDS,
  EXCLUDED_RESPONSE_KEYS,
  EXCLUDED_TOP_LEVEL_KEYS,
  PAPER_IDS,
  MAX_AI_EXCHANGES_PER_PAPER,
  TRANSCRIPT_NOT_APPLICABLE,
  cleanRecord,
  buildColumns,
  buildAccumulatedCsv,
  csvCell,
  CSV_BOM
};
