'use strict';

const PAPER_IDS = ['font', 'food', 'listing'];
const OPEN_RESPONSE_SUFFIXES = ['q1', 'q2', 'q3'];
const MAX_TRANSCRIPT_TURNS = 5;

const SRL_KEYS = [
  'srl_elab_combine', 'srl_elab_prior', 'srl_elab_relate',
  'srl_eval_different', 'srl_eval_know', 'srl_eval_learned',
  'srl_goal_deadlines', 'srl_goal_shortlong', 'srl_goal_standards',
  'srl_help_beforeown', 'srl_help_guidance', 'srl_help_identify', 'srl_help_own_r',
  'srl_plan_adapt', 'srl_plan_alternatives', 'srl_plan_organize', 'srl_plan_questions',
  'srl_task_change', 'srl_task_examples', 'srl_task_notes', 'srl_task_ownwords'
];

const CT_KEYS = [
  'ct_alternatives', 'ct_assumptions', 'ct_bias', 'ct_compare', 'ct_credibility', 'ct_evidence'
];

const BASE_COLUMNS = [
  'participant_id', 'prolific_id', 'record_type', 'test_mode',
  'session_start_iso', 'session_end_iso', 'total_survey_duration_ms',
  'completion_status', 'consent_status', 'media_release_status', 'screening_exit_reason',
  'research_role', 'research_role_years', 'research_expertise_stratum', 'ai_condition',
  'critical_thinking_placement', 'assignment_cell', 'stable_assignment_id_hash',
  'study_1_id', 'study_2_id',
  'ay_age', 'lang', 'lang_specify', 'ay_field', 'reviewed',
  'ai_hours_per_week', 'ai_tenure', 'ai_purpose', 'ai_purpose_other', 'ai_understanding',
  ...SRL_KEYS,
  ...CT_KEYS
];

const TASK_COLUMNS = [];
for (const paperId of PAPER_IDS) {
  for (const suffix of OPEN_RESPONSE_SUFFIXES) TASK_COLUMNS.push(`${paperId}_${suffix}`);
}
for (const paperId of PAPER_IDS) TASK_COLUMNS.push(`${paperId}_convincing`);
for (const paperId of PAPER_IDS) TASK_COLUMNS.push(`confidence_${paperId}`);
for (const paperId of PAPER_IDS) TASK_COLUMNS.push(`understood_${paperId}`);
TASK_COLUMNS.push(
  'whose_thinking',
  'quiz_score',
  'quiz_font_score',
  'quiz_food_score',
  'quiz_listing_score'
);
const PER_QUESTION_PROCESS_COLUMNS = [];
for (const paperId of PAPER_IDS) {
  for (const suffix of OPEN_RESPONSE_SUFFIXES) {
    const q = `${paperId}_${suffix}`;
    PER_QUESTION_PROCESS_COLUMNS.push(
      `${q}_response_length`,
      `${q}_keystrokes`,
      `${q}_paste_count`,
      `${q}_ai_to_answer_paste_count`,
      `${q}_revision_event_count`
    );
  }
}

const PER_PAPER_COLUMNS = [];

for (const paperId of PAPER_IDS) {
  PER_PAPER_COLUMNS.push(
    `${paperId}_duration_ms`,
    `${paperId}_ai_tab_opened`,
    `${paperId}_ai_time_to_first_open_ms`,
    `${paperId}_ai_time_to_first_message_ms`,
    `${paperId}_ai_prompt_count`
  );
}

const TRANSCRIPT_COLUMNS = [];
for (let position = 1; position <= 2; position += 1) {
  TRANSCRIPT_COLUMNS.push(`paper_${position}_id`, `paper_${position}_title`);
  for (let turn = 1; turn <= MAX_TRANSCRIPT_TURNS; turn += 1) {
    TRANSCRIPT_COLUMNS.push(
      `paper_${position}_participant_message_${turn}`,
      `paper_${position}_participant_message_time_${turn}`,
      `paper_${position}_ai_message_${turn}`,
      `paper_${position}_ai_message_time_${turn}`
    );
  }
}

const BEHAVIOR_COLUMNS = [
  'visibility_hidden_count',
  'fullscreen_exit_count',

  'ai_to_answer_paste_count',
  'answer_to_ai_paste_count',
  'question_to_ai_paste_count',
  'external_to_answer_paste_count',
  'external_to_ai_paste_count',

  'revision_event_count',
  'questions_revised_count',
  'proportion_of_answer_text_changed_after_ai_paste',

  'total_response_length',
  'total_logged_keystrokes'
];

const AI_SUMMARY_COLUMNS = [
  'total_participant_ai_prompts'
];

const CSV_COLUMNS = [
  ...BASE_COLUMNS,
  ...TASK_COLUMNS,
  ...PER_QUESTION_PROCESS_COLUMNS,
  ...PER_PAPER_COLUMNS,
  ...AI_SUMMARY_COLUMNS,
  ...TRANSCRIPT_COLUMNS,
  ...BEHAVIOR_COLUMNS
];

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
  return [record.study_1_id, record.study_2_id].filter(Boolean);
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
  const revisionLog = asArray(record.revision_log);
  const logs = record.logs || {};
  const order = paperOrder(record);

  const row = {};
  for (const key of CSV_COLUMNS) row[key] = '';

  row.participant_id = record.participant_id;
  row.prolific_id = record.prolific_id;
  row.record_type = record.test_mode ? 'test' : 'production';
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
  row.assignment_cell = record.assignment_cell;
  row.stable_assignment_id_hash = record.stable_assignment_id_hash;
  row.study_1_id = record.study_1_id || order[0];
  row.study_2_id = record.study_2_id || order[1];

  const responseKeys = [
    'ay_age', 'lang', 'lang_specify', 'ay_field', 'reviewed',
    'ai_hours_per_week', 'ai_tenure', 'ai_purpose', 'ai_purpose_other', 'ai_understanding',
    ...SRL_KEYS, ...CT_KEYS,
    ...TASK_COLUMNS.filter(
      (key) =>
        key !== 'quiz_score' &&
        key !== 'quiz_font_score' &&
        key !== 'quiz_food_score' &&
        key !== 'quiz_listing_score'
    )
  ];
  for (const key of responseKeys) row[key] = textValue(responses[key]);
  row.ai_purpose_other = textValue(
    responses.ai_purpose_other ?? responses.ai_purpose_specify ?? responses['rg-ai-purpose-specify']
  );
  row.quiz_score = record.quiz_score;
  const quizPaperScores =
    record.quiz_paper_scores &&
      typeof record.quiz_paper_scores === 'object'
      ? record.quiz_paper_scores
      : {};

  row.quiz_font_score =
    quizPaperScores.font != null
      ? quizPaperScores.font
      : '';

  row.quiz_food_score =
    quizPaperScores.food != null
      ? quizPaperScores.food
      : '';

  row.quiz_listing_score =
    quizPaperScores.listing != null
      ? quizPaperScores.listing
      : '';

  let totalResponseLength = 0;
  let totalKeystrokes = 0;

  // Populate per-question process measures and overall totals.
  for (const paperId of PAPER_IDS) {
    for (const suffix of OPEN_RESPONSE_SUFFIXES) {
      const questionId = `${paperId}_${suffix}`;
      const answer = String(responses[questionId] || '');
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

      const responseLength = answer.length;
      const keystrokes = Number(questionLog.keystrokes || 0);

      row[`${questionId}_response_length`] = responseLength;
      row[`${questionId}_keystrokes`] = keystrokes;
      row[`${questionId}_paste_count`] =
        questionPasteEvents.length;

      row[`${questionId}_ai_to_answer_paste_count`] =
        countBy(
          questionPasteEvents,
          event => event.source_type === 'ai_response'
        );

      row[`${questionId}_revision_event_count`] =
        questionRevisionEvents.length;

      totalResponseLength += responseLength;
      totalKeystrokes += keystrokes;
    }
  }
  row.total_response_length = totalResponseLength;
  row.total_logged_keystrokes = totalKeystrokes;

  // Populate per-paper timing and successful AI-use measures.
  for (const paperId of PAPER_IDS) {
    const t = timing[paperId] || {};
    const agg = aggregates[paperId] || {};

    const paperMessages = aiMessageLog.filter(
      msg => msg && msg.paper_id === paperId
    );

    row[`${paperId}_duration_ms`] =
      t.duration_ms ?? '';

    row[`${paperId}_ai_tab_opened`] =
      Boolean(agg.tab_opened);

    row[`${paperId}_ai_time_to_first_open_ms`] =
      agg.time_to_first_open_ms ?? '';

    row[`${paperId}_ai_time_to_first_message_ms`] =
      agg.time_to_first_message_ms ?? '';

    row[`${paperId}_ai_prompt_count`] =
      countBy(
        paperMessages,
        msg => msg.success === true
      ) || Number(agg.successful_messages || 0);
  }

  row.total_participant_ai_prompts =
    PAPER_IDS.reduce(
      (total, paperId) =>
        total + Number(row[`${paperId}_ai_prompt_count`] || 0),
      0
    );

  for (let position = 1; position <= 2; position += 1) {
    const paperId = order[position - 1];
    row[`paper_${position}_id`] = paperId || '';
    row[`paper_${position}_title`] = paperId && record[`study_${position}_title`]
      ? record[`study_${position}_title`]
      : (paperId && record[`assigned_paper_${position}_title`]) || '';
    const chat = asArray(aiChats[paperId]);
    const users = chat.filter((message) => message && message.role === 'user');
    const assistants = chat.filter((message) => message && message.role === 'assistant');
    for (let turn = 1; turn <= MAX_TRANSCRIPT_TURNS; turn += 1) {
      const user = users[turn - 1] || {};
      const assistant = assistants[turn - 1] || {};
      row[`paper_${position}_participant_message_${turn}`] = user.content || '';
      row[`paper_${position}_participant_message_time_${turn}`] = user.ts || '';
      row[`paper_${position}_ai_message_${turn}`] = assistant.content || '';
      row[`paper_${position}_ai_message_time_${turn}`] = assistant.ts || '';
    }
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
  row.external_to_answer_paste_count = countBy(pasteEvents, (event) => event.source_type === 'external_or_unknown' && event.target_type === 'participant_answer');
  row.external_to_ai_paste_count = countBy(pasteEvents, (event) => event.source_type === 'external_or_unknown' && event.target_type === 'ai_input');

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
  return '\uFEFF' + lines.join('\n');
}

const AI_TRANSCRIPT_COLUMNS = [
  'participant_id', 'prolific_id', 'record_type', 'test_mode', 'ai_condition',
  'research_expertise_stratum', 'assignment_cell', 'paper_id', 'paper_title',
  'paper_order_position', 'message_number', 'participant_prompt', 'participant_prompt_time',
  'assistant_response', 'assistant_response_time', 'success', 'latency_ms', 'error_type'
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
        rows.push({
          participant_id: record.participant_id || '',
          prolific_id: record.prolific_id || '',
          record_type: record.test_mode ? 'test' : 'production',
          test_mode: Boolean(record.test_mode),
          ai_condition: record.ai_condition || record.condition || '',
          research_expertise_stratum: record.research_expertise_stratum || record.expertise_tier || '',
          assignment_cell: record.assignment_cell || '',
          paper_id: paperId,
          paper_title: paperTitle,
          paper_order_position: paperPosition,
          message_number: i + 1,
          participant_prompt: logEntry.prompt || user.content || '',
          participant_prompt_time: logEntry.submit_ts_iso || user.ts || '',
          assistant_response: logEntry.response || assistant.content || '',
          assistant_response_time: logEntry.complete_ts_iso || assistant.ts || '',
          success: logEntry.success === true,
          latency_ms: logEntry.latency_ms ?? '',
          error_type: logEntry.error_type || ''
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
  buildAiTranscriptCsv
};
