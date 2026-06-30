'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','public','researcher_ai_survey.js'),'utf8');
test('frontend page order contains only one study page',()=>{assert.match(src,/order\.push\('page-study-1'\)/);assert.doesNotMatch(src,/order\.push\([\s\S]{0,100}'page-study-2'/);});
test('frontend consumes unassigned_paper_ids plural',()=>{assert.match(src,/data\.unassigned_paper_ids/);assert.doesNotMatch(src,/data\.unassigned_paper_id(?!s)/);});
test('participant instructions use one-study wording',()=>{assert.match(src,/You will now read one short research study\./);assert.doesNotMatch(src,/You will now read two short research studies/);});
test('test-mode paper override requires one paper',()=>{assert.match(src,/papers\.length === 1/);});
test('server autosave endpoint and 30-second dirty save are wired',()=>{assert.match(src,/\/api\/save-progress/);assert.match(src,/setInterval\(\(\) => \{ if \(autosaveDirty\) saveProgressNow\(\); \}, 30000\)/);});
