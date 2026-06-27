// Deterministic tests for the final six-region PDF viewport tracker.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const SURVEY_JS_PATH = path.join(__dirname, '..', 'public', 'researcher_ai_survey.js');
function loadViewportModule() {
  const source = fs.readFileSync(SURVEY_JS_PATH, 'utf8');
  const elements = {};
  function makeElement(id) { return { id, _rect:{top:0,bottom:0}, scrollHeight:0, clientHeight:0,
    addEventListener(){}, removeEventListener(){}, getBoundingClientRect(){return this._rect;},
    classList:{add(){},remove(){},contains(){return false;},toggle(){}}, closest(){return null;},
    querySelectorAll(){return this._canvases||[];}, querySelector(){return null;}, style:{}, innerHTML:'' }; }
  function getElementById(id){ if(!elements[id]) elements[id]=makeElement(id); return elements[id]; }
  const documentStub={ _visibilityState:'visible', get visibilityState(){return this._visibilityState;},
    _focused:true, hasFocus(){return this._focused;}, getElementById, addEventListener(){},removeEventListener(){},
    body:makeElement('body'), documentElement:makeElement('html'), createElement(){return makeElement('tmp');},
    querySelectorAll(){return[];},querySelector(){return null;} };
  const windowStub={addEventListener(){},removeEventListener(){},location:{search:''},innerWidth:1024,innerHeight:768,devicePixelRatio:1};
  class ResizeObserverStub{constructor(cb){this.cb=cb;}observe(){}disconnect(){}}
  const exportNames=['startViewportTracking','stopViewportTracking','tickSegment','updateViewportSegment','closeSegment','openSegment',
    'markPdfContentReady','numBucketsFor','bucketIndexRange','getPdfViewportRange','getPageGeometry','buildSixRegions',
    'refreshRegionGeometry','pickDominantRegion','computeDominantRegion','VIEWPORT_TRACKERS','DATA','nowTs',
    'EXPOSURE_THRESHOLD_MS','MAX_EXPOSURE_BUCKETS','VIEWPORT_HEARTBEAT_MS','aggregateNavigationSequence',
    'countNavigationTransitions','MIN_DWELL_MS','filterNavigableSegments','SIX_REGION_ORDER','SIX_REGION_INDEX'];
  const wrapped=source+'\n;return {'+exportNames.join(',')+'};';
  const factory=new Function('document','window','navigator','ResizeObserver','setInterval','clearInterval',wrapped);
  const mod=factory(documentStub,windowStub,{},ResizeObserverStub,()=>({}),()=>{});
  mod.__getElementById=getElementById; mod.__documentStub=documentStub; return mod;
}
function setGeometry(mod,paperId,{pages,viewportTop=0,viewportHeight=100,visible=true,focused=true}){
  const wrap=mod.__getElementById('pdfWrap-'+paperId); const pane=mod.__getElementById('paperPane-'+paperId);
  wrap._rect={top:-viewportTop,bottom:(pages.at(-1)?.bottom||0)-viewportTop}; wrap.scrollHeight=pages.at(-1)?.bottom||0;
  wrap._canvases=pages.map((p,i)=>({_rect:{top:p.top-viewportTop,bottom:p.bottom-viewportTop},getBoundingClientRect(){return this._rect;}}));
  pane._rect={top:0,bottom:viewportHeight}; pane.clientHeight=viewportHeight;
  mod.__documentStub._visibilityState=visible?'visible':'hidden'; mod.__documentStub._focused=focused;
}
function withClock(fn){const real=Date.now;let current=0;const c={set(v){current=v;Date.now=()=>current;},advance(v){current+=v;Date.now=()=>current;}};Date.now=()=>current;try{return fn(c);}finally{Date.now=real;}}
const PAGES=[{top:0,bottom:200},{top:220,bottom:420},{top:440,bottom:640}];
test('canonical order contains exactly six half-page labels',()=>{const m=loadViewportModule();assert.deepEqual(m.SIX_REGION_ORDER,[
  'P1-Top-Half','P1-Bottom-Half','P2-Top-Half','P2-Bottom-Half','P3-Top-Half','P3-Bottom-Half']);});
test('actual page geometry is split into two non-overlapping halves per page',()=>{const m=loadViewportModule();assert.deepEqual(m.buildSixRegions(PAGES),[
 {label:'P1-Top-Half',top:0,bottom:100},{label:'P1-Bottom-Half',top:100,bottom:200},
 {label:'P2-Top-Half',top:220,bottom:320},{label:'P2-Bottom-Half',top:320,bottom:420},
 {label:'P3-Top-Half',top:440,bottom:540},{label:'P3-Bottom-Half',top:540,bottom:640}]);});
test('partial page geometry is not measurement-ready',()=>withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'font',{pages:PAGES.slice(0,2),viewportHeight:100});m.startViewportTracking('font');m.markPdfContentReady('font');c.advance(6000);m.tickSegment('font');m.stopViewportTracking('font');assert.equal(m.DATA.timing.font.region_exposed_30s_count,'');}));
test('dominant region uses largest overlap and exact tie keeps previous state',()=>{const m=loadViewportModule();const regs=m.buildSixRegions(PAGES);let overlaps=[60,40,0,0,0,0];assert.equal(m.pickDominantRegion(overlaps,regs,null),'P1-Top-Half');overlaps=[50,50,0,0,0,0];assert.equal(m.pickDominantRegion(overlaps,regs,'P1-Bottom-Half'),'P1-Bottom-Half');assert.equal(m.pickDominantRegion(overlaps,regs,null),'P1-Top-Half');});
test('strict exposure threshold: 30000 does not count and 30001 does',()=>{withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'font',{pages:PAGES,viewportTop:0,viewportHeight:100});m.startViewportTracking('font');m.markPdfContentReady('font');c.advance(30000);m.tickSegment('font');m.stopViewportTracking('font');assert.equal(m.DATA.timing.font.region_exposed_30s_count,0);});withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'food',{pages:PAGES,viewportTop:0,viewportHeight:100});m.startViewportTracking('food');m.markPdfContentReady('food');c.advance(30001);m.tickSegment('food');m.stopViewportTracking('food');assert.equal(m.DATA.timing.food.region_exposed_30s_count,1);});});
test('viewport spanning adjacent halves credits both regions proportionally',()=>withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'font',{pages:PAGES,viewportTop:50,viewportHeight:100});m.startViewportTracking('font');m.markPdfContentReady('font');c.advance(60002);m.tickSegment('font');m.stopViewportTracking('font');assert.equal(m.DATA.timing.font.region_exposed_30s_count,2);assert.ok(m.DATA.timing.font.pdf_exposure_proportion_30s>0); }));
test('hidden and unfocused time are excluded',()=>withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'font',{pages:PAGES,viewportTop:0,viewportHeight:100});m.startViewportTracking('font');m.markPdfContentReady('font');c.advance(3000);m.tickSegment('font');setGeometry(m,'font',{pages:PAGES,viewportTop:0,viewportHeight:100,visible:false});m.updateViewportSegment('font');c.advance(30000);m.tickSegment('font');m.stopViewportTracking('font');assert.equal(m.DATA.timing.font.region_exposed_30s_count,0);}));
test('sub-second visits are removed and adjacent duplicates re-collapse',()=>{const m=loadViewportModule();assert.deepEqual(m.aggregateNavigationSequence([{region:'P1-Top-Half',ms:1500},{region:'P1-Bottom-Half',ms:500},{region:'P1-Top-Half',ms:1400}]),['P1-Top-Half']);});
test('backward transitions follow the full six-region order',()=>{const m=loadViewportModule();const r=m.countNavigationTransitions(['P1-Top-Half','P1-Bottom-Half','P2-Top-Half','P2-Bottom-Half','P1-Bottom-Half','P3-Top-Half','P2-Bottom-Half']);assert.equal(r.backward,2);});
test('final navigation output uses only approved labels and preserves zero backward count',()=>withClock(c=>{const m=loadViewportModule();c.set(0);setGeometry(m,'font',{pages:PAGES,viewportTop:0,viewportHeight:100});m.startViewportTracking('font');m.markPdfContentReady('font');c.advance(1500);m.tickSegment('font');setGeometry(m,'font',{pages:PAGES,viewportTop:100,viewportHeight:100});m.updateViewportSegment('font');c.advance(1500);m.tickSegment('font');m.stopViewportTracking('font');const seq=m.DATA.timing.font.navigation_sequence.split('>');assert.deepEqual(seq,['P1-Top-Half','P1-Bottom-Half']);assert.ok(seq.every(x=>m.SIX_REGION_ORDER.includes(x)));assert.equal(m.DATA.timing.font.backward_transition_count,0);}));
test('never-rendered PDF exports blank viewport fields',()=>withClock(c=>{const m=loadViewportModule();c.set(0);m.startViewportTracking('font');c.advance(6000);m.stopViewportTracking('font');assert.equal(m.DATA.timing.font.pdf_exposure_proportion_30s,'');assert.equal(m.DATA.timing.font.region_exposed_30s_count,'');assert.equal(m.DATA.timing.font.navigation_sequence,'');assert.equal(m.DATA.timing.font.backward_transition_count,'');}));
