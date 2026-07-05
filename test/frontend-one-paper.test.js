'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','public','researcher_ai_survey.js'),'utf8');
// Page-order/section-numbering logic now lives in the shared, pure
// public/survey-routing.js module (see test/frontend-routing.test.js for the
// behavioral tests); assertions about ordering read it here.
const routing=fs.readFileSync(path.join(__dirname,'..','public','survey-routing.js'),'utf8');
test('frontend page order contains only one study page',()=>{assert.match(routing,/order\.push\('page-study-1'\)/);assert.doesNotMatch(routing,/'page-study-2'/);});
test('frontend consumes unassigned_paper_ids plural',()=>{assert.match(src,/data\.unassigned_paper_ids/);assert.doesNotMatch(src,/data\.unassigned_paper_id(?!s)/);});
test('participant instructions use one-study wording',()=>{assert.match(src,/You will now read one short research study\./);assert.doesNotMatch(src,/You will now read two short research studies/);});
test('test-mode paper override requires one paper',()=>{assert.match(src,/papers\.length === 1/);});
test('server autosave endpoint and 30-second dirty save are wired',()=>{assert.match(src,/\/api\/save-progress/);assert.match(src,/setInterval\(\(\) => \{ if \(autosaveDirty\) saveProgressNow\(\); \}, 30000\)/);});

test('consent page no longer contains old AI familiarity screen or early-exit logic',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','public','researcher_ai_survey.html'),'utf8');
  assert.doesNotMatch(html,/id="rg-familiar"/);
  assert.doesNotMatch(src,/not_familiar_with_ai/);
});
test('revised SRL items use construct-named keys in exact order',()=>{
  const keys=[
    'srl_goal_setting','srl_strategic_planning','srl_task_strategies',
    'srl_elaboration','srl_self_evaluation','srl_help_seeking'
  ];
  let last=-1;
  for(const key of keys){
    const i=src.indexOf(`'${key}'`);
    assert.ok(i>last,`${key} should appear in order`);
    last=i;
  }
});
test('AI research-use gate controls conditional pages without changing assignment request',()=>{
  // Ordering lives in survey-routing.js: the base sequence, the AI-use gate,
  // and the prior-AI-use-gated experience/evaluation pages.
  assert.match(routing,/const order = \['page-consent', 'page-about-you', 'page-srl'\]/);
  assert.match(routing,/order\.push\('page-ai-use-gate'\)/);
  assert.match(routing,/if \(hasAiUse\) order\.push\('page-ai-experience'\)/);
  assert.match(routing,/if \(hasAiUse\) order\.push\('page-ai-evaluation'\)/);
  // The assignment request itself is unchanged and never sends the AI-use answer.
  assert.match(src,/body: JSON\.stringify\(\{\s*stable_participant_id: stableId,\s*research_role: effectiveRole/);
  assert.doesNotMatch(src,/assign-condition[\s\S]{0,300}ai_research_use/);
});
test('general CT is always included and AI evaluation follows it when applicable',()=>{
  // In the CT-after branch, page-ct is followed by the prior-AI-use-gated CT-with-AI page.
  assert.match(routing,/order\.push\('page-ct'\);\s*if \(hasAiUse\) order\.push\('page-ai-evaluation'\)/);
});
test('AI gate clears skipped conditional responses and rebuilds page order',()=>{
  assert.match(src,/function clearConditionalAiResponses\(\)/);
  assert.match(src,/if \(value === 'No'\) clearConditionalAiResponses\(\)/);
  assert.match(src,/if \(curId === 'page-ai-use-gate' && dir > 0\)/);
});
