// test/export.test.js — Local export tests against saved JSON/JSONL
// fixtures only. Deliberately makes ZERO network calls and NEVER touches
// /api/chat, OpenAI, GCS, or Firestore — it requires lib/export-csv.js
// directly and feeds it fixture records read from disk.
//
// Run with: npm run test:export

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildAccumulatedCsv,
  cleanRecord,
  DEAD_TOP_LEVEL_FIELDS,
  EXCLUDED_RESPONSE_KEYS,
  MAX_AI_EXCHANGES_PER_PAPER,
  TRANSCRIPT_NOT_APPLICABLE
} = require('../lib/export-csv');

// ---------------------------------------------------------------------------
// Minimal RFC4180 CSV parser, used ONLY here to verify buildAccumulatedCsv's
// output round-trips correctly. Intentionally independent of any escaping
// logic inside lib/export-csv.js so this is a real cross-check, not a
// tautology.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  // Strip a leading UTF-8 BOM if present.
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
  // Trailing field/row (file should end with \r\n, so this is normally empty).
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

function loadFixtureJsonl(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// 6 fixture records: the original 4 conditions (AI/noAI x pre/post), plus
// two added for this revision's tests — see comments at each test below.
const fixtures = loadFixtureJsonl('four-conditions.jsonl');
assert.equal(fixtures.length, 6, 'fixture file must contain exactly 6 records');

function byId(id) {
  const r = fixtures.find((f) => f.participant_id === id);
  assert.ok(r, 'fixture record ' + id + ' must exist');
  return r;
}

// ---------------------------------------------------------------------------
// Point #14: 1 record -> 1 row; 2 records -> 2 rows; 3 -> 3; 4 -> 4. First
// row persists after later ones are added (accumulation never overwrites
// earlier rows).
// ---------------------------------------------------------------------------
test('1 stored record produces exactly 1 CSV row', () => {
  const csv = buildAccumulatedCsv(fixtures.slice(0, 1));
  const objs = csvToObjects(csv);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].participant_id, 'P-TEST-AI-PRE-0001');
});

test('2 stored records produce exactly 2 CSV rows, and the first row is unchanged', () => {
  const csvOne = buildAccumulatedCsv(fixtures.slice(0, 1));
  const objsOne = csvToObjects(csvOne);

  const csvTwo = buildAccumulatedCsv(fixtures.slice(0, 2));
  const objsTwo = csvToObjects(csvTwo);

  assert.equal(objsTwo.length, 2);
  assert.equal(objsTwo[0].participant_id, objsOne[0].participant_id);
  assert.equal(objsTwo[0].research_role, objsOne[0].research_role);
  assert.equal(objsTwo[0].responses_json, objsOne[0].responses_json);
});

test('3 stored records produce exactly 3 CSV rows', () => {
  const csv = buildAccumulatedCsv(fixtures.slice(0, 3));
  const objs = csvToObjects(csv);
  assert.equal(objs.length, 3);
});

test('4 stored records (one per condition) produce exactly 4 CSV rows', () => {
  const csv = buildAccumulatedCsv(fixtures.slice(0, 4));
  const objs = csvToObjects(csv);
  assert.equal(objs.length, 4);
});

// ---------------------------------------------------------------------------
// Point #3: the three large raw-log columns are gone from the CSV.
// ---------------------------------------------------------------------------
test('ai_message_log_json, behavioral_events_json, and raw_record_json are absent from the CSV', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  ['ai_message_log_json', 'behavioral_events_json', 'raw_record_json'].forEach((col) => {
    assert.ok(!headers.includes(col), col + ' must not be a CSV column');
  });
});

// ---------------------------------------------------------------------------
// All retained *_json cells parse as valid JSON.
// ---------------------------------------------------------------------------
test('all nested _json columns parse as valid JSON for every row', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const jsonCols = [
    'paper_order_json', 'ai_purpose_json', 'ai_engagement_json',
    'responses_json', 'copy_events_json', 'paste_events_json',
    'revision_log_json', 'logs_json', 'timing_json', 'violations_json'
  ];
  objs.forEach((row) => {
    jsonCols.forEach((col) => {
      assert.doesNotThrow(() => JSON.parse(row[col]), col + ' must be valid JSON');
    });
  });
});

// ---------------------------------------------------------------------------
// Multiline answers, long AI messages, and Unicode survive the round trip
// (now checked via responses_json + the fixed transcript columns, since
// ai_message_log_json no longer exists as a CSV column).
// ---------------------------------------------------------------------------
test('multiline answers and Unicode survive intact', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0]; // P-TEST-AI-PRE-0001, the "longMultiline" fixture
  assert.ok(row0.font_q1.includes('\n'), 'font_q1 must preserve its embedded newline');
  assert.ok(row0.font_q1.includes('“curly quotes”'), 'curly quotes must survive');
  assert.ok(row0.font_q1.includes('éèê'), 'accented characters must survive');
  assert.ok(row0.font_q1.length > 400, 'the long answer must not be truncated');

  const responses = JSON.parse(row0.responses_json);
  assert.ok(responses.food_q4.includes('café'), 'café must survive inside responses_json');
  assert.ok(responses.food_q3.includes('×'), 'multiplication sign must survive');

  // The long AI assistant reply for paper_1 (font), exchange 1, must survive
  // unmodified in the fixed transcript column.
  assert.ok(row0.paper_1_ai_message_1.length > 1000, 'the long AI assistant reply must be present and unmodified in paper_1_ai_message_1');
});

// ---------------------------------------------------------------------------
// AI and No-AI rows align under the exact same header (no column shifting).
// ---------------------------------------------------------------------------
test('AI and No-AI participant rows share an identical column header, with No-AI fields blank', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  objs.forEach((row) => {
    assert.deepEqual(Object.keys(row), headers, 'every row must expose the exact same column set in the exact same order');
  });

  const aiRow = objs.find((r) => r.ai_condition === 'AI');
  const noAiRow = objs.find((r) => r.ai_condition === 'noAI');
  assert.ok(aiRow && noAiRow, 'fixture must include at least one AI and one No-AI row');

  // No-AI participants never sent AI messages: per-paper AI columns are
  // blank/zero, never missing or column-shifting.
  assert.equal(noAiRow.ai_engagement, '');
  assert.equal(noAiRow.whose_thinking, '');
  assert.equal(noAiRow.total_participant_ai_prompts, '0');
  assert.equal(noAiRow.total_assistant_responses, '0');
  assert.equal(noAiRow.total_successful_ai_messages, '0');
  assert.equal(noAiRow.total_failed_ai_messages, '0');

  // AI participants did engage.
  assert.notEqual(aiRow.ai_engagement, '');
  assert.notEqual(Number(aiRow.total_participant_ai_prompts), 0);
});

// ---------------------------------------------------------------------------
// Point #10 (this revision: updated to "N/A", not blank): a No-AI
// participant's 40 fixed transcript cells are all "N/A", since AI
// interaction was not applicable to their condition at all.
// ---------------------------------------------------------------------------
test('No-AI participants have "N/A" in all 40 transcript cells', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const noAiRow = objs.find((r) => r.participant_id === 'P-TEST-NOAI-PRE-0003');
  assert.ok(noAiRow);
  [1, 2].forEach((position) => {
    for (let n = 1; n <= 5; n++) {
      assert.equal(noAiRow['paper_' + position + '_participant_message_' + n], TRANSCRIPT_NOT_APPLICABLE);
      assert.equal(noAiRow['paper_' + position + '_participant_message_time_' + n], TRANSCRIPT_NOT_APPLICABLE);
      assert.equal(noAiRow['paper_' + position + '_ai_message_' + n], TRANSCRIPT_NOT_APPLICABLE);
      assert.equal(noAiRow['paper_' + position + '_ai_message_time_' + n], TRANSCRIPT_NOT_APPLICABLE);
    }
  });

  // Second No-AI fixture, independently confirmed.
  const noAiRow2 = objs.find((r) => r.participant_id === 'P-TEST-NOAI-POST-0004');
  assert.ok(noAiRow2);
  [1, 2].forEach((position) => {
    for (let n = 1; n <= 5; n++) {
      ['participant_message', 'participant_message_time', 'ai_message', 'ai_message_time'].forEach((field) => {
        assert.equal(noAiRow2['paper_' + position + '_' + field + '_' + n], 'N/A');
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Missing per-paper fields (the third, unassigned paper) are blank, never
// shifting columns.
// ---------------------------------------------------------------------------
test('the unassigned third paper\'s columns are blank, not missing', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  // Row 0 (P-TEST-AI-PRE-0001) was assigned font+food; listing is unassigned.
  const row0 = objs[0];
  assert.equal(row0.listing_q1, '');
  assert.equal(row0.listing_convincing, '');
  assert.equal(row0.confidence_listing, '');
  assert.equal(row0.understood_listing, '');
  assert.equal(row0.listing_study_start_iso, '');
  assert.equal(row0.listing_ai_prompt_count, '0');
  assert.equal(row0.listing_ai_tab_opened, 'false');
});

// ---------------------------------------------------------------------------
// Excluded duplicate/alias columns are absent as standalone columns, but
// their data remains recoverable via responses_json.
// ---------------------------------------------------------------------------
test('excluded alias fields are not standalone columns but remain recoverable', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);

  EXCLUDED_RESPONSE_KEYS.forEach((k) => {
    assert.ok(!headers.includes(k), 'excluded response key "' + k + '" must not be a standalone column');
  });
  assert.ok(!headers.includes('ay_role'), 'ay_role must not be a standalone column (duplicates research_role)');
  assert.ok(headers.includes('research_role'), 'research_role must be present as the canonical role column');

  ['expertise_tier', 'condition', 'ct_scale_placement', 'study_order',
    'assignment_version', 'assignment_id_source', 'paper_order_version',
    'role_locked_to_original', 'test_condition_override', 'test_paper_override_json',
    'assigned_paper_1_id', 'assigned_paper_1_title', 'assigned_paper_2_id', 'assigned_paper_2_title'
  ].forEach((k) => {
    assert.ok(!headers.includes(k), 'dev-only/legacy field "' + k + '" must not be a standalone column');
  });

  // But everything excluded is still recoverable from responses_json.
  const row0 = objs[0];
  const responses = JSON.parse(row0.responses_json);
  assert.equal(responses.ay_role, 'Second-year PhD student');
  assert.equal(responses['rg-ay-lang-specify'], '');
  assert.equal(responses['rg-ai-purpose-specify'], 'Brainstorming counterarguments');
  assert.equal(responses['aiInput-font'], 'unsent draft text');
});

// ---------------------------------------------------------------------------
// Redundant empty top-level quiz/draft_history/keystroke_counts are stripped
// from the cleaned record, while the real quiz/draft/keystroke data remains
// fully intact elsewhere (and, since cleanRecord is CSV-only, even the dead
// fields themselves remain in the original record / JSON export).
// ---------------------------------------------------------------------------
test('dead top-level placeholder fields are stripped from the CSV-cleaning path, but the real underlying data survives', () => {
  const recordWithDeadFields = fixtures[0];
  assert.ok('quiz' in recordWithDeadFields, 'fixture sanity check: source record has the dead field');
  assert.ok('draft_history' in recordWithDeadFields);
  assert.ok('keystroke_counts' in recordWithDeadFields);

  const cleaned = cleanRecord(recordWithDeadFields);
  DEAD_TOP_LEVEL_FIELDS.forEach((k) => {
    assert.ok(!(k in cleaned), 'cleaned record must not contain "' + k + '"');
  });
  // cleanRecord is CSV-only: the original raw record (what the JSON export
  // route returns, unmodified) still has the dead fields untouched.
  DEAD_TOP_LEVEL_FIELDS.forEach((k) => {
    assert.ok(k in recordWithDeadFields, 'cleanRecord must not mutate the original record');
  });

  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);

  // Real quiz data: quiz_score/quiz_total columns + quiz_<paper>_<i> columns.
  assert.equal(objs[0].quiz_score, '7');
  assert.equal(objs[0].quiz_total, '8');
  assert.equal(objs[0].quiz_font_0, 'A');
  assert.equal(objs[0].quiz_food_3, 'A');

  // Real draft/keystroke data: preserved inside logs_json.
  const logs = JSON.parse(objs[0].logs_json);
  assert.equal(logs.font_q1.keystrokes, 120);
  assert.equal(logs.font_q1.drafts.length, 1);
  assert.equal(logs.font_q1.drafts[0].value, 'draft snapshot text');
});

// ---------------------------------------------------------------------------
// All 21 current SRL items appear in the CSV, discovered dynamically (the
// schema builder never hard-codes an expected SRL item count).
// ---------------------------------------------------------------------------
test('all 21 SRL items appear as columns, discovered dynamically from the data', () => {
  const SRL_KEYS = [
    'srl_goal_standards', 'srl_goal_shortlong', 'srl_goal_deadlines',
    'srl_plan_questions', 'srl_plan_alternatives', 'srl_plan_adapt', 'srl_plan_organize',
    'srl_task_ownwords', 'srl_task_change', 'srl_task_notes', 'srl_task_examples',
    'srl_elab_relate', 'srl_elab_combine', 'srl_elab_prior',
    'srl_eval_know', 'srl_eval_different', 'srl_eval_learned',
    'srl_help_identify', 'srl_help_guidance', 'srl_help_beforeown', 'srl_help_own_r'
  ];
  assert.equal(SRL_KEYS.length, 21);

  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  SRL_KEYS.forEach((k) => {
    assert.ok(headers.includes(k), 'SRL item "' + k + '" must appear as a column');
  });

  // Also confirm the schema builder doesn't depend on a fixture having all
  // 21 — feed it a record set with only a handful of SRL keys and a record
  // set with a brand-new, never-before-seen SRL key, and confirm both are
  // picked up automatically without code changes.
  const reduced = [{ responses: { srl_goal_standards: 1, srl_plan_questions: 2 } }];
  const csvReduced = buildAccumulatedCsv(reduced);
  const headersReduced = Object.keys(csvToObjects(csvReduced)[0]);
  assert.ok(headersReduced.includes('srl_goal_standards'));
  assert.ok(headersReduced.includes('srl_plan_questions'));
  assert.ok(!headersReduced.includes('srl_help_own_r'), 'must not invent SRL columns that are not present in the data');

  const withNewItem = [{ responses: { srl_brand_new_future_item: 3 } }];
  const headersNew = Object.keys(csvToObjects(buildAccumulatedCsv(withNewItem))[0]);
  assert.ok(headersNew.includes('srl_brand_new_future_item'), 'a future, never-hard-coded SRL key must still be picked up dynamically');
});

// ---------------------------------------------------------------------------
// ai_understanding: included automatically when it exists; never invented
// when it doesn't.
// ---------------------------------------------------------------------------
test('ai_understanding column appears only when present in the data, and is never invented', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  assert.ok(headers.includes('ai_understanding'), 'ai_understanding must appear since at least one fixture record has it');
  assert.equal(objs[0].ai_understanding, 'I have a general sense. It learns from a lot of text and generates responses.');
  // Record index 1 (P-TEST-AI-POST-0002) does not have ai_understanding in
  // its responses; it must be blank, not absent (same header for all rows).
  assert.equal(objs[1].ai_understanding, '');

  const noneHaveIt = [{ responses: { ay_age: 30 } }];
  const headersNone = Object.keys(csvToObjects(buildAccumulatedCsv(noneHaveIt))[0]);
  assert.ok(!headersNone.includes('ai_understanding'), 'must not invent ai_understanding when no record has it');
});

// ---------------------------------------------------------------------------
// paper_order and paper_order_json both contain the expected order.
// ---------------------------------------------------------------------------
test('paper_order is a readable comma-joined value and paper_order_json is the matching JSON array', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].paper_order, 'font,food');
  assert.deepEqual(JSON.parse(objs[0].paper_order_json), ['font', 'food']);
  assert.equal(objs[1].paper_order, 'food,listing');
  assert.deepEqual(JSON.parse(objs[1].paper_order_json), ['food', 'listing']);
});

// ---------------------------------------------------------------------------
// Point #12: AI message totals correctly separate successful responses from
// failures (paper-level success/failure counts remain correct).
// ---------------------------------------------------------------------------
test('AI message totals correctly separate successful responses from failures', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const aiRow = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  // Fixture: 2 papers x (1 success + 1 failure) = 2 successes, 2 failures, 4 prompts total.
  assert.equal(aiRow.total_participant_ai_prompts, '4');
  assert.equal(aiRow.total_assistant_responses, '2');
  assert.equal(aiRow.total_successful_ai_messages, '2');
  assert.equal(aiRow.total_failed_ai_messages, '2');
  assert.equal(Number(aiRow.total_assistant_responses) + Number(aiRow.total_failed_ai_messages), Number(aiRow.total_participant_ai_prompts));
  assert.equal(aiRow.font_ai_successful_message_count, '1');
  assert.equal(aiRow.font_ai_failed_message_count, '1');
  assert.equal(aiRow.food_ai_successful_message_count, '1');
  assert.equal(aiRow.food_ai_failed_message_count, '1');
});

// ---------------------------------------------------------------------------
// Behavioral/copy/paste/revision derived counts are computed correctly.
// Point #6: behavioral_events_json itself is gone, but every summary count
// derived from it is still correct.
// ---------------------------------------------------------------------------
test('behavioral and paste-pathway summary counts are derived correctly', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs[0];
  assert.equal(row0.behavioral_event_count, '4');
  assert.equal(row0.violation_count, '1');
  assert.equal(row0.focus_count, '1');
  assert.equal(row0.visibility_visible_count, '1');
  assert.equal(row0.visibility_hidden_count, '1');
  assert.equal(row0.fullscreen_enter_count, '1');
  assert.equal(row0.copy_event_count, '1');
  assert.equal(row0.paste_event_count, '4');
  assert.equal(row0.ai_to_answer_paste_count, '1');
  assert.equal(row0.question_to_ai_paste_count, '1');
  assert.equal(row0.external_to_answer_paste_count, '1');
  assert.equal(row0.external_to_ai_paste_count, '1');
  assert.equal(row0.revision_event_count, '1');
  assert.equal(row0.questions_revised_count, '1');
  assert.equal(row0.total_chars_inserted_during_revisions, '30');
  assert.equal(row0.total_chars_deleted_during_revisions, '12');
  assert.equal(row0.total_logged_keystrokes, '200'); // 120 + 80
  assert.equal(row0.questions_with_draft_history, '1');
});

// ---------------------------------------------------------------------------
// CSV cell escaping survives commas/quotes embedded directly in a value
// (independent spot-check beyond the multiline/Unicode test above).
// ---------------------------------------------------------------------------
test('commas and embedded quotes in a single cell survive a full serialize/parse round trip', () => {
  const tricky = [Object.assign({}, fixtures[0], {
    responses: Object.assign({}, fixtures[0].responses, {
      font_q1: 'Has a comma, a "quoted phrase", and a trailing quote"'
    })
  })];
  const csv = buildAccumulatedCsv(tricky);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].font_q1, 'Has a comma, a "quoted phrase", and a trailing quote"');
});

// ===========================================================================
// New tests for this revision request (points #1-#5, #8 list of 14 behaviors)
// ===========================================================================

// ---------------------------------------------------------------------------
// Points #1 and #1's test requirement: ai_purpose_other primarily reads
// responses.ai_purpose_specify, preserves the original key in responses_json,
// and the complete value survives in the original record (would be returned
// unmodified by the JSON export route).
// ---------------------------------------------------------------------------
test('ai_purpose_other reads from responses.ai_purpose_specify when present', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  assert.equal(row0.ai_purpose_other, 'Brainstorming counterarguments');

  // The original key/value remains in responses_json.
  const responses = JSON.parse(row0.responses_json);
  assert.equal(responses.ai_purpose_specify, 'Brainstorming counterarguments');

  // And the complete value remains in the original stored record (what the
  // accumulated JSON export returns unmodified).
  const original = byId('P-TEST-AI-PRE-0001');
  assert.equal(original.responses.ai_purpose_specify, 'Brainstorming counterarguments');
});

// ---------------------------------------------------------------------------
// Point #1's fallback requirement: when ai_purpose_specify is absent but
// responses['rg-ai-purpose-specify'] has a value, ai_purpose_other falls
// back to it. Uses fixture P-TEST-AI-FALLBACK-0005, which deliberately omits
// ai_purpose_specify.
// ---------------------------------------------------------------------------
test('ai_purpose_other falls back to responses["rg-ai-purpose-specify"] when ai_purpose_specify is absent', () => {
  const fallbackRecord = byId('P-TEST-AI-FALLBACK-0005');
  assert.ok(!('ai_purpose_specify' in fallbackRecord.responses), 'fixture sanity check: ai_purpose_specify must be absent');
  assert.equal(fallbackRecord.responses['rg-ai-purpose-specify'], 'Fallback only value');

  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-FALLBACK-0005');
  assert.equal(row.ai_purpose_other, 'Fallback only value', 'must fall back to the raw DOM-id key when the canonical key is absent');

  // Still recoverable from responses_json, and the complete original record
  // is untouched (as the JSON export would return it).
  const responses = JSON.parse(row.responses_json);
  assert.equal(responses['rg-ai-purpose-specify'], 'Fallback only value');
});

test('ai_purpose_other is blank when neither key has a value', () => {
  const neither = [{ responses: {} }];
  const csv = buildAccumulatedCsv(neither);
  const objs = csvToObjects(csv);
  assert.equal(objs[0].ai_purpose_other, '', 'must be blank, never invented');
});

// ---------------------------------------------------------------------------
// Points #4 and #5: exactly 5 fixed exchange slots x 4 columns exist for
// both paper_1 and paper_2 — 40 transcript columns total, no per-exchange
// success/latency/error columns.
// ---------------------------------------------------------------------------
test('exactly 40 fixed transcript columns exist (5 exchanges x 4 fields x 2 paper positions)', () => {
  assert.equal(MAX_AI_EXCHANGES_PER_PAPER, 5);
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

  // Explicitly absent: per-exchange success/latency/error columns (spec
  // point #3 explicitly forbids these — that detail stays in JSON/summaries).
  [1, 2].forEach((position) => {
    for (let n = 1; n <= 5; n++) {
      ['success', 'latency_ms', 'error'].forEach((forbidden) => {
        const key = 'paper_' + position + '_' + forbidden + '_' + n;
        assert.ok(!headers.includes(key), key + ' must NOT exist as a column');
      });
    }
  });

  // paper_<position>_id / _title columns also exist.
  assert.ok(headers.includes('paper_1_id'));
  assert.ok(headers.includes('paper_1_title'));
  assert.ok(headers.includes('paper_2_id'));
  assert.ok(headers.includes('paper_2_title'));
});

// ---------------------------------------------------------------------------
// Point #7: messages map to the correct assigned-paper position via paper_id
// (study_1_id / study_2_id), never crossing positions.
// ---------------------------------------------------------------------------
test('transcript messages map to the correct assigned-paper position', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row0 = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  // P-TEST-AI-PRE-0001: study_1_id = font (position 1), study_2_id = food (position 2).
  assert.equal(row0.paper_1_id, 'font');
  assert.equal(row0.paper_2_id, 'food');
  assert.equal(row0.paper_1_participant_message_1, 'What is the main claim of font?');
  assert.equal(row0.paper_2_participant_message_1, 'What is the main claim of food?');
  // Never crossed: font's message never lands under paper_2_*, and vice versa.
  assert.notEqual(row0.paper_2_participant_message_1, row0.paper_1_participant_message_1);
});

// ---------------------------------------------------------------------------
// Point #8: message order within a paper is correct — uses fixture
// P-TEST-AI-FULL5-0006, whose ai_message_log array is deliberately stored
// OUT of message_number order (shuffled 3,1,5,2,4), to prove the CSV sorts
// by message_number rather than trusting array position.
// ---------------------------------------------------------------------------
test('transcript exchanges are ordered by message_number, independent of ai_message_log array order', () => {
  const full5 = byId('P-TEST-AI-FULL5-0006');
  // Fixture sanity check: the stored array is genuinely out of order.
  const storedOrder = full5.ai_message_log.map((m) => m.message_number);
  assert.deepEqual(storedOrder, [3, 1, 5, 2, 4], 'fixture sanity check: ai_message_log must be stored out of order');

  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-FULL5-0006');
  // paper_1 is font for this record.
  assert.equal(row.paper_1_id, 'font');
  for (let n = 1; n <= 5; n++) {
    assert.equal(row['paper_1_participant_message_' + n], 'Font message ' + n, 'exchange ' + n + ' must be in message_number order, not array order');
    assert.equal(row['paper_1_ai_message_' + n], 'Font reply ' + n);
  }
});

// ---------------------------------------------------------------------------
// Point #5 ("keep 5 slots even when fewer/more than 5 are used") and this
// revision's point #1 ("N/A for genuinely unused/inapplicable slots"): this
// same fixture record's paper_2 (food) has zero AI messages even though the
// participant IS in the AI condition, so all 20 of its transcript cells
// must be "N/A" (never blank, never literal undefined/null).
// ---------------------------------------------------------------------------
test('a paper with zero AI messages has "N/A" in all 20 of its transcript cells, never blank/undefined/null literals', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-FULL5-0006');
  assert.equal(row.paper_2_id, 'food');
  for (let n = 1; n <= 5; n++) {
    ['participant_message', 'participant_message_time', 'ai_message', 'ai_message_time'].forEach((field) => {
      const val = row['paper_2_' + field + '_' + n];
      assert.equal(val, TRANSCRIPT_NOT_APPLICABLE);
      assert.notEqual(val, '');
      assert.notEqual(val, 'undefined');
      assert.notEqual(val, 'null');
    });
  }
});

// ---------------------------------------------------------------------------
// This revision's point #1/#5 again from the other fixture: P-TEST-AI-PRE-0001
// sent only 2 of 5 possible messages per paper (one success, one failure —
// see the dedicated failed-request test below), so exchanges 3-5 (genuinely
// never used) must be "N/A", never blank and never undefined/null literals.
// ---------------------------------------------------------------------------
test('unused exchange slots (fewer than 5 messages sent) are "N/A", never blank/undefined/null literals', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  for (let n = 3; n <= 5; n++) {
    ['participant_message', 'participant_message_time', 'ai_message', 'ai_message_time'].forEach((field) => {
      const val = row['paper_1_' + field + '_' + n];
      assert.equal(val, TRANSCRIPT_NOT_APPLICABLE);
      assert.notEqual(val, '');
      assert.notEqual(val, 'undefined');
      assert.notEqual(val, 'null');
    });
  }
});

// ---------------------------------------------------------------------------
// Point #11, plus this revision's points #2/#5: a failed request preserves
// the participant's prompt and timestamp, but does not invent an AI
// response or AI-message timestamp — AND those two blank fields must stay
// distinguishable from "N/A" (the slot WAS used/applicable; the request
// simply did not return a successful response).
// ---------------------------------------------------------------------------
test('a failed AI request keeps the participant prompt/timestamp but leaves ai_message/ai_message_time blank (not "N/A")', () => {
  const original = byId('P-TEST-AI-PRE-0001');
  const failedEntry = original.ai_message_log.find((m) => m.paper_id === 'font' && m.success === false);
  assert.ok(failedEntry, 'fixture sanity check: a failed font entry must exist');
  assert.equal(failedEntry.message_number, 2);

  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  // Exchange 2 on paper_1 (font) is the failed one.
  assert.equal(row.paper_1_participant_message_2, 'Follow-up question');
  assert.notEqual(row.paper_1_participant_message_2, TRANSCRIPT_NOT_APPLICABLE, 'a failed request must never report its own prompt as N/A');
  assert.equal(row.paper_1_participant_message_time_2, failedEntry.submit_ts_iso);
  assert.notEqual(row.paper_1_participant_message_time_2, TRANSCRIPT_NOT_APPLICABLE);

  assert.equal(row.paper_1_ai_message_2, '', 'no AI response must be invented for a failed request');
  assert.notEqual(row.paper_1_ai_message_2, TRANSCRIPT_NOT_APPLICABLE, 'a failed request\'s blank AI response must not be confused with an unused/N-A slot');
  assert.equal(row.paper_1_ai_message_time_2, '', 'no AI-response timestamp must be invented for a failed request');
  assert.notEqual(row.paper_1_ai_message_time_2, TRANSCRIPT_NOT_APPLICABLE);

  // The same failure is independently confirmed on paper_2 (food).
  const failedEntry2 = original.ai_message_log.find((m) => m.paper_id === 'food' && m.success === false);
  assert.ok(failedEntry2);
  assert.equal(row.paper_2_participant_message_2, 'Follow-up question');
  assert.equal(row.paper_2_ai_message_2, '');
  assert.notEqual(row.paper_2_ai_message_2, TRANSCRIPT_NOT_APPLICABLE);
});

// ---------------------------------------------------------------------------
// This revision's point #5, items 6-8: paper-level/total failed-message
// counts remain correct, the accumulated JSON export still preserves full
// failure metadata (re-confirmed alongside the existing JSON-completeness
// test below), and no transcript cell anywhere in the CSV is ever the
// literal string "undefined" or "null" — checked across every row and every
// one of the 40 transcript columns, not just the targeted fixtures above.
// ---------------------------------------------------------------------------
test('paper-level and total failed-message counts remain correct alongside the new N/A transcript cells', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const row = objs.find((r) => r.participant_id === 'P-TEST-AI-PRE-0001');
  assert.equal(row.font_ai_failed_message_count, '1');
  assert.equal(row.food_ai_failed_message_count, '1');
  assert.equal(row.total_failed_ai_messages, '2');

  const noAiRow = objs.find((r) => r.participant_id === 'P-TEST-NOAI-PRE-0003');
  assert.equal(noAiRow.font_ai_failed_message_count, '0');
  assert.equal(noAiRow.listing_ai_failed_message_count, '0');
  assert.equal(noAiRow.total_failed_ai_messages, '0');
});

test('no transcript cell in the entire CSV is ever the literal string "undefined" or "null"', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  objs.forEach((row) => {
    [1, 2].forEach((position) => {
      for (let n = 1; n <= 5; n++) {
        ['participant_message', 'participant_message_time', 'ai_message', 'ai_message_time'].forEach((field) => {
          const val = row['paper_' + position + '_' + field + '_' + n];
          assert.notEqual(val, 'undefined', 'paper_' + position + '_' + field + '_' + n + ' must never be the literal string "undefined"');
          assert.notEqual(val, 'null', 'paper_' + position + '_' + field + '_' + n + ' must never be the literal string "null"');
          // Every transcript cell must be one of: "N/A", "" (blank, failed
          // request), or an actual non-empty captured value.
          assert.ok(val === TRANSCRIPT_NOT_APPLICABLE || val === '' || val.length > 0);
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Point #2: the accumulated JSON export (i.e. the raw stored records, which
// is exactly what the /api/admin/export-submissions.json route returns,
// completely independent of buildColumns/cleanRecord) still contains the
// complete ai_message_log, behavioral_events, and all other original data
// for every record — proving the CSV column removals have zero effect on
// JSON completeness.
// ---------------------------------------------------------------------------
test('the accumulated JSON export still contains the complete ai_message_log, behavioral_events, and all other original data', () => {
  // The JSON export route (server.js) calls loadAllSubmissionRecords() and
  // returns res.json(records) directly — it never calls cleanRecord() or
  // buildColumns(). We simulate that exact behavior here: the "JSON export"
  // is just the raw fixture records, untouched.
  fixtures.forEach((original) => {
    // ai_message_log: present and complete, including failed entries with
    // null response (not stripped, not summarized).
    assert.ok(Array.isArray(original.ai_message_log));
    if (original.participant_id === 'P-TEST-AI-PRE-0001') {
      assert.equal(original.ai_message_log.length, 4);
      const longReply = original.ai_message_log.find((m) => m.response && m.response.length > 1000);
      assert.ok(longReply, 'the long AI assistant reply must be present and unmodified in ai_message_log');
      const failed = original.ai_message_log.find((m) => m.success === false);
      assert.equal(failed.response, null, 'failed entries keep response: null, exactly as stored');
    }

    // behavioral_events: present and complete.
    assert.ok(Array.isArray(original.behavioral_events));

    // Everything else listed in the spec as required to remain complete.
    ['responses', 'ai_chats', 'timing', 'ai_paper_aggregates', 'copy_events',
      'paste_events', 'revision_log', 'logs', 'violations'].forEach((field) => {
      assert.ok(field in original, field + ' must remain present in the JSON export');
    });

    // Submission and assignment metadata.
    ['participant_id', 'prolific_id', 'completion_status', 'assignment_cell',
      'assignment_source', 'paper_order', 'study_1_id', 'study_2_id'].forEach((field) => {
      assert.ok(field in original, field + ' (submission/assignment metadata) must remain present in the JSON export');
    });
  });
});

// ---------------------------------------------------------------------------
// Point #6 (re-confirmed alongside #2): behavioral_events_json is absent as
// a CSV column, but every behavioral summary column is still present and
// correctly derived, and the full detailed array remains in the raw record
// (i.e. the JSON export).
// ---------------------------------------------------------------------------
test('behavioral summary columns remain even though behavioral_events_json is removed from the CSV', () => {
  const csv = buildAccumulatedCsv(fixtures);
  const objs = csvToObjects(csv);
  const headers = Object.keys(objs[0]);
  assert.ok(!headers.includes('behavioral_events_json'));
  [
    'behavioral_event_count', 'violation_count', 'blur_count', 'focus_count',
    'visibility_event_count', 'visibility_hidden_count', 'visibility_visible_count',
    'fullscreen_enter_count', 'fullscreen_exit_count', 'copy_event_count', 'paste_event_count'
  ].forEach((k) => assert.ok(headers.includes(k), k + ' must remain as a column'));

  const original = byId('P-TEST-AI-PRE-0001');
  assert.equal(original.behavioral_events.length, 4, 'full behavioral_events array remains in the raw/JSON-export record');
});
