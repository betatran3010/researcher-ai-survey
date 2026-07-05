'use strict';

// test/assignment-balancing.test.js
// Unit tests for the persistent count-based ("balanced") assignment logic and
// the reconciliation derivation, using lib/assignment-balancing.js directly
// with a faithful FAKE Firestore transaction — no live Firestore project or
// emulator required. Covers the selection algorithm, the transaction body
// (assignment + counters updated together, returning-participant idempotency),
// and the reconciliation counting.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CELL_IDS,
  PAPER_IDS,
  COUNTER_VERSION,
  normalizeCounts,
  chooseBalancedAssignment,
  applyIncrement,
  assignWithinTransaction,
  deriveCountsFromAssignments
} = require('../lib/assignment-balancing');

// ---- helpers ---------------------------------------------------------------

// Build a full counts document from a compact spec:
//   { AI_pre: { font, food, listing }, ... }  (missing => 0)
function counts(spec) {
  const cells = {};
  for (const c of CELL_IDS) {
    const s = (spec && spec[c]) || {};
    cells[c] = { papers: { font: s.font || 0, food: s.food || 0, listing: s.listing || 0 } };
  }
  return normalizeCounts({ cells });
}

// A faithful, minimal fake of a Firestore transaction + document refs. Writes
// are STAGED and only applied to the backing store on commit(), mirroring
// Firestore's atomic commit (a thrown body / failed commit leaves the store
// untouched — nothing is applied partially).
function makeFakeFirestore(initial) {
  const store = Object.assign({}, initial || {});
  function ref(path) { return { path }; }
  function newTx() {
    const staged = [];
    let wroteAfterRead = false;
    let sawWrite = false;
    return {
      staged,
      reads: [],
      async get(r) {
        if (sawWrite) wroteAfterRead = true; // reads-before-writes invariant
        this.reads.push(r.path);
        const d = store[r.path];
        return { exists: d !== undefined, data: () => d };
      },
      set(r, data) {
        sawWrite = true;
        staged.push({ path: r.path, data });
      },
      get readsBeforeWritesViolated() { return wroteAfterRead; },
      commit() { for (const w of staged) store[w.path] = w.data; }
    };
  }
  return { store, ref, newTx };
}

const A_REF = { path: 'assignments/hashX' };
const C_REF = { path: 'assignment_counters/counts' };

function makeDocBuilder(extra) {
  return (choice, unassigned) => Object.assign({
    hashed_participant_id: 'hashX',
    ai_condition: choice.cell.ai_condition,
    critical_thinking_placement: choice.cell.ct_placement,
    assignment_cell: choice.cell.cell,
    paper_ids: [choice.paper_id],
    paper_order: [choice.paper_id],
    unassigned_paper_ids: unassigned
  }, extra || {});
}

// ---- selection: least-filled primary cell ---------------------------------

test('new participant is assigned to the uniquely least-filled primary cell', () => {
  const c = counts({
    AI_pre: { font: 5, food: 5, listing: 5 },
    AI_post: { font: 5, food: 5, listing: 5 },
    noAI_pre: { font: 1, food: 1, listing: 1 }, // total 3 — the unique min
    noAI_post: { font: 5, food: 5, listing: 5 }
  });
  const choice = chooseBalancedAssignment(c, () => 0);
  assert.equal(choice.cell.cell, 'noAI_pre');
  assert.deepEqual(choice.tied_cells, ['noAI_pre']);
});

test('tied least-filled primary cells are the ONLY eligible choices', () => {
  // AI_post and noAI_pre both total 2 (the min); the other two total 9.
  const c = counts({
    AI_pre: { font: 3, food: 3, listing: 3 },
    AI_post: { font: 2, food: 0, listing: 0 },
    noAI_pre: { font: 0, food: 1, listing: 1 },
    noAI_post: { font: 3, food: 3, listing: 3 }
  });
  const chosen = new Set();
  // Enumerate every tie-break index the RNG could return.
  for (let i = 0; i < 8; i++) {
    const choice = chooseBalancedAssignment(c, (n) => i % n);
    assert.deepEqual(choice.tied_cells.slice().sort(), ['AI_post', 'noAI_pre']);
    chosen.add(choice.cell.cell);
  }
  // Only the two tied cells are ever chosen — never the heavier cells.
  assert.deepEqual([...chosen].sort(), ['AI_post', 'noAI_pre']);
});

// ---- selection: least-filled paper WITHIN the chosen cell -----------------

test('paper is selected from the least-filled paper within the chosen cell', () => {
  const c = counts({
    AI_pre: { font: 4, food: 1, listing: 4 },   // total 9 => uniquely least-filled cell; food is min paper
    AI_post: { font: 4, food: 4, listing: 4 },  // total 12
    noAI_pre: { font: 4, food: 4, listing: 4 }, // total 12
    noAI_post: { font: 4, food: 4, listing: 4 } // total 12
  });
  const choice = chooseBalancedAssignment(c, () => 0);
  assert.equal(choice.cell.cell, 'AI_pre');
  assert.equal(choice.paper_id, 'food');
  assert.deepEqual(choice.tied_papers, ['food']);
});

test('tied least-filled papers within the chosen cell are the only eligible papers', () => {
  const c = counts({
    AI_pre: { font: 0, food: 0, listing: 3 },   // total 3 => least-filled cell; font & food tie for min paper
    AI_post: { font: 2, food: 2, listing: 2 },  // total 6
    noAI_pre: { font: 2, food: 2, listing: 2 }, // total 6
    noAI_post: { font: 2, food: 2, listing: 2 } // total 6
  });
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const choice = chooseBalancedAssignment(c, (n) => i % n);
    assert.deepEqual(choice.tied_papers.slice().sort(), ['font', 'food']);
    seen.add(choice.paper_id);
  }
  assert.deepEqual([...seen].sort(), ['font', 'food']);
});

test('exactly one valid paper is assigned, with the other two unassigned', async () => {
  const fs = makeFakeFirestore();
  const tx = fs.newTx();
  const { assignment } = await assignWithinTransaction(tx, {
    assignmentRef: A_REF,
    counterRef: C_REF,
    makeAssignmentDoc: makeDocBuilder(),
    randomInt: () => 0
  });
  assert.equal(assignment.paper_ids.length, 1);
  assert.ok(PAPER_IDS.includes(assignment.paper_ids[0]));
  assert.equal(assignment.unassigned_paper_ids.length, 2);
  assert.ok(!assignment.unassigned_paper_ids.includes(assignment.paper_ids[0]));
});

// ---- transaction: assignment + counters updated together ------------------

test('assignment and counters are staged together in the same transaction', async () => {
  const fs = makeFakeFirestore(); // empty store -> first participant
  const tx = fs.newTx();
  const { created } = await assignWithinTransaction(tx, {
    assignmentRef: A_REF,
    counterRef: C_REF,
    makeAssignmentDoc: makeDocBuilder(),
    randomInt: () => 0
  });
  assert.equal(created, true);
  // Both writes staged, reads strictly before writes.
  assert.equal(tx.readsBeforeWritesViolated, false);
  const paths = tx.staged.map(w => w.path).sort();
  assert.deepEqual(paths, ['assignment_counters/counts', 'assignments/hashX']);

  // Nothing applied to the store until commit (atomicity: a failed commit
  // would leave NOTHING partially written).
  assert.equal(fs.store['assignments/hashX'], undefined);
  assert.equal(fs.store['assignment_counters/counts'], undefined);

  tx.commit();
  const counter = fs.store['assignment_counters/counts'];
  assert.equal(counter.counter_version, COUNTER_VERSION);
  // Exactly one assignment counted, and it matches the stored assignment.
  const asg = fs.store['assignments/hashX'];
  const cell = asg.assignment_cell;
  const paper = asg.paper_ids[0];
  assert.equal(counter.cells[cell].total, 1);
  assert.equal(counter.cells[cell].papers[paper], 1);
  const grand = CELL_IDS.reduce((s, c) => s + counter.cells[c].total, 0);
  assert.equal(grand, 1);
});

test('a failed transaction commit leaves NO partial counter/assignment writes', async () => {
  const fs = makeFakeFirestore();
  const tx = fs.newTx();
  await assignWithinTransaction(tx, {
    assignmentRef: A_REF,
    counterRef: C_REF,
    makeAssignmentDoc: makeDocBuilder(),
    randomInt: () => 0
  });
  // Simulate Firestore aborting the transaction (e.g. contention) by NOT
  // committing the staged writes. The store must be exactly as it started.
  assert.deepEqual(fs.store, {});
});

// ---- returning participant idempotency ------------------------------------

test('a returning participant receives the original assignment and does NOT increment counters', async () => {
  const original = {
    hashed_participant_id: 'hashX',
    assignment_cell: 'AI_post',
    paper_ids: ['listing'],
    paper_order: ['listing'],
    unassigned_paper_ids: ['font', 'food']
  };
  const fs = makeFakeFirestore({
    'assignments/hashX': original,
    'assignment_counters/counts': counts({ AI_post: { listing: 1 } })
  });
  const before = JSON.stringify(fs.store['assignment_counters/counts']);
  const tx = fs.newTx();
  const { assignment, created } = await assignWithinTransaction(tx, {
    assignmentRef: A_REF,
    counterRef: C_REF,
    makeAssignmentDoc: makeDocBuilder(),
    randomInt: () => 0
  });
  assert.equal(created, false);
  assert.deepEqual(assignment, original);
  // No writes staged at all for a returning participant.
  assert.equal(tx.staged.length, 0);
  tx.commit();
  assert.equal(JSON.stringify(fs.store['assignment_counters/counts']), before);
});

test('repeated requests for the same participant do not increment counters past the first', async () => {
  const fs = makeFakeFirestore(); // empty -> first request creates
  const tx1 = fs.newTx();
  await assignWithinTransaction(tx1, { assignmentRef: A_REF, counterRef: C_REF, makeAssignmentDoc: makeDocBuilder(), randomInt: () => 0 });
  tx1.commit();
  const afterFirst = JSON.stringify(fs.store['assignment_counters/counts']);

  // Second & third requests see the stored assignment and must not re-count.
  for (let i = 0; i < 2; i++) {
    const tx = fs.newTx();
    const { created } = await assignWithinTransaction(tx, { assignmentRef: A_REF, counterRef: C_REF, makeAssignmentDoc: makeDocBuilder(), randomInt: () => 0 });
    assert.equal(created, false);
    assert.equal(tx.staged.length, 0);
    tx.commit();
  }
  assert.equal(JSON.stringify(fs.store['assignment_counters/counts']), afterFirst);
  const grand = CELL_IDS.reduce((s, c) => s + fs.store['assignment_counters/counts'].cells[c].total, 0);
  assert.equal(grand, 1);
});

// ---- balancing ignores role/expertise -------------------------------------

test('balancing selection ignores role/expertise (depends only on counts)', async () => {
  const c = counts({ noAI_post: { font: 0, food: 0, listing: 0 }, AI_pre: { font: 1, food: 1, listing: 1 }, AI_post: { font: 1, food: 1, listing: 1 }, noAI_pre: { font: 1, food: 1, listing: 1 } });
  // Two calls with wildly different "role"/"expertise" metadata but identical
  // counts + RNG must produce the identical cell + paper.
  const store = { 'assignment_counters/counts': c };
  const fsA = makeFakeFirestore(Object.assign({}, store));
  const fsB = makeFakeFirestore(Object.assign({}, store));
  const a = await assignWithinTransaction(fsA.newTx(), { assignmentRef: A_REF, counterRef: C_REF, randomInt: () => 0, makeAssignmentDoc: makeDocBuilder({ research_role: 'PhD student', research_expertise_stratum: 'higher' }) });
  const b = await assignWithinTransaction(fsB.newTx(), { assignmentRef: A_REF, counterRef: C_REF, randomInt: () => 0, makeAssignmentDoc: makeDocBuilder({ research_role: 'Undergraduate research assistant', research_expertise_stratum: 'lower' }) });
  assert.equal(a.assignment.assignment_cell, b.assignment.assignment_cell);
  assert.equal(a.assignment.paper_ids[0], b.assignment.paper_ids[0]);
  assert.equal(a.assignment.assignment_cell, 'noAI_post'); // the empty (min) cell
});

// ---- concurrency (serialized-retry model) ---------------------------------

test('concurrent assignments stay balanced once serialized (retry sees fresh counts)', async () => {
  // Two participants arrive at an empty study. In Firestore, contending
  // transactions are serialized: the loser retries and reads the winner's
  // committed counts. Model that as two sequential commits and assert the
  // running total is 2 and spread across two DIFFERENT least-filled cells.
  const fs = makeFakeFirestore();
  const txA = fs.newTx();
  const p1 = await assignWithinTransaction(txA, { assignmentRef: { path: 'assignments/p1' }, counterRef: C_REF, randomInt: () => 0, makeAssignmentDoc: (ch, un) => ({ assignment_cell: ch.cell.cell, paper_ids: [ch.paper_id], paper_order: [ch.paper_id], unassigned_paper_ids: un }) });
  txA.commit();
  const txB = fs.newTx();
  const p2 = await assignWithinTransaction(txB, { assignmentRef: { path: 'assignments/p2' }, counterRef: C_REF, randomInt: () => 0, makeAssignmentDoc: (ch, un) => ({ assignment_cell: ch.cell.cell, paper_ids: [ch.paper_id], paper_order: [ch.paper_id], unassigned_paper_ids: un }) });
  txB.commit();
  const counter = fs.store['assignment_counters/counts'];
  const grand = CELL_IDS.reduce((s, c) => s + counter.cells[c].total, 0);
  assert.equal(grand, 2);
  // With a deterministic RNG the second assignment lands in a different cell
  // than the first (the first cell is no longer uniquely least-filled).
  assert.notEqual(p1.assignment.assignment_cell, p2.assignment.assignment_cell);
});

// ---- applyIncrement stays internally consistent ---------------------------

test('applyIncrement bumps the chosen cell total and paper together, without mutating input', () => {
  const base = counts({ AI_pre: { font: 1, food: 2, listing: 0 } });
  const snapshot = JSON.stringify(base);
  const next = applyIncrement(base, 'AI_pre', 'listing');
  assert.equal(JSON.stringify(base), snapshot); // input untouched
  assert.equal(next.cells.AI_pre.papers.listing, 1);
  assert.equal(next.cells.AI_pre.total, 4); // 1+2+1
});

// ---- reconciliation --------------------------------------------------------

const RECON_DOCS = [
  { id: 'a', assignment_cell: 'AI_pre', paper_ids: ['font'] },
  { id: 'b', assignment_cell: 'AI_pre', paper_ids: ['food'] },
  { id: 'c', assignment_cell: 'noAI_post', paper_order: ['listing'] }, // paper_order fallback
  { id: 'd', assignment_cell: 'AI_pre', paper_ids: ['font'] }
];

test('reconciliation dry-run derivation calculates correct totals', () => {
  const { counts: c, valid, malformed } = deriveCountsFromAssignments(RECON_DOCS);
  assert.equal(valid, 4);
  assert.equal(malformed.length, 0);
  assert.equal(c.cells.AI_pre.total, 3);
  assert.equal(c.cells.AI_pre.papers.font, 2);
  assert.equal(c.cells.AI_pre.papers.food, 1);
  assert.equal(c.cells.noAI_post.total, 1);
  assert.equal(c.cells.noAI_post.papers.listing, 1);
});

test('reconciliation reports malformed/unrecognized assignments without counting them', () => {
  const docs = RECON_DOCS.concat([
    { id: 'bad-cell', assignment_cell: 'NOPE', paper_ids: ['font'] },
    { id: 'bad-paper', assignment_cell: 'AI_post', paper_ids: ['banana'] },
    { id: 'two-papers', assignment_cell: 'AI_post', paper_ids: ['font', 'food'] }
  ]);
  const { valid, malformed } = deriveCountsFromAssignments(docs);
  assert.equal(valid, 4); // still only the 4 good ones
  const ids = malformed.map(m => m.id).sort();
  assert.deepEqual(ids, ['bad-cell', 'bad-paper', 'two-papers']);
});

test('reconciliation is idempotent and REPLACES rather than double-counts', () => {
  // Deriving is a pure function of the input, independent of any prior counter
  // value — so a --write (which set()s these totals) can be re-run any number
  // of times without inflating the counts.
  const first = deriveCountsFromAssignments(RECON_DOCS).counts;
  const second = deriveCountsFromAssignments(RECON_DOCS).counts;
  assert.deepEqual(first, second);
  // AI_pre total is 3 whether it's the first run or the hundredth — never 6.
  assert.equal(second.cells.AI_pre.total, 3);
});
