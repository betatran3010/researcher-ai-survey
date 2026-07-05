'use strict';

// Tests for partial quiz-progress autosave. The scoring + answer-conversion
// logic lives in a single shared syncQuizProgress() (used by both partial
// autosaves and final submission). These tests:
//   - extract the real quiz functions from public/researcher_ai_survey.js and
//     drive them with a minimal DOM shim (jsdom is unavailable in this env);
//   - assert wiring via source inspection;
//   - verify CSV export compatibility via lib/export-csv.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { flattenRecord, CSV_COLUMNS } = require('../lib/export-csv');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'researcher_ai_survey.js'), 'utf8');

// Extract a top-level `function NAME(...) {...}` or `const NAME = {...};` by
// brace matching (template-literal ${} braces stay balanced, so the count is
// correct for these functions).
function extractBlock(marker) {
  const i = src.indexOf(marker);
  assert.ok(i !== -1, 'missing source block: ' + marker);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let end = k + 1;
        if (src[end] === ';') end++;
        return src.slice(i, end);
      }
    }
  }
  throw new Error('no end for ' + marker);
}

const EXTRACTED = [
  'let QUIZ_PAGE_IDS = [];',
  extractBlock('const PAPERS = {'),
  extractBlock('function shuffleArray(arr) {'),
  'const QUIZ_RUNTIME_CORRECT = {};',
  extractBlock('function buildQuizPages() {'),
  extractBlock('function syncQuizProgress() {'),
  extractBlock('function finishQuiz() {'),
  extractBlock('function collectFieldsNow() {')
].join('\n\n');

// ------------------------------ DOM shim harness ----------------------------
function makeHarness() {
  let CHOICES = {};       // name -> displayed letter currently "checked"
  let RADIO_NAMES = [];   // names collectFieldsNow() should discover
  const containers = {};
  const getContainer = (id) => (containers[id] || (containers[id] = { id, innerHTML: '' }));
  const document = {
    getElementById: (id) => (id === 'quizPagesContainer' ? getContainer(id) : null),
    querySelector(sel) {
      const m = sel.match(/input\[name="([^"]+)"\]/);
      if (m && CHOICES[m[1]] != null) return { value: CHOICES[m[1]] };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'input[type="radio"]') return RADIO_NAMES.map((n) => ({ name: n }));
      return [];
    }
  };
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const spies = { schedule: 0, save: 0, dirty: 0 };
  const scheduleAutosave = () => { spies.schedule++; };
  const saveProgressNow = () => { spies.save++; };
  const markAutosaveDirty = () => { spies.dirty++; };
  const DATA = {
    study_order: [],
    responses: {},
    quiz_option_orders: {},
    quiz_question_orders: {},
    quiz_paper_scores: { font: null, food: null, listing: null },
    quiz_score: 0,
    quiz_total: 0
  };
  const factory = new Function(
    'document', 'DATA', 'escapeHtml', 'scheduleAutosave', 'saveProgressNow', 'markAutosaveDirty',
    EXTRACTED + '\nreturn { buildQuizPages, syncQuizProgress, finishQuiz, collectFieldsNow, PAPERS, QUIZ_RUNTIME_CORRECT };'
  );
  const api = factory(document, DATA, escapeHtml, scheduleAutosave, saveProgressNow, markAutosaveDirty);
  return {
    api, DATA, spies,
    setChoices: (c) => { CHOICES = c; },
    setRadioNames: (n) => { RADIO_NAMES = n; }
  };
}

// Build a randomized quiz for `paper` and prime the DOM shim with its radios.
function buildFor(paper) {
  const h = makeHarness();
  h.DATA.study_order = [paper];
  h.api.buildQuizPages();
  h.setRadioNames(h.api.PAPERS[paper].quiz.map((_, i) => `quiz_${paper}_${i}`));
  return h;
}

function otherLetter(l) { return ['A', 'B', 'C', 'D'].find((x) => x !== l); }

function makeRecord(paper, DATA) {
  return {
    participant_id: 'P1', prolific_id: 'PR1', record_source: 'autosave',
    submission_status: 'not_attempted', test_mode: false, completion_status: 'in_progress',
    consent_status: 'granted', research_role: "Master's student", research_expertise_stratum: 'lower',
    ai_condition: 'AI', critical_thinking_placement: 'pre', assignment_cell: 'AI_pre',
    study_1_id: paper, study_1_title: 'X', paper_order: [paper],
    responses: DATA.responses,
    timing: { [paper]: {} }, ai_chats: {}, ai_message_log: [], ai_paper_aggregates: {},
    behavioral_events: [], paste_events: [], copy_events: [], revision_log: [], logs: {}, violations: [],
    quiz_score: DATA.quiz_score, quiz_paper_scores: DATA.quiz_paper_scores
  };
}

// ============================== A. Partial progress =========================
test('A. two answers: exactly two stable fields, current score, total stays 5', () => {
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  const q1 = 'quiz_food_0', q3 = 'quiz_food_2';
  h.setChoices({ [q1]: rc[q1], [q3]: otherLetter(rc[q3]) }); // Q1 correct, Q3 wrong
  h.api.syncQuizProgress();
  const r = h.DATA.responses;
  assert.ok(r['quiz_food_q1_response'], 'Q1 stable field present');
  assert.ok(r['quiz_food_q3_response'], 'Q3 stable field present');
  assert.equal(r['quiz_food_q2_response'], null, 'Q2 unanswered stays null');
  assert.equal(r['quiz_food_q4_response'], null);
  assert.equal(r['quiz_food_q5_response'], null);
  assert.equal(h.DATA.quiz_score, 1, 'only Q1 correct');
  assert.equal(h.DATA.quiz_total, 5, 'total is the full assigned set, not 2');
  assert.equal(h.DATA.quiz_paper_scores.food, 1, 'assigned paper score is current');
  assert.equal(h.DATA.quiz_paper_scores.font, null, 'unassigned stays null');
  assert.equal(h.DATA.quiz_paper_scores.listing, null);
});

test('A. answering a third question does not erase earlier answers', () => {
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  h.setChoices({ 'quiz_food_0': rc['quiz_food_0'] });
  h.api.syncQuizProgress();
  const firstText = h.DATA.responses['quiz_food_q1_response'];
  h.setChoices({ 'quiz_food_0': rc['quiz_food_0'], 'quiz_food_4': rc['quiz_food_4'] });
  h.api.syncQuizProgress();
  assert.equal(h.DATA.responses['quiz_food_q1_response'], firstText, 'Q1 preserved');
  assert.ok(h.DATA.responses['quiz_food_q5_response'], 'Q5 now present');
  assert.equal(h.DATA.quiz_score, 2);
});

// ============================== B. Randomized mapping =======================
test('B. displayed letter maps to canonical text; scoring uses runtime letter', () => {
  const h = buildFor('food');
  const paper = h.api.PAPERS.food;
  const idx = 0;
  const name = 'quiz_food_0';
  const qObj = paper.quiz[idx];

  // Force a deterministic shuffled mapping: displayed A corresponds to the
  // canonical correct option B, and displayed A is therefore runtime-correct.
  h.DATA.quiz_option_orders[name] = ['B', 'A', 'C', 'D'];
  h.api.QUIZ_RUNTIME_CORRECT[name] = 'A';

  // The runtime-correct displayed letter must score and map back to the
  // canonical option text for original option B.
  h.setChoices({ [name]: 'A' });
  h.api.syncQuizProgress();

  const expectedText = qObj.options[1].replace(/^[A-D]\.\s*/, '');

  assert.equal(h.DATA.quiz_score, 1);
  assert.equal(
    h.DATA.responses.quiz_food_q1_response,
    expectedText
  );

  // Selecting canonical letter B must not score when runtime-correct is A.
  h.setChoices({ [name]: 'B' });
  h.api.syncQuizProgress();

  assert.equal(
    h.DATA.quiz_score,
    0,
    'must score against QUIZ_RUNTIME_CORRECT, not qObj.correct'
  );
});

test('B. syncQuizProgress source scores via QUIZ_RUNTIME_CORRECT, not the canonical letter', () => {
  // Strip line comments so an explanatory mention of qObj.correct doesn't count.
  const code = extractBlock('function syncQuizProgress() {').replace(/\/\/[^\n]*/g, '');
  assert.ok(code.includes('QUIZ_RUNTIME_CORRECT[name]'));
  assert.ok(!code.includes('qObj.correct'), 'canonical letter must not be used in scoring');
});

// ============================== C. Autosave integration =====================
test('C. change handler runs syncQuizProgress before scheduleAutosave for quiz radios', () => {
  const fn = src.slice(src.indexOf('function installAutosaveTriggers()'),
    src.indexOf('function installAutosaveTriggers()') + 1600);
  const change = fn.slice(fn.indexOf("addEventListener('change'"));
  const syncPos = change.indexOf('syncQuizProgress()');
  const schedPos = change.indexOf('scheduleAutosave()');
  assert.ok(syncPos !== -1, 'change handler must call syncQuizProgress');
  assert.ok(schedPos !== -1, 'change handler must call scheduleAutosave');
  assert.ok(syncPos < schedPos, 'sync must run BEFORE scheduleAutosave');
  assert.ok(change.includes("startsWith('quiz_')"), 'gated on quiz_ radio names');
});

test('C. collectFieldsNow synchronizes quiz progress after collecting radios', () => {
  const cf = extractBlock('function collectFieldsNow() {');
  assert.ok(cf.includes('syncQuizProgress();'), 'collectFieldsNow must call syncQuizProgress');
  // functional: an autosave (collectFieldsNow) after two selections carries the
  // stable fields + score in DATA (the autosave payload).
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  h.setChoices({ 'quiz_food_0': rc['quiz_food_0'], 'quiz_food_1': rc['quiz_food_1'] });
  h.api.collectFieldsNow();
  assert.ok(h.DATA.responses['quiz_food_q1_response']);
  assert.ok(h.DATA.responses['quiz_food_q2_response']);
  assert.equal(h.DATA.responses['quiz_food_q3_response'], null);
  assert.equal(h.DATA.quiz_score, 2);
  assert.equal(h.DATA.quiz_total, 5);
  // raw displayed-letter selections preserved as well
  assert.equal(h.DATA.responses['quiz_food_0'], rc['quiz_food_0']);
});

test('C. syncQuizProgress never triggers autosave itself (no recursion)', () => {
  const sync = extractBlock('function syncQuizProgress() {');
  assert.ok(!/scheduleAutosave|saveProgressNow|markAutosaveDirty/.test(sync));
  // calling collectFieldsNow (which calls syncQuizProgress) must not invoke the
  // autosave spies.
  const h = buildFor('food');
  h.setChoices({ 'quiz_food_0': h.api.QUIZ_RUNTIME_CORRECT['quiz_food_0'] });
  h.api.collectFieldsNow();
  assert.equal(h.spies.schedule, 0);
  assert.equal(h.spies.save, 0);
});

// ============================== D. Final behavior ===========================
test('D. finishQuiz delegates to syncQuizProgress with no duplicate scoring', () => {
  const fq = extractBlock('function finishQuiz() {');
  assert.ok(fq.includes('syncQuizProgress();'));
  assert.ok(!fq.includes('score++'), 'finishQuiz must not re-implement scoring');
  assert.ok(!fq.includes('QUIZ_RUNTIME_CORRECT'), 'finishQuiz must not re-implement conversion');
  // exactly one scoring implementation remains in the whole file
  assert.equal((src.match(/score\+\+/g) || []).length, 1, 'single source of truth for scoring');
});

test('D. fully-correct randomized quiz = 5/5; one wrong = 4/5', () => {
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  const all = {};
  for (let i = 0; i < 5; i++) all['quiz_food_' + i] = rc['quiz_food_' + i];
  h.setChoices(all);
  h.api.finishQuiz();
  assert.equal(h.DATA.quiz_score, 5);
  assert.equal(h.DATA.quiz_total, 5);
  assert.equal(h.DATA.quiz_paper_scores.food, 5);

  const wrong = Object.assign({}, all);
  wrong['quiz_food_2'] = otherLetter(rc['quiz_food_2']);
  h.setChoices(wrong);
  h.api.finishQuiz();
  assert.equal(h.DATA.quiz_score, 4);
  assert.equal(h.DATA.quiz_paper_scores.food, 4);
});

// ============================== E. Export compatibility =====================
test('E. partial autosave exports answered quiz columns and blanks the rest', () => {
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  h.setChoices({ 'quiz_food_0': rc['quiz_food_0'], 'quiz_food_1': rc['quiz_food_1'] });
  h.api.syncQuizProgress();
  const row = flattenRecord(makeRecord('food', h.DATA));
  assert.ok(CSV_COLUMNS.includes('quiz_q5_response'));
  assert.equal(row.quiz_q1_response, h.DATA.responses['quiz_food_q1_response']);
  assert.equal(row.quiz_q2_response, h.DATA.responses['quiz_food_q2_response']);
  assert.equal(row.quiz_q3_response, '', 'unanswered exports blank');
  assert.equal(row.quiz_q4_response, '');
  assert.equal(row.quiz_q5_response, '');
  assert.equal(row.quiz_score, 2);
});

test('E. full quiz exports all five stable fields + score 5', () => {
  const h = buildFor('food');
  const rc = h.api.QUIZ_RUNTIME_CORRECT;
  const all = {};
  for (let i = 0; i < 5; i++) all['quiz_food_' + i] = rc['quiz_food_' + i];
  h.setChoices(all);
  h.api.finishQuiz();
  const row = flattenRecord(makeRecord('food', h.DATA));
  for (let n = 1; n <= 5; n++) assert.ok(row['quiz_q' + n + '_response'], 'q' + n + ' exported');
  assert.equal(row.quiz_score, 5);
});
