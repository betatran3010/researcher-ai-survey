'use strict';

const PAPER_IDS = ['font', 'food', 'listing'];
// As of the single-textbox-per-question revision, each open-ended category is
// one field (no more _1/_2/_3 sub-items). Older stored records from before
// this change only have the legacy '<suffix>_1'/'_2'/'_3' fields;
// getOpenResponse() below merges those in so their content is never silently
// dropped from exports.
const OPEN_RESPONSE_SUFFIXES = ['strength', 'limitation', 'improvement'];
const LEGACY_OPEN_RESPONSE_SUFFIXES = [
  'strength_1', 'strength_2', 'strength_3',
  'limitation_1', 'limitation_2', 'limitation_3',
  'improvement_1', 'improvement_2', 'improvement_3'
];

// Returns the export value for a single open-response question. Prefers the
// new single-field response (e.g. "font_strength"); if that's missing/blank
// (an older record from before the single-textbox revision), falls back to
// joining the legacy "<paperId>_<suffix>_1/_2/_3" fields in order, separated
// by a blank line, skipping any that are empty so old records never gain
// meaningless separators. Never silently drops old response content.
function getOpenResponse(responses, paperId, suffix) {
  const resp = responses || {};
  const newValue = resp[`${paperId}_${suffix}`];
  if (newValue != null && String(newValue).trim() !== '') {
    return String(newValue);
  }
  return [1, 2, 3]
    .map(index => resp[`${paperId}_${suffix}_${index}`])
    .filter(value => value != null && String(value).trim() !== '')
    .map(String)
    .join('\n\n');
}

const MAX_TRANSCRIPT_TURNS = 5;

const SRL_KEYS = [
  'srl_goal_setting',
  'srl_strategic_planning',
  'srl_task_strategies',
  'srl_elaboration',
  'srl_self_evaluation',
  'srl_help_seeking'
];

const CT_KEYS = [
  'ct_credibility',
  'ct_understand_vs_judge',
  'ct_evidence',
  'ct_alternatives',
  'ct_weaknesses'
];

const AI_EVALUATION_KEYS = [
  'ai_eval_summarize_clarify',
  'ai_eval_before_own_judgment',
  'ai_eval_question_assumptions',
  'ai_eval_rely_without_comparing',
  'ai_eval_bias_concern'
];

const AI_EVALUATION_REPEAT_KEY = 'ai_eval_question_assumptions_repeat';

const SRL_REVERSE_CODED_KEYS = new Set([
  'srl_strategic_planning',
  'srl_self_evaluation'
]);

const CT_REVERSE_CODED_KEYS = new Set([
  'ct_evidence'
]);

const AI_EVALUATION_REVERSE_CODED_KEYS = new Set([
  'ai_eval_rely_without_comparing'
]);

const SRL_SCORED_KEYS = SRL_KEYS.map(key => `${key}_scored`);
const CT_SCORED_KEYS = CT_KEYS.map(key => `${key}_scored`);
const AI_EVALUATION_SCORED_KEYS = AI_EVALUATION_KEYS.map(key => `${key}_scored`);

const QUALITY_CHECK_COLUMNS = [
  'attention_check',
  AI_EVALUATION_REPEAT_KEY,
  'ai_repeat_consistent'
];

const DERIVED_AGGREGATE_COLUMNS = [
  'srl_composite_mean',
  'ct_composite_mean',
  'ai_eval_composite_mean',
  'any_ai_use',
  'total_copy_count',
  'total_paste_count',
  'questions_with_any_paste',
  'questions_with_ai_to_answer_paste'
];

const BASE_COLUMNS = [
  'participant_id', 'prolific_id', 'record_source', 'last_saved_at', 'test_mode',
  'session_start_iso', 'session_end_iso', 'total_survey_duration_ms',
  'completion_status', 'consent_status', 'media_release_status', 'screening_exit_reason',
  'research_role', 'research_role_years', 'research_experience_years', 'research_expertise_stratum', 'ai_condition',
  'critical_thinking_placement',
  'assigned_paper_id',
  'ay_age', 'lang', 'lang_specify', 'ay_field', 'reviewed',
  'ai_research_use', 'ai_hours_per_week', 'ai_tenure', 'ai_purpose', 'ai_purpose_other', 'ai_understanding',

  // Raw participant responses
  ...SRL_KEYS,
  ...CT_KEYS,
  ...AI_EVALUATION_KEYS,

  // Analysis-ready values
  ...SRL_SCORED_KEYS,
  ...CT_SCORED_KEYS,
  ...AI_EVALUATION_SCORED_KEYS,

  // Quality-control items
  ...QUALITY_CHECK_COLUMNS
];

// One-paper schema: each official participant is assigned exactly one paper.
// Generic column names (no paper prefix) hold that assigned paper's values.
const TASK_COLUMNS = [
  'strength_response',
  'limitation_response',
  'improvement_response',
  'convincing_rating',
  'confidence_rating',
  'understanding_rating',
  // First-typing timestamps per data dictionary (no paper prefix).
  'strength_first_typing_time',
  'limitation_first_typing_time',
  'improvement_first_typing_time',
  'quiz_q1_response',
  'quiz_q2_response',
  'quiz_q3_response',
  'quiz_q4_response',
  'quiz_q5_response',
  'quiz_score'
];
// One process-column set per open-response type; no paper prefix.
const PER_QUESTION_PROCESS_COLUMNS = [];
for (const suffix of OPEN_RESPONSE_SUFFIXES) {
  PER_QUESTION_PROCESS_COLUMNS.push(
    `${suffix}_response_length`,
    `${suffix}_keystrokes`,
    `${suffix}_paste_count`,
    `${suffix}_ai_to_answer_paste_count`,
    `${suffix}_revision_event_count`
  );
}

// One generic set of per-paper columns for the single assigned paper.
// PDF viewport threshold: strictly more than 30 s (EXPOSURE_THRESHOLD_MS = 30000).
const PER_PAPER_COLUMNS = [
  'task_duration_ms',
  'pdf_exposure_proportion_30s',
  'region_exposed_30s_count',
  'paper_navigation_sequence',
  'backward_transition_count',
  'component_navigation_sequence',
  'component_transition_count',
  'ai_time_to_first_message_ms',
  'ai_prompt_count'
];

// Generic transcript columns; assigned_paper_id in BASE_COLUMNS identifies the paper.
const TRANSCRIPT_COLUMNS = ['assigned_paper_title'];
for (let turn = 1; turn <= MAX_TRANSCRIPT_TURNS; turn += 1) {
  TRANSCRIPT_COLUMNS.push(
    `participant_message_${turn}`,
    `participant_message_time_${turn}`,
    `ai_message_${turn}`,
    `ai_message_time_${turn}`
  );
}

const BEHAVIOR_COLUMNS = [
  'visibility_hidden_count',
  'fullscreen_exit_count',

  'ai_to_answer_paste_count',
  'answer_to_ai_paste_count',
  'question_to_ai_paste_count',
  // ai_to_ai_paste_count: pastes into the AI input box where the clipboard
  // content originated from an earlier AI response in the same conversation.
  'ai_to_ai_paste_count',
  'external_to_answer_paste_count',
  'external_to_ai_paste_count',

  'revision_event_count',
  'questions_revised_count',
  'proportion_of_answer_text_changed_after_ai_paste',

  'total_response_length',
  'total_logged_keystrokes'
];

const CSV_COLUMNS = [
  ...BASE_COLUMNS,
  ...TASK_COLUMNS,
  ...PER_QUESTION_PROCESS_COLUMNS,
  ...PER_PAPER_COLUMNS,
  ...TRANSCRIPT_COLUMNS,
  ...BEHAVIOR_COLUMNS,
  ...DERIVED_AGGREGATE_COLUMNS
];

function scoreLikertResponse(rawValue, shouldReverse) {
  if (
    rawValue === null ||
    rawValue === undefined ||
    rawValue === ''
  ) {
    return '';
  }

  const numericValue = Number(rawValue);

  if (
    !Number.isInteger(numericValue) ||
    numericValue < 1 ||
    numericValue > 7
  ) {
    return '';
  }

  return shouldReverse
    ? 8 - numericValue
    : numericValue;
}

function cleanRecord(record) {
  const out = JSON.parse(JSON.stringify(record || {}));
  delete out.draft_history;
  delete out.keystroke_counts;
  delete out.quiz;
  return out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(' | ');
  if (typeof value === 'object') return '';
  return value;
}

function isoMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function countBy(items, predicate) {
  let count = 0;
  for (const item of items) if (predicate(item)) count += 1;
  return count;
}

// Word count for response-length columns. Trims leading/trailing whitespace,
// then counts whitespace-separated tokens. A blank or whitespace-only
// response returns 0.
function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function numericOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Returns the mean of `values` only when every value is present/valid;
// otherwise returns '' (blank), per the approved SRL/CT aggregate rule.
function meanIfAllValid(values, decimals = 4) {
  const nums = values.map(numericOrNull);
  if (nums.some((num) => num === null)) return '';
  const sum = nums.reduce((total, num) => total + num, 0);
  return Number((sum / nums.length).toFixed(decimals));
}

// Returns the sum of `values` only when every value is present/valid;
// otherwise returns '' (blank).
function sumIfAllValid(values) {
  const nums = values.map(numericOrNull);
  if (nums.some((num) => num === null)) return '';
  return nums.reduce((total, num) => total + num, 0);
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[right.length];
}

function paperOrder(record) {
  if (Array.isArray(record.paper_order) && record.paper_order.length) return record.paper_order;
  if (Array.isArray(record.study_order) && record.study_order.length) return record.study_order;
  return [record.study_1_id].filter(Boolean);
}

function getResponses(record) {
  return record.responses && typeof record.responses === 'object' ? record.responses : {};
}

function getAiToAnswerPastes(pasteEvents) {
  return pasteEvents.filter((event) =>
    event && event.source_type === 'ai_response' && event.target_type === 'participant_answer'
  );
}

function latestAiPasteByQuestion(pasteEvents) {
  const latest = new Map();
  for (const event of getAiToAnswerPastes(pasteEvents)) {
    if (!event.target_id) continue;
    const current = latest.get(event.target_id);
    const eventMs = isoMs(event.answer_state_captured_at || event.ts) || 0;
    const currentMs = current ? (isoMs(current.answer_state_captured_at || current.ts) || 0) : -1;
    if (!current || eventMs >= currentMs) latest.set(event.target_id, event);
  }
  return latest;
}

function flattenRecord(inputRecord) {
  const record = cleanRecord(inputRecord);
  const responses = getResponses(record);
  const timing = record.timing || {};
  const aggregates = record.ai_paper_aggregates || {};
  const aiChats = record.ai_chats || {};
  const aiMessageLog = asArray(record.ai_message_log);
  const behavioralEvents = asArray(record.behavioral_events);
  const pasteEvents = asArray(record.paste_events);
  const copyEvents = asArray(record.copy_events);
  const revisionLog = asArray(record.revision_log);
  const logs = record.logs || {};
  const order = paperOrder(record);

  const row = {};
  for (const key of CSV_COLUMNS) row[key] = '';

  row.participant_id = record.participant_id;
  row.prolific_id = record.prolific_id;
  row.record_source = record.record_source || (record.completion_status === 'completed' ? 'final_submission' : 'autosave');
  row.last_saved_at = record.last_saved_at || record.submission_confirmed_at || record.final_submission_timestamp || '';
  row.test_mode = Boolean(record.test_mode);
  row.session_start_iso = record.session_start_iso;
  row.session_end_iso = record.session_end_iso;
  const start = isoMs(record.session_start_iso);
  const end = isoMs(record.session_end_iso || record.final_submission_timestamp);
  row.total_survey_duration_ms = start != null && end != null ? Math.max(0, end - start) : '';
  row.completion_status = record.completion_status;
  row.consent_status = record.consent_status;
  row.media_release_status = record.media_release_status;
  row.screening_exit_reason = record.screening_exit_reason;
  row.research_role = record.research_role || responses.ay_role;
  row.research_role_years = record.research_role_years ?? responses.ay_role_years;
  row.research_expertise_stratum = record.research_expertise_stratum || record.expertise_tier;
  row.ai_condition = record.ai_condition || record.condition;
  row.critical_thinking_placement = record.critical_thinking_placement || record.ct_scale_placement;

  const assignedPaperId =
    record.assigned_paper_id ||
    record.assigned_paper_1_id ||
    record.study_1_id ||
    order[0] ||
    '';

  row.assigned_paper_id = assignedPaperId;

  const responseKeys = [
    'ay_age', 'lang', 'lang_specify', 'ay_field', 'research_experience_years', 'reviewed',
    'ai_research_use', 'ai_hours_per_week', 'ai_tenure', 'ai_purpose', 'ai_purpose_other', 'ai_understanding',
    ...SRL_KEYS,
    'attention_check',
    ...CT_KEYS,
    ...AI_EVALUATION_KEYS,
    AI_EVALUATION_REPEAT_KEY
  ];
  for (const key of responseKeys) row[key] = textValue(responses[key]);

  // One-paper task columns: populate from the assigned paper only.
  // getOpenResponse() merges legacy "_1/_2/_3" sub-items so old records are never blank.
  row.strength_response = getOpenResponse(responses, assignedPaperId, 'strength');
  row.limitation_response = getOpenResponse(responses, assignedPaperId, 'limitation');
  row.improvement_response = getOpenResponse(responses, assignedPaperId, 'improvement');
  // convincing_rating: stored as `${paperId}_convincing` in responses.
  row.convincing_rating = textValue(responses[`${assignedPaperId}_convincing`]);
  // confidence_rating / understanding_rating: stored under legacy keys.
  row.confidence_rating = textValue(responses[`${assignedPaperId}_confidence`]);
  row.understanding_rating = textValue(responses[`${assignedPaperId}_understood`]);
  row.ai_purpose_other = textValue(
    responses.ai_purpose_other ?? responses.ai_purpose_specify ?? responses['rg-ai-purpose-specify']
  );
  if (responses.ai_research_use === 'No') {
    row.ai_tenure = '';
    row.ai_hours_per_week = '';
    row.ai_purpose = '';
    row.ai_purpose_other = '';
    row.ai_understanding = '';
    for (const key of AI_EVALUATION_KEYS) {
      row[key] = '';
      row[`${key}_scored`] = '';
    }
    row[AI_EVALUATION_REPEAT_KEY] = '';
    row.ai_repeat_consistent = '';
    row.ai_eval_composite_mean = '';
  }
  // Automatically create analysis-ready SRL values.
  for (const key of SRL_KEYS) {
    row[`${key}_scored`] = scoreLikertResponse(
      responses[key],
      SRL_REVERSE_CODED_KEYS.has(key)
    );
  }

  // Automatically create analysis-ready general critical-thinking values.
  for (const key of CT_KEYS) {
    row[`${key}_scored`] = scoreLikertResponse(
      responses[key],
      CT_REVERSE_CODED_KEYS.has(key)
    );
  }

  // Automatically create analysis-ready AI-evaluation values.
  for (const key of AI_EVALUATION_KEYS) {
    row[`${key}_scored`] = scoreLikertResponse(
      responses[key],
      AI_EVALUATION_REVERSE_CODED_KEYS.has(key)
    );
  }

  const aiOriginalValue = Number(responses.ai_eval_question_assumptions);
  const aiRepeatedValue = Number(responses[AI_EVALUATION_REPEAT_KEY]);
  const hasBothAiRepeatResponses =
    Number.isInteger(aiOriginalValue) &&
    aiOriginalValue >= 1 &&
    aiOriginalValue <= 7 &&
    Number.isInteger(aiRepeatedValue) &&
    aiRepeatedValue >= 1 &&
    aiRepeatedValue <= 7;

  row.ai_repeat_consistent =
    hasBothAiRepeatResponses
      ? Math.abs(aiOriginalValue - aiRepeatedValue) <= 1
      : '';

  // Each composite requires every substantive scored item.
  row.srl_composite_mean = meanIfAllValid(
    SRL_KEYS.map((key) => row[`${key}_scored`])
  );

  row.ct_composite_mean = meanIfAllValid(
    CT_KEYS.map((key) => row[`${key}_scored`])
  );

  row.ai_eval_composite_mean = meanIfAllValid(
    AI_EVALUATION_KEYS.map((key) => row[`${key}_scored`])
  );
  if (responses.ai_research_use === 'No') {
    for (const key of AI_EVALUATION_KEYS) {
      row[key] = '';
      row[`${key}_scored`] = '';
    }
    row[AI_EVALUATION_REPEAT_KEY] = '';
    row.ai_repeat_consistent = '';
    row.ai_eval_composite_mean = '';
  }

  // quiz_score: the assigned paper's quiz score (stored by the front end).
  row.quiz_score = record.quiz_score;

  // quiz_q1_response … quiz_q5_response: assigned paper's quiz answers.
  for (let questionNumber = 1; questionNumber <= 5; questionNumber += 1) {
    row[`quiz_q${questionNumber}_response`] =
      textValue(responses[`quiz_${assignedPaperId}_q${questionNumber}_response`]);
  }

  let totalResponseLength = 0;
  let totalKeystrokes = 0;

  // Populate per-question process measures and overall totals from the assigned paper.
  for (const suffix of OPEN_RESPONSE_SUFFIXES) {
    const questionId = `${assignedPaperId}_${suffix}`;
    const answer = getOpenResponse(responses, assignedPaperId, suffix);
    const questionLog = logs[questionId] || {};

    const questionPasteEvents = pasteEvents.filter(
      event =>
        event &&
        event.target_type === 'participant_answer' &&
        event.target_id === questionId
    );

    const questionRevisionEvents = revisionLog.filter(
      event =>
        event &&
        event.question_id === questionId
    );

    const responseLength = wordCount(answer);
    const keystrokes = Number(questionLog.keystrokes || 0);

    // Generic process columns (no paper prefix) for the assigned paper.
    row[`${suffix}_response_length`] = responseLength;
    row[`${suffix}_keystrokes`] = keystrokes;
    row[`${suffix}_paste_count`] = questionPasteEvents.length;

    row[`${suffix}_ai_to_answer_paste_count`] =
      countBy(
        questionPasteEvents,
        event => event.source_type === 'ai_response'
      );

    row[`${suffix}_revision_event_count`] =
      questionRevisionEvents.length;

    // First-typing time: data dictionary name, no paper prefix.
    row[`${suffix}_first_typing_time`] = questionLog.first_keystroke_ts || '';

    totalResponseLength += responseLength;
    totalKeystrokes += keystrokes;
  }
  row.total_response_length = totalResponseLength;
  row.total_logged_keystrokes = totalKeystrokes;

  // Populate timing and AI-use measures from the single assigned paper.
  {
    const t = timing[assignedPaperId] || {};
    const agg = aggregates[assignedPaperId] || {};

    const paperMessages = aiMessageLog.filter(
      msg => msg && msg.paper_id === assignedPaperId
    );

    row.task_duration_ms = t.duration_ms ?? '';

    // Viewport-tracking measures written into timing[paperId] by the front end.
    // Left blank when absent (genuine 0 is distinct from "never measured").
    // pdf_exposure_proportion_30s: proportion of buckets exposed > 30 s.
    row.pdf_exposure_proportion_30s = t.pdf_exposure_proportion_30s ?? '';

    // region_exposed_30s_count: number of six half-page regions with > 30 s exposure.
    row.region_exposed_30s_count = t.region_exposed_30s_count ?? '';

    row.paper_navigation_sequence = t.paper_navigation_sequence ?? '';
    row.backward_transition_count = t.backward_transition_count ?? '';

    // Component-level navigation: collapsed Paper/Questions/AI state sequence.
    row.component_navigation_sequence = t.component_navigation_sequence ?? '';
    row.component_transition_count = t.component_transition_count ?? '';

    row.ai_time_to_first_message_ms = agg.time_to_first_message_ms ?? '';

    row.ai_prompt_count = countBy(paperMessages, msg => msg.success === true);
  }

  // Approved AI-use aggregates. Qualifying = successful prompt for the assigned paper.
  const qualifyingAiMessages = aiMessageLog.filter(
    (msg) => msg && msg.success === true && msg.paper_id === assignedPaperId
  );

  row.any_ai_use = qualifyingAiMessages.length > 0;



  // Generic transcript (single assigned paper; assigned_paper_id already in row).
  row.assigned_paper_title = assignedPaperId
    ? (record[`study_1_title`] || record[`assigned_paper_1_title`] || '')
    : '';
  const assignedChat = asArray(aiChats[assignedPaperId]);
  const chatUsers = assignedChat.filter((message) => message && message.role === 'user');
  const chatAssistants = assignedChat.filter((message) => message && message.role === 'assistant');
  for (let turn = 1; turn <= MAX_TRANSCRIPT_TURNS; turn += 1) {
    const user = chatUsers[turn - 1] || {};
    const assistant = chatAssistants[turn - 1] || {};
    row[`participant_message_${turn}`] = user.content || '';
    row[`participant_message_time_${turn}`] = user.ts || '';
    row[`ai_message_${turn}`] = assistant.content || '';
    row[`ai_message_time_${turn}`] = assistant.ts || '';
  }

  row.visibility_hidden_count = countBy(
    behavioralEvents,
    event => event.type === 'visibility'
  );

  row.fullscreen_exit_count = countBy(
    behavioralEvents,
    event => event.type === 'fullscreen_exit'
  );
  row.ai_to_answer_paste_count = countBy(pasteEvents, (event) => event.source_type === 'ai_response' && event.target_type === 'participant_answer');
  row.answer_to_ai_paste_count = countBy(pasteEvents, (event) => event.source_type === 'participant_answer' && event.target_type === 'ai_input');
  row.question_to_ai_paste_count = countBy(pasteEvents, (event) => event.source_type === 'question' && event.target_type === 'ai_input');
  // ai_to_ai_paste_count: pastes where source is a prior AI response AND
  // target is the AI input box (i.e. participant reused an AI reply as a
  // follow-up prompt). Computed from existing paste_events — no frontend
  // change required.
  row.ai_to_ai_paste_count = countBy(pasteEvents, (event) => event.source_type === 'ai_response' && event.target_type === 'ai_input');
  row.external_to_answer_paste_count = countBy(pasteEvents, (event) => event.source_type === 'external_or_unknown' && event.target_type === 'participant_answer');
  row.external_to_ai_paste_count = countBy(pasteEvents, (event) => event.source_type === 'external_or_unknown' && event.target_type === 'ai_input');

  // Approved copy/paste aggregates.
  row.total_copy_count = copyEvents.length;
  row.total_paste_count = pasteEvents.length;

  row.questions_with_any_paste = new Set(
    pasteEvents
      .filter((event) => event && event.target_type === 'participant_answer' && event.target_id)
      .map((event) => event.target_id)
  ).size;
  row.questions_with_ai_to_answer_paste = new Set(
    pasteEvents
      .filter((event) => event && event.target_type === 'participant_answer' && event.source_type === 'ai_response' && event.target_id)
      .map((event) => event.target_id)
  ).size;


  row.revision_event_count = revisionLog.length;
  row.questions_revised_count = new Set(revisionLog.map((event) => event && event.question_id).filter(Boolean)).size;

  let changeNumerator = 0;
  let changeDenominator = 0;
  for (const [questionId, paste] of latestAiPasteByQuestion(pasteEvents).entries()) {
    if (typeof paste.answer_value_after_paste !== 'string') continue;
    const finalAnswer = String(responses[questionId] || '');
    const baseline = paste.answer_value_after_paste;
    const denominator = Math.max(baseline.length, finalAnswer.length);
    if (denominator === 0) continue;
    changeNumerator += levenshteinDistance(baseline, finalAnswer);
    changeDenominator += denominator;
  }
  row.proportion_of_answer_text_changed_after_ai_paste = changeDenominator > 0
    ? Number((changeNumerator / changeDenominator).toFixed(4))
    : '';

  // One-paper model: no unassigned paper columns exist, so no blanking loop needed.
  return row;
}

function csvEscape(value) {
  if (value == null) return '""';
  const normalized = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function buildAccumulatedCsv(records) {
  const rows = asArray(records).map(flattenRecord);
  const lines = [CSV_COLUMNS.map(csvEscape).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  return '﻿' + lines.join('\n');
}

const AI_TRANSCRIPT_COLUMNS = [
  'record_type', 'participant_id', 'prolific_id', 'test_mode', 'assignment_cell', 'condition',
  'paper_id', 'paper_title', 'turn_number', 'participant_message', 'participant_message_timestamp',
  'assistant_message', 'assistant_message_timestamp', 'participant_message_length',
  'assistant_message_length', 'latency_ms', 'success'
];

function buildAiTranscriptRows(records) {
  const rows = [];
  for (const inputRecord of asArray(records)) {
    const record = cleanRecord(inputRecord);
    const order = paperOrder(record);
    const log = asArray(record.ai_message_log);
    const chats = record.ai_chats || {};

    for (const paperId of order) {
      const paperPosition = order.indexOf(paperId) + 1;
      const paperTitle = record[`study_${paperPosition}_title`] || record[`assigned_paper_${paperPosition}_title`] || '';
      const paperLog = log.filter((entry) => entry && entry.paper_id === paperId);
      const chat = asArray(chats[paperId]);
      const users = chat.filter((message) => message && message.role === 'user');
      const assistants = chat.filter((message) => message && message.role === 'assistant');
      const turnCount = Math.max(paperLog.length, users.length, assistants.length);

      for (let i = 0; i < turnCount; i += 1) {
        const logEntry = paperLog[i] || {};
        const user = users[i] || {};
        const assistant = assistants[i] || {};
        const participantMsg = logEntry.prompt || user.content || '';
        const assistantMsg   = logEntry.response || assistant.content || '';
        rows.push({
          record_type: record.test_mode ? 'test' : 'production',
          participant_id: record.participant_id || '',
          prolific_id: record.prolific_id || '',
          test_mode: Boolean(record.test_mode),
          assignment_cell: record.assignment_cell || '',
          condition: record.ai_condition || record.condition || '',
          paper_id: paperId,
          paper_title: paperTitle,
          turn_number: i + 1,
          participant_message: participantMsg,
          participant_message_timestamp: logEntry.submit_ts_iso || user.ts || '',
          assistant_message: assistantMsg,
          assistant_message_timestamp: logEntry.complete_ts_iso || assistant.ts || '',
          participant_message_length: participantMsg.length,
          assistant_message_length: assistantMsg.length,
          latency_ms: logEntry.latency_ms ?? '',
          success: logEntry.success === true
        });
      }
    }
  }
  return rows;
}

function buildAiTranscriptCsv(records) {
  const rows = buildAiTranscriptRows(records);
  const lines = [AI_TRANSCRIPT_COLUMNS.map(csvEscape).join(',')];
  for (const row of rows) lines.push(AI_TRANSCRIPT_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  return '\uFEFF' + lines.join('\n');
}

module.exports = {
  CSV_COLUMNS,
  AI_TRANSCRIPT_COLUMNS,
  cleanRecord,
  flattenRecord,
  buildAccumulatedCsv,
  buildAiTranscriptRows,
  buildAiTranscriptCsv,
  getOpenResponse,
  OPEN_RESPONSE_SUFFIXES,
  LEGACY_OPEN_RESPONSE_SUFFIXES
};
