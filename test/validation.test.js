'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'researcher_ai_survey.js'), 'utf8');

function extractCountResponseWords() {
  const match = src.match(/function countResponseWords\(text\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'countResponseWords() must exist');
  return new Function('text', match[1]);
}

function words(n) {
  return Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');
}

test('official uses the corrected artificial-study instruction', () => {
  assert.ok(src.includes('The studies in this task were artificially constructed. When reviewing each study, please apply the same analytical and scientific reasoning and judgment that you would use when assessing real research.'));
  assert.ok(!src.includes('The study in this task were artificially constructed.'));
});

test('official includes the two new instruction pages in the requested order', () => {
  const artificial = src.indexOf('The studies in this task were artificially constructed.');
  const specific = src.indexOf('Your written responses must be [[B]]specific to the study[[/B]].');
  const fiftyWords = src.indexOf('each response should be about [[B]]50 words or more (around 3 sentences)[[/B]].');
  const outsideTools = src.indexOf('Please complete the task without using any outside tools or resources.');

  assert.ok(artificial !== -1);
  assert.ok(specific > artificial);
  assert.ok(fiftyWords > specific);
  assert.ok(outsideTools > fiftyWords);
});

test('official uses the exact 50-word alert and threshold', () => {
  assert.ok(src.includes('const MIN_RESPONSE_WORDS = 50;'));
  assert.ok(src.includes('Please add more detail. Your response should be at least 50 words and explain the specific feature and why it matters.'));
});

test('official word counting rejects 49 words and accepts 50 words', () => {
  const countResponseWords = extractCountResponseWords();
  assert.equal(countResponseWords(words(49)), 49);
  assert.equal(countResponseWords(words(50)), 50);
});

test('official word counting ignores repeated whitespace', () => {
  const countResponseWords = extractCountResponseWords();
  assert.equal(countResponseWords('  one   two\n\nthree\t four  '), 4);
  assert.equal(countResponseWords('   \n\t  '), 0);
});

test('official immediately clears the red outline after an answer reaches 50 words', () => {
  assert.ok(src.includes('function initializeResponseWordValidation()'));
  assert.ok(src.includes("field.classList.remove('input-error')"));
  assert.ok(src.includes('countResponseWords(field.value) >= MIN_RESPONSE_WORDS'));
  assert.ok(src.includes('initializeResponseWordValidation();'));
});

test('official gives empty required answers priority over the short-response alert', () => {
  const emptyIndex = src.indexOf('} else if (emptyResponseInvalid) {');
  const shortIndex = src.indexOf('} else if (shortResponseInvalid) {');
  assert.ok(emptyIndex !== -1);
  assert.ok(shortIndex > emptyIndex);
});

test('official comprehension quiz is 5 questions per paper', () => {
  const paperSection = src.slice(src.indexOf('const PAPERS = {'), src.indexOf('const PAGE_IDS ='));
  const qCount = (paperSection.match(/\bq:/g) || []).length;
  // 3 papers × 5 questions each = 15.
  assert.equal(qCount, 15);
});

test('each paper defines exactly 5 quiz questions', () => {
  const paperSection = src.slice(src.indexOf('const PAPERS = {'), src.indexOf('const PAGE_IDS ='));
  for (const paperId of ['font', 'food', 'listing']) {
    const start = paperSection.indexOf(`${paperId}: {`);
    assert.ok(start !== -1, `${paperId} block must exist`);
    const nextIds = ['font', 'food', 'listing']
      .map(p => paperSection.indexOf(`${p}: {`, start + 1))
      .filter(i => i > start);
    const end = nextIds.length ? Math.min(...nextIds) : paperSection.length;
    const block = paperSection.slice(start, end);
    const qCount = (block.match(/\bq:/g) || []).length;
    assert.equal(qCount, 5, `${paperId} must have 5 questions`);
    const correctCount = (block.match(/correct:/g) || []).length;
    assert.equal(correctCount, 5, `${paperId} must have 5 answer keys`);
  }
});

test('official uses the updated paper titles and drops the old ones', () => {
  assert.ok(src.includes('Typeface–Context Congruence and the Cohort-Dependent Basis of Font Credibility'));
  assert.ok(src.includes('Matched Calories, Matched Responses? Comparing Post-Lunch Metabolic Patterns'));
  assert.ok(src.includes('Do Online Product Listings Accurately Describe What Arrives in the Package?'));
  // Old font title must be gone.
  assert.ok(!src.includes('Generational Differences in Font-Based Credibility Judgments'));
});

test('quiz transition text announces five questions, not four', () => {
  assert.ok(src.includes('answer five questions about:'));
  assert.ok(!src.includes('answer four questions about:'));
});

test('quiz build is generic over the assigned paper only (no unassigned-paper leak)', () => {
  // Pages are built by iterating the participant's study_order (their single
  // assigned paper), never the full PAPER_IDS list, so unassigned papers are
  // never rendered.
  assert.ok(src.includes('DATA.study_order.forEach((paperId'));
  const buildFn = src.slice(src.indexOf('function buildQuizPages()'), src.indexOf('function finishQuiz()'));
  assert.ok(buildFn.includes('PAPERS[paperId].quiz'));
  assert.ok(!/PAPER_IDS\.forEach/.test(buildFn), 'quiz build must not iterate all papers');
});

test('every quiz question page is required (only the transition page is exempt)', () => {
  // The no-response-required allowlist exempts the transition page but NOT the
  // per-question quiz pages, so each rendered question must be answered.
  const nrStart = src.indexOf('const noResponseRequired');
  assert.ok(nrStart !== -1, 'noResponseRequired allowlist must exist');
  const noResp = src.slice(nrStart, src.indexOf(';', nrStart));
  assert.ok(noResp.includes('page-quiz-transition-'));
  assert.ok(!/'page-quiz-'/.test(noResp), 'question pages must not be exempted wholesale');
  assert.ok(!/page-quiz-\$\{/.test(noResp));
  // Radio/checkbox question groups (one .options-grid per question) require a selection.
  assert.ok(src.includes('.options-grid'));
  assert.ok(src.includes('At least one option'));
});

test('scoring compares against the randomized correct letter (0..N over the assigned paper)', () => {
  const scoreFn = src.slice(src.indexOf('function finishQuiz()'), src.indexOf('function collectFieldsNow()'));
  // Score is accumulated by comparing the displayed choice to the per-render
  // correct letter, so a reshuffled answer order still scores correctly.
  assert.ok(scoreFn.includes('QUIZ_RUNTIME_CORRECT[name]'));
  assert.ok(scoreFn.includes('displayedLetter === correctLetter'));
  // Scoring iterates the assigned paper's own quiz array, so the max equals
  // that paper's question count (5) and the min is 0.
  assert.ok(scoreFn.includes('PAPERS[paperId].quiz.forEach'));
  assert.ok(scoreFn.includes('DATA.study_order.forEach'));
});

// ---------------------------------------------------------------------------
// Exact final quiz content (stems, answer keys, distinctive options) for all
// three papers. `srcU` unescapes the source's \' sequences so plain-text
// literals (e.g. "study's findings") match the file's escaped form.
// ---------------------------------------------------------------------------
const srcU = src.replace(/\\'/g, "'");

// One entry per question: paper id, exact stem, correct-answer key, and at
// least one distinctive option string unique to that question.
const FINAL_QUIZ = [
  // Font
  { paper: 'font', stem: 'What pattern produced the cohort interaction in credibility ratings?', key: 'A', option: 'Both mismatch types reduced credibility for both cohorts, with a larger effect among younger adults' },
  { paper: 'font', stem: 'Which measure was rated first, and why?', key: 'A', option: 'Appropriateness was rated first to anchor later credibility judgments to typeface fit' },
  { paper: 'font', stem: 'Why did the study include three different exemplar families?', key: 'C', option: 'To test whether the pattern generalized beyond one font contrast' },
  { paper: 'font', stem: 'How did younger adults respond to sans-serif institutional messages?', key: 'A', option: 'They judged them less appropriate but nearly as credible' },
  { paper: 'font', stem: 'Which set of messages was used in the experiment?', key: 'A', option: 'a bank account-security notice, a note from a friend, and a message from a coworker' },
  // Food
  { paper: 'food', stem: 'Which feature of the glucose curves most clearly distinguished the two lunches after their peaks?', key: 'B', option: 'The ultra-processed curve fell below baseline for a longer period' },
  { paper: 'food', stem: 'Why did the glucose measurements provide more information about the response over time?', key: 'A', option: 'Glucose was measured repeatedly, while insulin and triglycerides had one post-lunch measurement' },
  { paper: 'food', stem: 'How did self-reported hunger compare with later snack intake?', key: 'A', option: 'Participants reported similar hunger but ate different amounts from the snack tray' },
  { paper: 'food', stem: 'Which comparison is best supported by the study design?', key: 'A', option: 'The short-term responses to two different meal patterns in the same participants' },
  { paper: 'food', stem: "Which account was better supported by the study's findings?", key: 'B', option: 'The food-structure account' },
  // Listing
  { paper: 'listing', stem: 'What could the study not determine?', key: 'B', option: 'How much discrepancy buyers would tolerate before judging a product unacceptable' },
  { paper: 'listing', stem: 'Which procedure did the researchers use to classify listing accuracy?', key: 'B', option: 'any failed claim counted as a mismatch' },
  { paper: 'listing', stem: 'What did examining four product categories allow the researchers to compare?', key: 'A', option: 'Whether listing mismatch rates and types differed across kinds of products' },
  { paper: 'listing', stem: 'Why do the authors argue that star ratings may not closely track item-not-as-described returns?', key: 'D', option: 'Ratings reflect overall purchase satisfaction rather than listing accuracy alone' },
  { paper: 'listing', stem: 'Which description best matches the mismatch-rate results?', key: 'A', option: 'skincare and phone chargers had the highest overall rates' }
];

// Old stems that were replaced and must no longer appear anywhere in PAPERS.
const REMOVED_STEMS = [
  // Original font quiz (Generational-Differences era)
  'Why did the researchers include three different serif/sans-serif font pairs?',
  'What is the best description of how trustworthiness was measured in the study?',
  'Which statement best describes the Generation × Scenario interaction?',
  "What explanation do the authors propose for the study's results?",
  // Original + interim food stems
  'Why did the researchers use a within-subjects crossover design, with each participant eating both lunches on separate days?',
  'Why did the researchers use two blood draws rather than repeated blood sampling across the entire visit?',
  'What did the correlation between the post-lunch glucose dip and snack intake suggest?',
  'What mechanism do the authors propose linking food processing to the different metabolic responses?',
  'What pattern did the repeated glucose measurements reveal?',
  // Original + interim listing stems
  'How did the researchers sample products across the three seller types within each product category?',
  'What did the researchers use as an external benchmark to assess whether audit-coded mismatch scores or star ratings reflected real-world listing problems?',
  'Which pattern of mismatch rates was found across seller types?',
  'Which conclusion is best supported by the category-specific mismatch results?',
  'What did examining four product categories allow the researchers to assess?'
];

function paperBlock(paperId) {
  const section = srcU.slice(srcU.indexOf('const PAPERS = {'), srcU.indexOf('const PAGE_IDS ='));
  const start = section.indexOf(`${paperId}: {`);
  const others = ['font', 'food', 'listing']
    .map(p => section.indexOf(`${p}: {`, start + 1))
    .filter(i => i > start);
  const end = others.length ? Math.min(...others) : section.length;
  return section.slice(start, end);
}

test('every final quiz stem is present in the correct paper block', () => {
  for (const q of FINAL_QUIZ) {
    const block = paperBlock(q.paper);
    assert.ok(block.includes(`q: '${q.stem}'`), `${q.paper}: missing stem "${q.stem}"`);
  }
});

test('each final quiz question carries its exact correct-answer key', () => {
  for (const q of FINAL_QUIZ) {
    const block = paperBlock(q.paper);
    const stemIdx = block.indexOf(`q: '${q.stem}'`);
    assert.ok(stemIdx !== -1, `${q.paper}: missing stem "${q.stem}"`);
    // Slice from this stem to the next question stem (or block end): exactly
    // one `correct:` lives in that window.
    const nextIdx = block.indexOf('q: \'', stemIdx + 5);
    const window = block.slice(stemIdx, nextIdx === -1 ? block.length : nextIdx);
    const keys = window.match(/correct:\s*'([A-D])'/g) || [];
    assert.equal(keys.length, 1, `${q.paper} "${q.stem}" must have exactly one key`);
    assert.ok(window.includes(`correct: '${q.key}'`), `${q.paper} "${q.stem}" key must be ${q.key}`);
  }
});

test('each final quiz question includes its distinctive option text', () => {
  for (const q of FINAL_QUIZ) {
    const block = paperBlock(q.paper);
    assert.ok(block.includes(q.option), `${q.paper} "${q.stem}" missing option "${q.option}"`);
  }
});

test('replaced old Food and Listing (and Font) stems are absent from PAPERS', () => {
  const section = srcU.slice(srcU.indexOf('const PAPERS = {'), srcU.indexOf('const PAGE_IDS ='));
  for (const stem of REMOVED_STEMS) {
    assert.ok(!section.includes(stem), `old stem must be gone: "${stem}"`);
  }
});

test('Food and Listing quizzes begin with the final revised first question', () => {
  const foodBlock = paperBlock('food');
  const listingBlock = paperBlock('listing');
  // The first `q:` in each block is the intended opening question.
  const foodFirst = foodBlock.slice(foodBlock.indexOf('q: \''));
  const listingFirst = listingBlock.slice(listingBlock.indexOf('q: \''));
  assert.ok(foodFirst.startsWith("q: 'Which feature of the glucose curves most clearly distinguished the two lunches after their peaks?'"));
  assert.ok(listingFirst.startsWith("q: 'What could the study not determine?'"));
});
