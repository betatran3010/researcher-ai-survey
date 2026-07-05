'use strict';

// test/frontend-routing.test.js
// Unit tests for the pure page-order + section-numbering logic in
// public/survey-routing.js (window.SurveyRouting), covering both placement
// conditions and both prior-AI-use branches, plus the "gate answer changes"
// rebuild and section numbering.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', 'public', 'survey-routing.js'));

const INSTR = ['page-instructions-0', 'page-instructions-1'];
const QUIZ = ['page-quiz-transition-font', 'page-quiz-font-0'];

function order(placement, hasAiUse) {
  return R.computePageOrder(placement, hasAiUse, INSTR, QUIZ);
}
function idx(arr, id) { return arr.indexOf(id); }
function before(arr, a, b) { return idx(arr, a) !== -1 && idx(arr, b) !== -1 && idx(arr, a) < idx(arr, b); }

// ---- CT-before (pre) -------------------------------------------------------

test('CT-before WITH prior AI use: full ordered sequence', () => {
  const o = order('pre', true);
  assert.deepEqual(o, [
    'page-consent', 'page-about-you', 'page-srl',
    'page-ct', 'page-ai-use-gate', 'page-ai-experience', 'page-ai-evaluation',
    'page-instructions-0', 'page-instructions-1', 'page-study-1',
    'page-quiz-intro', 'page-quiz-transition-font', 'page-quiz-font-0',
    'page-debrief', 'page-submitted'
  ]);
});

test('CT-before WITHOUT prior AI use: no AI-experience / AI-evaluation pages', () => {
  const o = order('pre', false);
  assert.ok(!o.includes('page-ai-experience'));
  assert.ok(!o.includes('page-ai-evaluation'));
  assert.deepEqual(o, [
    'page-consent', 'page-about-you', 'page-srl',
    'page-ct', 'page-ai-use-gate',
    'page-instructions-0', 'page-instructions-1', 'page-study-1',
    'page-quiz-intro', 'page-quiz-transition-font', 'page-quiz-font-0',
    'page-debrief', 'page-submitted'
  ]);
});

test('CT-before: page-ct appears BEFORE page-ai-use-gate (both AI-use branches)', () => {
  assert.ok(before(order('pre', true), 'page-ct', 'page-ai-use-gate'));
  assert.ok(before(order('pre', false), 'page-ct', 'page-ai-use-gate'));
});

test('CT-before: CT with AI (page-ai-evaluation) follows the AI-use gate/experience', () => {
  const o = order('pre', true);
  assert.ok(before(o, 'page-ai-use-gate', 'page-ai-evaluation'));
  assert.ok(before(o, 'page-ai-experience', 'page-ai-evaluation'));
  assert.ok(before(o, 'page-ai-evaluation', 'page-study-1'));
});

// ---- CT-after (post) -------------------------------------------------------

test('CT-after WITH prior AI use: full ordered sequence', () => {
  const o = order('post', true);
  assert.deepEqual(o, [
    'page-consent', 'page-about-you', 'page-srl',
    'page-ai-use-gate', 'page-ai-experience',
    'page-instructions-0', 'page-instructions-1', 'page-study-1',
    'page-quiz-intro', 'page-quiz-transition-font', 'page-quiz-font-0',
    'page-ct', 'page-ai-evaluation',
    'page-debrief', 'page-submitted'
  ]);
});

test('CT-after WITHOUT prior AI use: no AI-experience / AI-evaluation pages', () => {
  const o = order('post', false);
  assert.ok(!o.includes('page-ai-experience'));
  assert.ok(!o.includes('page-ai-evaluation'));
  assert.deepEqual(o, [
    'page-consent', 'page-about-you', 'page-srl',
    'page-ai-use-gate',
    'page-instructions-0', 'page-instructions-1', 'page-study-1',
    'page-quiz-intro', 'page-quiz-transition-font', 'page-quiz-font-0',
    'page-ct',
    'page-debrief', 'page-submitted'
  ]);
});

test('CT-after: task and quiz come BEFORE page-ct', () => {
  for (const ai of [true, false]) {
    const o = order('post', ai);
    assert.ok(before(o, 'page-study-1', 'page-ct'), 'task before CT');
    assert.ok(before(o, 'page-quiz-intro', 'page-ct'), 'quiz-intro before CT');
    assert.ok(before(o, 'page-quiz-font-0', 'page-ct'), 'quiz pages before CT');
  }
});

test('CT-after: the quiz immediately follows the task/instruction sequence (no CT in between)', () => {
  const o = order('post', true);
  // page-study-1 -> page-quiz-intro are adjacent, and no CT page sits between
  // the task and the quiz.
  assert.equal(idx(o, 'page-quiz-intro'), idx(o, 'page-study-1') + 1);
  assert.ok(idx(o, 'page-ct') > idx(o, 'page-quiz-font-0'));
});

// ---- AI-evaluation eligibility --------------------------------------------

test('AI-evaluation (CT with AI) eligibility is based ONLY on prior AI use', () => {
  // Present whenever hasAiUse is true, absent whenever false — in BOTH
  // placements. (It never depends on the assigned experimental condition.)
  assert.ok(order('pre', true).includes('page-ai-evaluation'));
  assert.ok(order('post', true).includes('page-ai-evaluation'));
  assert.ok(!order('pre', false).includes('page-ai-evaluation'));
  assert.ok(!order('post', false).includes('page-ai-evaluation'));
});

// ---- gate answer change rebuilds correct order ----------------------------

test('changing the AI-use gate answer Yes->No rebuilds the order without conditional AI pages', () => {
  const yes = order('pre', true);
  const no = order('pre', false);
  assert.ok(yes.includes('page-ai-experience') && yes.includes('page-ai-evaluation'));
  assert.ok(!no.includes('page-ai-experience') && !no.includes('page-ai-evaluation'));
  // page-ct stays before the gate regardless of the answer.
  assert.ok(before(no, 'page-ct', 'page-ai-use-gate'));
});

// ---- section numbering -----------------------------------------------------

test('section numbers follow the actual order (CT-before)', () => {
  assert.deepEqual(R.computeSectionNumbers('pre', true), {
    about_you: 1, srl: 2, ct: 3, ai_use_gate: 4, ai_experience: 4, ai_evaluation: 5, task: 6, quiz: 7, debrief: 8
  });
  assert.deepEqual(R.computeSectionNumbers('pre', false), {
    about_you: 1, srl: 2, ct: 3, ai_use_gate: 4, task: 5, quiz: 6, debrief: 7
  });
});

test('section numbers follow the actual order (CT-after: quiz before CT)', () => {
  const post = R.computeSectionNumbers('post', true);
  assert.deepEqual(post, {
    about_you: 1, srl: 2, ai_use_gate: 3, ai_experience: 3, task: 4, quiz: 5, ct: 6, ai_evaluation: 7, debrief: 8
  });
  // The numbering must agree with the page order: quiz's number < ct's number.
  assert.ok(post.quiz < post.ct);
  assert.ok(post.task < post.quiz);
  assert.deepEqual(R.computeSectionNumbers('post', false), {
    about_you: 1, srl: 2, ai_use_gate: 3, task: 4, quiz: 5, ct: 6, debrief: 7
  });
});

test('section numbers are consistent with computePageOrder for every branch', () => {
  // For each visible section, its assigned number must be monotonic in the
  // actual page order (earlier page => smaller-or-equal number).
  const sectionForPage = {
    'page-about-you': 'about_you', 'page-srl': 'srl', 'page-ct': 'ct',
    'page-ai-use-gate': 'ai_use_gate', 'page-ai-experience': 'ai_experience',
    'page-ai-evaluation': 'ai_evaluation', 'page-study-1': 'task',
    'page-quiz-intro': 'quiz', 'page-debrief': 'debrief'
  };
  for (const placement of ['pre', 'post']) {
    for (const ai of [true, false]) {
      const o = order(placement, ai);
      const nums = R.computeSectionNumbers(placement, ai);
      let lastNum = 0;
      for (const pageId of o) {
        const key = sectionForPage[pageId];
        if (!key) continue;
        const n = nums[key];
        assert.ok(typeof n === 'number', `${key} has a number in ${placement}/${ai}`);
        assert.ok(n >= lastNum, `section numbers non-decreasing along the page order (${placement}/${ai} at ${pageId}: ${n} < ${lastNum})`);
        lastNum = n;
      }
    }
  }
});
