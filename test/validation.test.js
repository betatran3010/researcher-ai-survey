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
  const seventyFive = src.indexOf('each response should be about [[B]]75 words or more[[/B]].');
  const outsideTools = src.indexOf('Please complete the task without using any outside tools or resources.');

  assert.ok(artificial !== -1);
  assert.ok(specific > artificial);
  assert.ok(seventyFive > specific);
  assert.ok(outsideTools > seventyFive);
});

test('official uses the exact 75-word alert and threshold', () => {
  assert.ok(src.includes('const MIN_RESPONSE_WORDS = 75;'));
  assert.ok(src.includes('Please add more detail. Your response should be at least 75 words and explain the specific feature and why it matters.'));
});

test('official word counting rejects 74 words and accepts 75 words', () => {
  const countResponseWords = extractCountResponseWords();
  assert.equal(countResponseWords(words(74)), 74);
  assert.equal(countResponseWords(words(75)), 75);
});

test('official word counting ignores repeated whitespace', () => {
  const countResponseWords = extractCountResponseWords();
  assert.equal(countResponseWords('  one   two\n\nthree\t four  '), 4);
  assert.equal(countResponseWords('   \n\t  '), 0);
});

test('official immediately clears the red outline after an answer reaches 75 words', () => {
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

test('official comprehension quiz remains 4 questions per paper', () => {
  const paperSection = src.slice(src.indexOf('const PAPERS = {'), src.indexOf('const PAGE_IDS ='));
  const qCount = (paperSection.match(/q:/g) || []).length;
  assert.equal(qCount, 12);
});
