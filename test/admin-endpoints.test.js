// test/admin-endpoints.test.js — Boots the real server.js as a child
// process (local-file storage mode, a throwaway admin key + temp data dir,
// test mode disabled) and exercises ONLY the admin export endpoints + the
// /admin/export page over HTTP on localhost. Never calls /api/chat, OpenAI,
// GCS, or Firestore-dependent routes (those clients are constructed lazily
// in server.js and are simply never touched by anything this suite calls),
// so this makes no network/paid-API calls and requires no GCP credentials.
//
// Submissions are read/written under a throwaway os.tmpdir() directory
// (SUBMISSION_DATA_DIR), never this repo's real data/ directory, and that
// directory is removed in teardown.
//
// Run with: npm run test:export (invoked together with export.test.js)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4173;
const BASE_URL = 'http://127.0.0.1:' + PORT;
const ADMIN_KEY = 'test-only-admin-key-' + Date.now();

// A throwaway directory for this run's submissions.jsonl / test-submissions.jsonl
// — never the real project data/ directory. Created fresh before boot, removed
// in teardown, so this suite never reads or writes the developer's actual
// local submission data.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-endpoints-test-'));

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

let serverProcess;

test('setup: boot server.js with local-file storage + throwaway admin key', async () => {
  serverProcess = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      USE_LOCAL_SUBMISSION_FILE: 'true',
      SUBMISSION_DATA_DIR: TEST_DATA_DIR,
      ENABLE_TEST_MODE: 'false',
      ADMIN_EXPORT_KEY: ADMIN_KEY,
      OPENAI_API_KEY: '',
      ALLOWED_ORIGIN: '',
      // No GCP project, no ADC, no metadata server in this environment —
      // none of the routes this suite exercises touch Firestore or GCS
      // (both are only constructed lazily on first use by routes this suite
      // never calls), so these are left empty/unset rather than pointed at
      // anything real.
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GCS_SUBMISSIONS_BUCKET: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer(serverProcess, 10000);
});

test('missing admin key returns 401', async () => {
  const res = await fetch(BASE_URL + '/api/admin/export-submissions.csv?type=test');
  assert.equal(res.status, 401);
});

test('incorrect admin key returns 401', async () => {
  const res = await fetch(BASE_URL + '/api/admin/export-submissions.csv?type=test', {
    headers: { 'X-Admin-Key': 'definitely-the-wrong-key' }
  });
  assert.equal(res.status, 401);
});

test('correct admin key downloads accumulated test CSV with UTF-8 BOM and text/csv content type', async () => {
  const res = await fetch(BASE_URL + '/api/admin/export-submissions.csv?type=test', {
    headers: { 'X-Admin-Key': ADMIN_KEY }
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/csv'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0xEF);
  assert.equal(buf[1], 0xBB);
  assert.equal(buf[2], 0xBF);
});

test('correct admin key downloads accumulated test JSON as a plain array', async () => {
  const res = await fetch(BASE_URL + '/api/admin/export-submissions.json?type=test', {
    headers: { 'X-Admin-Key': ADMIN_KEY }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test('production and test exports never mix: invalid type is rejected', async () => {
  const res = await fetch(BASE_URL + '/api/admin/export-submissions.csv?type=bogus', {
    headers: { 'X-Admin-Key': ADMIN_KEY }
  });
  assert.equal(res.status, 400);
});

test('/admin/export page is reachable and reveals no data before authentication', async () => {
  const res = await fetch(BASE_URL + '/admin/export');
  assert.equal(res.status, 200);
  const html = await res.text();
  // The static shell must not embed the admin key, and must not contain any
  // participant-looking data inline (it only renders a form; all real data
  // comes from a later authenticated fetch() call, not page content).
  assert.ok(!html.includes(ADMIN_KEY));
  assert.ok(html.includes('Admin export key'));
});

test('teardown: stop the server and remove the temp data dir', () => {
  if (serverProcess) serverProcess.kill();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
