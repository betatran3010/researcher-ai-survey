// test/viewport.test.js — Deterministic unit tests for the PDF
// viewport-tracking CALCULATION functions themselves (classifyAOI,
// bucketIndexRange, tickSegment, updateViewportSegment, closeSegment,
// openSegment, markPdfContentReady, startViewportTracking,
// stopViewportTracking), as opposed to test/export.test.js's tests, which
// only check that the four resulting fields round-trip correctly through
// the CSV.
//
// IMPORTANT: this file loads the REAL, LIVE public/researcher_ai_survey.js
// source via fs.readFileSync (see loadViewportModule below) and executes it
// in a sandboxed Function with minimal DOM/timer stubs. It does NOT
// hand-transcribe or maintain a separate copy of the viewport-tracking
// code — every function under test here is the literal function defined in
// the production file, byte-for-byte, re-loaded fresh for every test. The
// only things stubbed are: document/window/navigator/ResizeObserver (so the
// file's top-level `document.addEventListener(...)` registrations and the
// `setInterval(autosave, 10000)` call don't throw or leave a real OS timer
// running), and `Date.now` (monkey-patched per test for exact, deterministic
// timing instead of relying on wall-clock time or fake-timer APIs).
//
// Run with: node --test test/viewport.test.js (also wired into
// npm run test:export).

'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SURVEY_JS_PATH = path.join(__dirname, '..', 'public', 'researcher_ai_survey.js');

function loadViewportModule() {
  const source = fs.readFileSync(SURVEY_JS_PATH, 'utf8');

  const elements = {};
  function makeElement(id) {
    return {
      id,
      _rect: { top: 0 },
      scrollHeight: 0,
      clientHeight: 0,
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() { return this._rect; },
      classList: { add() {}, remove() {}, contains() { return false; } },
      closest() { return null; },
      querySelectorAll() { return []; },
      style: {}
    };
  }
  function getElementById(id) {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
  }

  const documentStub = {
    _visibilityState: 'visible',
    get visibilityState() { return this._visibilityState; },
    _focused: true,
    hasFocus() { return this._focused; },
    getElementById,
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    createElement() { return makeElement('tmp'); },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };

  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    location: { search: '' },
    innerWidth: 1024,
    innerHeight: 768
  };

  class ResizeObserverStub {
    constructor(cb) { this.cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  // setInterval/clearInterval are stubbed to no-ops: tests drive tickSegment
  // and updateViewportSegment manually at exact simulated times instead of
  // relying on a real 1s heartbeat, which is what makes the numeric
  // expectations below exact rather than timing-flaky.
  const noopSetInterval = () => ({});
  const noopClearInterval = () => {};

  const exportNames = [
    'startViewportTracking', 'stopViewportTracking', 'tickSegment',
    'updateViewportSegment', 'closeSegment', 'openSegment',
    'markPdfContentReady', 'classifyAOI', 'numBucketsFor',
    'bucketIndexRange', 'getPdfViewportRange', 'VIEWPORT_TRACKERS',
    'DATA', 'nowTs', 'EXPOSURE_THRESHOLD_MS', 'MAX_EXPOSURE_BUCKETS',
    'VIEWPORT_HEARTBEAT_MS', 'aggregateNavigationSequence',
    'countNavigationTransitions', 'MIN_DWELL_MS',
    'filterNavigableSegments', 'NAVIGABLE_REGIONS'
  ];

  const wrapped = source + '\n;return {' + exportNames.join(',') + '};';
  const factory = new Function(
    'document', 'window', 'navigator', 'ResizeObserver',
    'setInterval', 'clearInterval',
    wrapped
  );
  const mod = factory(
    documentStub, windowStub, {}, ResizeObserverStub,
    noopSetInterval, noopClearInterval
  );
  mod.__getElementById = getElementById;
  mod.__documentStub = documentStub;
  return mod;
}

// Points the fake pane/wrap pair for `paperId` at a given content height,
// viewport height, and scroll position, and sets tab visibility/focus.
function setPane(mod, paperId, { contentHeight, viewportHeight, scrollTop = 0, visible = true, focused = true }) {
  const wrap = mod.__getElementById('pdfWrap-' + paperId);
  const pane = mod.__getElementById('paperPane-' + paperId);
  wrap.scrollHeight = contentHeight;
  pane.clientHeight = viewportHeight;
  pane._rect.top = 0;
  wrap._rect.top = -scrollTop;
  mod.__documentStub._visibilityState = visible ? 'visible' : 'hidden';
  mod.__documentStub._focused = focused;
}

// Monkey-patches the real global Date.now for the duration of `fn`, then
// restores it. Used so tickSegment()'s internal `nowTs() -> Date.now()`
// calls see exactly the timestamps a test specifies.
function withClock(fn) {
  const realNow = Date.now;
  let current = 0;
  const clock = {
    set(ms) { current = ms; Date.now = () => current; },
    advance(ms) { current += ms; Date.now = () => current; }
  };
  Date.now = () => current;
  try {
    return fn(clock);
  } finally {
    Date.now = realNow;
  }
}

// Total exposed-ms summed across all buckets for a paperId's tracker —
// used to sanity-check accumulation without depending on a specific
// bucket layout.
// Sum of exposed-ms across all buckets. NOTE: for a 'Full'/wide region that
// spans every bucket, each tick's elapsed-ms gets added to EVERY bucket it
// covers, so this sum is (elapsed-ms-actually-exposed x number-of-buckets-
// covered), not the raw elapsed time -- callers comparing against a single
// tick's elapsed time must either divide by the number of covered buckets
// or inspect a single bucket directly (see maxExposedMs below).
function totalExposedMs(mod, paperId) {
  const tracker = mod.VIEWPORT_TRACKERS[paperId];
  if (!tracker || !tracker.bucketExposedMs) return 0;
  return tracker.bucketExposedMs.reduce((a, b) => a + b, 0);
}

// The exposed-ms recorded on any single bucket -- the right comparison when
// a region spans multiple/all buckets uniformly, since every covered bucket
// receives the identical per-tick elapsed time.
function maxExposedMs(mod, paperId) {
  const tracker = mod.VIEWPORT_TRACKERS[paperId];
  if (!tracker || !tracker.bucketExposedMs) return 0;
  return Math.max(0, ...tracker.bucketExposedMs);
}

// ---------------------------------------------------------------------------
// classifyAOI: pure region-classification function.
// ---------------------------------------------------------------------------

test('classifyAOI: contentHeight <= viewportHeight is always "Full"', () => {
  const mod = loadViewportModule();
  assert.equal(mod.classifyAOI({ contentHeight: 10, viewportHeight: 10, visibleTop: 0, visibleBottom: 10 }), 'Full');
  assert.equal(mod.classifyAOI({ contentHeight: 8, viewportHeight: 20, visibleTop: 0, visibleBottom: 8 }), 'Full');
});

test('classifyAOI: null range is "Unrendered"', () => {
  const mod = loadViewportModule();
  assert.equal(mod.classifyAOI(null), 'Unrendered');
});

test('classifyAOI: Top / Middle / Bottom anchors classify correctly', () => {
  const mod = loadViewportModule();
  // contentHeight=10, viewportHeight=4 -> scrollRange=6, anchors at 0/3/6.
  assert.equal(mod.classifyAOI({ contentHeight: 10, viewportHeight: 4, visibleTop: 0 }), 'Top');
  assert.equal(mod.classifyAOI({ contentHeight: 10, viewportHeight: 4, visibleTop: 3 }), 'Middle');
  assert.equal(mod.classifyAOI({ contentHeight: 10, viewportHeight: 4, visibleTop: 6 }), 'Bottom');
});

// ---------------------------------------------------------------------------
// Full lifecycle scenarios via startViewportTracking -> ... ->
// stopViewportTracking, with an exact simulated clock.
// ---------------------------------------------------------------------------

test('no scrolling: dwelling only at Top produces sequence "Top" (the 0ms initial Unrendered visit is dropped by the min-dwell filter), with exposure crossing 5s ONLY on the buckets actually within the visible Top range', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    // contentHeight=10, viewportHeight=4 -> only buckets 0-3 of 10 are ever
    // in view while sitting at Top (visibleTop=0, visibleBottom=4); the
    // other 6 buckets (covering Middle/Bottom) are never visited, so they
    // can never cross the threshold. Proportion is over ALL buckets in the
    // document, not just the visited subset -- this is the real, intended
    // behavior of pdf_exposure_proportion_5s (it answers "what fraction of
    // the whole document did this participant actually look at", not "of
    // the area visited, how much was looked at").
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 4, scrollTop: 0 });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font'); // opens the 'Top' segment at t=0

    clock.advance(6000); // dwell 6s at Top, well past the 5s threshold
    mod.tickSegment('font'); // simulates one heartbeat tick

    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // The initial 'Unrendered' segment opens and closes in the same instant
    // (0ms dwell) since markPdfContentReady runs immediately after
    // startViewportTracking with no clock advance -- the MIN_DWELL_MS filter
    // drops any aggregated AOI visit under 1000ms, so it never appears here.
    assert.equal(t.navigation_sequence, 'Top');
    assert.equal(t.navigation_transition_count, 0);
    assert.equal(t.backward_transition_count, 0);
    assert.equal(t.pdf_exposure_proportion_5s, 0.4, '4 of 10 buckets (the visible Top range) crossed 5000ms; the other 6 were never visited');
  });
});

test('Top -> Middle -> Bottom (each dwelled >=5s) produces a 4-state sequence with 2 forward transitions', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // scrollRange=8, anchors 0/4/8
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font'); // -> Top

    clock.advance(6000);
    mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // Middle
    mod.updateViewportSegment('font');
    clock.advance(6000);
    mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8 }); // Bottom
    mod.updateViewportSegment('font');
    clock.advance(6000);
    mod.tickSegment('font');

    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // 0ms 'Unrendered' visit is dropped by the min-dwell filter (see the "no
    // scrolling" test above for why).
    assert.equal(t.navigation_sequence, 'Top>Middle>Bottom');
    assert.equal(t.navigation_transition_count, 2);
    assert.equal(t.backward_transition_count, 0);
  });
});

test('Top -> Middle -> Bottom -> Middle produces exactly 1 backward transition', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(2000); mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 });
    mod.updateViewportSegment('font');
    clock.advance(2000); mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8 });
    mod.updateViewportSegment('font');
    clock.advance(2000); mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // back to Middle
    mod.updateViewportSegment('font');
    clock.advance(2000); mod.tickSegment('font');

    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // 0ms 'Unrendered' visit dropped by the min-dwell filter.
    assert.equal(t.navigation_sequence, 'Top>Middle>Bottom>Middle');
    assert.equal(t.navigation_transition_count, 3);
    assert.equal(t.backward_transition_count, 1, 'only Bottom->Middle is a regression; Top->Middle->Bottom is forward');
  });
});

test('collapsing adjacent duplicate states: repeated updateViewportSegment calls at the same scroll position do not grow the sequence', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    // Fire several redundant scroll/resize events at the SAME position.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(500);
      mod.updateViewportSegment('font');
    }

    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // 0ms 'Unrendered' visit dropped by the min-dwell filter.
    assert.equal(t.navigation_sequence, 'Top', 'no duplicate consecutive "Top" entries despite 5 redundant updates');
    assert.equal(t.navigation_transition_count, 0);
  });
});

test('exposure excludes hidden-tab intervals: time while document.visibilityState is "hidden" does not count toward bucket exposure', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0, visible: true });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font'); // 'Full' region, visible

    clock.advance(3000);
    mod.tickSegment('font'); // 3000ms of real exposure accumulated

    // Tab goes hidden; updateViewportSegment closes the visible segment and
    // opens a new (hidden) one.
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0, visible: false });
    mod.updateViewportSegment('font');

    clock.advance(10000); // 10s hidden -- must NOT be added to exposure
    mod.tickSegment('font');

    mod.stopViewportTracking('font');

    assert.equal(maxExposedMs(mod, 'font'), 3000, 'only the 3000ms visible dwell should be counted as exposure per bucket (Full region spans every bucket equally), with zero added for the 10s hidden afterward');
  });
});

test('exposure excludes unfocused-window intervals: time while document.hasFocus() is false does not count toward bucket exposure', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0, focused: true });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    clock.advance(2000);
    mod.tickSegment('font'); // 2000ms exposed while focused

    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0, focused: false });
    mod.updateViewportSegment('font');

    clock.advance(20000); // 20s unfocused -- must NOT be added to exposure
    mod.tickSegment('font');

    mod.stopViewportTracking('font');

    assert.equal(maxExposedMs(mod, 'font'), 2000, 'only the 2000ms focused dwell should be counted as exposure per bucket, with zero added for the 20s unfocused afterward');
  });
});

test('hidden/unfocused time IS still retained in the segment\'s own elapsed-time bookkeeping (rawLog), even though it is excluded from bucket exposure', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0, visible: false });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font'); // becomes ready while already hidden -> still opens a 'Full' segment marked visible:false

    clock.advance(7000); // 7s hidden
    mod.tickSegment('font');
    mod.stopViewportTracking('font');

    const tracker = mod.VIEWPORT_TRACKERS.font;
    const lastSeg = tracker.rawLog[tracker.rawLog.length - 1];
    assert.equal(lastSeg.visible, false);
    assert.equal(lastSeg.duration_ms, 7000, 'segment bookkeeping (rawLog duration_ms) counts elapsed wall-clock time regardless of visibility');
    assert.equal(totalExposedMs(mod, 'font'), 0, 'but none of that 7s was credited as bucket exposure, since the tab was hidden throughout');
  });
});

test('overlapping viewport ranges accumulate correctly: revisiting the same region twice sums exposure rather than resetting it', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    clock.advance(3000); mod.tickSegment('font'); // 3s at Top (first visit)

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8 }); // move to Bottom
    mod.updateViewportSegment('font');
    clock.advance(1000); mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // back to Top (second visit)
    mod.updateViewportSegment('font');
    clock.advance(3000); mod.tickSegment('font'); // another 3s at Top

    mod.stopViewportTracking('font');

    // Top's buckets (the first 4 of 12) should now have accumulated
    // 3000 + 3000 = 6000ms total, crossing the 5000ms threshold, even though
    // neither single visit alone reached it.
    const tracker = mod.VIEWPORT_TRACKERS.font;
    const topBucketsMs = tracker.bucketExposedMs.slice(0, 4);
    topBucketsMs.forEach((ms) => assert.equal(ms, 6000));
    const t = mod.DATA.timing.font;
    assert.ok(t.pdf_exposure_proportion_5s > 0 && t.pdf_exposure_proportion_5s < 1,
      'Top buckets crossed the threshold but Bottom-only-1s buckets did not, so proportion must be strictly between 0 and 1');
  });
});

test('exposure proportion stays within [0, 1] across a varied multi-region scenario', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 30, viewportHeight: 6, scrollTop: 0 });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    const positions = [0, 6, 12, 18, 24, 12, 0, 24];
    positions.forEach((pos) => {
      setPane(mod, 'font', { contentHeight: 30, viewportHeight: 6, scrollTop: pos });
      mod.updateViewportSegment('font');
      clock.advance(1700);
      mod.tickSegment('font');
    });

    mod.stopViewportTracking('font');
    const p = mod.DATA.timing.font.pdf_exposure_proportion_5s;
    assert.ok(typeof p === 'number' && p >= 0 && p <= 1, 'proportion=' + p + ' must be in [0,1]');
  });
});

test('rapid movement to Bottom does not produce full exposure: a sub-second pass through Middle never crosses the 5s threshold there', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    clock.advance(200); mod.tickSegment('font'); // barely dwell at Top

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // Middle, passed through quickly
    mod.updateViewportSegment('font');
    clock.advance(300); mod.tickSegment('font'); // only 300ms at Middle

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8 }); // settle at Bottom
    mod.updateViewportSegment('font');
    clock.advance(8000); mod.tickSegment('font'); // long dwell at Bottom

    mod.stopViewportTracking('font');

    const tracker = mod.VIEWPORT_TRACKERS.font;
    const middleBucketsMs = tracker.bucketExposedMs.slice(4, 8);
    const bottomBucketsMs = tracker.bucketExposedMs.slice(8, 12);
    middleBucketsMs.forEach((ms) => assert.ok(ms < mod.EXPOSURE_THRESHOLD_MS, 'Middle was only dwelled 300ms, must stay under the 5000ms threshold'));
    bottomBucketsMs.forEach((ms) => assert.ok(ms >= mod.EXPOSURE_THRESHOLD_MS, 'Bottom was dwelled 8000ms, must cross the threshold'));
    // The real code rounds the proportion to 4 decimal places (toFixed(4))
    // before storing it, so compare against the same rounded value.
    const expectedProportion = Number((bottomBucketsMs.length / tracker.bucketExposedMs.length).toFixed(4));
    assert.equal(mod.DATA.timing.font.pdf_exposure_proportion_5s, expectedProportion);
  });
});

test('"Full" edge case: content shorter than the viewport is classified Full and can still reach full exposure', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 5, viewportHeight: 20, scrollTop: 0 }); // content shorter than pane
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    clock.advance(6000);
    mod.tickSegment('font');
    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // 0ms 'Unrendered' visit dropped by the min-dwell filter.
    assert.equal(t.navigation_sequence, 'Full');
    assert.equal(t.pdf_exposure_proportion_5s, 1);
  });
});

test('unassigned-paper fields remain absent at the calculation layer: a paper that is never tracked gets none of the four viewport keys written onto it', () => {
  const mod = loadViewportModule();
  // DATA.timing is pre-seeded as { font: {}, food: {}, listing: {} } for all
  // three papers (see the DATA literal near the top of the file), so the key
  // itself always exists -- but for a paper that's never started/stopped
  // (simulating one the participant was never assigned), none of the four
  // viewport fields are ever written onto that object, and no tracker is
  // ever created for it. lib/export-csv.js's `t.pdf_exposure_proportion_5s
  // ?? ''` then reads this as blank, which is what the CSV-level test in
  // test/export.test.js (the "listing" assertions) independently confirms.
  assert.deepEqual(mod.DATA.timing.listing, {});
  assert.equal('pdf_exposure_proportion_5s' in mod.DATA.timing.listing, false);
  assert.equal('navigation_sequence' in mod.DATA.timing.listing, false);
  assert.equal('navigation_transition_count' in mod.DATA.timing.listing, false);
  assert.equal('backward_transition_count' in mod.DATA.timing.listing, false);
  assert.equal(mod.VIEWPORT_TRACKERS.listing, undefined, 'no tracker object is ever created for a paper that was never started');
});

test('numBucketsFor and bucketIndexRange: bucket math is exact for simple integer geometries', () => {
  const mod = loadViewportModule();
  assert.equal(mod.numBucketsFor(10), 10);
  assert.equal(mod.numBucketsFor(0.4), 1, 'numBucketsFor floors to at least 1 bucket');
  assert.equal(mod.numBucketsFor(50000), mod.MAX_EXPOSURE_BUCKETS, 'capped at MAX_EXPOSURE_BUCKETS');

  // contentHeight=10, bucketCount=10 -> 1px buckets.
  assert.deepEqual(mod.bucketIndexRange(0, 4, 10, 10), { start: 0, end: 4 });
  assert.deepEqual(mod.bucketIndexRange(6, 10, 10, 10), { start: 6, end: 10 });
  // Degenerate bucketCount=0 must not divide by zero.
  assert.deepEqual(mod.bucketIndexRange(0, 4, 10, 0), { start: 0, end: 0 });
});

// ---------------------------------------------------------------------------
// Lagun & Lalmas (2016) min-dwell preprocessing: navigation_sequence is
// REQUIRED to drop any aggregated AOI visit under MIN_DWELL_MS (1000ms)
// before transitions/backward-transitions are counted. This is not an
// optional scope choice -- it is part of the cited preprocessing method, and
// the four-step procedure (aggregate consecutive same-AOI intervals -> drop
// any whose total is under MIN_DWELL_MS -> re-collapse newly-adjacent
// duplicates -> THEN compute sequence/transitions/backward-transitions) is
// implemented by aggregateNavigationSequence()/countNavigationTransitions()
// and exercised end-to-end by stopViewportTracking(). The tests below cover
// both the exact worked examples used to specify this behavior and direct,
// synthetic-input unit tests of the two extracted functions themselves.
// ---------------------------------------------------------------------------

test('Example A (full lifecycle): Top 4000ms / Middle 200ms / Bottom 5000ms collapses to Top|Bottom -- the sub-1s Middle visit is dropped entirely', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(4000); mod.tickSegment('font'); // Top: 4000ms

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // Middle
    mod.updateViewportSegment('font');
    clock.advance(200); mod.tickSegment('font'); // Middle: 200ms (< MIN_DWELL_MS)

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8 }); // Bottom
    mod.updateViewportSegment('font');
    clock.advance(5000); mod.tickSegment('font'); // Bottom: 5000ms
    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // 0ms 'Unrendered' visit and the 200ms 'Middle' visit are both dropped by
    // the min-dwell filter, leaving only Top and Bottom.
    assert.equal(t.navigation_sequence, 'Top>Bottom');
    assert.equal(t.navigation_transition_count, 1);
    assert.equal(t.backward_transition_count, 0);
  });
});

test('Example B (full lifecycle): Top 3000ms / Middle 200ms / Top 4000ms collapses to just Top once the sub-1s Middle visit is removed and the two Top visits become adjacent', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(3000); mod.tickSegment('font'); // Top: 3000ms

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // Middle
    mod.updateViewportSegment('font');
    clock.advance(200); mod.tickSegment('font'); // Middle: 200ms (< MIN_DWELL_MS)

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // back to Top
    mod.updateViewportSegment('font');
    clock.advance(4000); mod.tickSegment('font'); // Top: 4000ms
    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    // After dropping the 200ms Middle visit, the two Top visits become
    // adjacent and must re-collapse into a single Top entry.
    assert.equal(t.navigation_sequence, 'Top');
    assert.equal(t.navigation_transition_count, 0);
    assert.equal(t.backward_transition_count, 0);
  });
});

// ---------------------------------------------------------------------------
// Direct, synthetic-input unit tests of aggregateNavigationSequence() and
// countNavigationTransitions() themselves (bypassing the clock/tracker
// lifecycle entirely), matching the user's exact worked examples.
// ---------------------------------------------------------------------------

test('aggregateNavigationSequence: Example A synthetic rawLog -> ["Top","Bottom"]', () => {
  const mod = loadViewportModule();
  const rawLog = [
    { region: 'Top', ms: 4000 },
    { region: 'Middle', ms: 200 },
    { region: 'Bottom', ms: 5000 }
  ];
  const sequence = mod.aggregateNavigationSequence(rawLog);
  assert.deepEqual(sequence, ['Top', 'Bottom']);
  const { transitions, backward } = mod.countNavigationTransitions(sequence);
  assert.equal(transitions, 1);
  assert.equal(backward, 0);
});

test('aggregateNavigationSequence: Example B synthetic rawLog -> ["Top"] (adjacent duplicates re-collapse after the short visit is dropped)', () => {
  const mod = loadViewportModule();
  const rawLog = [
    { region: 'Top', ms: 3000 },
    { region: 'Middle', ms: 200 },
    { region: 'Top', ms: 4000 }
  ];
  const sequence = mod.aggregateNavigationSequence(rawLog);
  assert.deepEqual(sequence, ['Top']);
  const { transitions, backward } = mod.countNavigationTransitions(sequence);
  assert.equal(transitions, 0);
  assert.equal(backward, 0);
});

test('aggregateNavigationSequence: consecutive same-AOI intervals are summed BEFORE the min-dwell filter is applied', () => {
  const mod = loadViewportModule();
  // Two consecutive 600ms Middle intervals (e.g. from two scroll events that
  // never left the Middle AOI) sum to 1200ms, clearing MIN_DWELL_MS, even
  // though neither individual interval would on its own.
  const rawLog = [
    { region: 'Top', ms: 4000 },
    { region: 'Middle', ms: 600 },
    { region: 'Middle', ms: 600 },
    { region: 'Bottom', ms: 5000 }
  ];
  const sequence = mod.aggregateNavigationSequence(rawLog);
  assert.deepEqual(sequence, ['Top', 'Middle', 'Bottom']);
});

test('MIN_DWELL_MS is exactly 1000', () => {
  const mod = loadViewportModule();
  assert.equal(mod.MIN_DWELL_MS, 1000);
});

// ---------------------------------------------------------------------------
// Regression tests added for: (1) the tickSegment-before-close fix in
// stopViewportTracking (a trailing partial interval since the last heartbeat
// must not be lost); (2) filterNavigableSegments() excluding hidden/
// unfocused/Unrendered/Unclassified intervals from navigation_sequence
// before MIN_DWELL_MS aggregation ever runs; (3) the strict ">" exposure
// threshold comparison; (4) the richer rawLog segment schema.
// ---------------------------------------------------------------------------

test('stopping between heartbeat ticks: time elapsed since the last heartbeat is still credited when stopViewportTracking is called directly, with no intervening tickSegment call', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0 }); // Full, spans every bucket
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');

    clock.advance(6000); // 6s pass with NO heartbeat tick fired (participant leaves mid-interval)
    mod.stopViewportTracking('font'); // must flush the trailing 6s itself

    assert.equal(maxExposedMs(mod, 'font'), 6000, 'stopViewportTracking must flush time since the last heartbeat before closing the segment');
    const tracker = mod.VIEWPORT_TRACKERS.font;
    const lastSeg = tracker.rawLog[tracker.rawLog.length - 1];
    assert.equal(lastSeg.duration_ms, 6000);
    assert.equal(mod.DATA.timing.font.pdf_exposure_proportion_5s, 1, 'the full 6s dwell crosses the 5s threshold for every bucket, even with no manual tick before stop');
  });
});

test('final partial interval (after the last heartbeat, before stop) contributes correctly to both exposure and navigation dwell', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(2000); mod.tickSegment('font'); // 2s ticked normally

    // No further manual tick -- simulate 4 more seconds passing with the
    // participant leaving the paper directly (no intervening heartbeat).
    clock.advance(4000);
    mod.stopViewportTracking('font'); // must flush the trailing 4s, for a total Top dwell of 6000ms

    const t = mod.DATA.timing.font;
    assert.equal(t.navigation_sequence, 'Top', 'the full 6000ms Top dwell (2000 ticked + 4000 flushed on stop) must clear MIN_DWELL_MS and appear in navigation_sequence');
    assert.equal(maxExposedMs(mod, 'font'), 6000, 'the trailing 4000ms must also be credited to bucket exposure, not just rawLog bookkeeping');
  });
});

test('navigation_sequence excludes hidden-tab intervals even when dwelled well past MIN_DWELL_MS', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0, visible: true }); // Top, visible
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(3000); mod.tickSegment('font'); // 3s visible at Top

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4, visible: false }); // Middle, but tab HIDDEN
    mod.updateViewportSegment('font');
    clock.advance(4000); mod.tickSegment('font'); // 4s at Middle while hidden -- well over MIN_DWELL_MS

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8, visible: true }); // Bottom, visible again
    mod.updateViewportSegment('font');
    clock.advance(3000); mod.tickSegment('font');
    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    assert.equal(t.navigation_sequence, 'Top>Bottom', 'the 4s hidden Middle visit must never appear in navigation_sequence despite exceeding MIN_DWELL_MS');
    assert.equal(t.navigation_transition_count, 1);
  });
});

test('navigation_sequence excludes unfocused-window intervals even when dwelled well past MIN_DWELL_MS', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 0, focused: true }); // Top, focused
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(3000); mod.tickSegment('font'); // 3s focused at Top

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4, focused: false }); // Middle, window UNFOCUSED
    mod.updateViewportSegment('font');
    clock.advance(4000); mod.tickSegment('font'); // 4s at Middle while unfocused -- well over MIN_DWELL_MS

    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 8, focused: true }); // Bottom, focused again
    mod.updateViewportSegment('font');
    clock.advance(3000); mod.tickSegment('font');
    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    assert.equal(t.navigation_sequence, 'Top>Bottom', 'the 4s unfocused Middle visit must never appear in navigation_sequence despite exceeding MIN_DWELL_MS');
    assert.equal(t.navigation_transition_count, 1);
  });
});

test('navigation_sequence excludes Unrendered and Unclassified intervals regardless of dwell length', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    mod.startViewportTracking('font'); // segment opens as 'Unrendered' (no content yet)
    clock.advance(5000); mod.tickSegment('font'); // 5s Unrendered dwell, well over MIN_DWELL_MS

    // contentHeight=100, viewportHeight=4 -> scrollRange=96, anchors 0/48/96.
    // visibleTop=20 is 20px from the nearest anchor (Top), which exceeds the
    // viewportHeight(4) tie-break window -> classifies as 'Unclassified'.
    setPane(mod, 'font', { contentHeight: 100, viewportHeight: 4, scrollTop: 20 });
    mod.markPdfContentReady('font'); // closes the Unrendered segment, opens 'Unclassified'
    clock.advance(5000); mod.tickSegment('font'); // 5s Unclassified dwell, well over MIN_DWELL_MS

    setPane(mod, 'font', { contentHeight: 100, viewportHeight: 4, scrollTop: 0 }); // Top
    mod.updateViewportSegment('font');
    clock.advance(3000); mod.tickSegment('font');

    setPane(mod, 'font', { contentHeight: 100, viewportHeight: 4, scrollTop: 96 }); // Bottom
    mod.updateViewportSegment('font');
    clock.advance(3000); mod.tickSegment('font');

    mod.stopViewportTracking('font');

    const t = mod.DATA.timing.font;
    assert.equal(t.navigation_sequence, 'Top>Bottom', 'neither the 5s Unrendered preamble nor the 5s Unclassified dwell may ever appear, no matter how long they lasted');
    assert.equal(t.navigation_transition_count, 1);
  });
});

test('exactly EXPOSURE_THRESHOLD_MS (5000ms) does not cross the strict ">5s" threshold', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0 }); // Full, spans every bucket
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(5000); mod.tickSegment('font'); // exactly 5000ms
    mod.stopViewportTracking('font');

    assert.equal(maxExposedMs(mod, 'font'), 5000);
    assert.equal(mod.DATA.timing.font.pdf_exposure_proportion_5s, 0, 'exactly 5000ms must NOT cross a strict ">5000ms" threshold');
  });
});

test('5001ms (one millisecond over EXPOSURE_THRESHOLD_MS) does cross the strict ">5s" threshold', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPane(mod, 'font', { contentHeight: 10, viewportHeight: 10, scrollTop: 0 });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(5001); mod.tickSegment('font');
    mod.stopViewportTracking('font');

    assert.equal(maxExposedMs(mod, 'font'), 5001);
    assert.equal(mod.DATA.timing.font.pdf_exposure_proportion_5s, 1, '5001ms must cross a strict ">5000ms" threshold');
  });
});

test('rawLog segments carry the full recomputable schema: start/end timestamps, duration, content/viewport height, visible range, normalized position, visibility, focus, and AOI', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(1000);
    setPane(mod, 'font', { contentHeight: 12, viewportHeight: 4, scrollTop: 4 }); // Middle: scrollRange=8, visibleTop=4 -> normalized 0.5
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    clock.advance(2000); mod.tickSegment('font');
    mod.stopViewportTracking('font');

    const tracker = mod.VIEWPORT_TRACKERS.font;
    const seg = tracker.rawLog[tracker.rawLog.length - 1];
    assert.equal(seg.region, 'Middle');
    assert.equal(seg.start_ts, 1000);
    assert.equal(seg.end_ts, 3000);
    assert.equal(seg.duration_ms, 2000);
    assert.equal(seg.content_height, 12);
    assert.equal(seg.viewport_height, 4);
    assert.equal(seg.visible_top, 4);
    assert.equal(seg.visible_bottom, 8);
    assert.equal(seg.normalized_position, 0.5);
    assert.equal(seg.visible, true);
    assert.equal(seg.focused, true);
  });
});

test('filterNavigableSegments: directly excludes hidden, unfocused, Unrendered, and Unclassified entries from a synthetic rawLog', () => {
  const mod = loadViewportModule();
  const rawLog = [
    { region: 'Unrendered', duration_ms: 5000, visible: true, focused: true },
    { region: 'Top', duration_ms: 3000, visible: true, focused: true },
    { region: 'Middle', duration_ms: 4000, visible: false, focused: true },
    { region: 'Middle', duration_ms: 4000, visible: true, focused: false },
    { region: 'Unclassified', duration_ms: 5000, visible: true, focused: true },
    { region: 'Bottom', duration_ms: 3000, visible: true, focused: true }
  ];
  const navigable = mod.filterNavigableSegments(rawLog);
  assert.deepEqual(navigable, [
    { region: 'Top', ms: 3000 },
    { region: 'Bottom', ms: 3000 }
  ]);
});
