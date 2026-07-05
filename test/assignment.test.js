// test/assignment.test.js — Boots the real server.js as a child process
// (local-file storage mode, test mode enabled, throwaway admin key, no GCP
// credentials) and exercises ONLY the test-mode assignment endpoints
// (/api/test-mode-status, /api/test-assign-condition) over HTTP on
// localhost. These are the endpoints that can be exercised without a
// real Firestore project, because /api/test-assign-condition deliberately
// never touches ASSIGNMENTS_COLLECTION.
//
// /api/assign-condition (the real, Firestore-transaction-backed count-based
// balancing endpoint) is NOT exercised here, for the same reason
// test/admin-endpoints.test.js never calls Firestore/GCS-dependent routes:
// this environment has no GCP credentials or Firestore emulator available.
// The balancing SELECTION logic and the transaction body are instead unit-
// tested directly (without a live Firestore) in test/assignment-balancing.test.js
// via lib/assignment-balancing.js; end-to-end verification against a real
// Firestore/emulator remains a manual step (see final report).
//
// Run with: npm run test:export (invoked together with export.test.js,
// admin-endpoints.test.js, viewport.test.js)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4174;
const BASE_URL = 'http://127.0.0.1:' + PORT;

const VALID_PAPER_IDS = ['font', 'food', 'listing'];
const VALID_CELLS = ['AI_pre', 'AI_post', 'noAI_pre', 'noAI_post'];

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-test-'));

function waitForServer(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let buf = '';
    function onData(chunk) {
      buf += chunk.toString();
      if (/Server listening on port/.test(buf)) {
        child.stdout.removeListener('data', onData);
        resolve();
      }
    }
    child.stdout.on('data', onData);
    child.once('error', reject);
    const poll = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('Server did not start in time. Output so far: ' + buf));
      }
    }, 100);
    child.once('exit', () => clearInterval(poll));
  });
}

function bootServer(extraEnv) {
  return spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      USE_LOCAL_SUBMISSION_FILE: 'true',
      SUBMISSION_DATA_DIR: TEST_DATA_DIR,
      ADMIN_EXPORT_KEY: 'test-only-admin-key-' + Date.now(),
      OPENAI_API_KEY: '',
      ALLOWED_ORIGIN: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GCS_SUBMISSIONS_BUCKET: ''
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

let serverProcess;

test('setup: boot server.js with test mode enabled', async () => {
  serverProcess = bootServer({ ENABLE_TEST_MODE: 'true' });
  await waitForServer(serverProcess, 10000);
});

test('/api/test-mode-status reports enabled: true and nothing else', async () => {
  const res = await fetch(BASE_URL + '/api/test-mode-status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['enabled']);
  assert.equal(body.enabled, true);
});

test('valid single-paper override returns exactly one assigned paper and two unassigned', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: 'AI_pre',
      papers: ['food'],
      research_role: "Master's student"
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.paper_order, ['food']);
  assert.equal(body.paper_order.length, 1);
  assert.deepEqual(body.unassigned_paper_ids.slice().sort(), ['font', 'listing']);
  assert.equal(body.unassigned_paper_ids.length, 2);
  assert.equal(body.assignment_version, 'v5_balanced_counts_one_paper');
  assert.equal(body.paper_order_version, 'v5_balanced_counts_one_paper');
  assert.equal(body.assignment_cell, 'AI_pre');
  assert.equal(body.assignment_source, 'test_mode_override');
});

test('single-paper override also accepted as a bare string', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: 'noAI_post',
      papers: 'listing',
      research_role: "Master's student"
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.paper_order, ['listing']);
  assert.deepEqual(body.unassigned_paper_ids.slice().sort(), ['font', 'food']);
});

test('no override supplied returns a fixed, reproducible default single paper', async () => {
  const res1 = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell: 'AI_post', research_role: "Master's student" })
  });
  const res2 = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell: 'AI_post', research_role: "Master's student" })
  });
  const body1 = await res1.json();
  const body2 = await res2.json();
  assert.equal(body1.paper_order.length, 1);
  assert.deepEqual(body1.paper_order, body2.paper_order);
  assert.deepEqual(body1.unassigned_paper_ids, body2.unassigned_paper_ids);
  assert.ok(VALID_PAPER_IDS.includes(body1.paper_order[0]));
});

test('old two-paper array override (deprecated shape) is rejected with 400', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: 'AI_pre',
      papers: ['font', 'food'],
      research_role: "Master's student"
    })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /one value/i);
});

test('comma-separated two-paper override string is rejected with 400', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: 'AI_pre',
      papers: 'font,food',
      research_role: "Master's student"
    })
  });
  assert.equal(res.status, 400);
});

test('invalid/unrecognized paper id override is rejected with 400', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: 'AI_pre',
      papers: ['not-a-real-paper'],
      research_role: "Master's student"
    })
  });
  assert.equal(res.status, 400);
});

test('missing/invalid cell is rejected with 400', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell: 'not-a-real-cell', research_role: "Master's student" })
  });
  assert.equal(res.status, 400);
});

test('missing/invalid research_role is rejected with 400', async () => {
  const res = await fetch(BASE_URL + '/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell: 'AI_pre', papers: ['font'] })
  });
  assert.equal(res.status, 400);
});

test('teardown: stop server (test mode enabled)', async () => {
  serverProcess.kill();
});

test('test mode disabled: /api/test-assign-condition returns 403', async () => {
  const proc = bootServer({ ENABLE_TEST_MODE: 'false', PORT: String(PORT) });
  await waitForServer(proc, 10000);
  try {
    const statusRes = await fetch(BASE_URL + '/api/test-mode-status');
    const statusBody = await statusRes.json();
    assert.equal(statusBody.enabled, false);

    const res = await fetch(BASE_URL + '/api/test-assign-condition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cell: 'AI_pre', papers: ['font'], research_role: "Master's student" })
    });
    assert.equal(res.status, 403);
  } finally {
    proc.kill();
  }
});

test('cleanup: remove throwaway data dir', () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
