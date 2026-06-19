const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('researcher_ai_survey.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.com/' });
const { window } = dom;

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  await wait(200);
  const doc = window.document;
  console.log('Loaded. Active page:', doc.querySelector('.page.active')?.id);

  // simulate consent
  const consentRadios = doc.querySelectorAll('input[name=consent]');
  consentRadios[0].checked = true;
  const roleRadios = doc.querySelectorAll('input[name=role]');
  roleRadios[5].checked = true; // phd_y3 -> higher tier
  const famRadios = doc.querySelectorAll('input[name=familiar]');
  famRadios[0].checked = true;

  window.submitConsentPage();
  await wait(50);
  console.log('After consent, active page:', doc.querySelector('.page.active')?.id);
  console.log('Condition:', window.DATA.condition, 'Tier:', window.DATA.expertise_tier, 'CT placement:', window.DATA.ct_scale_placement);
  console.log('Study order:', window.DATA.study_order);

  // jump through nav using navigate(1) repeatedly, filling minimal required fields where needed
  for (let i=0;i<20;i++){
    const activeId = doc.querySelector('.page.active')?.id;
    if (activeId === 'page-s6') {
      // fill nothing required strictly, just continue
      window.finishDemographicsAndAssign();
    } else if (activeId === 'page-instructions') {
      window.enterFullscreenAndStart();
    } else if (activeId === 'page-reflections') {
      window.goToQuiz();
    } else if (activeId === 'page-quiz') {
      window.finishQuiz();
    } else {
      window.navigate(1);
    }
    await wait(20);
    const newId = doc.querySelector('.page.active')?.id;
    console.log(i, '->', newId);
    if (newId === 'page-debrief') break;
  }

  console.log('Quiz score:', window.DATA.quiz_score_total);
  console.log('Violations:', window.DATA.violations.length);
  console.log('Errors so far: none thrown');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
