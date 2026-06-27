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
      _rect: { top: 0, bottom: 0 },
      _canvases: [],
      scrollHeight: 0,
      clientHeight: 0,
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect() { return this._rect; },
      querySelectorAll(selector) { return selector === 'canvas' ? this._canvases : []; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      closest() { return null; }, style: {}, innerHTML: ''
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
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'), documentElement: makeElement('html'),
    createElement() { return makeElement('tmp'); },
    querySelectorAll() { return []; }, querySelector() { return null; }
  };
  const windowStub = {
    addEventListener() {}, removeEventListener() {},
    location: { search: '' }, innerWidth: 1024, innerHeight: 768,
    devicePixelRatio: 1, scrollTo() {}
  };
  class ResizeObserverStub { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
  const exportNames = [
    'startViewportTracking','stopViewportTracking','tickSegment','updateViewportSegment',
    'closeSegment','openSegment','markPdfContentReady','getPdfViewportRange',
    'getPageGeometry','buildNineRegions','refreshRegionGeometry','pickDominantRegion',
    'computeDominantRegion','numBucketsFor','bucketIndexRange','VIEWPORT_TRACKERS',
    'DATA','nowTs','EXPOSURE_THRESHOLD_MS','MAX_EXPOSURE_BUCKETS',
    'VIEWPORT_HEARTBEAT_MS','aggregateNavigationSequence','countNavigationTransitions',
    'MIN_DWELL_MS','filterNavigableSegments','NINE_REGION_ORDER','NINE_REGION_INDEX',
    'NON_NAVIGABLE_REGIONS','DOMINANT_REGION_TIE_RATIO'
  ];
  const wrapped = source + '\n;return {' + exportNames.join(',') + '};';
  const factory = new Function('document','window','navigator','ResizeObserver','setInterval','clearInterval', wrapped);
  const mod = factory(documentStub, windowStub, {}, ResizeObserverStub, () => ({}), () => {});
  mod.__getElementById = getElementById;
  mod.__documentStub = documentStub;
  return mod;
}

function setPaperGeometry(mod, paperId, {
  pageHeights = [300, 300, 300], gap = 30, viewportHeight = 120,
  scrollTop = 0, visible = true, focused = true
} = {}) {
  const wrap = mod.__getElementById('pdfWrap-' + paperId);
  const pane = mod.__getElementById('paperPane-' + paperId);
  const pageTops = [];
  let cursor = 0;
  for (const h of pageHeights) { pageTops.push(cursor); cursor += h + gap; }
  const contentHeight = pageHeights.length ? cursor - gap : 0;
  wrap.scrollHeight = contentHeight;
  wrap._rect = { top: -scrollTop, bottom: contentHeight - scrollTop };
  pane.clientHeight = viewportHeight;
  pane._rect = { top: 0, bottom: viewportHeight };
  wrap._canvases = pageHeights.map((height, i) => ({
    getBoundingClientRect() {
      return { top: pageTops[i] - scrollTop, bottom: pageTops[i] + height - scrollTop };
    }
  }));
  mod.__documentStub._visibilityState = visible ? 'visible' : 'hidden';
  mod.__documentStub._focused = focused;
}

function withClock(fn) {
  const realNow = Date.now;
  let current = 0;
  const clock = {
    set(ms) { current = ms; Date.now = () => current; },
    advance(ms) { current += ms; Date.now = () => current; }
  };
  Date.now = () => current;
  try { return fn(clock); } finally { Date.now = realNow; }
}

test('canonical region order contains exactly the approved nine labels', () => {
  const mod = loadViewportModule();
  assert.deepEqual(mod.NINE_REGION_ORDER, [
    'P1-Top','P1-Middle','P1-Bottom','P2-Top','P2-Middle','P2-Bottom','P3-Top','P3-Middle','P3-Bottom'
  ]);
});

test('actual canvas boundaries are read and each page is split into thirds', () => {
  const mod = loadViewportModule();
  setPaperGeometry(mod, 'font', { pageHeights: [300, 360, 240], gap: 20 });
  const pages = mod.getPageGeometry('font');
  assert.deepEqual(pages, [{top:0,bottom:300},{top:320,bottom:680},{top:700,bottom:940}]);
  const regions = mod.buildNineRegions(pages);
  assert.equal(regions.length, 9);
  assert.deepEqual(regions.slice(0, 3), [
    {label:'P1-Top',top:0,bottom:100},
    {label:'P1-Middle',top:100,bottom:200},
    {label:'P1-Bottom',top:200,bottom:300}
  ]);
  assert.deepEqual(regions.slice(3, 6), [
    {label:'P2-Top',top:320,bottom:440},
    {label:'P2-Middle',top:440,bottom:560},
    {label:'P2-Bottom',top:560,bottom:680}
  ]);
});

test('partial page geometry is not treated as a valid nine-region measurement', () => {
  const mod = loadViewportModule();
  withClock(() => {
    setPaperGeometry(mod, 'font', { pageHeights: [300,300] });
    mod.startViewportTracking('font');
    mod.markPdfContentReady('font');
    assert.deepEqual(mod.VIEWPORT_TRACKERS.font.regions, []);
    mod.stopViewportTracking('font');
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, '');
    assert.equal(mod.DATA.timing.font.navigation_sequence, '');
    assert.equal(mod.DATA.timing.font.backward_transition_count, '');
  });
});

test('dominant state uses largest overlap; first exact tie chooses earlier region', () => {
  const mod = loadViewportModule();
  const regions = mod.buildNineRegions([{top:0,bottom:300},{top:330,bottom:630},{top:660,bottom:960}]);
  const overlaps = regions.map(r => Math.max(0, Math.min(r.bottom, 380) - Math.max(r.top, 250)));
  assert.equal(overlaps[2], 50);
  assert.equal(overlaps[3], 50);
  assert.equal(mod.pickDominantRegion(overlaps, regions, null), 'P1-Bottom');
  overlaps[3] = 70;
  assert.equal(mod.pickDominantRegion(overlaps, regions, null), 'P2-Top');
});

test('near tie retains the previous valid state', () => {
  const mod = loadViewportModule();
  const regions = mod.buildNineRegions([{top:0,bottom:300},{top:330,bottom:630},{top:660,bottom:960}]);
  const overlaps = new Array(9).fill(0);
  overlaps[2] = 100;
  overlaps[3] = 99.5; // within 1% tie ratio
  assert.equal(mod.pickDominantRegion(overlaps, regions, 'P2-Top'), 'P2-Top');
  assert.equal(mod.pickDominantRegion(overlaps, regions, 'P1-Bottom'), 'P1-Bottom');
});

test('strict exposure threshold: 5000ms does not count and 5001ms does', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 0 });
    mod.startViewportTracking('font'); mod.markPdfContentReady('font');
    clock.advance(5000); mod.tickSegment('font'); mod.stopViewportTracking('font');
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, 0);
  });
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 0 });
    mod.startViewportTracking('font'); mod.markPdfContentReady('font');
    clock.advance(5001); mod.tickSegment('font'); mod.stopViewportTracking('font');
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, 1);
  });
});

test('viewport spanning adjacent pages proportionally credits both regions', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    // Visible range 250..380: 50px of P1-Bottom and 50px of P2-Top.
    setPaperGeometry(mod, 'font', { viewportHeight: 130, scrollTop: 250 });
    mod.startViewportTracking('font'); mod.markPdfContentReady('font');
    clock.advance(10002); mod.tickSegment('font'); mod.stopViewportTracking('font');
    const tracker = mod.VIEWPORT_TRACKERS.font;
    assert.equal(Math.round(tracker.regionExposedMs[2]), 5001);
    assert.equal(Math.round(tracker.regionExposedMs[3]), 5001);
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, 2);
  });
});

test('hidden and unfocused time is excluded from exposure and navigation', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 0 });
    mod.startViewportTracking('font'); mod.markPdfContentReady('font');
    clock.advance(2000); mod.tickSegment('font');
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 100, visible: false });
    mod.updateViewportSegment('font'); clock.advance(8000); mod.tickSegment('font');
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 200, visible: true, focused: false });
    mod.updateViewportSegment('font'); clock.advance(8000); mod.tickSegment('font');
    mod.stopViewportTracking('font');
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, 0);
    assert.equal(mod.DATA.timing.font.navigation_sequence, 'P1-Top');
    assert.equal(mod.DATA.timing.font.backward_transition_count, 0);
  });
});

test('sub-1000ms visits are removed and newly adjacent duplicates re-collapse', () => {
  const mod = loadViewportModule();
  assert.deepEqual(mod.aggregateNavigationSequence([
    {region:'P1-Top',ms:1500},{region:'P1-Middle',ms:500},{region:'P1-Top',ms:1400}
  ]), ['P1-Top']);
});

test('backward transitions use the full nine-region reading order', () => {
  const mod = loadViewportModule();
  const result = mod.countNavigationTransitions([
    'P1-Top','P1-Middle','P2-Top','P2-Middle','P1-Bottom','P3-Top','P2-Bottom'
  ]);
  assert.equal(result.backward, 2);
});

test('final sequence contains only approved labels and no Start/Leave tokens', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 0 });
    mod.startViewportTracking('font'); mod.markPdfContentReady('font');
    clock.advance(1500); mod.tickSegment('font');
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 100 });
    mod.updateViewportSegment('font'); clock.advance(1500); mod.tickSegment('font');
    setPaperGeometry(mod, 'font', { viewportHeight: 100, scrollTop: 0 });
    mod.updateViewportSegment('font'); clock.advance(1500); mod.tickSegment('font');
    mod.stopViewportTracking('font');
    const seq = mod.DATA.timing.font.navigation_sequence.split('>');
    assert.deepEqual(seq, ['P1-Top','P1-Middle','P1-Top']);
    assert.ok(seq.every(s => mod.NINE_REGION_ORDER.includes(s)));
    assert.ok(!seq.includes('Start') && !seq.includes('Leave'));
    assert.equal(mod.DATA.timing.font.backward_transition_count, 1);
  });
});

test('never-rendered geometry produces blanks rather than false zeros', () => {
  withClock((clock) => {
    const mod = loadViewportModule();
    clock.set(0);
    setPaperGeometry(mod, 'font', { pageHeights: [], viewportHeight: 100 });
    mod.startViewportTracking('font');
    clock.advance(6000); mod.tickSegment('font'); mod.stopViewportTracking('font');
    assert.equal(mod.DATA.timing.font.pdf_exposure_proportion_5s, '');
    assert.equal(mod.DATA.timing.font.region_exposed_5s_count, '');
    assert.equal(mod.DATA.timing.font.navigation_sequence, '');
    assert.equal(mod.DATA.timing.font.backward_transition_count, '');
  });
});

test('start and stop are idempotent', () => {
  const mod = loadViewportModule();
  setPaperGeometry(mod, 'font');
  mod.startViewportTracking('font');
  const tracker = mod.VIEWPORT_TRACKERS.font;
  mod.startViewportTracking('font');
  assert.equal(mod.VIEWPORT_TRACKERS.font, tracker);
  mod.stopViewportTracking('font');
  assert.doesNotThrow(() => mod.stopViewportTracking('font'));
});
