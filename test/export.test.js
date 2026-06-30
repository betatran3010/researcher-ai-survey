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
    responses:{font_strength:'A strength',font_limitation:'A limitation',font_improvement:'An improvement',font_understood:6,font_convincing:5,font_confidence:6},
    timing:{font:{duration_ms:120000,pdf_exposure_proportion_30s:0.5,region_exposed_30s_count:3,navigation_sequence:'P1-Top-Half>P1-Bottom-Half',backward_transition_count:0}},
    ai_chats:{font:[{role:'user',content:'Prompt',ts:'2026-06-29T09:10:00Z'},{role:'assistant',content:'Reply',ts:'2026-06-29T09:10:01Z'}]},
    ai_message_log:[{paper_id:'font',success:true,prompt:'Prompt'}], ai_paper_aggregates:{font:{tab_opened:true,successful_messages:1}},
    behavioral_events:[],paste_events:[],copy_events:[],revision_log:[],logs:{},quiz_score:3,quiz_paper_scores:{font:3}
  }, overrides);
}

test('schema uses one paper position and new open-response columns',()=>{
  for (const p of ['font','food','listing']) for (const s of ['strength','limitation','improvement']) assert.ok(CSV_COLUMNS.includes(`${p}_${s}`));
  assert.ok(!CSV_COLUMNS.some(c=>/_strength_[123]$|_limitation_[123]$|_improvement_[123]$/.test(c)));
  assert.ok(CSV_COLUMNS.includes('paper_1_id'));
  assert.ok(!CSV_COLUMNS.includes('paper_2_id'));
  assert.ok(!CSV_COLUMNS.includes('study_2_id'));
});

test('one-paper row populates assigned paper and leaves others blank',()=>{
  const row=flattenRecord(record());
  assert.equal(row.study_1_id,'font');
  assert.equal(row.font_strength,'A strength');
  assert.equal(row.food_strength,'');
  assert.equal(row.listing_strength,'');
  assert.equal(row.total_task_duration_ms,120000);
  assert.equal(row.total_participant_ai_prompts,1);
  assert.equal(row.papers_with_any_ai_prompt,1);
});

test('record provenance fields are exported',()=>{
  const row=flattenRecord(record());
  assert.equal(row.record_source,'final_submission');
  assert.equal(row.last_saved_at,'2026-06-29T10:00:00.000Z');
  assert.equal(row.submission_status,'confirmed');
});

test('legacy open responses merge without data loss and new value wins',()=>{
  assert.equal(getOpenResponse({font_strength_1:'one',font_strength_2:'two'},'font','strength'),'one\n\ntwo');
  assert.equal(getOpenResponse({font_strength:'new',font_strength_1:'old'},'font','strength'),'new');
});

test('approved viewport fields preserve genuine zeros and obsolete fields are absent',()=>{
  const row=flattenRecord(record({timing:{font:{duration_ms:0,pdf_exposure_proportion_30s:0,region_exposed_30s_count:0,navigation_sequence:'P1-Top-Half',backward_transition_count:0}}}));
  assert.equal(row.font_duration_ms,0); assert.equal(row.total_task_duration_ms,0); assert.equal(row.font_pdf_exposure_proportion_30s,0);
  for (const c of CSV_COLUMNS) assert.ok(!/pdf_exposure_proportion_5s|navigation_transition_count|revisit_count/.test(c));
});

test('main CSV and transcript CSV each produce one participant/paper position',()=>{
  const csv=buildAccumulatedCsv([record()]);
  assert.ok(csv.charCodeAt(0)===0xFEFF); assert.ok(csv.includes('"paper_1_id"')); assert.ok(!csv.includes('"paper_2_id"'));
  const rows=buildAiTranscriptRows([record()]);
  assert.equal(rows.length,1); assert.equal(rows[0].paper_order_position,1); assert.equal(rows[0].paper_id,'font');
  assert.deepEqual(Object.keys(rows[0]),AI_TRANSCRIPT_COLUMNS);
});

test('unassigned-paper AI activity is excluded from aggregates',()=>{
  const row=flattenRecord(record({ai_message_log:[{paper_id:'listing',success:true,prompt:'wrong paper'}]}));
  assert.equal(row.any_ai_use,false); assert.equal(row.papers_with_any_ai_prompt,0); assert.equal(row.mean_ai_prompt_length,'');
});
