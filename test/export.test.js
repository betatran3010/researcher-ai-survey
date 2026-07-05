'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CSV_COLUMNS, AI_TRANSCRIPT_COLUMNS, flattenRecord, buildAccumulatedCsv, buildAiTranscriptRows, getOpenResponse } = require('../lib/export-csv');

function record(overrides={}) {
  return Object.assign({
    participant_id:'P1', prolific_id:'PR1', record_source:'final_submission', last_saved_at:'2026-06-29T10:00:00.000Z',
    submission_status:'confirmed', test_mode:false, completion_status:'completed', consent_status:'granted',
    research_role:"Master's student", research_expertise_stratum:'lower', ai_condition:'AI', critical_thinking_placement:'pre',
    assignment_cell:'AI_pre', study_1_id:'font', study_1_title:'Font paper', paper_order:['font'],
    responses:{font_strength:'A strength',font_limitation:'A limitation',font_improvement:'An improvement',font_understood:6,font_convincing:5,font_confidence:6,
               quiz_font_q1_response:'A',quiz_font_q2_response:'B',quiz_font_q3_response:'C',quiz_font_q4_response:'D',quiz_font_q5_response:'E'},
    timing:{font:{duration_ms:120000,pdf_exposure_proportion_30s:0.5,region_exposed_30s_count:1,paper_navigation_sequence:'P1-Top-Half>P1-Bottom-Half',backward_transition_count:0,component_navigation_sequence:'Paper>Questions',component_transition_count:1}},
    ai_chats:{font:[{role:'user',content:'Prompt',ts:'2026-06-29T09:10:00Z'},{role:'assistant',content:'Reply',ts:'2026-06-29T09:10:01Z'}]},
    ai_message_log:[{paper_id:'font',success:true,prompt:'Prompt'}], ai_paper_aggregates:{font:{tab_opened:true,successful_messages:1}},
    behavioral_events:[],paste_events:[],copy_events:[],revision_log:[],logs:{},quiz_score:3,quiz_paper_scores:{font:3}
  }, overrides);
}

test('schema has generic one-paper columns, not three paper-prefixed sets', () => {
  // Generic task columns must exist
  for (const col of ['strength_response','limitation_response','improvement_response',
                     'convincing_rating','confidence_rating','understanding_rating',
                     'strength_first_typing_time','limitation_first_typing_time','improvement_first_typing_time',
                     'quiz_q1_response','quiz_q2_response','quiz_q3_response','quiz_q4_response','quiz_q5_response','quiz_score']) {
    assert.ok(CSV_COLUMNS.includes(col), `missing ${col}`);
  }
  // No per-paper prefixed open-response copies
  for (const p of ['font','food','listing']) {
    for (const s of ['strength','limitation','improvement']) {
      assert.ok(!CSV_COLUMNS.includes(`${p}_${s}`), `unexpected column ${p}_${s}`);
    }
    assert.ok(!CSV_COLUMNS.includes(`${p}_convincing`), `unexpected ${p}_convincing`);
    assert.ok(!CSV_COLUMNS.includes(`confidence_${p}`), `unexpected confidence_${p}`);
    assert.ok(!CSV_COLUMNS.includes(`understood_${p}`), `unexpected understood_${p}`);
    assert.ok(!CSV_COLUMNS.includes(`quiz_${p}_q1_response`), `unexpected quiz_${p}_q1_response`);
  }
  // No per-paper timing/viewport columns
  for (const p of ['font','food','listing']) {
    for (const s of ['duration_ms','pdf_exposure_proportion_30s','region_exposed_30s_count',
                     'paper_navigation_sequence','backward_transition_count',
                     'component_navigation_sequence','component_transition_count',
                     'ai_time_to_first_message_ms','ai_prompt_count']) {
      assert.ok(!CSV_COLUMNS.includes(`${p}_${s}`), `unexpected per-paper column ${p}_${s}`);
    }
  }
  // Generic per-paper columns must exist (one set)
  for (const col of ['task_duration_ms','pdf_exposure_proportion_30s','region_exposed_30s_count',
                     'paper_navigation_sequence','backward_transition_count',
                     'component_navigation_sequence','component_transition_count',
                     'ai_time_to_first_message_ms','ai_prompt_count']) {
    assert.ok(CSV_COLUMNS.includes(col), `missing generic column ${col}`);
  }
  // No per-paper transcript columns
  for (const p of ['font','food','listing']) {
    assert.ok(!CSV_COLUMNS.some(c => c.startsWith(`${p}_participant_message`)), `unexpected ${p} transcript column`);
  }
  assert.ok(!CSV_COLUMNS.includes('paper_1_id'), 'paper_1_id must not exist (use assigned_paper_id)');
  // Generic transcript columns must exist
  for (let t = 1; t <= 5; t += 1) {
    assert.ok(CSV_COLUMNS.includes(`participant_message_${t}`), `missing participant_message_${t}`);
    assert.ok(CSV_COLUMNS.includes(`ai_message_${t}`), `missing ai_message_${t}`);
  }
  assert.ok(CSV_COLUMNS.includes('assigned_paper_id'));
  assert.ok(CSV_COLUMNS.includes('assigned_paper_title'));
  assert.ok(!CSV_COLUMNS.includes('paper_2_id'));
});

test('one-paper row exports generic columns from the assigned paper', () => {
  const row = flattenRecord(record());
  assert.equal(row.assigned_paper_id, 'font');
  assert.equal(row.strength_response, 'A strength');
  assert.equal(row.limitation_response, 'A limitation');
  assert.equal(row.improvement_response, 'An improvement');
  assert.equal(row.convincing_rating, 5);
  assert.equal(row.confidence_rating, 6);
  assert.equal(row.understanding_rating, 6);
  assert.equal(row.task_duration_ms, 120000);
  assert.equal(row.ai_prompt_count, 1);
  assert.equal(row.any_ai_use, true);
});

test('quiz responses and score are generic (not paper-prefixed)', () => {
  const row = flattenRecord(record());
  assert.equal(row.quiz_score, 3);
  assert.equal(row.quiz_q1_response, 'A');
  assert.equal(row.quiz_q2_response, 'B');
  assert.equal(row.quiz_q3_response, 'C');
  assert.equal(row.quiz_q4_response, 'D');
  assert.equal(row.quiz_q5_response, 'E');
  assert.equal(row['quiz_font_q1_response'], undefined);
  assert.equal(row['quiz_font_q5_response'], undefined);
});

test('quiz_q5_response is exported for the assigned paper and empty for unassigned papers', () => {
  const assigned = flattenRecord(record());
  assert.ok(CSV_COLUMNS.includes('quiz_q5_response'));
  assert.equal(assigned.quiz_q5_response, 'E');
  const other = flattenRecord(record({
    study_1_id: 'food', study_1_title: 'Food paper', paper_order: ['food'],
    responses: {
      food_strength: 's', food_limitation: 'l', food_improvement: 'i',
      food_understood: 5, food_convincing: 4, food_confidence: 5,
      quiz_food_q1_response: 'W', quiz_food_q2_response: 'X',
      quiz_food_q3_response: 'Y', quiz_food_q4_response: 'Z',
      quiz_food_q5_response: 'Q'
    },
    quiz_score: 5, quiz_paper_scores: { food: 5 }
  }));
  assert.equal(other.quiz_q5_response, 'Q');
  assert.equal(other.quiz_score, 5);
});

test('record provenance fields are exported', () => {
  const row = flattenRecord(record());
  assert.equal(row.record_source, 'final_submission');
  assert.equal(row.last_saved_at, '2026-06-29T10:00:00.000Z');
});

test('legacy open responses merge without data loss and new value wins', () => {
  assert.equal(getOpenResponse({font_strength_1:'one',font_strength_2:'two'},'font','strength'),'one\n\ntwo');
  assert.equal(getOpenResponse({font_strength:'new',font_strength_1:'old'},'font','strength'),'new');
});

test('generic viewport fields: genuine zeros preserved, removed columns absent', () => {
  const row = flattenRecord(record({timing:{font:{duration_ms:0,pdf_exposure_proportion_30s:0,region_exposed_30s_count:0,paper_navigation_sequence:'P1-Top-Half',backward_transition_count:0,component_navigation_sequence:'Paper',component_transition_count:0}}}));
  assert.equal(row.task_duration_ms, 0);
  assert.equal(row.pdf_exposure_proportion_30s, 0);
  assert.equal(row.region_exposed_30s_count, 0);
  assert.equal(row.paper_navigation_sequence, 'P1-Top-Half');
  assert.equal(row.component_navigation_sequence, 'Paper');
  assert.equal(row.component_transition_count, 0);
  // Removed columns must not appear in schema
  assert.ok(!CSV_COLUMNS.some(c => c.endsWith('_pdf_exposure_proportion_5s')));
  assert.ok(!CSV_COLUMNS.some(c => c.endsWith('_navigation_transition_count')));
  // Required dictionary columns must be present
  assert.ok(CSV_COLUMNS.includes('pdf_exposure_proportion_30s'));
  assert.ok(CSV_COLUMNS.includes('region_exposed_30s_count'));
  assert.ok(CSV_COLUMNS.includes('paper_navigation_sequence'));
  assert.ok(CSV_COLUMNS.includes('component_navigation_sequence'));
  // first_typing_time columns without paper prefix
  assert.ok(CSV_COLUMNS.includes('strength_first_typing_time'));
  assert.ok(CSV_COLUMNS.includes('limitation_first_typing_time'));
  assert.ok(CSV_COLUMNS.includes('improvement_first_typing_time'));
});

test('transcript uses generic column names; assigned_paper_id identifies the paper', () => {
  const csv = buildAccumulatedCsv([record()]);
  assert.ok(csv.charCodeAt(0) === 0xFEFF);
  assert.ok(csv.includes('"participant_message_1"'));
  assert.ok(csv.includes('"assigned_paper_title"'));
  assert.ok(!csv.includes('"paper_1_id"'));
  assert.ok(!csv.includes('"paper_2_id"'));
  const rows = buildAiTranscriptRows([record()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn_number, 1);
  assert.equal(rows[0].paper_id, 'font');
  assert.equal(rows[0].condition, 'AI');
  assert.equal(rows[0].participant_message, 'Prompt');
  assert.equal(rows[0].assistant_message, 'Reply');
  assert.equal(rows[0].participant_message_length, 'Prompt'.length);
  assert.equal(rows[0].assistant_message_length, 'Reply'.length);
  assert.equal(Object.keys(rows[0]).length, 17);
  assert.deepEqual(Object.keys(rows[0]), AI_TRANSCRIPT_COLUMNS);
  // Generic transcript values
  const row = flattenRecord(record());
  assert.equal(row.assigned_paper_title, 'Font paper');
  assert.equal(row.participant_message_1, 'Prompt');
  assert.equal(row.ai_message_1, 'Reply');
});

test('unassigned-paper AI activity is excluded from aggregates', () => {
  const row = flattenRecord(record({ai_message_log:[{paper_id:'listing',success:true,prompt:'wrong paper'}]}));
  assert.equal(row.any_ai_use, false);
});

test('per-question process columns use generic suffix names', () => {
  const r = record({
    logs: { font_strength: { keystrokes: 42, first_keystroke_ts: '2026-01-01T10:00:00Z' } },
    paste_events: [{ source_type: 'ai_response', target_type: 'participant_answer', target_id: 'font_strength' }]
  });
  const row = flattenRecord(r);
  assert.equal(row.strength_keystrokes, 42);
  assert.equal(row.strength_first_typing_time, '2026-01-01T10:00:00Z');
  assert.equal(row.strength_ai_to_answer_paste_count, 1);
  // Old per-paper prefixed process columns must not exist in schema
  assert.ok(!CSV_COLUMNS.includes('font_strength_keystrokes'));
  assert.ok(!CSV_COLUMNS.includes('food_strength_keystrokes'));
  assert.ok(!CSV_COLUMNS.includes('listing_strength_keystrokes'));
});

test('response_length columns use word count not character count', () => {
  const r = record({
    responses: {
      font_strength: 'hello world foo',  // 3 words
      font_limitation: 'A limitation',   // 2 words
      font_improvement: ''               // 0 words
    }
  });
  const row = flattenRecord(r);
  assert.equal(row.strength_response_length, 3);
  assert.equal(row.limitation_response_length, 2);
  assert.equal(row.improvement_response_length, 0);
  // total_response_length is word-count sum
  assert.equal(row.total_response_length, 5);
});

test('blank and whitespace-only responses yield response_length of 0', () => {
  const r = record({
    responses: { font_strength: '   ', font_limitation: '', font_improvement: '\n' }
  });
  const row = flattenRecord(r);
  assert.equal(row.strength_response_length, 0);
  assert.equal(row.limitation_response_length, 0);
  assert.equal(row.improvement_response_length, 0);
  assert.equal(row.total_response_length, 0);
});

test('revised SRL schema uses one construct-named item per category and one composite', () => {
  const expected = [
    'srl_goal_setting','srl_strategic_planning','srl_task_strategies',
    'srl_elaboration','srl_self_evaluation','srl_help_seeking'
  ];
  for (const key of expected) {
    assert.ok(CSV_COLUMNS.includes(key));
    assert.ok(CSV_COLUMNS.includes(`${key}_scored`));
  }
  for (const obsolete of [
    'srl_goal_standards','srl_goal_shortlong','srl_plan_questions',
    'srl_goal_setting_mean','srl_strategic_planning_mean','srl_task_strategies_mean',
    'srl_elaboration_mean','srl_self_evaluation_mean','srl_help_seeking_mean'
  ]) assert.ok(!CSV_COLUMNS.includes(obsolete));
  assert.ok(CSV_COLUMNS.includes('srl_composite_mean'));
});

test('SRL reverse scoring and complete-case composite are correct', () => {
  const responses = {
    srl_goal_setting:7,
    srl_strategic_planning:7,
    srl_task_strategies:6,
    srl_elaboration:5,
    srl_self_evaluation:6,
    srl_help_seeking:4
  };
  const row = flattenRecord(record({responses:Object.assign({},record().responses,responses)}));
  assert.equal(row.srl_goal_setting_scored, 7);
  assert.equal(row.srl_strategic_planning_scored, 1);
  assert.equal(row.srl_self_evaluation_scored, 2);
  assert.equal(row.srl_composite_mean, Number(((7+1+6+5+2+4)/6).toFixed(4)));
  delete responses.srl_help_seeking;
  const incomplete = flattenRecord(record({responses:Object.assign({},record().responses,responses)}));
  assert.equal(incomplete.srl_composite_mean, '');
});

test('general CT schema, scoring, and attention-check exclusion are correct', () => {
  const responses = {
    ct_credibility:6,ct_understand_vs_judge:5,ct_evidence:7,
    ct_alternatives:4,ct_weaknesses:3,attention_check:2
  };
  const row = flattenRecord(record({responses:Object.assign({},record().responses,responses)}));
  assert.equal(row.ct_evidence_scored, 1);
  assert.equal(row.ct_composite_mean, Number(((6+5+1+4+3)/5).toFixed(4)));
  assert.equal(row.attention_check, 2);
  for (const obsolete of ['ct_bias','ct_assumptions','ct_compare','ct_alternatives_repeat','ct_repeat_consistent']) {
    assert.ok(!CSV_COLUMNS.includes(obsolete));
  }
});

test('AI evaluation scoring, repeat consistency, and composite are correct', () => {
  const responses = {
    ai_research_use:'Yes',
    ai_eval_summarize_clarify:6,
    ai_eval_before_own_judgment:5,
    ai_eval_question_assumptions:4,
    ai_eval_rely_without_comparing:7,
    ai_eval_bias_concern:3,
    ai_eval_question_assumptions_repeat:5
  };
  const row = flattenRecord(record({responses:Object.assign({},record().responses,responses)}));
  assert.equal(row.ai_eval_rely_without_comparing_scored, 1);
  assert.equal(row.ai_repeat_consistent, true);
  assert.equal(row.ai_eval_composite_mean, Number(((6+5+4+1+3)/5).toFixed(4)));
});

test('response_length columns use word count not character count', () => {
  const r = record({
    responses: {
      font_strength: 'hello world foo',  // 3 words
      font_limitation: 'A limitation',   // 2 words
      font_improvement: ''               // 0 words
    }
  });
  const row = flattenRecord(r);
  assert.equal(row.strength_response_length, 3);
  assert.equal(row.limitation_response_length, 2);
  assert.equal(row.improvement_response_length, 0);
  // total_response_length is word-count sum
  assert.equal(row.total_response_length, 5);
});

test('blank and whitespace-only responses yield response_length of 0', () => {
  const r = record({
    responses: { font_strength: '   ', font_limitation: '', font_improvement: '\n' }
  });
  const row = flattenRecord(r);
  assert.equal(row.strength_response_length, 0);
  assert.equal(row.limitation_response_length, 0);
  assert.equal(row.improvement_response_length, 0);
  assert.equal(row.total_response_length, 0);
});

test('No prior research AI use produces structural blanks for skipped fields', () => {
  const responses = {
    ai_research_use:'No',
    ai_tenure:'stale',
    ai_hours_per_week:5,
    ai_purpose:['stale'],
    ai_understanding:'stale',
    ai_eval_summarize_clarify:7,
    ai_eval_before_own_judgment:7,
    ai_eval_question_assumptions:7,
    ai_eval_rely_without_comparing:7,
    ai_eval_bias_concern:7,
    ai_eval_question_assumptions_repeat:7
  };
  const row = flattenRecord(record({responses:Object.assign({},record().responses,responses)}));
  assert.equal(row.ai_research_use, 'No');
  for (const key of [
    'ai_tenure','ai_hours_per_week','ai_purpose','ai_purpose_other','ai_understanding',
    'ai_eval_summarize_clarify','ai_eval_before_own_judgment','ai_eval_question_assumptions',
    'ai_eval_rely_without_comparing','ai_eval_bias_concern',
    'ai_eval_question_assumptions_repeat','ai_repeat_consistent',
    'ai_eval_composite_mean'
  ]) assert.equal(row[key], '');
});
