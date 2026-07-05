#!/usr/bin/env node
'use strict';

// scripts/reconcile-assignment-counters.js
// ---------------------------------------------------------------------------
// One-off, idempotent reconciliation of the balancing counter document from
// the assignment documents already present in Firestore. Run this ONCE, after
// selecting the intended Google Cloud project, BEFORE real recruitment starts,
// so the running counts used by /api/assign-condition reflect any assignments
// that already exist (e.g. from earlier pilots or test runs left in the
// `assignments` collection).
//
// This script:
//   * reads every document in the `assignments` collection;
//   * counts each VALID assignment by its assignment_cell and its single
//     assigned paper (paper_ids[0], falling back to paper_order[0]);
//   * REPORTS malformed / unrecognized assignments without changing them;
//   * DERIVES the counter totals and, in --write mode, REPLACES the counter
//     document with those derived totals (it never increments, so running it
//     repeatedly is idempotent and can never double-count);
//   * never reassigns, deletes, or modifies any assignment document;
//   * never runs automatically (not imported by server.js).
//
// It does NOT reassign participants and does NOT reset assignments.
//
// SAFETY:
//   * Default mode is DRY-RUN: it prints the calculated totals and the list of
//     malformed docs and writes NOTHING. You must pass --write to persist.
//   * The Google Cloud project MUST be selected explicitly, via --project=<id>
//     or the GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env var. The script refuses
//     to run against an implicit/ambient project so you cannot accidentally
//     reconcile the wrong database.
//   * Auth is Application Default Credentials only (same as the server) — no
//     service-account key file is read or referenced.
//
// USAGE (see also ASSIGNMENT_BALANCING.md):
//   # 1) Dry run (no writes) against an explicitly named project:
//   GOOGLE_CLOUD_PROJECT=my-project node scripts/reconcile-assignment-counters.js --dry-run
//   #    or, equivalently, with the project as a flag:
//   node scripts/reconcile-assignment-counters.js --project=my-project --dry-run
//
//   # 2) Once the dry-run totals look right, write them:
//   GOOGLE_CLOUD_PROJECT=my-project node scripts/reconcile-assignment-counters.js --write
//
// npm wrappers (note the extra `--` so npm forwards the flags):
//   npm run reconcile:counters:dry-run   # dry run (add -- --project=... if needed)
//   npm run reconcile:counters -- --write --project=my-project
// ---------------------------------------------------------------------------

const { Firestore } = require('@google-cloud/firestore');
const {
  COUNTER_COLLECTION,
  COUNTER_DOC_ID,
  COUNTER_VERSION,
  CELL_IDS,
  PAPER_IDS,
  deriveCountsFromAssignments
} = require('../lib/assignment-balancing');

const ASSIGNMENTS_COLLECTION = 'assignments';

function parseArgs(argv) {
  const args = { write: false, dryRun: false, project: null };
  for (const a of argv.slice(2)) {
    if (a === '--write') args.write = true;
    else if (a === '--dry-run' || a === '--dryrun') args.dryRun = true;
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length).trim();
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error('Unknown argument: ' + a);
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log([
    'Reconcile the assignment-balancing counter document from existing assignments.',
    '',
    'Modes:',
    '  (default)      DRY RUN — compute and print totals, write nothing.',
    '  --dry-run      Explicit dry run (same as default).',
    '  --write        Persist the derived totals (REPLACES the counter doc).',
    '',
    'Project (required, choose one):',
    '  --project=<id>              Google Cloud project id, or',
    '  GOOGLE_CLOUD_PROJECT=<id>   env var (GCLOUD_PROJECT also accepted).',
    '',
    'Examples:',
    '  GOOGLE_CLOUD_PROJECT=my-project node scripts/reconcile-assignment-counters.js --dry-run',
    '  node scripts/reconcile-assignment-counters.js --project=my-project --write'
  ].join('\n'));
}

function resolveProject(args) {
  return (
    args.project ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    null
  );
}

function formatCounts(counts) {
  const lines = [];
  let grand = 0;
  for (const cell of CELL_IDS) {
    const c = counts.cells[cell];
    const papers = PAPER_IDS.map(p => `${p}=${c.papers[p]}`).join(', ');
    lines.push(`  ${cell.padEnd(10)} total=${c.total}   (${papers})`);
    grand += c.total;
  }
  lines.push(`  ${'TOTAL'.padEnd(10)} valid=${grand}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const projectId = resolveProject(args);
  if (!projectId) {
    console.error(
      'ERROR: no Google Cloud project selected.\n' +
      'Pass --project=<id> or set GOOGLE_CLOUD_PROJECT. Refusing to run against ' +
      'an ambient/implicit project so the wrong database cannot be reconciled by accident.'
    );
    process.exit(2);
  }

  // --write takes precedence if both are (mistakenly) passed; otherwise default
  // to a safe dry run.
  const willWrite = args.write === true;
  const mode = willWrite ? 'WRITE' : 'DRY-RUN';

  console.log(`[reconcile] project = ${projectId}`);
  console.log(`[reconcile] mode    = ${mode}`);
  console.log(`[reconcile] reading collection "${ASSIGNMENTS_COLLECTION}" ...`);

  const firestore = new Firestore({ projectId });

  const snap = await firestore.collection(ASSIGNMENTS_COLLECTION).get();
  const docs = [];
  snap.forEach(d => {
    docs.push(Object.assign({ id: d.id }, d.data()));
  });
  console.log(`[reconcile] read ${docs.length} assignment document(s).`);

  const { counts, valid, malformed } = deriveCountsFromAssignments(docs);

  console.log('\n[reconcile] derived counter totals:');
  console.log(formatCounts(counts));

  if (malformed.length > 0) {
    console.log(`\n[reconcile] WARNING: ${malformed.length} malformed/unrecognized assignment(s) (NOT counted, NOT modified):`);
    for (const m of malformed) {
      console.log(`  - ${m.id}: ${m.reason}`);
    }
  } else {
    console.log('\n[reconcile] no malformed assignments found.');
  }

  if (!willWrite) {
    console.log('\n[reconcile] DRY RUN — no changes written. Re-run with --write to persist these totals.');
    return;
  }

  const counterRef = firestore.collection(COUNTER_COLLECTION).doc(COUNTER_DOC_ID);
  const payload = {
    cells: counts.cells,
    updated_at: new Date().toISOString(),
    counter_version: COUNTER_VERSION,
    reconciled_at: new Date().toISOString(),
    reconciled_valid_count: valid,
    reconciled_malformed_count: malformed.length
  };
  // set() with no merge REPLACES the document, so re-running is idempotent and
  // never double-counts.
  await counterRef.set(payload);
  console.log(`\n[reconcile] WROTE ${COUNTER_COLLECTION}/${COUNTER_DOC_ID} (${valid} valid assignment(s) counted).`);
}

main().catch(err => {
  console.error('[reconcile] FAILED:', err);
  process.exit(1);
});
