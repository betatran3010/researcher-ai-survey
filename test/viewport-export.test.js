'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CSV_COLUMNS, flattenRecord } = require('../lib/export-csv');

function record() {
  return {
    participant_id: 'P1', paper_order: ['font'], study_1_id: 'font',
    responses: {}, timing: {
      font: {
        duration_ms: 1000,
        pdf_exposure_proportion_30s: 0.625,
        region_exposed_30s_count: 6,
        navigation_sequence: 'P1-Top-Half>P1-Bottom-Half>P2-Top-Half>P1-Bottom-Half',
        backward_transition_count: 1,
        navigation_transition_count: 99,
        revisit_count: 99,
        page_1_exposure_proportion_5s: 0.9
      },
      food: {
        duration_ms: 0,
        pdf_exposure_proportion_30s: 0,
        region_exposed_30s_count: 0,
        navigation_sequence: 'P1-Top-Half',
        backward_transition_count: 0
      }
    },
    ai_paper_aggregates: {}, ai_chats: {}, ai_message_log: [], behavioral_events: [],
    paste_events: [], copy_events: [], revision_log: [], logs: {}
  };
}

test('official CSV contains exactly the five approved scrolling fields per paper', () => {
  for (const paperId of ['font','food','listing']) {
    for (const suffix of [
      'duration_ms','pdf_exposure_proportion_30s','region_exposed_30s_count',
      'navigation_sequence','backward_transition_count'
    ]) assert.ok(CSV_COLUMNS.includes(`${paperId}_${suffix}`));
  }
});

test('obsolete scrolling columns are absent from official CSV schema', () => {
  for (const paperId of ['font','food','listing']) {
    for (const suffix of [
      'navigation_transition_count','revisit_count','page_1_exposure_proportion_5s',
      'page_2_exposure_proportion_5s','page_3_exposure_proportion_5s'
    ]) assert.ok(!CSV_COLUMNS.includes(`${paperId}_${suffix}`));
    assert.ok(!CSV_COLUMNS.some(c => c.startsWith(`${paperId}_P1-`) || c.startsWith(`${paperId}_P2-`) || c.startsWith(`${paperId}_P3-`)));
  }
});

test('official flattening preserves measured values including genuine zeros', () => {
  const row = flattenRecord(record());
  assert.equal(row.font_duration_ms, 1000);
  assert.equal(row.font_pdf_exposure_proportion_30s, 0.625);
  assert.equal(row.font_region_exposed_30s_count, 6);
  assert.equal(row.font_navigation_sequence, 'P1-Top-Half>P1-Bottom-Half>P2-Top-Half>P1-Bottom-Half');
  assert.equal(row.font_backward_transition_count, 1);
  assert.equal(row.food_duration_ms, '');
  assert.equal(row.food_pdf_exposure_proportion_30s, '');
  assert.equal(row.food_region_exposed_30s_count, '');
  assert.equal(row.food_backward_transition_count, '');
});

test('unassigned paper scrolling fields remain blank', () => {
  const row = flattenRecord(record());
  for (const suffix of [
    'duration_ms','pdf_exposure_proportion_30s','region_exposed_30s_count',
    'navigation_sequence','backward_transition_count'
  ]) assert.equal(row[`listing_${suffix}`], '');
});
