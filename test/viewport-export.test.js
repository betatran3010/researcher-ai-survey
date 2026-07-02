'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CSV_COLUMNS, flattenRecord } = require('../lib/export-csv');

function record(overrides) {
  return Object.assign({
    participant_id: 'P1', paper_order: ['font'], study_1_id: 'font',
    responses: {}, timing: {
      font: {
        duration_ms: 1000,
        pdf_exposure_proportion_30s: 0.625,
        region_exposed_30s_count: 2,
        paper_navigation_sequence: 'P1-Top-Half>P1-Bottom-Half>P2-Top-Half>P1-Bottom-Half',
        backward_transition_count: 1,
        component_navigation_sequence: 'Paper>Questions>AI',
        component_transition_count: 2
      }
    },
    ai_paper_aggregates: {}, ai_chats: {}, ai_message_log: [], behavioral_events: [],
    paste_events: [], copy_events: [], revision_log: [], logs: {}
  }, overrides);
}

test('official CSV contains exactly the approved generic scrolling columns (one set, no paper prefix)', () => {
  const required = [
    'task_duration_ms', 'pdf_exposure_proportion_30s', 'region_exposed_30s_count',
    'paper_navigation_sequence', 'backward_transition_count',
    'component_navigation_sequence', 'component_transition_count'
  ];
  for (const col of required) {
    assert.ok(CSV_COLUMNS.includes(col), `missing ${col}`);
  }
  // Exactly one set — no per-paper copies
  for (const paperId of ['font', 'food', 'listing']) {
    for (const col of required) {
      assert.ok(!CSV_COLUMNS.includes(`${paperId}_${col}`), `unexpected per-paper column ${paperId}_${col}`);
    }
    assert.ok(!CSV_COLUMNS.includes(`${paperId}_duration_ms`), `unexpected ${paperId}_duration_ms`);
  }
});

test('removed scrolling columns are absent from official CSV schema', () => {
  for (const suffix of [
    'pdf_exposure_proportion_5s', 'navigation_transition_count',
    'navigation_sequence', 'revisit_count'
  ]) {
    assert.ok(!CSV_COLUMNS.includes(suffix), `unexpected column ${suffix}`);
    for (const paperId of ['font', 'food', 'listing']) {
      assert.ok(!CSV_COLUMNS.includes(`${paperId}_${suffix}`), `unexpected column ${paperId}_${suffix}`);
    }
  }
  // Region/landmark columns removed
  assert.ok(!CSV_COLUMNS.some(c => /^(font|food|listing)_P[123]-/.test(c)));
});

test('official flattening writes assigned-paper values to generic columns', () => {
  const row = flattenRecord(record());
  assert.equal(row.task_duration_ms, 1000);
  assert.equal(row.pdf_exposure_proportion_30s, 0.625);
  assert.equal(row.region_exposed_30s_count, 2);
  assert.equal(row.paper_navigation_sequence, 'P1-Top-Half>P1-Bottom-Half>P2-Top-Half>P1-Bottom-Half');
  assert.equal(row.backward_transition_count, 1);
  assert.equal(row.component_navigation_sequence, 'Paper>Questions>AI');
  assert.equal(row.component_transition_count, 2);
  // No per-paper columns exist in the row
  assert.equal(row['font_duration_ms'], undefined);
  assert.equal(row['food_duration_ms'], undefined);
  assert.equal(row['listing_duration_ms'], undefined);
});

test('genuine zeros in assigned-paper scrolling fields are preserved', () => {
  const row = flattenRecord(record({
    timing: {
      font: {
        duration_ms: 0,
        pdf_exposure_proportion_30s: 0,
        region_exposed_30s_count: 0,
        paper_navigation_sequence: 'P1-Top-Half',
        backward_transition_count: 0,
        component_navigation_sequence: 'Paper',
        component_transition_count: 0
      }
    }
  }));
  assert.equal(row.task_duration_ms, 0);
  assert.equal(row.pdf_exposure_proportion_30s, 0);
  assert.equal(row.region_exposed_30s_count, 0);
  assert.equal(row.backward_transition_count, 0);
  assert.equal(row.component_transition_count, 0);
});

test('missing timing data produces blank generic columns, not zero', () => {
  const row = flattenRecord(record({ timing: {} }));
  assert.equal(row.task_duration_ms, '');
  assert.equal(row.pdf_exposure_proportion_30s, '');
  assert.equal(row.region_exposed_30s_count, '');
  assert.equal(row.paper_navigation_sequence, '');
  assert.equal(row.backward_transition_count, '');
});
