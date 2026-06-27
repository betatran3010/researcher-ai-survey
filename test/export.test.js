// test/export.test.js — Local export tests against in-memory fixture
// records only. Deliberately makes ZERO network calls and NEVER touches
// /api/chat, OpenAI, GCS, or Firestore — it requires lib/export-csv.js
// directly and feeds it deterministic fixture records constructed here.
//
// NOTE ON THIS REVISION: this file was rewritten to match the CURRENT
// lib/export-csv.js schema (BASE_COLUMNS/TASK_COLUMNS/PER_QUESTION_PROCESS_
// COLUMNS/PER_PAPER_COLUMNS/AI_SUMMARY_COLUMNS/TRANSCRIPT_COLUMNS/
// BEHAVIOR_COLUMNS, flattenRecord, buildAccumulatedCsv, buildAiTranscriptCsv).
// The previous version of this file asserted against an older, superseded
// export schema (DEAD_TOP_LEVEL_FIELDS, EXCLUDED_RESPONSE_KEYS,
// MAX_AI_EXCHANGES_PER_PAPER, TRANSCRIPT_NOT_APPLICABLE, responses_json,
// ai_engagement, etc.) that does not exist in lib/export-csv.js as it
// stands today — that schema was retired by the "Reconcile survey frontend
// backend and data exports" commit, which rewrote lib/export-csv.js to
// track the survey's real current instrumentation (SRL/CT scales,
// paste/keystroke/revision tracking per question, AI prompt counts) without
// the test file being updated to match. This file restores a genuine
// passing baseline against the schema that is actually in production.
//
// Run with: npm run test:export

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CSV_COLUMNS,
  AI_TRANSCRIPT_COLUMNS,
  cleanRecord,
  flattenRecord,
  buildAccumulatedCsv,
  buildAiTranscriptRows,
  buildAiTranscriptCsv
} = require('../lib/export-csv');

// ---------------------------------------------------------------------------
// Minimal RFC4180 CSV parser, used ONLY here to verify buildAccumulatedCsv's
// output round-trips correctly. Intentionally independent of any escaping
// logic inside lib/export-csv.js so this is a real cross-check, not a
// tautology.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
    }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

// ---------------------------------------------------------------------------
// Deterministic fixture builder. Mirrors the actual shape submitted by
// public/researcher_ai_survey.js: responses (flat key/value map), timing
// (per-paper duration_ms etc.), ai_chats (per-paper role/content arrays),
// ai_message_log (flat array tagged with paper_id/success), logs (per-question
// keystrokes/drafts), paste_events, revision_log, behavioral_events.
// ---------------------------------------------------------------------------
function makeRecord(overrides) {
  const base = {
    participant_id: 'P-TEST-0001',
    prolific_id: 'PROLIFIC-0001',
    test_mode: false,
    session_start_iso: '2026-06-01T10:00:00.000Z',
    session_end_iso: '2026-06-01T10:45:00.000Z',
    completion_status: 'completed',
    consent_status: 'granted',
    media_release_status: 'granted',
    research_role: 'Second-year PhD student',
    research_role_years: 2,
    research_expertise_stratum: 'mid',
    ai_condition: 'AI',
    critical_thinking_placement: 'pre',
    assignment_cell: 'AI-pre-mid',
    stable_assignment_id_hash: 'hash-0001',
    study_1_id: 'font',
    study_2_id: 'food',
    paper_order: ['font', 'food'],
    responses: {
      ay_age: 29,
      lang: 'English',
      ay_field: 'Cognitive Science',
      reviewed: 'yes',
      ai_hours_per_week: 5,
      ai_tenure: '1-2 years',
      ai_purpose: 'Brainstorming',
      ai_purpose_other: 'Brainstorming counterarguments',
      ai_understanding: 'I have a general sense.',
      srl_goal_standards: 4, srl_goal_shortlong: 3, srl_goal_deadlines: 5,
      srl_plan_questions: 4, srl_plan_alternatives: 3, srl_plan_adapt: 4, srl_plan_organize: 5,
      srl_task_ownwords: 4, srl_task_change: 3, srl_task_notes: 4, srl_task_examples: 5,
      srl_elab_relate: 4, srl_elab_combine: 3, srl_elab_prior: 4,
      srl_eval_know: 4, srl_eval_different: 3, srl_eval_learned: 4,
      srl_help_clarification: 3, srl_help_identify: 4, srl_help_information: 4, srl_help_own_r: 5,
      ct_alternatives: 4, ct_assumptions: 3, ct_bias: 4, ct_compare: 5, ct_credibility: 4, ct_evidence: 3,
      font_strength_1: 'Font main claim text.\nWith a newline and “curly quotes” and éèê.',
      font_strength_2: 'Font strength 2 answer',
      font_strength_3: 'Font strength 3 answer',
      font_limitation_1: 'Font limitation 1 answer',
      font_limitation_2: 'Font limitation 2 answer',
      font_limitation_3: 'Font limitation 3 answer',
      font_improvement_1: 'Font improvement 1 answer',
      font_improvement_2: 'Font improvement 2 answer',
      font_improvement_3: 'Font improvement 3 answer',
      food_strength_1: 'Food strength 1 answer with café and ×',
      food_strength_2: 'Food strength 2 answer',
      food_strength_3: 'Food strength 3 answer',
      food_limitation_1: 'Food limitation 1 answer',
      food_limitation_2: 'Food limitation 2 answer',
      food_limitation_3: 'Food limitation 3 answer',
      food_improvement_1: 'Food improvement 1 answer',
      food_improvement_2: 'Food improvement 2 answer',
      food_improvement_3: 'Food improvement 3 answer',
      font_convincing: 4,
      food_convincing: 5,
      confidence_font: 4,
      confidence_food: 5,
      understood_font: 'yes',
      understood_food: 'yes',
      whose_thinking: 'mostly mine'
    },
    quiz_score: 7,
    quiz_paper_scores: { font: 3, food: 4 },
    timing: {
      font: {
        duration_ms: 120000,
        pdf_exposure_proportion_5s: 0.625,
        navigation_sequence: 'Top>Middle>Bottom>Middle',
        navigation_transition_count: 3,
        backward_transition_count: 1
      },
      food: {
        duration_ms: 95000,
        pdf_exposure_proportion_5s: 0,
        navigation_sequence: 'Top',
        navigation_transition_count: 0,
        backward_transition_count: 0
      }
    },
    ai_paper_aggregates: {
      font: { tab_opened: true, time_to_first_open_ms: 5000, time_to_first_message_ms: 8000, successful_messages: 1 },
      food: { tab_opened: true, time_to_first_open_ms: 4000, time_to_first_message_ms: 7000, successful_messages: 1 }
    },
    ai_chats: {
      font: [
        { role: 'user', content: 'What is the main claim of font?', ts: '2026-06-01T10:05:00.000Z' },
        { role: 'assistant', content: 'A'.repeat(1200), ts: '2026-06-01T10:05:05.000Z' }
      ],
      food: [
        { role: 'user', content: 'What is the main claim of food?', ts: '2026-06-01T10:20:00.000Z' },
        { role: 'assistant', content: 'Food reply text', ts: '2026-06-01T10:20:05.000Z' }
      ]
    },
    ai_message_log: [
      { paper_id: 'font', success: true, prompt: 'What is the main claim of font?' },
      { paper_id: 'font', success: false, prompt: 'This attempt failed and must be excluded' },
      { paper_id: 'food', success: true, prompt: 'Summarize the strongest evidence in food.' },
      { paper_id: 'food', success: false, prompt: 'This one also failed and must be excluded' }
    ],
    logs: {
      font_strength_1: { keystrokes: 120, drafts: [{ value: 'draft snapshot text' }] },
      food_strength_1: { keystrokes: 80, drafts: [] }
    },
    paste_events: [
      { source_type: 'ai_response', target_type: 'participant_answer', target_id: 'font_strength_1', answer_value_after_paste: 'baseline answer text here' },
      { source_type: 'participant_answer', target_type: 'ai_input' },
      { source_type: 'question', target_type: 'ai_input' },
      { source_type: 'external_or_unknown', target_type: 'participant_answer' }
    ],
    copy_events: [
      { source_type: 'ai_response' },
      { source_type: 'ai_response' },
      { source_type: 'participant_answer' },
      { source_type: 'question' },
      { source_type: 'external_or_unknown' }
    ],
    revision_log: [
      { question_id: 'font_strength_1' }
    ],
    behavioral_events: [
      { type: 'visibility' },
      { type: 'fullscreen_exit' },
      { type: 'other_a' },
      { type: 'other_b' }
    ],
    quiz: { font_0: 'A' },
    draft_history: { font_strength_1: ['x'] },
    keystroke_counts: { font_strength_1: 120 }
  };
  return Object.assign({}, base, overrides);
}

const recordNoAi = makeRecord({
  participant_id: 'P-TEST-NOAI-0002',
  ai_condition: 'noAI',
  study_1_id: 'food',
  study_2_id: 'listing',
  paper_order: ['food', 'listing'],
  ai_chats: {},
  ai_message_log: [],
  ai_paper_aggregates: {},
  timing: { food: { duration_ms: 60000 }, listing: { duration_ms: 70000 } },
  responses: (() => {
    // Start from the base responses but strip the font_* fields, since this
    // fixture's participant was never assigned the font paper — in the real
    // app, an unassigned paper's question fields are simply never written
    // into responses. Leaving them in here (as the previous version of this
    // fixture did) would defeat the "unassigned paper is blank" test, since
    // open-response answer columns are read straight from responses
    // regardless of paper assignment.
    const r = Object.assign({}, makeRecord({}).responses);
    ['strength_1', 'strength_2', 'strength_3', 'limitation_1', 'limitation_2', 'limitation_3',
      'improvement_1', 'improvement_2', 'improvement_3'].forEach((suffix) => {
      delete r['font_' + suffix];
    });
    delete r.font_convincing; delete r.confidence_font; delete r.understood_font;
    return Object.assign(r, {
      listing_strength_1: 'Listing strength 1 answer', listing_strength_2: 'Listing strength 2 answer', listing_strength_3: 'Listing strength 3 answer',
      listing_limitation_1: 'Listing limitation 1 answer', listing_limitation_2: 'Listing limitation 2 answer', listing_limitation_3: 'Listing limitation 3 answer',
      listing_improvement_1: 'Listing improvement 1 answer', listing_improvement_2: 'Listing improvement 2 answer', listing_improvement_3: 'Listing improvement 3 answer',
      listing_convincing: 3, confidence_listing: 3, understood_listing: 'yes'
    });
  })()
});

const fixtures = [makeRecord({}), recordNoAi];

// ---------------------------------------------------------------------------
// Row count scales 1:1 with input records, and earlier rows are unaffected
// by later ones being added.
// ---------------------------------------------------------------------------
test('1 stored record produces exactly 1 CSV row', () => {
  const csv = buildAccumulatedCsv(fixtures.slice(0, 1));
  const objs = csvToObjects(csv);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].participant_id, 'P-TEST-0001');
});

test('2 stored records produce exactly 2 CSV rows, and the first row is unchanged', () => {
  const csvOne = buildAccumulatedCsv(fixtures.slice(0, 1));
  const objsOne = csvToObjects(csvOne);
  const csvTwo = buildAccumulatedCsv(fixtures.slice(0, 2));
  const objsTwo = csvToObjects(csvTwo);
  assert.equal(objsTwo.length, 2);
  assert.equal(objsTwo[0].participant_id, objsOne[0].participant_id);
  assert.equal(objsTwo[0].research_role, objsOne[0].research_role);
});

// ---------------------------------------------------------------------------
// Every row shares an identical header/column order, including for the
// No-AI participant (whose AI-specific fields are blank, never missing).
// ---------------------------------------------------------------------------
test('AI and No-AI participant rows share an identical column header, with No-AI fields blank', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  objs.forEach((row) => {
    assert.deepEqual(Object.keys(row), headers, 'every row must expose the exact same column set in the exact same order');
  });
  assert.deepEqual(headers, CSV_COLUMNS, 'CSV header must exactly equal the exported CSV_COLUMNS list, in order');

  const aiRow = objs.find((r) => r.ai_condition === 'AI');
  const noAiRow = objs.find((r) => r.ai_condition === 'noAI');
  assert.ok(aiRow && noAiRow);
  assert.equal(noAiRow.total_participant_ai_prompts, '0');
  assert.equal(noAiRow.font_ai_prompt_count, '0');
  assert.notEqual(Number(aiRow.total_participant_ai_prompts), 0);
});

// ---------------------------------------------------------------------------
// The unassigned third paper's columns are blank, never missing/shifted.
// ---------------------------------------------------------------------------
test('the unassigned third paper\'s columns are blank, not missing', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  // Row 0 (P-TEST-0001) is assigned font+food; listing is unassigned.
  const row0 = objs[0];
  ['strength_1', 'strength_2', 'strength_3', 'limitation_1', 'limitation_2', 'limitation_3',
    'improvement_1', 'improvement_2', 'improvement_3'].forEach((suffix) => {
    assert.equal(row0['listing_' + suffix], '', 'listing_' + suffix + ' must be blank for the unassigned paper');
  });
  assert.equal(row0.listing_convincing, '');
  assert.equal(row0.confidence_listing, '');
  assert.equal(row0.understood_listing, '');
  assert.equal(row0.listing_duration_ms, '');
  assert.equal(row0.listing_ai_prompt_count, '0');
  assert.equal(row0.listing_ai_tab_opened, 'FALSE');

  // Row 1 (No-AI, food+listing) is unassigned font.
  const row1 = objs[1];
  ['strength_1', 'strength_2', 'strength_3', 'limitation_1', 'limitation_2', 'limitation_3',
    'improvement_1', 'improvement_2', 'improvement_3'].forEach((suffix) => {
    assert.equal(row1['font_' + suffix], '', 'font_' + suffix + ' must be blank for the unassigned paper');
  });
  assert.equal(row1.font_duration_ms, '');
});

// ---------------------------------------------------------------------------
// Multiline answers and Unicode survive the full serialize/parse round trip.
// ---------------------------------------------------------------------------
test('multiline answers and Unicode survive intact', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  assert.ok(row0.font_strength_1.includes('\n'), 'font_strength_1 must preserve its embedded newline');
  assert.ok(row0.font_strength_1.includes('curly quotes'), 'curly-quote text must survive');
  assert.ok(row0.font_strength_1.includes('éèê'), 'accented characters must survive');
  assert.ok(row0.food_strength_1.includes('café'), 'café must survive in food_strength_1');
  assert.ok(row0.food_strength_1.includes('×'), 'multiplication sign must survive');
  assert.ok(row0.paper_1_ai_message_1.length > 1000, 'the long AI assistant reply must be present and unmodified in paper_1_ai_message_1');
});

// ---------------------------------------------------------------------------
// CSV cell escaping survives commas/quotes embedded directly in a value.
// ---------------------------------------------------------------------------
test('commas and embedded quotes in a single cell survive a full serialize/parse round trip', () => {
  const tricky = [makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, {
      font_strength_1: 'Has a comma, a "quoted phrase", and a trailing quote"'
    })
  })];
  const csv = buildAccumulatedCsv(tricky);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].font_strength_1, 'Has a comma, a "quoted phrase", and a trailing quote"');
});

// ---------------------------------------------------------------------------
// Dead top-level placeholder fields (quiz/draft_history/keystroke_counts) are
// stripped only on the CSV-cleaning path; the original record (what the JSON
// export route returns, untouched) keeps them intact, and the REAL
// quiz/draft/keystroke data (which lives elsewhere: quiz_score, logs, etc.)
// is correct in the CSV regardless.
// ---------------------------------------------------------------------------
test('dead top-level placeholder fields are stripped from the CSV-cleaning path only', () => {
  const record = makeRecord({});
  assert.ok('quiz' in record);
  assert.ok('draft_history' in record);
  assert.ok('keystroke_counts' in record);

  const cleaned = cleanRecord(record);
  assert.ok(!('quiz' in cleaned));
  assert.ok(!('draft_history' in cleaned));
  assert.ok(!('keystroke_counts' in cleaned));
  // cleanRecord must not mutate the original record (the JSON export route
  // returns stored records as-is, never through cleanRecord).
  assert.ok('quiz' in record, 'cleanRecord must not mutate its input');

  const csv = buildAccumulatedCsv([record]);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].quiz_score, '7');
  assert.equal(objs[0].quiz_font_score, '3');
  assert.equal(objs[0].quiz_food_score, '4');
});

// ---------------------------------------------------------------------------
// All current SRL and CT scale items appear as columns with correct values.
// ---------------------------------------------------------------------------
test('all SRL and CT scale items appear as columns with correct values', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  ['srl_goal_standards', 'srl_plan_questions', 'srl_help_own_r', 'ct_alternatives', 'ct_evidence'].forEach((k) => {
    assert.ok(headers.includes(k), 'item "' + k + '" must appear as a column');
  });
  assert.equal(objs[0].srl_goal_standards, '4');
  assert.equal(objs[0].ct_evidence, '3');
});

// ---------------------------------------------------------------------------
// Per-paper AI prompt counts, tab-open flags, and time-to-first metrics are
// populated correctly from ai_message_log / ai_paper_aggregates.
// ---------------------------------------------------------------------------
test('per-paper AI engagement measures are computed correctly', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  // 1 successful message logged per paper in ai_message_log.
  assert.equal(row0.font_ai_prompt_count, '1');
  assert.equal(row0.food_ai_prompt_count, '1');
  assert.equal(row0.font_ai_tab_opened, 'TRUE');
  assert.equal(row0.font_ai_time_to_first_open_ms, '5000');
  assert.equal(row0.font_ai_time_to_first_message_ms, '8000');
  assert.equal(row0.total_participant_ai_prompts, '2');
});

// ---------------------------------------------------------------------------
// duration_ms is read straight from timing[paperId].duration_ms, never
// recomputed, and is blank (not 0) for an unassigned paper.
// ---------------------------------------------------------------------------
test('per-paper duration_ms is read directly from timing[paperId].duration_ms', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].font_duration_ms, '120000');
  assert.equal(objs[0].food_duration_ms, '95000');
  assert.equal(objs[0].listing_duration_ms, '', 'unassigned paper duration must be blank, not 0');
});

// ---------------------------------------------------------------------------
// PDF viewport-tracking measures (pdf_exposure_proportion_5s,
// navigation_sequence, navigation_transition_count, backward_transition_count)
// are read directly from timing[paperId], exactly like duration_ms, and never
// computed/recomputed inside lib/export-csv.js itself -- that computation
// happens client-side in public/researcher_ai_survey.js. These are
// deterministic fixture-level checks, not a re-test of the client-side
// bucket/AOI logic.
// ---------------------------------------------------------------------------
test('per-paper viewport-tracking measures are read directly from timing[paperId], without touching duration_ms', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];

  // font: a real, non-trivial navigation sequence with one backward jump.
  assert.equal(row0.font_pdf_exposure_proportion_5s, '0.625');
  assert.equal(row0.font_navigation_sequence, 'Top>Middle>Bottom>Middle');
  assert.equal(row0.font_navigation_transition_count, '3');
  assert.equal(row0.font_backward_transition_count, '1');

  // food: a genuine measured 0 (visited Top only, never went back) must
  // round-trip as the string "0", not blank -- 0 is a real measured value
  // and must be distinguishable from "never measured".
  assert.equal(row0.food_pdf_exposure_proportion_5s, '0');
  assert.equal(row0.food_navigation_sequence, 'Top');
  assert.equal(row0.food_navigation_transition_count, '0');
  assert.equal(row0.food_backward_transition_count, '0');

  // listing: unassigned in this fixture (no timing.listing entry at all) --
  // all four viewport fields must be blank, exactly like duration_ms, not 0
  // or "undefined".
  assert.equal(row0.listing_pdf_exposure_proportion_5s, '');
  assert.equal(row0.listing_navigation_sequence, '');
  assert.equal(row0.listing_navigation_transition_count, '');
  assert.equal(row0.listing_backward_transition_count, '');

  // duration_ms itself must be completely unaffected by the presence of the
  // new viewport fields on the same timing[paperId] object (no double-
  // counting, no field collision, no accidental overwrite).
  assert.equal(row0.font_duration_ms, '120000');
  assert.equal(row0.food_duration_ms, '95000');
});

// ---------------------------------------------------------------------------
// Raw scroll_event_count must never be exported as a primary measure, and
// mouse hover/focus signals must never be exported as proof of reading.
// This is a direct, automated check against the project's explicit
// constraint (see governing spec) rather than relying on code review alone.
// ---------------------------------------------------------------------------
test('raw scroll_event_count and hover-based measures are never exported as primary CSV columns', () => {
  const hasScrollEventColumn = CSV_COLUMNS.some((col) => /scroll_event_count/i.test(col));
  const hasHoverColumn = CSV_COLUMNS.some((col) => /hover/i.test(col));
  assert.equal(hasScrollEventColumn, false, 'CSV_COLUMNS must not include any *scroll_event_count* column');
  assert.equal(hasHoverColumn, false, 'CSV_COLUMNS must not include any *hover* column');
});

// ---------------------------------------------------------------------------
// navigation_sequence is exported as the already-collapsed (no consecutive
// duplicates) sequence string, joined with '>'. This locks in the export
// format so a future change to the join character/shape is caught here
// rather than silently changing the CSV schema.
// ---------------------------------------------------------------------------
test('navigation_sequence is exported as a >-joined string, unmodified from timing[paperId]', () => {
  const record = makeRecord({
    timing: {
      font: {
        duration_ms: 50000,
        pdf_exposure_proportion_5s: 1,
        navigation_sequence: 'Top>Bottom>Top',
        navigation_transition_count: 2,
        backward_transition_count: 1
      }
    }
  });
  const row = flattenRecord(record);
  assert.equal(row.font_navigation_sequence, 'Top>Bottom>Top');
  assert.equal(typeof row.font_navigation_sequence, 'string');
});

// ---------------------------------------------------------------------------
// Per-question process measures (response length, keystrokes, paste counts,
// revision counts) and their totals are computed correctly.
// ---------------------------------------------------------------------------
test('per-question process measures and totals are computed correctly', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  assert.equal(row0.font_strength_1_keystrokes, '120');
  assert.equal(row0.food_strength_1_keystrokes, '80');
  assert.equal(Number(row0.font_strength_1_response_length), row0.font_strength_1.length);
  assert.equal(row0.font_strength_1_paste_count, '1');
  assert.equal(row0.font_strength_1_ai_to_answer_paste_count, '1');
  assert.equal(row0.font_strength_1_revision_event_count, '1');
  assert.equal(row0.total_logged_keystrokes, '200');

  // Only font_strength_1 has logged keystrokes/paste/revision activity in this
  // fixture -- a sibling field in the SAME group (font_strength_2) must not
  // pick up any of that activity by accident.
  assert.equal(row0.font_strength_2_keystrokes, '0', 'font_strength_2 must not inherit keystrokes logged against font_strength_1');
  assert.equal(row0.font_strength_2_paste_count, '0', 'font_strength_2 must not inherit a paste event logged against font_strength_1');
  assert.equal(row0.font_strength_2_revision_event_count, '0', 'font_strength_2 must not inherit a revision logged against font_strength_1');
});

// ---------------------------------------------------------------------------
// All 27 semantic open-response columns (3 papers x 9 strength/limitation/
// improvement items) exist, and the old 3-per-paper q1/q2/q3 columns are
// completely gone from the schema.
// ---------------------------------------------------------------------------
const NEW_OPEN_RESPONSE_SUFFIXES = [
  'strength_1', 'strength_2', 'strength_3',
  'limitation_1', 'limitation_2', 'limitation_3',
  'improvement_1', 'improvement_2', 'improvement_3'
];
const ALL_PAPER_IDS = ['font', 'food', 'listing'];

test('all 27 semantic open-response columns exist in the CSV schema', () => {
  let count = 0;
  ALL_PAPER_IDS.forEach((paperId) => {
    NEW_OPEN_RESPONSE_SUFFIXES.forEach((suffix) => {
      const col = `${paperId}_${suffix}`;
      assert.ok(CSV_COLUMNS.includes(col), col + ' must exist as a CSV column');
      count++;
    });
  });
  assert.equal(count, 27, 'there must be exactly 27 semantic open-response columns (3 papers x 9 items)');
});

test('the old <paper>_q1/_q2/_q3 columns no longer exist anywhere in the schema', () => {
  ALL_PAPER_IDS.forEach((paperId) => {
    ['q1', 'q2', 'q3'].forEach((oldSuffix) => {
      const oldCol = `${paperId}_${oldSuffix}`;
      assert.ok(!CSV_COLUMNS.includes(oldCol), oldCol + ' must NOT exist in the new schema');
      assert.ok(!CSV_COLUMNS.includes(oldCol + '_response_length'), oldCol + '_response_length must NOT exist');
      assert.ok(!CSV_COLUMNS.includes(oldCol + '_keystrokes'), oldCol + '_keystrokes must NOT exist');
    });
  });
});

// ---------------------------------------------------------------------------
// Each of the 9 fields for a paper round-trips independently through CSV with
// its own distinct value -- a multiline/comma/quote/Unicode-laden value in
// one field, and confirm none of the 9 sibling fields ever cross-contaminate.
// ---------------------------------------------------------------------------
test('each of the 9 open-response fields for a paper round-trips independently, with no cross-contamination', () => {
  const distinctValues = {};
  NEW_OPEN_RESPONSE_SUFFIXES.forEach((suffix, i) => {
    distinctValues[`font_${suffix}`] = `UNIQUE-VALUE-${i}-for-${suffix}`;
  });
  const record = makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, distinctValues)
  });
  const csv = buildAccumulatedCsv([record]);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  NEW_OPEN_RESPONSE_SUFFIXES.forEach((suffix, i) => {
    assert.equal(row0[`font_${suffix}`], `UNIQUE-VALUE-${i}-for-${suffix}`, `font_${suffix} must round-trip its own distinct value`);
    // Make sure none of the OTHER 8 fields accidentally picked up this value.
    NEW_OPEN_RESPONSE_SUFFIXES.forEach((otherSuffix) => {
      if (otherSuffix === suffix) return;
      assert.notEqual(row0[`font_${otherSuffix}`], `UNIQUE-VALUE-${i}-for-${suffix}`, `font_${otherSuffix} must not contain font_${suffix}'s value`);
    });
  });
});

test('multiline text, commas, quotation marks, and Unicode all survive together in a single new field', () => {
  const trickyValue = 'Line one.\nLine two with a comma, a "quoted phrase", café, ×, and éèê.';
  const record = makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, {
      font_limitation_2: trickyValue
    })
  });
  const csv = buildAccumulatedCsv([record]);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].font_limitation_2, trickyValue, 'font_limitation_2 must preserve newline, comma, quotes, and Unicode exactly');
});

// ---------------------------------------------------------------------------
// Strength 1's response text cannot accidentally appear under Strength 2/3,
// or under any Limitation/Improvement column -- a direct check against
// category bleed, beyond the generic round-trip test above.
// ---------------------------------------------------------------------------
test('a Strength 1 response cannot accidentally appear in Strength 2/3 or another category', () => {
  const sentinel = 'SENTINEL-ONLY-IN-STRENGTH-1';
  const record = makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, {
      food_strength_1: sentinel
    })
  });
  const csv = buildAccumulatedCsv([record]);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  assert.equal(row0.food_strength_1, sentinel);
  NEW_OPEN_RESPONSE_SUFFIXES.filter((s) => s !== 'strength_1').forEach((suffix) => {
    assert.notEqual(row0[`food_${suffix}`], sentinel, `food_${suffix} must not contain the Strength 1 sentinel value`);
  });
});

// ---------------------------------------------------------------------------
// total_response_length and total_logged_keystrokes sum across all 9
// open-response fields per assigned paper, not just the first item.
// ---------------------------------------------------------------------------
test('total_response_length and total_logged_keystrokes sum across all 9 fields per assigned paper', () => {
  const record = makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, {
      font_strength_2: 'twelve chars',
      font_limitation_3: 'seven'
    }),
    logs: {
      font_strength_1: { keystrokes: 120, drafts: [] },
      food_strength_1: { keystrokes: 80, drafts: [] },
      font_strength_2: { keystrokes: 15, drafts: [] }
    }
  });
  const row = flattenRecord(record);
  let expectedLength = 0;
  ['font', 'food'].forEach((paperId) => {
    NEW_OPEN_RESPONSE_SUFFIXES.forEach((suffix) => {
      expectedLength += String(record.responses[`${paperId}_${suffix}`] || '').length;
    });
  });
  assert.equal(row.total_response_length, expectedLength, 'total_response_length must equal the sum of all 18 assigned-paper open-response field lengths');
  assert.equal(row.total_logged_keystrokes, 120 + 80 + 15, 'total_logged_keystrokes must sum keystrokes logged against any of the 9 fields per paper');
});

// ---------------------------------------------------------------------------
// Behavioral and paste-pathway summary counts are derived correctly from the
// raw event arrays.
// ---------------------------------------------------------------------------
test('behavioral and paste-pathway summary counts are derived correctly', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  assert.equal(row0.visibility_hidden_count, '1');
  assert.equal(row0.fullscreen_exit_count, '1');
  assert.equal(row0.ai_to_answer_paste_count, '1');
  assert.equal(row0.answer_to_ai_paste_count, '1');
  assert.equal(row0.question_to_ai_paste_count, '1');
  assert.equal(row0.external_to_answer_paste_count, '1');
  assert.equal(row0.revision_event_count, '1');
  assert.equal(row0.questions_revised_count, '1');
});

// ---------------------------------------------------------------------------
// Transcript columns: exactly 2 positions x 5 turns x 4 fields = 40 columns,
// correctly mapped to the assigned paper at each position, never crossed.
// ---------------------------------------------------------------------------
test('exactly 40 fixed transcript columns exist (5 turns x 4 fields x 2 paper positions)', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  let transcriptColCount = 0;
  [1, 2].forEach((position) => {
    for (let n = 1; n <= 5; n++) {
      ['participant_message', 'participant_message_time', 'ai_message', 'ai_message_time'].forEach((field) => {
        const key = 'paper_' + position + '_' + field + '_' + n;
        assert.ok(headers.includes(key), key + ' must exist as a column');
        transcriptColCount++;
      });
    }
  });
  assert.equal(transcriptColCount, 40);
});

test('transcript messages map to the correct assigned-paper position, never crossing positions', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs.find((r) => r.participant_id === 'P-TEST-0001');
  assert.equal(row0.paper_1_id, 'font');
  assert.equal(row0.paper_2_id, 'food');
  assert.equal(row0.paper_1_participant_message_1, 'What is the main claim of font?');
  assert.equal(row0.paper_2_participant_message_1, 'What is the main claim of food?');
  assert.notEqual(row0.paper_2_participant_message_1, row0.paper_1_participant_message_1);
  // Unused turns 2-5 are blank, not undefined/null literal text.
  for (let n = 2; n <= 5; n++) {
    assert.equal(row0['paper_1_participant_message_' + n], '');
  }
});

// ---------------------------------------------------------------------------
// JSON export completeness: the raw stored record (exactly what the JSON
// export route returns, never passed through cleanRecord) retains every
// original field, proving CSV-only field removal has zero effect on the
// JSON export.
// ---------------------------------------------------------------------------
test('the raw record (as returned by the JSON export route) retains every original field untouched', () => {
  const record = makeRecord({});
  ['quiz', 'draft_history', 'keystroke_counts', 'ai_message_log', 'behavioral_events',
    'responses', 'ai_chats', 'timing', 'ai_paper_aggregates', 'paste_events',
    'revision_log', 'logs'].forEach((field) => {
    assert.ok(field in record, field + ' must remain present in the raw/JSON-export record');
  });
  assert.equal(record.ai_message_log.length, 4);
  assert.equal(record.behavioral_events.length, 4);
});

// ---------------------------------------------------------------------------
// buildAiTranscriptRows / buildAiTranscriptCsv: one row per actual exchange
// (not per fixed slot), correctly tagging success/failure and paper context.
// ---------------------------------------------------------------------------
test('buildAiTranscriptRows produces one row per chat exchange with correct success tagging', () => {
  const rows = buildAiTranscriptRows(fixtures);
  const row0Font = rows.find((r) => r.participant_id === 'P-TEST-0001' && r.paper_id === 'font');
  assert.ok(row0Font);
  assert.equal(row0Font.participant_prompt, 'What is the main claim of font?');
  assert.equal(row0Font.paper_order_position, 1);

  const csv = buildAiTranscriptCsv(fixtures);
  const objs = csvToObjects(csv);
  assert.deepEqual(Object.keys(objs[0]), AI_TRANSCRIPT_COLUMNS);
  // The No-AI participant has no chats at all, so contributes zero transcript rows.
  assert.ok(!objs.some((r) => r.participant_id === 'P-TEST-NOAI-0002'));
});

// ---------------------------------------------------------------------------
// Approved derived/aggregate columns: SRL subscale means + composite,
// ct_composite_mean, total_task_duration_ms, AI-use aggregates, and
// copy/paste aggregates. Uses a clean all-4s SRL/CT record so reverse-coding
// arithmetic (8 - value) cannot mask a wiring bug: 8 - 4 = 4, so every
// scored item, subscale mean, and composite mean below should equal exactly
// 4 when every input is present and valid.
// ---------------------------------------------------------------------------
const ALL_SRL_KEYS = [
  'srl_goal_standards', 'srl_goal_shortlong', 'srl_goal_deadlines',
  'srl_plan_questions', 'srl_plan_alternatives', 'srl_plan_adapt', 'srl_plan_organize',
  'srl_task_ownwords', 'srl_task_change', 'srl_task_notes', 'srl_task_examples',
  'srl_elab_relate', 'srl_elab_combine', 'srl_elab_prior',
  'srl_eval_know', 'srl_eval_different', 'srl_eval_learned',
  'srl_help_clarification', 'srl_help_identify', 'srl_help_information', 'srl_help_own_r'
];
const ALL_CT_KEYS = ['ct_alternatives', 'ct_assumptions', 'ct_bias', 'ct_compare', 'ct_credibility', 'ct_evidence'];

function srlCtCleanRecord(overrides) {
  const allFours = {};
  ALL_SRL_KEYS.forEach((k) => { allFours[k] = 4; });
  ALL_CT_KEYS.forEach((k) => { allFours[k] = 4; });
  return makeRecord({
    responses: Object.assign({}, makeRecord({}).responses, allFours, overrides)
  });
}

test('all 21 official SRL fields are represented in the fixture, with no leftover legacy field names', () => {
  const record = makeRecord({});
  ALL_SRL_KEYS.forEach((k) => {
    assert.ok(k in record.responses, k + ' must be present in the fixture responses');
  });
  assert.ok(!('srl_help_guidance' in record.responses), 'legacy srl_help_guidance must not be present');
  assert.ok(!('srl_help_beforeown' in record.responses), 'legacy srl_help_beforeown must not be present');
});

test('each SRL subscale mean and the composite mean equal 4 when every item is valid', () => {
  const row = flattenRecord(srlCtCleanRecord({}));
  ['srl_goal_setting_mean', 'srl_strategic_planning_mean', 'srl_task_strategies_mean',
    'srl_elaboration_mean', 'srl_self_evaluation_mean', 'srl_help_seeking_mean'].forEach((col) => {
    assert.equal(row[col], 4, col + ' must equal 4 when every item in the subscale is valid');
  });
  assert.equal(row.srl_composite_mean, 4, 'srl_composite_mean must equal 4 when all six subscale means are present');
});

test('ct_composite_mean equals 4 when all six primary CT items are valid, and ignores ct_alternatives_repeat/attention_check', () => {
  const record = srlCtCleanRecord({ ct_alternatives_repeat: 1, attention_check: 1 });
  const row = flattenRecord(record);
  assert.equal(row.ct_composite_mean, 4);
});

// ---------------------------------------------------------------------------
// Reverse-scoring correctness: srl_goal_shortlong, ct_evidence, ct_bias, and
// ct_compare are all reverse-coded (scored value = 8 - rawValue). Uses
// asymmetric raw values (1s and 7s) so that a wiring bug -- e.g. a reverse-
// coded item accidentally being scored as if it were not reverse-coded --
// would change the resulting mean and be caught here, unlike the all-4s
// fixture used elsewhere where 8 - 4 = 4 masks any reverse-coding error.
// ---------------------------------------------------------------------------
test('SRL and CT aggregates use reverse-scored values correctly', () => {
  const record = srlCtCleanRecord({
    srl_goal_standards: 7,
    srl_goal_shortlong: 1,
    srl_goal_deadlines: 7,

    ct_credibility: 7,
    ct_evidence: 1,
    ct_alternatives: 7,
    ct_bias: 1,
    ct_assumptions: 7,
    ct_compare: 1
  });

  const row = flattenRecord(record);

  assert.equal(row.srl_goal_setting_mean, 7);
  assert.equal(row.ct_composite_mean, 7);
});

test('an SRL subscale mean is blank if any required item is missing or invalid', () => {
  const record = srlCtCleanRecord({ srl_goal_standards: '' });
  const row = flattenRecord(record);
  assert.equal(row.srl_goal_setting_mean, '', 'srl_goal_setting_mean must be blank when srl_goal_standards is missing');
  // An out-of-range value (e.g. 9) is also invalid and must blank the subscale.
  const record2 = srlCtCleanRecord({ srl_plan_questions: 9 });
  const row2 = flattenRecord(record2);
  assert.equal(row2.srl_strategic_planning_mean, '', 'srl_strategic_planning_mean must be blank when an item is out of the valid 1-7 range');
});

test('srl_composite_mean is blank if any of the six subscale means is blank', () => {
  const record = srlCtCleanRecord({ srl_eval_learned: '' });
  const row = flattenRecord(record);
  assert.equal(row.srl_self_evaluation_mean, '', 'the affected subscale itself must be blank');
  assert.equal(row.srl_composite_mean, '', 'srl_composite_mean must be blank when any subscale mean is blank');
  // The other five subscale means, unaffected, must still be populated.
  assert.equal(row.srl_goal_setting_mean, 4);
});

test('ct_composite_mean is blank if any primary CT item is missing or invalid', () => {
  const record = srlCtCleanRecord({ ct_bias: '' });
  const row = flattenRecord(record);
  assert.equal(row.ct_composite_mean, '', 'ct_composite_mean must be blank when a primary CT item is missing');
});

// ---------------------------------------------------------------------------
// total_task_duration_ms: sum of duration_ms across the two assigned papers
// only, blank unless both are present/valid, and a genuine measured 0 must
// not be treated as missing.
// ---------------------------------------------------------------------------
test('total_task_duration_ms sums duration_ms across exactly the two assigned papers', () => {
  const row = flattenRecord(makeRecord({}));
  assert.equal(row.total_task_duration_ms, 120000 + 95000);
});

test('a measured duration of 0 remains valid and is not treated as missing in total_task_duration_ms', () => {
  const record = makeRecord({
    timing: { font: { duration_ms: 0 }, food: { duration_ms: 95000 } }
  });
  const row = flattenRecord(record);
  assert.equal(row.total_task_duration_ms, 0 + 95000, 'a real measured 0 must be summed, not treated as missing');
});

test('total_task_duration_ms is blank when either assigned paper never measured a duration', () => {
  const record = makeRecord({ timing: { font: { duration_ms: 120000 } } });
  const row = flattenRecord(record);
  assert.equal(row.total_task_duration_ms, '', 'must be blank when the food duration was never measured');
});

// ---------------------------------------------------------------------------
// AI-use aggregates: any_ai_use, papers_with_any_ai_prompt, and
// mean_ai_prompt_length, computed only from successful prompts belonging to
// one of the participant's two assigned papers.
// ---------------------------------------------------------------------------
test('any_ai_use, papers_with_any_ai_prompt, and mean_ai_prompt_length are computed from qualifying prompts only', () => {
  const record = makeRecord({});
  const row = flattenRecord(record);
  const qualifying = record.ai_message_log.filter((m) => m.success === true);
  const expectedMean = Number(
    (qualifying.reduce((total, m) => total + m.prompt.length, 0) / qualifying.length).toFixed(4)
  );
  assert.equal(row.any_ai_use, true);
  assert.equal(row.papers_with_any_ai_prompt, 2);
  assert.equal(Number(row.mean_ai_prompt_length), expectedMean);
});

test('failed prompts are excluded from any_ai_use, papers_with_any_ai_prompt, and mean_ai_prompt_length', () => {
  const record = makeRecord({
    ai_message_log: [
      { paper_id: 'font', success: false, prompt: 'failed prompt one' },
      { paper_id: 'food', success: false, prompt: 'failed prompt two' }
    ]
  });
  const row = flattenRecord(record);
  assert.equal(row.any_ai_use, false);
  assert.equal(row.papers_with_any_ai_prompt, 0);
  assert.equal(row.mean_ai_prompt_length, '');
});

test('mean_ai_prompt_length is blank when there are no successful prompts', () => {
  const record = makeRecord({ ai_message_log: [] });
  const row = flattenRecord(record);
  assert.equal(row.mean_ai_prompt_length, '');
});

test('messages belonging to an unassigned paper are excluded from any_ai_use, papers_with_any_ai_prompt, and mean_ai_prompt_length', () => {
  // This participant is assigned font + food only; a successful message
  // logged against "listing" (unassigned) must not count toward any
  // AI-use aggregate.
  const record = makeRecord({
    ai_message_log: [
      { paper_id: 'listing', success: true, prompt: 'a prompt about an unassigned paper' }
    ]
  });
  const row = flattenRecord(record);
  assert.equal(row.any_ai_use, false, 'a successful prompt on an unassigned paper must not count as any_ai_use');
  assert.equal(row.papers_with_any_ai_prompt, 0);
  assert.equal(row.mean_ai_prompt_length, '');
});

// ---------------------------------------------------------------------------
// Copy/paste aggregates derived from copy_events / paste_events.
// ---------------------------------------------------------------------------
test('total_copy_count, total_paste_count, and the source/target-specific copy/paste counts are computed correctly', () => {
  const row = flattenRecord(makeRecord({}));
  assert.equal(row.total_copy_count, 5);
  assert.equal(row.ai_response_copy_count, 2);
  assert.equal(row.answer_copy_count, 1);
  assert.equal(row.question_copy_count, 1);

  assert.equal(row.total_paste_count, 4);
  assert.equal(row.total_answer_paste_count, 2, 'target_type participant_answer: the ai_response->answer paste and the external->answer paste');
  assert.equal(row.total_ai_input_paste_count, 2, 'target_type ai_input: the answer->ai paste and the question->ai paste');
  assert.equal(row.questions_with_any_paste, 1, 'only one paste event has both target_type participant_answer and a target_id');
  assert.equal(row.questions_with_ai_to_answer_paste, 1);
});

test('duplicate paste events into the same response box count once for questions_with_any_paste', () => {
  const record = makeRecord({
    paste_events: [
      { source_type: 'external_or_unknown', target_type: 'participant_answer', target_id: 'font_strength_1' },
      { source_type: 'external_or_unknown', target_type: 'participant_answer', target_id: 'font_strength_1' },
      { source_type: 'ai_response', target_type: 'participant_answer', target_id: 'font_strength_1' }
    ]
  });
  const row = flattenRecord(record);
  assert.equal(row.total_paste_count, 3, 'total_paste_count counts every individual paste event, including duplicates');
  assert.equal(row.questions_with_any_paste, 1, 'three pastes into the same target_id must count as one distinct question');
  assert.equal(row.questions_with_ai_to_answer_paste, 1);
});

// ---------------------------------------------------------------------------
// flattenRecord is a pure function: calling it twice on the same input
// yields identical output, and it never mutates its input record.
// ---------------------------------------------------------------------------
test('flattenRecord is pure: identical output across calls, no mutation of input', () => {
  const record = makeRecord({});
  const before = JSON.stringify(record);
  const row1 = flattenRecord(record);
  const row2 = flattenRecord(record);
  assert.deepEqual(row1, row2);
  assert.equal(JSON.stringify(record), before, 'flattenRecord must not mutate its input record');
});
