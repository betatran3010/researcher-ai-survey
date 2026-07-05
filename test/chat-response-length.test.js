'use strict';

// Source-level tests for the /api/chat AI-assistant response-length behavior
// in server.js: the LENGTH RULE system prompt, the 450-token guardrail, and
// the SILENT server-side length-retry (which must never surface to the
// participant). These assert against the handler source the same way
// test/validation.test.js asserts against the frontend source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The /api/chat handler only.
const handler = src.slice(
  src.indexOf("app.post('/api/chat'"),
  src.indexOf('// ---------- Condition/CT-placement')
);
assert.ok(handler.length > 0, 'could not locate the /api/chat handler');

// The silent length-retry block: from the finish-reason branch to the
// turn-count log line (which legitimately reads conversation_history and must
// not be counted as part of the retry logic).
const retryBlock = handler.slice(
  handler.indexOf("if (finishReason === 'length')"),
  handler.indexOf("console.log('[api/chat]'")
);
assert.ok(retryBlock.length > 0, 'could not locate the length-retry block');

// ------------------------------ System prompt ------------------------------

test('system prompt states the exact 3-sentence-or-3-bullet structural rule', () => {
  assert.ok(handler.includes(
    'LENGTH RULE: Reply using either no more than 3 concise prose sentences or no more than 3 bullet points with one concise sentence per bullet.'
  ));
});

test('system prompt requires one concise sentence per bullet', () => {
  assert.ok(handler.includes('3 bullet points with one concise sentence per bullet'));
});

test('system prompt forbids combining prose and bullets', () => {
  assert.ok(handler.includes('Never combine the two formats.'));
});

test('system prompt forbids headings, sub-bullets, introductions, and concluding summaries', () => {
  assert.ok(handler.includes('Do not use headings, sub-bullets, introductions, or concluding summaries.'));
});

test('system prompt includes the 120-word ceiling', () => {
  assert.ok(handler.includes('Keep the entire response under 120 words.'));
});

test('system prompt says to cover multiple parts briefly when possible', () => {
  assert.ok(handler.includes('If the question contains several parts, cover them briefly when possible, but prioritize the most important information rather than elaborating on every possible point.'));
});

test('system prompt requires completing the final sentence', () => {
  assert.ok(handler.includes('Always complete the final sentence.'));
});

test('system prompt no longer contains the old 200-word / five-sentence / numbered-list language', () => {
  assert.ok(!src.includes('under about 200 words'));
  assert.ok(!src.includes('no more than five sentences'));
  assert.ok(!src.includes('brief numbered list'));
  assert.ok(!src.includes('narrow the scope of the answer rather than running long'));
});

// ---------------------------- API configuration ----------------------------

test('max_tokens is exactly 450 and 300 is gone', () => {
  assert.ok(src.includes('max_tokens: 450'));
  assert.ok(!src.includes('max_tokens: 300'));
});

test('both the initial request and the retry use the same 450-token caller', () => {
  // A single callOpenAI(msgs) builder holds model/temperature/max_tokens, and
  // it is invoked exactly twice: the initial request and the one retry.
  assert.ok(/const callOpenAI = \(msgs\) => fetch\(/.test(handler));
  const callerDef = handler.slice(handler.indexOf('const callOpenAI ='), handler.indexOf('});', handler.indexOf('const callOpenAI =')) + 3);
  assert.ok(callerDef.includes('max_tokens: 450'), 'the shared caller must send max_tokens: 450');
  const callSites = handler.match(/callOpenAI\(/g) || [];
  assert.equal(callSites.length, 2, 'exactly two calls: initial + one retry');
  assert.ok(handler.includes('await callOpenAI(messages)'));
  assert.ok(handler.includes('await callOpenAI(retryMessages)'));
});

test('model and temperature are unchanged', () => {
  assert.ok(handler.includes("model: 'gpt-4o-mini'"));
  assert.ok(handler.includes('temperature: 0.3'));
  // Only one model/temperature declaration (shared by both calls).
  assert.equal((handler.match(/temperature: 0\.3/g) || []).length, 1);
  assert.equal((handler.match(/model: 'gpt-4o-mini'/g) || []).length, 1);
});

// ------------------------------ Length handling ----------------------------

test('finish_reason is inspected on the initial response', () => {
  assert.ok(handler.includes('const choice = data?.choices?.[0];'));
  assert.ok(handler.includes('let reply = choice?.message?.content;'));
  assert.ok(handler.includes('const finishReason = choice?.finish_reason;'));
});

test('finish_reason === length produces a server-side warning with participant_id and paper_id', () => {
  assert.ok(handler.includes("if (finishReason === 'length')"));
  const warn = handler.match(/console\.warn\([^\n]*\{ participant_id, paper_id \}\)/);
  assert.ok(warn, 'a console.warn including participant_id and paper_id is required');
});

test('exactly one silent retry is made, using a fresh (non-mutated) messages array', () => {
  assert.ok(retryBlock.includes('const retryMessages = messages.concat('),
    'retry must build a fresh array via concat, not mutate messages');
  assert.ok(!retryBlock.includes('messages.push('), 'retry must not mutate the original messages array');
  assert.equal((retryBlock.match(/callOpenAI\(/g) || []).length, 1, 'exactly one retry call');
});

test('the retry appends exactly the specified rewrite instruction', () => {
  assert.ok(handler.includes(
    'Rewrite the answer as a complete response under 90 words. Use at most 3 concise sentences or 3 bullet points with one concise sentence per bullet. Do not include an introduction, heading, sub-bullets, or conclusion. Preserve the most important content and finish every sentence.'
  ));
});

test('on retry success only the retry reply is used', () => {
  assert.ok(retryBlock.includes('reply = retryReply;'));
});

test('nothing about truncation/finish_reason/retry is returned to the frontend', () => {
  // The only success payload is { reply }.
  assert.ok(handler.includes('return res.json({ reply });'));
  // No response payload leaks length/retry internals.
  const jsonPayloads = handler.match(/res\.json\([^;]*\)/g) || [];
  for (const p of jsonPayloads) {
    assert.ok(!/finish/i.test(p), 'no finish_reason in a response payload');
    assert.ok(!/truncat/i.test(p), 'no truncation info in a response payload');
    assert.ok(!/token/i.test(p), 'no token-limit info in a response payload');
    assert.ok(!/\bretry\b/i.test(p), 'no retry metadata in a response payload');
    assert.ok(!/\bwarning\b/i.test(p), 'no warning in a response payload');
  }
});

test('the silent retry does not count as an extra participant message or AI turn', () => {
  // The turn counter is derived once from conversation_history and the retry
  // block never touches conversation_history or increments a counter.
  assert.ok(handler.includes('turn: conversation_history.length + 1'));
  assert.ok(!retryBlock.includes('conversation_history'),
    'retry must not read or mutate conversation_history');
  assert.ok(!/\+\+/.test(retryBlock), 'retry must not increment any counter');
});

// ------------------------------ Failure handling ---------------------------

const GENERIC = "error: 'The AI assistant could not respond right now. Please try again.'";

test('missing-content behavior is intact (generic 502)', () => {
  assert.ok(handler.includes('if (!reply) {'));
  const missing = handler.slice(handler.indexOf('if (!reply) {'), handler.indexOf('if (!reply) {') + 300);
  assert.ok(missing.includes('res.status(502)'));
  assert.ok(missing.includes(GENERIC));
});

test('retry failure / empty / still-truncated falls back to the existing generic failure', () => {
  // Non-OK retry, missing retry content, or a retry that is itself length-capped
  // all return the same generic participant-facing error, and log server-side.
  assert.ok(retryBlock.includes("!retryReply || retryChoice?.finish_reason === 'length'"));
  assert.equal((retryBlock.match(/The AI assistant could not respond right now\. Please try again\./g) || []).length, 3,
    'all three retry-failure paths use the generic message');
  assert.ok((retryBlock.match(/console\.error/g) || []).length >= 3, 'technical details logged server-side');
});
