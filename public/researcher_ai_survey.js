/* ============================================================
   Researcher AI Survey — frontend logic
   ============================================================ */

// pdf.js requires an explicit worker script when not using a bundler —
// without this, getDocument() silently fails and study PDFs never render.
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ---------- Core state ----------
function genId(){ return 'P-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
function nowIso(){ return new Date().toISOString(); }
function nowTs(){ return Date.now(); }

const DATA = {
  participant_id: genId(),
  session_start_iso: nowIso(),
  session_end_iso: null,
  prolific_id: '',
  consent: false,
  consent_status: null,        // 'granted' | 'declined'
  media_release_status: null,  // 'granted' | 'declined'
  screening_exit_reason: null, // 'not_familiar_with_ai' | 'declined_consent' | null
  completion_status: 'in_progress', // 'in_progress' | 'completed' | 'exited_early'
  final_submission_timestamp: null,

  // Legacy fields, kept for backward compatibility with existing export logic.
  expertise_tier: null,
  condition: null,
  ct_scale_placement: null,
  study_order: [],
  study_1_id: null, study_2_id: null,
  study_1_title: null, study_2_title: null,

  // New backend randomization variables (spec-required names). Mirror the
  // legacy fields above so neither the existing export pipeline nor the new
  // spec's required variable names need to be removed.
  research_expertise_stratum: null, // mirrors expertise_tier
  ai_condition: null,               // mirrors condition
  critical_thinking_placement: null,// mirrors ct_scale_placement
  assigned_paper_1_id: null, assigned_paper_1_title: null,
  assigned_paper_2_id: null, assigned_paper_2_title: null,
  unassigned_paper_id: null,
  paper_order: [], // mirrors study_order (2 entries)

  responses: {},
  ai_chats: { font: [], food: [], listing: [] },
  timing: { font:{}, food:{}, listing:{} },
  ai_paper_aggregates: { font:{}, food:{}, listing:{} },
  ai_message_log: [],
  behavioral_events: [],
  revision_log: [],
  paste_events: [],
  draft_history: [],
  keystroke_counts: {},
  violations: [],
  quiz: {},
  quiz_score: 0,
  quiz_total: 0,
  fullscreen_used: false,
  logs: {}
};

// ---------- Option constants ----------
const ROLE_OPTIONS = [
  {l:'Undergraduate research assistant', tier:'lower'},
  {l:'Post-baccalaureate research assistant or lab manager', tier:'lower'},
  {l:"Master's student", tier:'lower'},
  {l:'First-year PhD student', tier:'lower'},
  {l:'Second-year PhD student', tier:'higher'},
  {l:'Third-year PhD student', tier:'higher'},
  {l:'Fourth-year PhD student', tier:'higher'},
  {l:'Fifth-year or later PhD student', tier:'higher'},
  {l:'Postdoctoral scholar', tier:'higher'}
];

// Section 4, Q1 — "For which research-related purposes do you use AI
// assistants? Select all that apply." (verbatim option list, spec section 4)
const AI_PURPOSE_OPTIONS = [
  {l:'Finding information or practical guidance'},
  {l:'Understanding papers, methods, or concepts'},
  {l:'Summarizing research materials'},
  {l:'Brainstorming research questions, hypotheses, study designs, or other research ideas'},
  {l:'Writing, editing, presentations, or research communication'},
  {l:'Coding, mathematics, quantitative analysis, or other technical work'},
  {l:'Interpreting results'},
  {l:'Evaluating arguments, evidence, methods, or research designs'},
  {l:'Talking through a research decision'},
  {l:'Other', specify:true}
];

const TENURE_OPTIONS = [
  'I am just starting out',
  'Less than 6 months',
  '6–12 months',
  '1–2 years',
  'More than 2 years'
];

// Section 4, Q4 sliders (verbatim left/right anchor text from spec)
const SLIDERS = [
  {key:'slider_role_balance', q:'When I use AI for research work, my role is...', left:'AI does the work, I use what it produces', right:'I do the work, AI at most assists my decisions'},
  {key:'slider_dependence', q:'Over time, using AI has made me...', left:'More capable and independent on my own in research tasks', right:'More reliant on AI for research tasks I used to do myself'},
  {key:'slider_origin', q:'When I use AI for research work, it feels like it is...', left:'Surfacing information that already exists', right:'Creating something new or creative'},
  {key:'slider_personhood', q:'AI feels to me like...', left:'A neutral, impersonal instrument', right:'Something with its own point of view'}
];

const LANG_OPTIONS = ['English','Other'];

const REVIEWED_OPTIONS = ['None','1–5','6–15','16–30','More than 30'];

const COUNTRY_OPTIONS = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
  'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi',
  'Cambodia','Cameroon','Canada','Cape Verde','Central African Republic','Chad','Chile','China','Colombia',
  'Comoros','Costa Rica','Croatia','Cuba','Cyprus','Czech Republic','Denmark','Djibouti','Dominican Republic',
  'Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji',
  'Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea',
  'Guinea-Bissau','Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland',
  'Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait',
  'Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg',
  'Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius',
  'Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia',
  'Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia',
  'Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines',
  'Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia',
  'Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal',
  'Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia',
  'South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland',
  'Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago',
  'Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom',
  'United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia',
  'Zimbabwe','Prefer not to say'
];

const UNDERSTANDING_OPTIONS = [
  'I just use it. I do not think much about how it works.',
  'I have a general sense. It learns from a lot of text and generates responses.',
  'I understand it reasonably well. I know about training, prompting, and limitations.',
  'I understand it technically. I work with or study AI systems.'
];

const ENGAGEMENT_OPTIONS = [
  {l:'I used it to clarify or check my understanding of the study.'},
  {l:'I used it to summarize part or all of the study.'},
  {l:'I used it to help develop, refine, or question my own ideas.'},
  {l:'I used it to suggest possible interpretations, strengths, limitations, or future directions.'},
  {l:'I used it to organize, phrase, or improve my written responses.'},
  {l:'I read its responses but made little or no use of them in my answers.'},
  {l:'I did not use the AI assistant for this study.', exclusive:true}
];

// SRL — 21 items, 6 categories (verbatim from spec)
const SRL_ITEMS = [
  // Goal Setting
  ['srl_goal_standards','I set personal standards for the quality of my research work.','goal_setting'],
  ['srl_goal_shortlong','I set short-term goals for what I want to accomplish in a specific research task, as well as longer-term goals for the overall project.','goal_setting'],
  ['srl_goal_deadlines','I set realistic deadlines for completing research work.','goal_setting'],
  // Strategic Planning
  ['srl_plan_questions','I ask myself questions about what I need to understand or evaluate before I begin.','strategic_planning'],
  ['srl_plan_alternatives','I think of alternative ways to approach a research problem and choose the one that seems most useful.','strategic_planning'],
  ['srl_plan_adapt','When planning my research work, I use and adapt strategies that have worked in the past.','strategic_planning'],
  ['srl_plan_organize','I organize my time and resources to accomplish my research goals to the best of my ability.','strategic_planning'],
  // Task Strategies
  ['srl_task_ownwords','I try to translate new information into my own words.','task_strategies'],
  ['srl_task_change','I change strategies when I do not make progress.','task_strategies'],
  ['srl_task_notes','When working on research tasks, I make notes to help organize my thoughts.','task_strategies'],
  ['srl_task_examples','I create my own examples or interpretations to make information more meaningful.','task_strategies'],
  // Elaboration
  ['srl_elab_relate','When learning something new, I try to relate it to what I already know.','elaboration'],
  ['srl_elab_combine','When learning something new, I combine different sources of information, such as papers, prior readings, AI tools, websites, or other materials.','elaboration'],
  ['srl_elab_prior','I draw on my prior knowledge and research experience when interpreting new information.','elaboration'],
  // Self-Evaluation
  ['srl_eval_know','I usually know how well I understand something once I have finished working on it.','self_evaluation'],
  ['srl_eval_different','After finishing a research task, I consider whether the task could be approached differently.','self_evaluation'],
  ['srl_eval_learned','I think about what I have learned after I finish a research task.','self_evaluation'],
  // Help Seeking
  ['srl_help_identify','I try to identify specific questions I can ask when I need help.','help_seeking'],
  ['srl_help_guidance','When I am unsure where to start, I seek guidance to help me decide how to approach the task.','help_seeking'],
  ['srl_help_beforeown','I ask other people or AI what to think about a research task before I have formed my own view.','help_seeking'],
  ['srl_help_own_r','Even when I am having trouble understanding something, I prefer to work through it on my own before asking for help. (Reverse-scored)','help_seeking']
];

// Critical-Thinking scale — 6 items (verbatim), shared by pre/post placement
const CT_ITEMS_LIST = (function(){
  const pairs = [
    'ct_credibility','I critically evaluate the credibility of the sources of information I encounter.',
    'ct_evidence','I consider whether the evidence presented supports the conclusion being made.',
    'ct_alternatives','I consider alternative explanations before accepting a research claim.',
    'ct_bias','I reflect on possible biases in my own thinking when making judgments.',
    'ct_assumptions','I question the assumptions underlying information or suggestions provided by AI tools.',
    'ct_compare','I compare AI-generated information or recommendations with other sources before relying on them.'
  ];
  const out = [];
  for (let i=0;i<pairs.length;i+=2){ out.push({key:pairs[i], label:pairs[i+1]}); }
  return out;
})();

// Spec section 8 says to insert the identical "How You Evaluate Research
// Claims" section for the after-task placement, so pre and post share one
// intro string rather than separate wording.
const CT_INTRO = 'Please indicate how well each statement describes the way you typically evaluate research claims, evidence, or explanations. Answer based on how you usually behave, not how you think you should behave. There are no right or wrong answers.';
const CT_INTRO_PRE = CT_INTRO;
const CT_INTRO_POST = CT_INTRO;
const CT_SCALE_NOTE = '1 = Not at all true for me, 7 = Very true for me';

// Spec section 6, "Standardized In-Task Questions For Each Assigned Study" —
// this exact 5-question set is repeated verbatim for Paper 1 and Paper 2
// (no per-paper custom wording), so the label lives here rather than per
// paper as in the previous version.
const STANDARD_Q_DEFS = [
  {suffix:'q1', type:'textarea', label:'What do you think are the main strengths of this study?'},
  {suffix:'q2', type:'textarea', label:'What do you think are the main limitations of this study?'},
  {suffix:'q3', type:'textarea', label:'How could the study be improved, or what should researchers investigate next?'},
  {suffix:'q4', type:'textarea', label:'What broader implications might follow from these findings beyond those stated in the paper?'},
  {suffix:'convincing', type:'scale7', label:'How convincing do you find this paper?'}
];

// ---------- Papers ----------
const PAPERS = {
  font: {
    id:'font',
    title:'Generational Differences in Font-Based Credibility Judgments Across Everyday Contexts',
    pdfFile:'papers/font.pdf',
    quiz:[
      { q:'Why did the researchers include three different serif/sans-serif font pairs?',
        options:[
          'A. To compare whether some font pairs produced stronger credibility judgments because they were easier to read',
          'B. To determine whether the generational difference remained when the specific typefaces changed, rather than depending on one familiar font contrast',
          'C. To ensure that each communicative context was presented in a different serif/sans-serif pair',
          'D. To examine whether older and younger adults differed in their familiarity with the six individual typefaces'
        ], correct:'B' },
      { q:'What is the best description of how trustworthiness was measured in the study?',
        options:[
          'A. Participants rated the trustworthiness of each font version separately, and the two ratings were compared',
          'B. Participants rated how well each typeface fit the context, which was used as an indirect measure of trust',
          'C. Participants selected the more trustworthy version and then ranked all three font pairs',
          'D. Participants chose which of two identically worded versions they found more trustworthy'
        ], correct:'D' },
      { q:'Which statement best describes the Generation × Scenario interaction?',
        options:[
          'A. Older adults showed their strongest serif preference in print-legacy contexts, whereas younger adults showed their clearest sans-serif preference in digitally native contexts',
          'B. Older adults preferred serif typefaces more than younger adults across all four scenarios, and the size of this difference remained constant across contexts',
          'C. Younger adults\' confidence ratings varied more across scenarios than older adults\' ratings did',
          'D. The interaction was driven mainly by the bank security notice, which produced the largest generational difference'
        ], correct:'A' },
      { q:'What explanation do the authors propose for the study\'s results?',
        options:[
          'A. Communication context determines which typeface category appears credible: serif fonts naturally fit formal contexts, whereas sans-serif fonts naturally fit digital contexts, regardless of the reader\'s background',
          'B. Age-related differences in visual processing make serif fonts easier for older adults to interpret and sans-serif fonts easier for younger adults to interpret',
          'C. Repeated exposure to a typeface category in particular communicative contexts builds familiarity with that pairing, so what feels credible depends on a person\'s exposure history',
          'D. Individual typefaces possess relatively stable credibility cues, but different scenarios change how strongly readers attend to those cues'
        ], correct:'C' }
    ]
  },
  food: {
    id:'food',
    title:'Does Food Processing Change Blood Sugar and Insulin Responses to a Calorie-Matched Lunch?',
    pdfFile:'papers/food.pdf',
    quiz:[
      { q:'Why did the researchers use a within-subjects crossover design, with each participant eating both lunches on separate days?',
        options:[
          'A. To compare each participant\'s responses across lunches while reducing the influence of stable metabolic differences between individuals',
          'B. To isolate processing level by ensuring that the two lunches were identical in every respect except how they were prepared',
          'C. To test whether eating one lunch changed participants\' metabolic response to the lunch served at the later visit',
          'D. To increase the effective sample size by treating the two visits as independent observations from different participants'
        ], correct:'A' },
      { q:'Why did the researchers use two blood draws rather than repeated blood sampling across the entire visit?',
        options:[
          'A. Because the continuous glucose monitor captured the full metabolic response, making later insulin and triglyceride measurements unnecessary',
          'B. Because insulin and triglycerides were expected to remain relatively stable after the 60-minute measurement',
          'C. To ensure that collecting blood did not affect how much participants later ate from the snack tray',
          'D. To limit the burden of repeated blood draws while still measuring insulin and triglycerides at a time when post-meal responses typically peak'
        ], correct:'D' },
      { q:'What did the correlation between the post-lunch glucose dip and snack intake suggest?',
        options:[
          'A. Larger glucose drops were associated with greater snack intake, indicating that the glucose dip fully accounted for the lunch-condition difference in later eating',
          'B. Larger glucose drops were associated with greater snack intake only after the ultra-processed lunch, indicating that the relationship did not occur in the other condition',
          'C. Larger glucose drops were associated with greater snack intake, but the correlation alone could not establish that the glucose dip caused participants to eat more',
          'D. Larger glucose drops predicted greater snack intake even after differences in taste and texture were controlled statistically'
        ], correct:'C' },
      { q:'What mechanism do the authors propose linking food processing to the different metabolic responses?',
        options:[
          'A. Greater processing makes food easier to break down and absorb, which may produce a sharper glucose rise, a larger insulin response, and a later decline',
          'B. Ultra-processed foods contain more metabolizable calories than their labels report, even when labeled calories and macronutrients are matched',
          'C. Additives in ultra-processed foods directly impair insulin signaling, causing glucose to remain elevated throughout the observation period',
          'D. Minimally processed foods require more chewing, and the slower eating rate accounts for the observed glucose and insulin differences'
        ], correct:'A' }
    ]
  },
  listing: {
    id:'listing',
    title:'Do Online Product Listings Accurately Describe What Arrives in the Package?',
    pdfFile:'papers/listing.pdf',
    quiz:[
      { q:'What did the researchers use as an external benchmark to assess whether audit-coded mismatch scores or star ratings reflected real-world listing problems?',
        options:[
          'A. Each listing\'s overall return rate, which combined returns due to inaccurate descriptions with returns for fit, preference, damage, and other reasons',
          'B. The proportion of written reviews that mentioned discrepancies between the listing and the delivered product',
          'C. Each listing\'s trailing 90-day item-not-as-described return rate, which recorded returns attributed specifically to the product not matching its listing',
          'D. The number of customer complaints or policy reports submitted against the seller during the preceding 90 days'
        ], correct:'C' },
      { q:'How did the researchers sample products across the three seller types within each product category?',
        options:[
          'A. They sampled seller types in proportion to their share of listings on the marketplace',
          'B. They sampled the same number of products from each seller type within every category',
          'C. They sampled more seller-shipped third-party listings in categories expected to have higher mismatch rates',
          'D. They sampled products from only one seller type within each category'
        ], correct:'B' },
      { q:'Which conclusion is best supported by the category-specific mismatch results?',
        options:[
          'A. Product categories differed mainly in how often mismatches occurred, while the types of claims that failed were broadly similar across categories',
          'B. Product categories differed both in their overall mismatch rates and in the kinds of listing claims that were most often inaccurate',
          'C. Differences between product categories were primarily caused by unequal representation of the three seller types',
          'D. Categories with more easily measurable physical features, such as dimensions or capacity, consistently showed the highest mismatch rates'
        ], correct:'B' },
      { q:'Why might star ratings fail to closely track objective listing accuracy, according to the authors?',
        options:[
          'A. Star ratings are calculated across all products sold by the same seller, whereas mismatch scores were calculated for individual listings',
          'B. Star ratings are based primarily on whether a product was returned, whereas mismatch scores were based on direct inspection',
          'C. Star ratings place greater weight on recent reviews, whereas mismatch scores weighted every audited claim equally',
          'D. Star ratings combine listing accuracy with other aspects of the purchase, such as shipping, customer service, packaging, and price satisfaction'
        ], correct:'D' }
    ]
  }
};

const PAGE_IDS = [];
const PAPER_IDS = ['font','food','listing'];

function getPlainStudyText(paperId){
  return (window.PAPER_PLAIN_TEXT && window.PAPER_PLAIN_TEXT[paperId]) || '';
}

// ---------- Page order + section numbering ----------
let pageOrder = ['page-consent'];
let currentIdx = 0;
let QUIZ_PAGE_IDS = [];

function buildPageOrder(){
  const order = ['page-consent','page-about-you','page-srl'];
  if (DATA.ct_scale_placement === 'pre') order.push('page-ct');
  order.push('page-ai-experience','page-instructions','page-study-1','page-study-2','page-reflections');
  if (DATA.ct_scale_placement === 'post') order.push('page-ct');
  order.push('page-quiz-intro');
  order.push(...QUIZ_PAGE_IDS);
  order.push('page-debrief');
  pageOrder = order;
  applySectionNumbers();
}

function applySectionNumbers(){
  const pre = DATA.ct_scale_placement === 'pre';
  const map = pre
    ? {about_you:1, srl:2, ct:3, ai_experience:4, task:5, reflections:6, quiz:7, debrief:8}
    : {about_you:1, srl:2, ai_experience:3, task:4, reflections:5, ct:6, quiz:7, debrief:8};
  Object.keys(map).forEach(k=>{
    const el = document.getElementById('secnum-' + k.replace(/_/g,'-'));
    if (el) el.textContent = map[k];
  });
}

// ---------- Stratified random assignment ----------
// Assignment happens exactly once, immediately after the About You page, and
// is then frozen for the rest of the session by being written into DATA
// (which autosave() persists to localStorage every 10s and restoreAssignmentIfPresent()
// can read back). This makes the assignment immune to refresh, resize,
// tab-switch, or page navigation, since none of those re-run this function.
function assignConditionAndOrder(){
  const tier = DATA.expertise_tier;
  const counterKey = 'strat_counter_' + tier;
  let counter = 0;
  try { counter = parseInt(localStorage.getItem(counterKey) || '0', 10); } catch(e){}
  const condition = (counter % 2 === 0) ? 'AI' : 'noAI';
  try { localStorage.setItem(counterKey, String(counter + 1)); } catch(e){}
  DATA.condition = condition;
  DATA.ai_condition = condition;
  document.body.classList.add(condition === 'AI' ? 'condition-ai' : 'condition-noai');

  // CT placement is counterbalanced independently WITHIN each tier+condition
  // cell (4 cells total: lower/higher x AI/noAI), alternating pre/post.
  const ctKey = 'strat_ct_counter_' + tier + '_' + condition;
  let ctCounter = 0;
  try { ctCounter = parseInt(localStorage.getItem(ctKey) || '0', 10); } catch(e){}
  DATA.ct_scale_placement = (ctCounter % 2 === 0) ? 'pre' : 'post';
  DATA.critical_thinking_placement = DATA.ct_scale_placement;
  try { localStorage.setItem(ctKey, String(ctCounter + 1)); } catch(e){}

  // Select 2 of the 3 pool papers without replacement, in randomized
  // presentation order; the third stays unassigned for this participant.
  const shuffledPool = fisherYates([...PAPER_IDS]);
  const order = shuffledPool.slice(0, 2);
  const unassigned = shuffledPool[2];

  DATA.study_order = order;
  DATA.study_1_id = order[0]; DATA.study_2_id = order[1];
  DATA.study_1_title = PAPERS[order[0]].title;
  DATA.study_2_title = PAPERS[order[1]].title;

  DATA.paper_order = [...order];
  DATA.assigned_paper_1_id = order[0]; DATA.assigned_paper_1_title = PAPERS[order[0]].title;
  DATA.assigned_paper_2_id = order[1]; DATA.assigned_paper_2_title = PAPERS[order[1]].title;
  DATA.unassigned_paper_id = unassigned;
}

function fisherYates(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Navigation ----------
function showPage(id){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0,0);
  document.getElementById('siteHeader').style.display = (id === 'page-consent') ? '' : 'none';
  updateNav();
  const m = /^page-study-(\d)$/.exec(id);
  if (m){
    const slotNum = parseInt(m[1],10);
    const paperId = DATA['study_' + slotNum + '_id'];
    if (paperId){
      markStudyStart(id);
      renderStudyPdfIfNeeded(paperId);
    }
  }
}

const selfNavPages = ['page-consent', 'page-exit'];

function updateNav(){
  const idx = pageOrder.indexOf(getCurrentPageId());
  const total = pageOrder.length;
  const pct = total > 1 ? Math.round((idx / (total - 1)) * 100) : 0;
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = pct + '%';
  const stepLabel = document.getElementById('navStep');
  const btnNext = document.getElementById('btnNext');
  const curId = getCurrentPageId();
  if (selfNavPages.includes(curId)){
    if (btnNext) btnNext.style.display = 'none';
    if (stepLabel) stepLabel.textContent = '';
  } else {
    if (btnNext) btnNext.style.display = '';
    if (stepLabel) stepLabel.textContent = 'Step ' + (idx + 1) + ' of ' + total;
    if (btnNext) btnNext.textContent = (curId === 'page-debrief') ? 'Finish' : (/^page-instructions$/.test(curId) ? 'Begin Task →' : 'Continue →');
  }
  const topMeta = document.getElementById('topMeta');
  if (topMeta) topMeta.textContent = 'ID: ' + DATA.participant_id;
}

function getCurrentPageId(){
  const active = document.querySelector('.page.active');
  return active ? active.id : pageOrder[0];
}

let currentStudyPaperId = null;

function navigate(dir){
  if (!validateCurrentPage()) return;
  const curId = getCurrentPageId();
  const idx = pageOrder.indexOf(curId);

  const studyMatch = /^page-study-(\d)$/.exec(curId);
  if (studyMatch && dir > 0){
    const paperId = DATA['study_' + studyMatch[1] + '_id'];
    if (paperId) finalizeStudyTiming(paperId);
  }

  collectFieldsNow();

  if (curId === 'page-about-you' && dir > 0){
    finalizeAboutYou();
  }

  let nextIdx = idx + dir;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= pageOrder.length){
    finalizeSubmission();
    return;
  }
  currentIdx = nextIdx;
  const nextId = pageOrder[currentIdx];

  if (curId === 'page-instructions' && dir > 0){
    enterFullscreenAndStart();
  }
  if (curId === 'page-quiz-intro' && dir > 0 && QUIZ_PAGE_IDS.length === 0){
    buildQuizPages();
    buildPageOrder();
    currentIdx = pageOrder.indexOf('page-quiz-intro') + 1;
  }

  showPage(pageOrder[currentIdx]);
}

function finalizeAboutYou(){
  const roleVal = document.querySelector('input[name="ay_role"]:checked');
  const roleObj = roleVal ? ROLE_OPTIONS.find(o => o.l === roleVal.value) : null;
  DATA.expertise_tier = roleObj ? roleObj.tier : 'lower';
  DATA.research_expertise_stratum = DATA.expertise_tier;
  assignConditionAndOrder();
  buildPageOrder();
  renderAllSections();
  buildInstructionsText();
  buildStudyPages();
}

function finalizeStudyTiming(paperId){
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  DATA.timing[paperId].study_end_ts = nowTs();
  DATA.timing[paperId].study_end_iso = nowIso();
  if (DATA.timing[paperId].study_start_ts){
    DATA.timing[paperId].duration_ms = DATA.timing[paperId].study_end_ts - DATA.timing[paperId].study_start_ts;
  }
}

function markStudyStart(slotId){
  const m = /^page-study-(\d)$/.exec(slotId);
  if (!m) return;
  const paperId = DATA['study_' + m[1] + '_id'];
  if (!paperId) return;
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  if (!DATA.timing[paperId].study_start_ts){
    DATA.timing[paperId].study_start_ts = nowTs();
    DATA.timing[paperId].study_start_iso = nowIso();
  }
  currentStudyPaperId = paperId;
}

// ---------- Validation (kept disabled per prior testing instruction) ----------
function isFieldVisible(el){
  if (!el) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}
function clearValidationErrors(pageEl){
  if (!pageEl) return;
  pageEl.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
  pageEl.querySelectorAll('.group-error').forEach(el => el.classList.remove('group-error'));
}
function flagGroupError(container){
  if (container) container.classList.add('group-error');
}
function validateCurrentPage(){
  // TEMP: required-field enforcement disabled for fast click-through testing.
  // Re-enable by removing this early return once testing is done.
  return true;
}

// ---------- Consent page ----------
function toggleConsent(inputId, visualId){
  const input = document.getElementById(inputId);
  const visual = document.getElementById(visualId);
  input.checked = !input.checked;
  visual.classList.toggle('checked', input.checked);
}

function populateCountrySelect(){
  const select = document.getElementById('ay_country');
  if (!select || select.dataset.populated) return; // never re-run, so an in-progress selection is never reset
  const options = COUNTRY_OPTIONS.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.insertAdjacentHTML('beforeend', options);
  select.dataset.populated = 'true';
}

function renderRadioGroup(containerId, name, options, getLabel, type){
  const container = document.getElementById(containerId);
  if (!container) return;
  type = type || 'radio';
  container.innerHTML = options.map((o,i) => {
    const value = getLabel ? getLabel(o) : o;
    const sub = (typeof o === 'object' && o.sub) ? `<div class="q-sublabel" style="margin:4px 0 0;">${escapeHtml(o.sub)}</div>` : '';
    return `<label class="option-item" data-group="${name}">
      <input type="${type}" name="${name}" value="${escapeHtml(value)}">
      <div class="option-dot"></div>
      <div><div class="option-text">${escapeHtml(value)}</div>${sub}</div>
    </label>`;
  }).join('');
}

function initConsentPage(){
  renderRadioGroup(
    'rg-familiar',
    'familiar',
    ['Yes', 'No, I have not heard of or used any of these']
  );

  document.querySelectorAll('input[name="familiar"]').forEach(input => {
    input.addEventListener('change', event => {
      if (event.target.value.startsWith('No')) {
        DATA.responses.familiar = event.target.value;
        DATA.responses.exit_reason = 'not_familiar_with_ai';
        DATA.screening_exit_reason = 'not_familiar_with_ai';
        DATA.completion_status = 'exited_early';
        DATA.session_end_iso = nowIso();

        showExitScreen();
      }
    });
  });
}

function showExitScreen(){
  pageOrder = ['page-consent','page-exit'];
  currentIdx = 1;
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('navStep').textContent = '';
  document.getElementById('btnNext').style.display = 'none';
  document.getElementById('siteHeader').style.display = 'none';
  showPage('page-exit');
}

function declineConsent(){
  DATA.consent_status = 'declined';
  DATA.screening_exit_reason = 'declined_consent';
  DATA.completion_status = 'exited_early';
  DATA.session_end_iso = nowIso();
  showExitScreen();
}

function submitConsentPage(){
  const prolific = document.getElementById('prolific_id').value.trim();
  const prolificHint = document.getElementById('prolificErrorHint');
  const familiar = document.querySelector('input[name="familiar"]:checked');
  const consentCb = document.getElementById('consent-cb');
  const mediaCb = document.getElementById('media-cb');
  const errEl = document.getElementById('consent-error');

  let ok = true;
  if (!prolific){
    document.getElementById('prolific_id').classList.add('input-error');
    if (prolificHint) prolificHint.style.display = 'block';
    ok = false;
  } else {
    document.getElementById('prolific_id').classList.remove('input-error');
    if (prolificHint) prolificHint.style.display = 'none';
  }
  if (!familiar){
    flagGroupError(document.getElementById('rg-familiar'));
    ok = false;
  }
  if (!consentCb.checked || !mediaCb.checked){
    ok = false;
  }
  if (!ok){
    if (errEl) errEl.style.display = 'block';
    return;
  }
  if (errEl) errEl.style.display = 'none';

  if (familiar.value.startsWith('No')){
    DATA.screening_exit_reason = 'not_familiar_with_ai';
    DATA.completion_status = 'exited_early';
    DATA.session_end_iso = nowIso();
    showExitScreen();
    return;
  }

  DATA.prolific_id = prolific;
  DATA.consent = true;
  DATA.consent_status = 'granted';
  DATA.media_release_status = 'granted';

  buildPageOrder();
  currentIdx = pageOrder.indexOf('page-about-you');
  showPage('page-about-you');
}

function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------- Generic rendering helpers ----------
function updateSliderFill(el){
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100;
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(to right, var(--terra) ${pct}%, var(--border) ${pct}%)`;
}

function likertItemHtml(name, label, leftLab, rightLab){
  let btns = '';
  for (let i=1;i<=7;i++){
    btns += `<button type="button" class="likert-btn" data-name="${name}" data-val="${i}" onclick="selectLikert(this)">${i}</button>`;
  }
  return `<div class="likert-item" data-name="${name}">
    <div class="likert-statement">${escapeHtml(label)}</div>
    <div class="likert-scale">${btns}</div>
  </div>`;
}

function selectLikert(btn){
  const name = btn.getAttribute('data-name');
  document.querySelectorAll(`.likert-btn[data-name="${name}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  DATA.responses[name] = parseInt(btn.getAttribute('data-val'),10);
}

function renderScale7Block(containerId, items, leftLab, rightLab, append){
  const container = document.getElementById(containerId);
  if (!container) return;
  const html = items.map(([key,label]) => likertItemHtml(key, label, leftLab, rightLab)).join('');
  if (append) container.innerHTML += html; else container.innerHTML = html;
}

// ---------- About You / SRL / CT / AI Experience rendering ----------
function renderAllSections(){
  // About You
  renderRadioGroup('rg-ay-lang', 'lang', LANG_OPTIONS);
  setupSpecifyField('rg-ay-lang', 'lang', 'Other');
  renderRadioGroup('rg-ay-role', 'ay_role', ROLE_OPTIONS, o => o.l);
  renderRadioGroup('rg-ay-reviewed', 'reviewed', REVIEWED_OPTIONS);

  // SRL
  renderScale7Block('srlWrap', SRL_ITEMS.map(([k,l]) => [k,l]));

  // Critical-Thinking shared template
  const ctIntroEl = document.getElementById('ctIntroText');
  if (ctIntroEl){
    const introText = (DATA.ct_scale_placement === 'pre') ? CT_INTRO_PRE : CT_INTRO_POST;
    ctIntroEl.innerHTML = `<p class="muted" style="margin-bottom:16px;">${escapeHtml(introText)}</p><p class="q-sublabel" style="margin-top:0;">${escapeHtml(CT_SCALE_NOTE)}</p>`;
  }
  renderScale7Block('ctWrap', CT_ITEMS_LIST.map(o => [o.key, o.label]));

  // AI Experience
  renderRadioGroup('rg-ai-purpose', 'ai_purpose', AI_PURPOSE_OPTIONS, o => o.l, 'checkbox');
  setupSpecifyField('rg-ai-purpose', 'ai_purpose', 'Other');
  renderRadioGroup('rg-ai-tenure', 'ai_tenure', TENURE_OPTIONS);
  renderRadioGroup('rg-ai-understanding', 'ai_understanding', UNDERSTANDING_OPTIONS);

  const slidersWrap = document.getElementById('slidersWrap');
  if (slidersWrap){
    slidersWrap.innerHTML = SLIDERS.map(s => `
      <div class="slider-block">
        <div class="slider-q">${escapeHtml(s.q)}</div>
        <div class="slider-ends">
          <div class="slider-end">${escapeHtml(s.left)}</div>
          <div class="slider-end right">${escapeHtml(s.right)}</div>
        </div>
        <input type="range" min="0" max="100" value="50" data-key="${s.key}" oninput="updateSliderFill(this); DATA.responses['${s.key}']=this.value;">
      </div>`).join('');
    slidersWrap.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
  }
}

// Shows/hides a free-text "specify" input next to a checkbox/radio group
// whenever the option literally labeled `triggerLabel` (e.g. "Other") is
// checked — used for the spec's "Other [specify]" options. Stores the typed
// text in DATA.responses[fieldName + '_specify'].
function setupSpecifyField(containerId, fieldName, triggerLabel){
  const container = document.getElementById(containerId);
  if (!container) return;
  let specifyEl = document.getElementById(containerId + '-specify');
  if (!specifyEl){
    specifyEl = document.createElement('input');
    specifyEl.type = 'text';
    specifyEl.id = containerId + '-specify';
    specifyEl.placeholder = 'Please specify';
    specifyEl.style.marginTop = '10px';
    specifyEl.style.display = 'none';
    specifyEl.addEventListener('input', () => { DATA.responses[fieldName + '_specify'] = specifyEl.value; });
    container.insertAdjacentElement('afterend', specifyEl);
  }
  const sync = () => {
    const checked = container.querySelector(`input[name="${fieldName}"][value="${triggerLabel}"]:checked`);
    specifyEl.style.display = checked ? '' : 'none';
  };
  container.addEventListener('change', sync);
  sync();
}

// ---------- Instructions text ----------
const INSTRUCTIONS_COMMON = [
  'You will now read two short research studies, presented one at a time.',
  'For each study, the paper will appear on the left side of the page, and the response questions will appear on the right. After reading the study, you will identify its strengths and limitations, suggest improvements or future directions, and rate how convincing you find its conclusions.',
  'The studies in this task were artificially constructed for research purposes and are not real published papers. Please approach each study as though you were a researcher evaluating a submitted paper. Apply the same scientific reasoning and judgment that you would use when assessing real research.',
  'Please answer based on the information provided and your own judgment. There are no single correct answers to the open-ended evaluation questions.',
  'While completing the task, please remain on this page and do not open new tabs, switch to another application, or use outside tools. The task will be displayed in fullscreen mode to help you focus.'
];

const INSTRUCTIONS_AI_ONLY = [
  'You will have access to an AI assistant during the paper-evaluation task.',
  'At the top of the right panel, you will see two tabs: Questions, where you will enter your responses; AI Assistant, where you can interact with the AI assistant.',
  'You may switch between these tabs while reading the paper or preparing your responses. The AI assistant will have access to the paper currently displayed, so you may ask about the paper without pasting the full text.',
  'You may send up to five messages to the AI assistant for each study. The number of messages remaining will be displayed in the AI Assistant tab. You may decide how to use these messages. After all five messages have been used, you will no longer be able to send additional messages for that study.',
  'If you choose to use AI, use only the assistant provided on this page. Do not use outside AI assistants, search engines, websites, notes, or other tools. Your interactions with the provided AI assistant will be recorded as part of the study data.'
];

const INSTRUCTIONS_NOAI_ONLY = [
  'Please complete the task using only the research papers provided on this page and your own understanding.',
  'Do not use AI assistants, search engines, websites, notes, or other outside tools or materials.'
];

const INSTRUCTIONS_MOCKUP_SVG_QUESTIONS = `<svg viewBox="0 0 560 280" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="556" height="276" rx="12" fill="#fff" stroke="#d9e2ec" stroke-width="2"/>
  <rect x="20" y="20" width="230" height="240" rx="8" fill="#eef2f6" stroke="#d9e2ec"/>
  <text x="135" y="145" text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#5f6f82">Research paper</text>
  <rect x="270" y="20" width="270" height="34" rx="8" fill="#f3f7fb" stroke="#d7e0ea"/>
  <rect x="278" y="27" width="90" height="20" rx="6" fill="#003262"/>
  <text x="323" y="41" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="#fff">Questions</text>
  <rect x="374" y="27" width="110" height="20" rx="6" fill="#fff" stroke="#bc9b6a"/>
  <text x="429" y="41" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="#003262">✦ AI Assistant</text>
  <rect x="270" y="64" width="270" height="196" rx="8" fill="#fff" stroke="#d9e2ec"/>
  <text x="280" y="92" font-family="Inter,sans-serif" font-size="11.5" font-weight="600" fill="#172033">1. What was the purpose of this study?</text>
  <rect x="280" y="102" width="252" height="52" rx="6" fill="#f3f5f8" stroke="#d9e2ec"/>
  <text x="280" y="178" font-family="Inter,sans-serif" font-size="11.5" font-weight="600" fill="#172033">2. How was the data collected?</text>
  <rect x="280" y="188" width="252" height="52" rx="6" fill="#f3f5f8" stroke="#d9e2ec"/>
</svg>`;

const INSTRUCTIONS_MOCKUP_SVG_AI = `<svg viewBox="0 0 560 280" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="556" height="276" rx="12" fill="#fff" stroke="#d9e2ec" stroke-width="2"/>
  <rect x="20" y="20" width="230" height="240" rx="8" fill="#eef2f6" stroke="#d9e2ec"/>
  <text x="135" y="145" text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#5f6f82">Research paper</text>
  <rect x="270" y="20" width="270" height="34" rx="8" fill="#f3f7fb" stroke="#d7e0ea"/>
  <rect x="278" y="27" width="90" height="20" rx="6" fill="#fff" stroke="#bc9b6a"/>
  <text x="323" y="41" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="#003262">Questions</text>
  <rect x="374" y="27" width="110" height="20" rx="6" fill="#003262"/>
  <text x="429" y="41" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="#fff">✦ AI Assistant</text>
  <rect x="270" y="64" width="270" height="196" rx="8" fill="#fff" stroke="#d9e2ec"/>
  <rect x="280" y="76" width="160" height="24" rx="8" fill="#faf6ee" stroke="#d9e2ec"/>
  <rect x="391" y="108" width="140" height="24" rx="8" fill="#003262"/>
  <rect x="280" y="140" width="180" height="24" rx="8" fill="#faf6ee" stroke="#d9e2ec"/>
  <rect x="280" y="226" width="196" height="26" rx="6" fill="#fff" stroke="#d9e2ec"/>
  <rect x="484" y="226" width="48" height="26" rx="6" fill="#fff" stroke="#bc9b6a"/>
  <text x="508" y="243" text-anchor="middle" font-family="Inter,sans-serif" font-size="10" font-weight="700" fill="#003262">Send</text>
</svg>`;

const INSTRUCTIONS_MOCKUP_NOTE = 'You may switch between the Questions and AI Assistant tabs at any time.';

function buildInstructionsText(){
  const isAI = DATA.condition === 'AI';
  const blocks = [...INSTRUCTIONS_COMMON];
  if (isAI) blocks.push(...INSTRUCTIONS_AI_ONLY); else blocks.push(...INSTRUCTIONS_NOAI_ONLY);
  const html = blocks.map(t => `<p style="margin-bottom:14px;">${escapeHtml(t)}</p>`).join('');
  const textEl = document.getElementById('instructionsText');
  if (textEl) textEl.innerHTML = html;
  const mockupEl = document.getElementById('instructionsMockup');
  if (mockupEl){
    mockupEl.innerHTML = isAI ? `
      <div class="mockup-block">${INSTRUCTIONS_MOCKUP_SVG_QUESTIONS}</div>
      <p class="mockup-note">${escapeHtml(INSTRUCTIONS_MOCKUP_NOTE)}</p>
      <div class="mockup-block">${INSTRUCTIONS_MOCKUP_SVG_AI}</div>
    ` : '';
  }
}

// ---------- Study pages ----------
const STUDY_PDF_QUEUE = {};

function buildStudyPages(){
  DATA.study_order.forEach((paperId, i) => {
    const slotId = 'page-study-' + (i+1);
    const slotEl = document.getElementById(slotId);
    if (!slotEl) return;
    const paper = PAPERS[paperId];
    const isAI = DATA.condition === 'AI';

    const questionsHtml = STANDARD_Q_DEFS.map(def => {
      const label = def.label;
      const fieldId = paperId + '_' + def.suffix;
      if (def.type === 'scale7'){
        let btns = '';
        for (let v=1;v<=7;v++){
          btns += `<button type="button" class="conf-btn" data-name="${fieldId}" data-val="${v}" onclick="selectConvincing(this)">${v}</button>`;
        }
        return `<div class="q-card">
          <div class="q-label">${escapeHtml(label)}</div>
          <div class="q-sublabel">1 = Not at all convincing, 7 = Completely convincing</div>
          <div class="conf-scale" data-name="${fieldId}">${btns}</div>
        </div>`;
      }
      return `<div class="q-card">
        <div class="q-label">${escapeHtml(label)}</div>
        <textarea id="${fieldId}" data-logfield="${fieldId}" placeholder="Type your response here..."></textarea>
      </div>`;
    }).join('');

    slotEl.innerHTML = `
      <div class="section-label"><div class="section-title">Study ${i+1} of 2</div></div>
      <div class="study-grid">
        <div class="paper-pane" id="paperPane-${paperId}">
          <div class="pdf-render-wrap" id="pdfWrap-${paperId}"><p class="pdf-status-msg">Loading paper…</p></div>
          <p class="pdf-zoom-note">Use your browser's zoom (Ctrl/Cmd +/-) for a closer look.</p>
        </div>
        <div class="workspace-pane">
          <div class="workspace-head">
            <div class="workspace-tabs">
              <button class="tab-btn active" data-tab="questions" onclick="switchWorkspaceTab('${paperId}','questions')">Questions</button>
              <button class="tab-btn ai-only ai-tab-btn attention" data-tab="ai" onclick="switchWorkspaceTab('${paperId}','ai')">AI Assistant</button>
            </div>
          </div>
          <div class="tab-content active" data-tab="questions" id="questionsTab-${paperId}">
            <div class="questions-pane">${questionsHtml}</div>
          </div>
          <div class="tab-content ai-only" data-tab="ai" id="aiTab-${paperId}">
            <div class="ai-chat-pane">
              <div class="ai-messages" id="aiMessages-${paperId}"></div>
              <div class="q-sublabel" id="aiRemaining-${paperId}" style="padding:0 12px 6px;margin:0;"></div>
              <div class="ai-input-row">
                <textarea id="aiInput-${paperId}" placeholder="Ask the AI assistant about this study..." onkeydown="handleAIInputKeydown(event,'${paperId}')"></textarea>
                <button class="btn-ask-ai" id="aiSendBtn-${paperId}" onclick="sendAIMessage('${paperId}')">Send</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    STUDY_PDF_QUEUE[paperId] = { url: paper.pdfFile, containerId: 'pdfWrap-' + paperId, rendered:false };
    if (isAI) updateAiRemainingUI(paperId);
  });
  attachLoggingListeners();
}

function selectConvincing(btn){
  const name = btn.getAttribute('data-name');
  document.querySelectorAll(`.conf-btn[data-name="${name}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  DATA.responses[name] = parseInt(btn.getAttribute('data-val'),10);
}

function renderStudyPdfIfNeeded(paperId){
  const entry = STUDY_PDF_QUEUE[paperId];
  if (!entry || entry.rendered) return;
  entry.rendered = true;
  renderPDF(entry.url, entry.containerId, paperId);
}

// Per-paperId cache of page images (JPEG data URLs) captured straight from
// the same pdf.js canvases used for on-screen rendering, so the AI assistant
// can be given a real look at figures/tables rather than only extracted text.
// Capped both in page count and resolution to keep the /api/chat payload
// reasonably small (vision models charge/limit by image size, and we don't
// want a 40-page PDF ballooning every chat request).
let STUDY_PDF_IMAGES = {};
const MAX_AI_VISION_PAGES = 8;
const AI_VISION_MAX_DIMENSION = 1100; // px, longest side, before JPEG re-encode

async function renderPDF(url, containerId, paperId){
  const container = document.getElementById(containerId);
  if (!container) return;
  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    container.innerHTML = '';
    const dpr = window.devicePixelRatio || 1;
    const capturedImages = [];
    for (let pageNum=1; pageNum<=pdf.numPages; pageNum++){
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const targetWidth = container.clientWidth || 760;
      const scale = (targetWidth / viewport.width) * dpr;
      const scaledViewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      canvas.style.width = '100%';
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
      container.appendChild(canvas);

      if (paperId && capturedImages.length < MAX_AI_VISION_PAGES){
        try {
          capturedImages.push(downscaleCanvasToJpeg(canvas, AI_VISION_MAX_DIMENSION));
        } catch (captureErr){
          console.error('Could not capture page image for AI vision', paperId, pageNum, captureErr);
        }
      }
    }
    if (paperId) STUDY_PDF_IMAGES[paperId] = capturedImages;
  } catch (err){
    console.error('PDF render failed for', url, err);
    container.innerHTML = '<p class="pdf-status-msg">Could not load the paper. Please contact the study team.</p>';
  }
}

// Re-draws an already-rendered page canvas at a smaller resolution and
// returns a JPEG data URL. Keeps the on-screen canvas at full
// (device-pixel-ratio-scaled) resolution for readability while sending the
// AI assistant a much lighter copy.
function downscaleCanvasToJpeg(sourceCanvas, maxDimension){
  const longestSide = Math.max(sourceCanvas.width, sourceCanvas.height);
  const ratio = longestSide > maxDimension ? (maxDimension / longestSide) : 1;
  const outW = Math.max(1, Math.round(sourceCanvas.width * ratio));
  const outH = Math.max(1, Math.round(sourceCanvas.height * ratio));
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  outCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, outW, outH);
  return outCanvas.toDataURL('image/jpeg', 0.72);
}

function getStudyPdfImages(paperId){
  return STUDY_PDF_IMAGES[paperId] || [];
}

// ---------- AI chat panel ----------
function switchWorkspaceTab(paperId, tab){
  const scope = document.getElementById('paperPane-' + paperId)?.closest('.study-page') || document;
  scope.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
  scope.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.getAttribute('data-tab') === tab));
  if (tab === 'ai'){
    renderAIMessages(paperId);
    document.querySelectorAll('.ai-tab-btn').forEach(b => { b.classList.remove('attention'); b.querySelector('.tab-badge')?.remove(); });
    recordAiTabOpened(paperId);
    updateAiRemainingUI(paperId);
  }
}

const MAX_AI_MESSAGES_PER_PAPER = 5;

function getAiAggregate(paperId){
  // DATA.ai_paper_aggregates pre-populates each pool paper as an empty {}
  // object (see the DATA literal above), which is truthy — so a plain
  // "if (!DATA.ai_paper_aggregates[paperId])" guard never actually fills in
  // the default fields, leaving successful_messages as undefined. That
  // turned "remaining = MAX - successful_messages" into NaN, which made the
  // UI report the 5-message limit as already reached on first load. Always
  // merge in any missing default fields instead of only checking truthiness.
  const existing = DATA.ai_paper_aggregates[paperId];
  if (!existing || typeof existing.successful_messages !== 'number'){
    DATA.ai_paper_aggregates[paperId] = Object.assign({
      tab_opened: false, first_open_ts: null, time_to_first_open_ms: null,
      time_to_first_message_ms: null, total_messages: 0, successful_messages: 0,
      limit_reached: false
    }, existing || {});
  }
  return DATA.ai_paper_aggregates[paperId];
}

function recordAiTabOpened(paperId){
  const agg = getAiAggregate(paperId);
  if (agg.tab_opened) return; // only the first open counts
  agg.tab_opened = true;
  agg.first_open_ts = nowTs();
  const startTs = DATA.timing[paperId] && DATA.timing[paperId].study_start_ts;
  if (startTs) agg.time_to_first_open_ms = agg.first_open_ts - startTs;
}

function updateAiRemainingUI(paperId){
  const agg = getAiAggregate(paperId);
  const remaining = Math.max(0, MAX_AI_MESSAGES_PER_PAPER - agg.successful_messages);
  const note = document.getElementById('aiRemaining-' + paperId);
  if (note) note.textContent = remaining > 0
    ? remaining + ' of ' + MAX_AI_MESSAGES_PER_PAPER + ' messages remaining'
    : 'You have reached the 5-message limit for this paper.';
  const input = document.getElementById('aiInput-' + paperId);
  const sendBtn = document.getElementById('aiSendBtn-' + paperId);
  const limitReached = remaining <= 0;
  agg.limit_reached = limitReached;
  if (input) input.disabled = limitReached;
  if (sendBtn) sendBtn.disabled = limitReached;
}

function renderAIMessages(paperId){
  const wrap = document.getElementById('aiMessages-' + paperId);
  if (!wrap) return;
  // Rebuilt purely from DATA.ai_chats — the thinking indicator is transient
  // UI state and is NEVER part of this array, so it can never leak into the
  // research transcript or get sent back to the backend as conversation history.
  // Deliberately does NOT re-create a thinking indicator here based on pending
  // state: doing so previously caused the indicator to reappear after the real
  // reply was rendered, because this function is called from sendAIMessage's
  // `finally` block. The indicator is owned solely by sendAIMessage via a
  // direct DOM element reference (see createThinkingMessage / aiThinkingEls).
  wrap.innerHTML = DATA.ai_chats[paperId].map(m => `
    <div class="ai-msg ${m.role}">
      <span class="ai-msg-role">${m.role === 'user' ? 'You' : 'AI Assistant'}</span>
      ${escapeHtml(m.content)}
    </div>`).join('');
  wrap.scrollTop = wrap.scrollHeight;
  // If a request is still pending for this paper (e.g. the participant switched
  // tabs and back while waiting), re-attach the existing thinking element (the
  // same DOM node, not a freshly created one) so there is still only ever one.
  const pendingEl = aiThinkingEls[paperId];
  if (aiSendInFlight[paperId] && pendingEl) {
    wrap.appendChild(pendingEl);
    wrap.scrollTop = wrap.scrollHeight;
  }
}

// Per-paperId map of the single in-flight thinking indicator's DOM element
// (or undefined when none is showing). Keeping a direct element reference —
// rather than looking it up by a shared/global id — guarantees we only ever
// remove the exact node we created for this study's request.
let aiThinkingEls = {};

function createThinkingMessage(paperId, messagesContainer){
  // Guard against a duplicate indicator for the same paper (e.g. a stray
  // double-invocation); reuse the existing element instead of stacking a new one.
  if (aiThinkingEls[paperId]) return aiThinkingEls[paperId];
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'ai-msg assistant thinking';
  thinkingEl.setAttribute('aria-label', 'AI is thinking');
  thinkingEl.innerHTML = `
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
  `;
  messagesContainer.appendChild(thinkingEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  aiThinkingEls[paperId] = thinkingEl;
  return thinkingEl;
}

function removeThinkingMessage(paperId){
  const el = aiThinkingEls[paperId];
  if (el && el.isConnected) el.remove();
  delete aiThinkingEls[paperId];
}

async function callBackendChat(paperId, userMessage){
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participant_id: DATA.participant_id,
      condition: DATA.condition,
      paper_id: paperId,
      study_title: PAPERS[paperId].title,
      study_text: getPlainStudyText(paperId),
      study_images: getStudyPdfImages(paperId),
      user_message: userMessage,
      conversation_history: DATA.ai_chats[paperId]
    })
  });
  if (!response.ok){
    throw new Error('Backend chat request failed with status ' + response.status);
  }
  const data = await response.json();
  return data.reply;
}

let aiSendInFlight = {};

function handleAIInputKeydown(e, paperId){
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return; // allow newline
  if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
  e.preventDefault(); // stop Enter from inserting a newline when used to send
  sendAIMessage(paperId);
}

async function sendAIMessage(paperId){
  if (aiSendInFlight[paperId]) return; // prevent duplicate requests (Send click or repeated Enter)
  const agg = getAiAggregate(paperId);
  if (agg.successful_messages >= MAX_AI_MESSAGES_PER_PAPER) return; // 5-message cap reached; input should already be disabled
  const input = document.getElementById('aiInput-' + paperId);
  const sendBtn = document.getElementById('aiSendBtn-' + paperId);
  const messagesContainer = document.getElementById('aiMessages-' + paperId);
  const text = (input.value || '').trim();
  if (!text) return; // ignore empty / whitespace-only submissions

  aiSendInFlight[paperId] = true;
  if (sendBtn){ sendBtn.disabled = true; sendBtn.textContent = 'Thinking…'; }
  if (input) input.disabled = true;

  const sendStartTs = nowTs();
  agg.total_messages++;
  DATA.ai_chats[paperId].push({ role:'user', content:text, ts: nowIso() });
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  if (!DATA.timing[paperId].first_ai_message_ts){
    DATA.timing[paperId].first_ai_message_ts = nowTs();
    DATA.timing[paperId].first_ai_message_iso = nowIso();
    const startTs = DATA.timing[paperId].study_start_ts;
    if (startTs) agg.time_to_first_message_ms = DATA.timing[paperId].first_ai_message_ts - startTs;
  }
  input.value = '';
  renderAIMessages(paperId); // shows the participant's message immediately

  // Direct DOM element reference — never a shared/global id — so cleanup
  // below can only ever remove this exact node for this exact paperId.
  const thinkingEl = createThinkingMessage(paperId, messagesContainer);

  let success = false;
  let errorType = null;
  let reply = null;
  try {
    reply = await callBackendChat(paperId, text);
    // Remove the temporary indicator BEFORE the real reply is stored/rendered.
    removeThinkingMessage(paperId);
    DATA.ai_chats[paperId].push({ role:'assistant', content: reply, ts: nowIso() });
    success = true;
  } catch (err){
    console.error('AI chat error for', paperId, err); // detailed error stays in the console only
    errorType = (err && err.message) || 'unknown_error';
    removeThinkingMessage(paperId);
    reply = 'The assistant could not respond right now. Please try again.';
    DATA.ai_chats[paperId].push({ role:'assistant', content: reply, ts: nowIso() });
  } finally {
    const sendEndTs = nowTs();
    // Only successful submissions count against the 5-message cap, per spec.
    if (success) agg.successful_messages++;
    DATA.ai_message_log.push({
      participant_id: DATA.participant_id,
      paper_id: paperId,
      paper_order_position: DATA.study_order.indexOf(paperId) + 1,
      message_number: agg.total_messages,
      prompt: text,
      response: success ? reply : null,
      submit_ts_iso: new Date(sendStartTs).toISOString(),
      complete_ts_iso: new Date(sendEndTs).toISOString(),
      latency_ms: sendEndTs - sendStartTs,
      success,
      error_type: errorType,
      messages_remaining: Math.max(0, MAX_AI_MESSAGES_PER_PAPER - agg.successful_messages)
    });

    // Extra safeguard in case it was somehow not removed above (e.g. a thrown
    // error before either branch ran). Cleanup always happens here regardless
    // of success or failure, and runs BEFORE the in-flight flag is cleared so
    // renderAIMessages (called next) never mistakes this for a still-pending request.
    if (thinkingEl && thinkingEl.isConnected) thinkingEl.remove();
    delete aiThinkingEls[paperId];

    renderAIMessages(paperId);
    aiSendInFlight[paperId] = false;
    if (sendBtn) sendBtn.textContent = 'Send';
    updateAiRemainingUI(paperId); // re-enables (or permanently disables at the cap) input/button
    input && !input.disabled && input.focus();
  }
}

// ---------- Anti-cheat / fullscreen monitoring ----------
let inTaskPhase = false;

function showWarnBanner(msg){
  const banner = document.getElementById('warnBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.style.display = 'block';
  clearTimeout(showWarnBanner._t);
  showWarnBanner._t = setTimeout(() => { banner.style.display = 'none'; }, 4000);
}

function violationMessage(type){
  const map = {
    visibility: 'Please stay on this tab while completing the task.',
    blur: 'Please keep this window focused while completing the task.',
    fullscreen_exit: 'Please remain in fullscreen mode while completing the task.',
    contextmenu: 'Right-click is disabled during the task.',
    devtools_shortcut: 'Developer tools are disabled during the task.'
  };
  return map[type] || 'Please follow the task instructions.';
}

function logViolation(type){
  DATA.violations.push({ type, ts: nowIso(), paper_id: currentStudyPaperId });
  logBehavioralEvent(type);
  showWarnBanner(violationMessage(type));
}

// General-purpose behavioral event log (fullscreen enter/exit/re-entry,
// visibility change, window blur/focus). Kept separate from DATA.violations
// (which only records the negative/warning-worthy events) so both the
// existing violations-based logic and the new spec's broader behavioral
// event log have what they each expect.
function logBehavioralEvent(type){
  DATA.behavioral_events.push({ participant_id: DATA.participant_id, paper_id: currentStudyPaperId, type, ts: nowIso() });
}

document.addEventListener('visibilitychange', () => {
  if (!inTaskPhase) return;
  if (document.hidden) logViolation('visibility');
  else logBehavioralEvent('visibility_visible');
});
window.addEventListener('blur', () => {
  if (inTaskPhase) logViolation('blur');
});
window.addEventListener('focus', () => {
  if (inTaskPhase) logBehavioralEvent('focus');
});
document.addEventListener('fullscreenchange', () => {
  if (inTaskPhase){
    if (!document.fullscreenElement){
      logViolation('fullscreen_exit');
      showFullscreenRequiredOverlay();
    } else {
      logBehavioralEvent('fullscreen_enter');
      hideFullscreenRequiredOverlay();
    }
  }
});
document.addEventListener('contextmenu', (e) => {
  if (inTaskPhase){ e.preventDefault(); logViolation('contextmenu'); }
});
document.addEventListener('keydown', (e) => {
  if (!inTaskPhase) return;
  const isDevtools = e.key === 'F12' ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && ['I','J','C'].includes(e.key)) ||
    ((e.metaKey) && e.altKey && e.key === 'I');
  if (isDevtools){ e.preventDefault(); logViolation('devtools_shortcut'); }
});

function showFullscreenRequiredOverlay(){
  document.getElementById('fsRequiredOverlay')?.classList.add('open');
}
function hideFullscreenRequiredOverlay(){
  document.getElementById('fsRequiredOverlay')?.classList.remove('open');
}

function enterFullscreenAndStart(){
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (req){
    req.call(el).then(() => {
      DATA.fullscreen_used = true;
      inTaskPhase = true;
      logBehavioralEvent('fullscreen_enter');
      hideFullscreenRequiredOverlay();
    }).catch(() => {
      inTaskPhase = true;
    });
  } else {
    inTaskPhase = true;
  }
}

// ---------- Behavioral logging ----------
// Substantial-revision detection: rather than logging every keystroke, we
// only log when a pause of >=2s follows a change that deleted or replaced
// >=20 characters since the last logged (or initial) snapshot. A simple
// common-prefix/common-suffix diff against the snapshot is enough to
// estimate chars-deleted vs. chars-inserted without a full diff library.
const SUBSTANTIAL_REVISION_MIN_CHARS = 20;
const SUBSTANTIAL_REVISION_PAUSE_MS = 2000;

function diffCounts(oldVal, newVal){
  let prefix = 0;
  const maxPrefix = Math.min(oldVal.length, newVal.length);
  while (prefix < maxPrefix && oldVal[prefix] === newVal[prefix]) prefix++;
  let oldEnd = oldVal.length, newEnd = newVal.length;
  while (oldEnd > prefix && newEnd > prefix && oldVal[oldEnd-1] === newVal[newEnd-1]){ oldEnd--; newEnd--; }
  const charsDeleted = Math.max(0, oldEnd - prefix);
  const charsInserted = Math.max(0, newEnd - prefix);
  return { charsDeleted, charsInserted };
}

function fieldIdToPaperId(fieldId){
  const match = PAPER_IDS.find(pid => fieldId === pid || fieldId.startsWith(pid + '_'));
  return match || null;
}

function attachLoggingListeners(){
  document.querySelectorAll('textarea[data-logfield]').forEach(ta => {
    const id = ta.getAttribute('data-logfield');
    if (ta._loggingAttached) return;
    ta._loggingAttached = true;
    if (!DATA.logs[id]) DATA.logs[id] = { keystrokes:0, pastes:0, drafts:[] };
    ta._revisionSnapshot = ta.value || '';
    ta.addEventListener('keydown', () => { DATA.logs[id].keystrokes++; });
    ta.addEventListener('paste', (e) => {
      DATA.logs[id].pastes++;
      const pasted = (e.clipboardData || window.clipboardData).getData('text');
      DATA.paste_events.push({ field:id, ts: nowIso(), length: pasted.length });
    });
    ta.addEventListener('input', () => {
      clearTimeout(ta._revisionTimer);
      ta._revisionTimer = setTimeout(() => {
        const before = ta._revisionSnapshot;
        const after = ta.value || '';
        const { charsDeleted, charsInserted } = diffCounts(before, after);
        if (charsDeleted >= SUBSTANTIAL_REVISION_MIN_CHARS){
          DATA.revision_log.push({
            participant_id: DATA.participant_id,
            paper_id: fieldIdToPaperId(id),
            question_id: id,
            ts: nowIso(),
            chars_deleted: charsDeleted,
            chars_inserted: charsInserted,
            response_length_before: before.length,
            response_length_after: after.length
          });
        }
        ta._revisionSnapshot = after;
      }, SUBSTANTIAL_REVISION_PAUSE_MS);
    });
    ta.addEventListener('blur', () => {
      DATA.logs[id].drafts.push({ ts: nowIso(), value: ta.value });
    });
  });
}

// ---------- Reflections page ----------
function buildPaperScaleRows(containerId, fieldPrefix){
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = DATA.study_order.map((paperId, i) => {
    const name = fieldPrefix + '_' + paperId;
    let btns = '';
    for (let v=1; v<=7; v++){
      btns += `<button type="button" class="conf-btn" data-name="${name}" data-val="${v}" onclick="selectConvincing(this)">${v}</button>`;
    }
    return `<div class="conf-row">
      <div class="conf-label">Paper ${i+1}: ${escapeHtml(PAPERS[paperId].title)}</div>
      <div class="conf-scale" data-name="${name}">${btns}</div>
    </div>`;
  }).join('');
}

function prepareReflectionsPage(){
  inTaskPhase = false;
  buildPaperScaleRows('confWrap', 'confidence');
  buildPaperScaleRows('understandWrap', 'understood');
  if (DATA.condition === 'AI'){
    buildPerPaperAiReflections();
  }
}

// Single shared AI-engagement (multi-select) + ownership (1-7 scale)
// question pair, asked once across both papers — per the spec's "Select all
// that apply" / "Overall, whose thinking..." wording (verbatim, not
// per-paper). Field names are fixed ('ai_engagement', 'whose_thinking') and
// picked up by collectFieldsNow()'s generic name-based collection.
function buildPerPaperAiReflections(){
  const wrap = document.getElementById('perPaperAiReflectionsWrap');
  if (!wrap) return;
  const wtName = 'whose_thinking';
  wrap.innerHTML = `<div class="q-card">
      <div class="q-label">How did you engage with the AI assistant during the previous task? Select all that apply.</div>
      <div class="options-grid" id="engageWrap"></div>
    </div>
    <div class="q-card">
      <div class="q-label">Overall, whose thinking is reflected in your responses?</div>
      <div class="q-sublabel">1 = Mostly the AI assistant's thinking     7 = Mostly my own thinking</div>
      <div class="conf-scale" data-name="${wtName}">${(function(){
        let btns = '';
        for (let v=1; v<=7; v++){ btns += `<button type="button" class="conf-btn" data-name="${wtName}" data-val="${v}" onclick="selectConvincing(this)">${v}</button>`; }
        return btns;
      })()}</div>
    </div>`;
  renderRadioGroup('engageWrap', 'ai_engagement', ENGAGEMENT_OPTIONS, o => o.l, 'checkbox');
}

// Exclusive-checkbox handling + selected-state styling
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('.option-item input[type="radio"], .option-item input[type="checkbox"]')){
    const item = t.closest('.option-item');
    if (t.type === 'radio'){
      document.querySelectorAll(`input[name="${t.name}"]`).forEach(inp => inp.closest('.option-item')?.classList.remove('selected'));
      item.classList.add('selected');
    } else {
      item.classList.toggle('selected', t.checked);
      if (t.name.startsWith('ai_engagement')){
        const opt = ENGAGEMENT_OPTIONS.find(o => o.l === t.value);
        const exclusiveVals = ENGAGEMENT_OPTIONS.filter(o => o.exclusive).map(o => o.l);
        if (t.checked){
          if (opt && opt.exclusive){
            document.querySelectorAll(`input[name="${t.name}"]`).forEach(inp => {
              if (inp !== t){ inp.checked = false; inp.closest('.option-item')?.classList.remove('selected'); }
            });
          } else {
            document.querySelectorAll(`input[name="${t.name}"]`).forEach(inp => {
              if (exclusiveVals.includes(inp.value)){ inp.checked = false; inp.closest('.option-item')?.classList.remove('selected'); }
            });
          }
        }
      }
    }
  }
});

// ---------- Quiz ----------
// Renders one page per comprehension-quiz question. DATA.study_order holds
// the two assigned paper ids in the same order the participant evaluated
// them (the unassigned third pool paper is never in this array, so its quiz
// is never built/shown here) — iterating it in order naturally satisfies
// "same order participant evaluated papers" + "no unassigned paper" without
// any extra bookkeeping. PAPERS[paperId].title is read fresh on every
// question (not just the first per paper) so the title label appears on
// every page and always reflects the paper the current question belongs to.
function buildQuizPages(){
  const container = document.getElementById('quizPagesContainer');
  if (!container) return;
  QUIZ_PAGE_IDS = [];
  let html = '';
  DATA.study_order.forEach(paperId => {
    const paperTitle = PAPERS[paperId].title;
    PAPERS[paperId].quiz.forEach((qObj, qi) => {
      const pageId = 'page-quiz-' + paperId + '-' + qi;
      QUIZ_PAGE_IDS.push(pageId);
      const name = 'quiz_' + paperId + '_' + qi;
      const optsHtml = qObj.options.map(opt => {
        const letter = opt.trim()[0];
        return `<label class="option-item" data-group="${name}">
          <input type="radio" name="${name}" value="${letter}">
          <div class="option-dot"></div>
          <div class="option-text">${escapeHtml(opt)}</div>
        </label>`;
      }).join('');
      html += `<div class="page" id="${pageId}">
        <div class="q-card">
          <div class="quiz-paper-title">${escapeHtml(paperTitle)}</div>
          <div class="q-label">${escapeHtml(qObj.q)}</div>
          <div class="options-grid">${optsHtml}</div>
        </div>
      </div>`;
    });
  });
  container.innerHTML = html;
}

function finishQuiz(){
  let score = 0, total = 0;
  DATA.study_order.forEach(paperId => {
    PAPERS[paperId].quiz.forEach((qObj, qi) => {
      total++;
      const name = 'quiz_' + paperId + '_' + qi;
      const chosen = document.querySelector(`input[name="${name}"]:checked`);
      const val = chosen ? chosen.value : null;
      DATA.responses[name] = val;
      if (val === qObj.correct) score++;
    });
  });
  DATA.quiz_score = score;
  DATA.quiz_total = total;
}

// ---------- Field collection ----------
function collectFieldsNow(){
  document.querySelectorAll('textarea[id]').forEach(ta => { DATA.responses[ta.id] = ta.value; });
  document.querySelectorAll('input[type="text"][id], input[type="number"][id]').forEach(inp => { DATA.responses[inp.id] = inp.value; });
  document.querySelectorAll('select[id]').forEach(sel => { DATA.responses[sel.id] = sel.value; });
  document.querySelectorAll('input[type="range"][data-key]').forEach(inp => { DATA.responses[inp.getAttribute('data-key')] = inp.value; });
  const radioNames = new Set();
  document.querySelectorAll('input[type="radio"]').forEach(r => radioNames.add(r.name));
  radioNames.forEach(name => {
    if (name === 'familiar') return;
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    if (checked) DATA.responses[name] = checked.value;
  });
  const cbGroups = new Set();
  document.querySelectorAll('input[type="checkbox"][name]').forEach(c => cbGroups.add(c.name));
  cbGroups.forEach(name => {
    if (name === 'consent-cb' || name === 'media-cb') return;
    const checked = Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(c => c.value);
    DATA.responses[name] = checked;
  });
}

// ---------- Export / Admin ----------
function flattenForExport(){
  const flat = {
    participant_id: DATA.participant_id,
    prolific_id: DATA.prolific_id,
    session_start_iso: DATA.session_start_iso,
    session_end_iso: DATA.session_end_iso,
    final_submission_timestamp: DATA.final_submission_timestamp,
    completion_status: DATA.completion_status,
    consent_status: DATA.consent_status,
    media_release_status: DATA.media_release_status,
    screening_exit_reason: DATA.screening_exit_reason,
    expertise_tier: DATA.expertise_tier,
    research_expertise_stratum: DATA.research_expertise_stratum,
    condition: DATA.condition,
    ai_condition: DATA.ai_condition,
    ct_scale_placement: DATA.ct_scale_placement,
    critical_thinking_placement: DATA.critical_thinking_placement,
    study_order: DATA.study_order.join(','),
    paper_order: DATA.paper_order.join(','),
    unassigned_paper_id: DATA.unassigned_paper_id,
    quiz_score: DATA.quiz_score,
    quiz_total: DATA.quiz_total,
    fullscreen_used: DATA.fullscreen_used,
    violations_count: DATA.violations.length
  };
  DATA.study_order.forEach((paperId, i) => {
    const t = DATA.timing[paperId] || {};
    const agg = DATA.ai_paper_aggregates[paperId] || {};
    flat['study_' + (i+1) + '_id'] = paperId;
    flat['study_' + (i+1) + '_title'] = PAPERS[paperId].title;
    flat['study_' + (i+1) + '_duration_ms'] = t.duration_ms || '';
    flat['study_' + (i+1) + '_ai_turns'] = DATA.ai_chats[paperId].filter(m => m.role==='user').length;
    flat['study_' + (i+1) + '_ai_transcript'] = JSON.stringify(DATA.ai_chats[paperId]);
    flat['study_' + (i+1) + '_ai_tab_opened'] = agg.tab_opened || false;
    flat['study_' + (i+1) + '_ai_time_to_first_open_ms'] = agg.time_to_first_open_ms || '';
    flat['study_' + (i+1) + '_ai_time_to_first_message_ms'] = agg.time_to_first_message_ms || '';
    flat['study_' + (i+1) + '_ai_limit_reached'] = agg.limit_reached || false;
  });
  Object.assign(flat, DATA.responses);
  return flat;
}

function downloadBlob(content, filename, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadJSON(){
  downloadBlob(JSON.stringify(DATA, null, 2), DATA.participant_id + '.json', 'application/json');
}

function downloadCSV(){
  const flat = flattenForExport();
  const keys = Object.keys(flat);
  const escapeCsv = (v) => '"' + String(v == null ? '' : v).replace(/"/g,'""') + '"';
  const csv = keys.join(',') + '\n' + keys.map(k => escapeCsv(flat[k])).join(',');
  downloadBlob(csv, DATA.participant_id + '.csv', 'text/csv');
}

function openAdminOverlay(){
  const overlay = document.getElementById('adminOverlay');
  const pre = document.getElementById('adminPreview');
  if (pre) pre.textContent = JSON.stringify(DATA, null, 2);
  if (overlay) overlay.classList.add('open');
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E'){
    openAdminOverlay();
  }
});

// ---------- Submission ----------
async function submitToServer(){
  try {
    const response = await fetch('/api/submit-survey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DATA)
    });
    if (!response.ok) throw new Error('submit-survey failed with status ' + response.status);
  } catch (err){
    console.warn('submitToServer failed (endpoint may not be implemented yet):', err);
  }
}

function finalizeSubmission(){
  if (document.fullscreenElement){
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen)?.call(document);
  }
  collectFieldsNow();
  finishQuiz();
  DATA.session_end_iso = nowIso();
  DATA.completion_status = 'completed';
  DATA.final_submission_timestamp = nowIso();
  submitToServer();
  currentIdx = pageOrder.indexOf('page-debrief');
  showPage('page-debrief');
}

// ---------- Autosave ----------
function autosave(){
  collectFieldsNow();
  try { localStorage.setItem('research_survey_autosave', JSON.stringify(DATA)); } catch(e){}
}
setInterval(autosave, 10000);

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  initConsentPage();
  populateCountrySelect();
  // Populate the About You / SRL / CT / AI-experience radio groups and sliders
  // up front. Previously this only happened in finalizeAboutYou(), which runs
  // when leaving the About You page — so the page-about-you radio groups
  // (first language, research role, reviewed-a-paper) were still empty the
  // first time a participant actually saw that page. renderAllSections() is
  // called again later (in finalizeAboutYou) to refresh CT intro text/order
  // once condition assignment has happened; calling it here too is harmless.
  renderAllSections();
  pageOrder = ['page-consent'];
  currentIdx = 0;
  showPage('page-consent');
  updateNav();

  document.querySelectorAll('#page-reflections').forEach(() => {});
  const origNavigate = navigate;
  // Hook to build reflections content right when that page is about to show.
  const observer = new MutationObserver(() => {
    const reflPage = document.getElementById('page-reflections');
    if (reflPage && reflPage.classList.contains('active') && !reflPage._prepared){
      reflPage._prepared = true;
      prepareReflectionsPage();
    }
  });
  observer.observe(document.body, { attributes:true, subtree:true, attributeFilter:['class'] });

  const params = new URLSearchParams(window.location.search);
  if (params.get('admin') === '1') openAdminOverlay();
});
