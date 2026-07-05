'use strict';

// lib/assignment-balancing.js
// ---------------------------------------------------------------------------
// Persistent, count-based ("balanced") assignment logic for the Research
// Scholars survey, extracted into its own module so the pure selection logic
// and the Firestore-transaction body can both be unit-tested without a live
// Firestore project (test/assignment-balancing.test.js drives them with a
// faithful fake transaction).
//
// The study is NO LONGER stratified by expertise/role. Balancing is driven
// ONLY by how many participants have already been assigned to each cell/paper.
// Role, expertise, and demographics never influence which counter is read or
// which cell/paper is chosen.
//
// Hierarchical balancing for each newly assigned participant:
//   1. Choose the primary experimental cell with the lowest running count
//      (AI_pre / AI_post / noAI_pre / noAI_post). Ties are broken by a secure
//      random pick among ONLY the tied cells.
//   2. Within the chosen cell, choose the paper (font / food / listing) with
//      the lowest running count. Ties are broken by a secure random pick among
//      ONLY the tied papers.
// Four-cell balance is the primary target; paper balance is nested inside the
// selected cell and can never override four-cell balance.
//
// Firestore counter document (single doc — no query, so no composite index):
//   Collection: assignment_counters
//   Document:   counts
//   {
//     cells: {
//       AI_pre:    { total, papers: { font, food, listing } },
//       AI_post:   { total, papers: { font, food, listing } },
//       noAI_pre:  { total, papers: { font, food, listing } },
//       noAI_post: { total, papers: { font, food, listing } }
//     },
//     updated_at: <ISO string>,
//     counter_version: "v5_balanced_counts"
//   }
// A missing document, missing cell, or missing field is treated as a count of
// zero. `total` for a cell always equals the sum of its three paper counts
// (every participant is assigned exactly one paper).
// ---------------------------------------------------------------------------

const crypto = require('crypto');

// The four primary experimental cells (AI x CT-placement). Order is stable but
// otherwise arbitrary; ties are broken randomly among tied cells only.
const ASSIGNMENT_CELLS = [
  { ai_condition: 'AI', ct_placement: 'pre', cell: 'AI_pre' },
  { ai_condition: 'AI', ct_placement: 'post', cell: 'AI_post' },
  { ai_condition: 'noAI', ct_placement: 'pre', cell: 'noAI_pre' },
  { ai_condition: 'noAI', ct_placement: 'post', cell: 'noAI_post' }
];

const CELL_IDS = ASSIGNMENT_CELLS.map(c => c.cell);

// The 3-paper pool. Each participant is assigned exactly ONE paper.
const PAPER_IDS = ['font', 'food', 'listing'];

const COUNTER_COLLECTION = 'assignment_counters';
const COUNTER_DOC_ID = 'counts';
const COUNTER_VERSION = 'v5_balanced_counts';

// Cryptographically secure default. Injectable so tests can make tie-breaking
// deterministic and inspect exactly which candidates were eligible.
function secureRandomInt(n) {
  return crypto.randomInt(n);
}

// Coerce any stored value into a non-negative integer count (0 for missing,
// negative, NaN, or non-numeric).
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Normalize a (possibly missing/partial) counter document into a full, fresh
// structure with every cell and every paper present as an integer. The cell
// `total` is always recomputed as the sum of that cell's paper counts so the
// two levels can never drift. Passing null/undefined yields an all-zero doc.
function normalizeCounts(doc) {
  const src = (doc && doc.cells) || {};
  const cells = {};
  for (const cell of CELL_IDS) {
    const cellSrc = src[cell] || {};
    const paperSrc = cellSrc.papers || {};
    const papers = {};
    let total = 0;
    for (const p of PAPER_IDS) {
      const n = toCount(paperSrc[p]);
      papers[p] = n;
      total += n;
    }
    cells[cell] = { total, papers };
  }
  return { cells };
}

// Pick the id with the lowest count. Ties are resolved by a secure random pick
// among ONLY the tied ids. Returns { chosen, tied, min }.
function pickLeastFilled(idsWithCounts, randomInt) {
  const rnd = randomInt || secureRandomInt;
  const min = Math.min(...idsWithCounts.map(x => x.count));
  const tied = idsWithCounts.filter(x => x.count === min).map(x => x.id);
  const chosen = tied[rnd(tied.length)];
  return { chosen, tied, min };
}

// The core hierarchical selection. Pure function of the current counts.
// Returns the chosen cell metadata object, the chosen paper id, the tied sets
// (for tests/logging), and the normalized counts (for the caller to increment
// inside the same transaction).
function chooseBalancedAssignment(counterDoc, randomInt) {
  const rnd = randomInt || secureRandomInt;
  const counts = normalizeCounts(counterDoc);

  // 1) Least-filled primary cell.
  const cellChoice = pickLeastFilled(
    CELL_IDS.map(id => ({ id, count: counts.cells[id].total })),
    rnd
  );
  const cellId = cellChoice.chosen;
  const cellMeta = ASSIGNMENT_CELLS.find(c => c.cell === cellId);

  // 2) Least-filled paper WITHIN that cell.
  const paperChoice = pickLeastFilled(
    PAPER_IDS.map(id => ({ id, count: counts.cells[cellId].papers[id] })),
    rnd
  );

  return {
    cell: cellMeta,
    paper_id: paperChoice.chosen,
    tied_cells: cellChoice.tied,
    tied_papers: paperChoice.tied,
    counts
  };
}

// Return a fresh normalized counts object with the chosen cell + paper each
// incremented by one. Does not mutate the input.
function applyIncrement(normalized, cellId, paperId) {
  const next = normalizeCounts(normalized);
  if (!CELL_IDS.includes(cellId) || !PAPER_IDS.includes(paperId)) {
    throw new Error('applyIncrement: unknown cell/paper ' + cellId + '/' + paperId);
  }
  next.cells[cellId].papers[paperId] += 1;
  next.cells[cellId].total = PAPER_IDS.reduce(
    (s, p) => s + next.cells[cellId].papers[p], 0
  );
  return next;
}

// Serialize normalized counts into the persisted counter-document shape.
function toCounterDoc(normalized, nowIso) {
  return {
    cells: normalizeCounts(normalized).cells,
    updated_at: nowIso,
    counter_version: COUNTER_VERSION
  };
}

// ---------------------------------------------------------------------------
// Transaction body — shared by /api/assign-condition (real Firestore) and the
// unit tests (fake transaction). Reads happen strictly before writes, so this
// is a valid Firestore transaction and is atomic under concurrency, multiple
// Cloud Run instances, and retries.
//
//   t              : a Firestore transaction (or faithful fake) with async
//                    get(ref) and set(ref, data).
//   assignmentRef  : DocumentReference for assignments/{hashedId}.
//   counterRef     : DocumentReference for assignment_counters/counts.
//   makeAssignmentDoc(choice, unassignedPaperIds) : builds the participant's
//                    assignment document (participant-specific fields live in
//                    the caller, not here).
//   randomInt      : optional injectable RNG (defaults to secure).
//   now            : optional () => ISO string (defaults to real clock).
//
// Returns { assignment, created }. For a returning participant (assignment doc
// already exists), returns the ORIGINAL document unchanged with created:false
// and performs NO counter read and NO writes.
// ---------------------------------------------------------------------------
async function assignWithinTransaction(t, opts) {
  const {
    assignmentRef,
    counterRef,
    makeAssignmentDoc,
    randomInt,
    now
  } = opts;
  const nowFn = now || (() => new Date().toISOString());

  const assignmentSnap = await t.get(assignmentRef);
  if (assignmentSnap.exists) {
    // Idempotent: returning participants keep their original assignment and
    // never touch the counters.
    return { assignment: assignmentSnap.data(), created: false };
  }

  const counterSnap = await t.get(counterRef);
  const counterData = counterSnap.exists ? counterSnap.data() : null;

  const choice = chooseBalancedAssignment(counterData, randomInt);
  const unassignedPaperIds = PAPER_IDS.filter(p => p !== choice.paper_id);
  const assignmentDoc = makeAssignmentDoc(choice, unassignedPaperIds);

  const nextCounts = applyIncrement(choice.counts, choice.cell.cell, choice.paper_id);

  // Both writes are staged on the transaction and committed atomically by
  // Firestore. If the transaction fails/retries, neither is applied — the
  // assignment doc and the counters can never be left partially updated.
  t.set(assignmentRef, assignmentDoc);
  t.set(counterRef, toCounterDoc(nextCounts, nowFn()));

  return { assignment: assignmentDoc, created: true };
}

// ---------------------------------------------------------------------------
// Reconciliation: derive counter totals purely from existing assignment
// documents. Used by scripts/reconcile-assignment-counters.js. Idempotent by
// construction (a pure function of its input), and it REPLACES totals rather
// than incrementing, so re-running never double-counts.
//
// docs: array of assignment documents (each ideally carrying an `id` field for
//       reporting). Returns { counts, valid, malformed }.
// ---------------------------------------------------------------------------
function deriveCountsFromAssignments(docs) {
  const counts = normalizeCounts(null); // all zeros
  const malformed = [];
  let valid = 0;

  for (const d of docs || []) {
    const idForReport =
      (d && (d.id || d.hashed_participant_id)) || '(unknown id)';
    const cell = d && d.assignment_cell;

    // Prefer paper_ids; fall back to paper_order. Must be exactly one valid
    // paper (this is a one-paper study).
    const paperArr =
      (d && (Array.isArray(d.paper_ids) ? d.paper_ids
        : Array.isArray(d.paper_order) ? d.paper_order
          : null)) || null;
    const paper = paperArr && paperArr.length === 1 ? paperArr[0] : null;

    if (!CELL_IDS.includes(cell)) {
      malformed.push({ id: idForReport, reason: 'unrecognized assignment_cell: ' + JSON.stringify(cell) });
      continue;
    }
    if (!PAPER_IDS.includes(paper)) {
      malformed.push({ id: idForReport, reason: 'invalid or non-single paper: ' + JSON.stringify(paperArr) });
      continue;
    }

    counts.cells[cell].papers[paper] += 1;
    counts.cells[cell].total += 1;
    valid += 1;
  }

  return { counts, valid, malformed };
}

module.exports = {
  ASSIGNMENT_CELLS,
  CELL_IDS,
  PAPER_IDS,
  COUNTER_COLLECTION,
  COUNTER_DOC_ID,
  COUNTER_VERSION,
  secureRandomInt,
  normalizeCounts,
  pickLeastFilled,
  chooseBalancedAssignment,
  applyIncrement,
  toCounterDoc,
  assignWithinTransaction,
  deriveCountsFromAssignments
};
