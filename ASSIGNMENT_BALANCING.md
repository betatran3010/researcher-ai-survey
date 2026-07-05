# Assignment balancing (count-based) & counter reconciliation

This document describes the persistent, count-based ("balanced") condition
assignment used by `/api/assign-condition`, the Firestore counter document it
maintains, and the one-off reconciliation script used to seed those counts from
assignments that already exist.

Core logic lives in `lib/assignment-balancing.js` (pure, unit-tested) and is
wired into `server.js`. The frontend page-order logic is unrelated to this file
(see `public/survey-routing.js`).

## What changed

Previously each new participant's cell and paper were drawn **independently and
uniformly at random** (`crypto.randomInt`), with no counters and no awareness of
how many participants were already in each condition.

Now each new participant is assigned by **hierarchical count-based balancing**
that reads the running counts first. All the previously-guaranteed properties
are preserved: the stable participant id is still normalized + SHA-256 hashed,
assignments are still stored in Firestore inside a transaction, a returning
participant still gets their original assignment back unchanged, and exactly one
paper is assigned.

## Algorithm (per new participant, in a single Firestore transaction)

1. Read the participant's assignment document (`assignments/{hashedId}`).
2. If it exists, return it unchanged — **no counter is read or modified**.
3. Otherwise read the counter document and, treating any missing document/field
   as `0`:
   1. find the primary cell(s) with the lowest total among `AI_pre`,
      `AI_post`, `noAI_pre`, `noAI_post`;
   2. if several tie, pick uniformly at random **among only the tied cells**
      (`crypto.randomInt`);
   3. within the chosen cell, find the paper(s) with the lowest count among
      `font`, `food`, `listing`;
   4. if several tie, pick uniformly at random **among only the tied papers**.
4. Build the assignment document (unchanged schema) and, in the **same
   transaction**, increment the chosen cell total and the chosen within-cell
   paper count.

Four-cell balance is the primary target; paper balance is nested within the
chosen cell and can never override four-cell balance. Balancing never reads
role, expertise, demographics, process memory, local files, localStorage, or
Cloud Run filesystem state. Because the read and both writes happen in one
Firestore transaction, the scheme is atomic and correct under concurrent
participants, multiple Cloud Run instances, retries, and refreshes/returns.

## Assignment metadata

New assignment documents record:

- `assignment_source: "firestore_balanced_counts"`
- `assignment_version: "v5_balanced_counts_one_paper"`
- `paper_order_version: "v5_balanced_counts_one_paper"` (field retained for
  backward compatibility)

Previously stored assignment documents are **not** altered just because they
carry an older version label.

## Firestore counter document

- Collection: `assignment_counters`
- Document id: `counts`

```json
{
  "cells": {
    "AI_pre":    { "total": 0, "papers": { "font": 0, "food": 0, "listing": 0 } },
    "AI_post":   { "total": 0, "papers": { "font": 0, "food": 0, "listing": 0 } },
    "noAI_pre":  { "total": 0, "papers": { "font": 0, "food": 0, "listing": 0 } },
    "noAI_post": { "total": 0, "papers": { "font": 0, "food": 0, "listing": 0 } }
  },
  "updated_at": "2026-07-04T00:00:00.000Z",
  "counter_version": "v5_balanced_counts"
}
```

A missing document, missing cell, or missing field is treated as `0`. Each
cell's `total` always equals the sum of its three paper counts (every
participant is assigned exactly one paper). This is a single document read by
id — **no query, so no composite index is required.**

## Reconciliation (seed counts from existing assignments)

Run this **once**, against the intended project, **before real recruitment**, so
the counters reflect any assignment documents already in the `assignments`
collection. It never reassigns, deletes, or edits assignment documents; it only
(re)writes the `assignment_counters/counts` document by **replacing** its totals
with values derived from the existing assignments (so re-running is idempotent
and never double-counts). Malformed/unrecognized assignments are reported and
skipped, never silently changed.

Authentication is Application Default Credentials only (same as the server). The
Google Cloud project must be selected explicitly.

### Dry run (prints totals, writes nothing — the default)

```bash
# pick ONE way to name the project:
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run reconcile:counters:dry-run
# or
npm run reconcile:counters -- --project=YOUR_PROJECT_ID --dry-run
```

### Write (persist the derived totals)

```bash
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run reconcile:counters -- --write
# or
npm run reconcile:counters -- --project=YOUR_PROJECT_ID --write
```

Notes:
- The script refuses to run without an explicitly selected project (no ambient
  project), so the wrong database cannot be reconciled by accident.
- The `--` before the flags is required so `npm` forwards them to the script.
- Run the dry run first, confirm the totals look right, then run `--write`.
- Run write-mode reconciliation only **before recruitment begins** or while
  assignment traffic is paused. Do not run `--write` while participants may be
  receiving assignments, because the script replaces the counter document with
  totals derived from its earlier collection read.
