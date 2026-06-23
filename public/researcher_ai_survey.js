/* ============================================================
   Researcher AI Survey — frontend logic
   ============================================================ */

// pdf.js requires an explicit worker script when not using a bundler —
// without this, getDocument() silently fails and study PDFs never render.
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ---------- Core state ----------
function genId() { return 'P-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }
function nowTs() { return Date.now(); }

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
  research_role: null,              // exact selected role string, as returned by the server
  research_role_years: null,        // PhD student only — years in program, as returned by the server
  assignment_cell: null,            // combined cell label, e.g. "AI_pre" — authoritative, server-generated
  assignment_assigned_at: null,     // server timestamp the assignment was made
  assignment_source: null,          // assignment method, e.g. "deterministic_server_hash"
  assignment_version: null,         // version tag baked into the server's condition/CT hash input (e.g. "v1")
  stable_assignment_id_hash: null,  // one-way SHA-256 digest (server-computed) of the normalized id actually hashed for assignment (prolific_id or fallback UUID) — NOT the raw value, so it is never the same plaintext as prolific_id under a second field name
  assignment_id_source: null,       // 'prolific_id' | 'generated_fallback'
  role_locked_to_original: false,   // true if a role change on this browser was overridden to keep the original assignment stable
  paper_order_version: null,        // version tag baked into the server's paper-order hash input (e.g. "v1")
  assigned_paper_1_id: null, assigned_paper_1_title: null,
  assigned_paper_2_id: null, assigned_paper_2_title: null,
  unassigned_paper_id: null,
  paper_order: [], // mirrors study_order (2 entries)

  responses: {},
  ai_chats: { font: [], food: [], listing: [] },
  timing: { font: {}, food: {}, listing: {} },
  ai_paper_aggregates: { font: {}, food: {}, listing: {} },
  ai_message_log: [],
  behavioral_events: [],
  revision_log: [],
  copy_events: [],
  paste_events: [],
  // Removed (formerly draft_history: [], keystroke_counts: {}, quiz: {}):
  // these three top-level fields were write-once-at-init placeholders, never
  // read or written anywhere else in this file. Their real data already
  // lives elsewhere and is unaffected by this removal:
  //   - draft snapshots / per-question keystrokes -> logs[<fieldId>] (below)
  //   - quiz answers                              -> responses['quiz_<paperId>_<qi>']
  //   - quiz summary                               -> quiz_score / quiz_total (below)
  violations: [],
  quiz_score: 0,
  quiz_total: 0,
  fullscreen_used: false,
  logs: {},

  // ===================== TEST MODE (DEV/QA ONLY) =====================
  // Always present on every record (real participants get test_mode:false)
  // so production/test records are distinguishable purely by inspecting the
  // exported data, never by which fields exist. See activateTestModeIfValid()
  // and assignConditionAndOrder() below for how these get set.
  test_mode: false,
  test_condition_override: null, // e.g. "AI_pre", only set when test_mode is true
  test_paper_override: null,     // e.g. ["font","food"], only set when explicitly overridden via ?papers=

  // ===================== Submission-status tracking (spec section 7) =====================
  submission_status: 'not_attempted', // 'not_attempted' | 'submitting' | 'confirmed' | 'failed'
  submission_attempted_at: null,
  submission_confirmed_at: null,
  submission_error: null
};

// ---------- Option constants ----------
// Per mentor (Eunice Yiu) comments on the spec doc: Master's student and PhD
// student each collapse to a single option (rather than per-year PhD
// options) and prompt for a free-typed number of years in the program
// (rounded up to the nearest integer, no cap — some people take more than
// five years); Postdoctoral scholar prompts for years in the position. PhD
// student's expertise tier is derived from the typed year (1 = lower,
// 2+ = higher) rather than from the option label — see ROLE_YEARS_FIELD and
// the server's ROLE_TIER_MAP/PhD handling in server.js.
const ROLE_OPTIONS = [
  { l: 'Undergraduate research assistant', tier: 'lower' },
  { l: 'Post-baccalaureate research assistant or lab manager', tier: 'lower' },
  { l: "Master's student", tier: 'lower', years: true, yearsLabel: 'Number of years in the program (rounded up to the nearest integer)' },
  { l: 'PhD student', tier: null, years: true, yearsLabel: 'Number of years in the program (rounded up to the nearest integer)' },
  { l: 'Postdoctoral scholar', tier: 'higher', years: true, yearsLabel: 'Number of years in the position (rounded up to the nearest integer)' }
];

// Section 4, Q1 — "For which research-related purposes do you use AI
// assistants? Select all that apply." (verbatim option list, spec section 4)
const AI_PURPOSE_OPTIONS = [
  { l: 'Finding information or practical guidance' },
  { l: 'Understanding papers, methods, or concepts' },
  { l: 'Summarizing research materials' },
  { l: 'Brainstorming research questions, hypotheses, study designs, or other research ideas' },
  { l: 'Writing, editing, presentations, or research communication' },
  { l: 'Coding, mathematics, quantitative analysis, or other technical work' },
  { l: 'Interpreting results' },
  { l: 'Evaluating arguments, evidence, methods, or research designs' },
  { l: 'Talking through a research decision' },
  { l: 'Other', specify: true }
];

const TENURE_OPTIONS = [
  'I am just starting out',
  'Less than 6 months',
  '6–12 months',
  '1–2 years',
  'More than 2 years'
];

const LANG_OPTIONS = ['English', 'Other'];

const REVIEWED_OPTIONS = ['None', '1–5', '6–20', '20–50', '51–100', 'More than 100'];

const UNDERSTANDING_OPTIONS = [
  'I just use it. I do not think much about how it works.',
  'I have a general sense. It learns from a lot of text and generates responses.',
  'I understand it reasonably well. I know about training, prompting, and limitations.',
  'I understand it technically. I work with or study AI systems.'
];

// SRL — 21 items, 6 categories (verbatim from spec)
const SRL_ITEMS = [
  // Goal Setting
  ['srl_goal_standards', 'I set personal standards for the quality of my research work.', 'goal_setting'],
  ['srl_goal_shortlong', 'I set short-term goals for what I want to accomplish in a specific research task, as well as longer-term goals for the overall project.', 'goal_setting'],
  ['srl_goal_deadlines', 'I set realistic deadlines for completing research work.', 'goal_setting'],
  // Strategic Planning
  ['srl_plan_questions', 'I ask myself questions about what I need to understand or evaluate before I begin.', 'strategic_planning'],
  ['srl_plan_alternatives', 'I think of alternative ways to approach a research problem and choose the one that seems most useful.', 'strategic_planning'],
  ['srl_plan_adapt', 'When planning my research work, I use and adapt strategies that have worked in the past.', 'strategic_planning'],
  ['srl_plan_organize', 'I organize my time and resources to accomplish my research goals to the best of my ability.', 'strategic_planning'],
  // Task Strategies
  ['srl_task_ownwords', 'I try to translate new information into my own words.', 'task_strategies'],
  ['srl_task_change', 'I change strategies when I do not make progress.', 'task_strategies'],
  ['srl_task_notes', 'When working on research tasks, I make notes to help organize my thoughts.', 'task_strategies'],
  ['srl_task_examples', 'I create my own examples or interpretations to make information more meaningful.', 'task_strategies'],
  // Elaboration
  ['srl_elab_relate', 'When learning something new, I try to relate it to what I already know.', 'elaboration'],
  ['srl_elab_combine', 'When learning something new, I combine different sources of information, such as papers, prior readings, AI tools, websites, or other materials.', 'elaboration'],
  ['srl_elab_prior', 'I draw on my prior knowledge and research experience when interpreting new information.', 'elaboration'],
  // Self-Evaluation
  ['srl_eval_know', 'I usually know how well I understand something once I have finished working on it.', 'self_evaluation'],
  ['srl_eval_different', 'After finishing a research task, I consider whether the task could be approached differently.', 'self_evaluation'],
  ['srl_eval_learned', 'I think about what I have learned after I finish a research task.', 'self_evaluation'],
  // Help Seeking
  ['srl_help_identify', 'I try to identify specific questions I can ask when I need help.', 'help_seeking'],
  ['srl_help_guidance', 'When I am unsure where to start, I seek guidance to help me decide how to approach the task.', 'help_seeking'],
  ['srl_help_beforeown', 'I ask other people or AI what to think about a research task before I have formed my own view.', 'help_seeking'],
  ['srl_help_own_r', 'Even when I am having trouble understanding something, I prefer to work through it on my own before asking for help.', 'help_seeking']
];

// Critical-Thinking scale — 6 items (verbatim), shared by pre/post placement
const CT_ITEMS_LIST = (function () {
  const pairs = [
    'ct_credibility', 'I critically evaluate the credibility of the sources of information I encounter.',
    'ct_evidence', 'I consider whether the evidence presented supports the conclusion being made.',
    'ct_alternatives', 'I consider alternative explanations before accepting a research claim.',
    'ct_bias', 'I reflect on possible biases in my own thinking when making judgments.',
    'ct_assumptions', 'I question the assumptions underlying information or suggestions provided by AI tools.',
    'ct_compare', 'I compare AI-generated information or recommendations with other sources before relying on them.'
  ];
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) { out.push({ key: pairs[i], label: pairs[i + 1] }); }
  return out;
})();

// The critical-thinking items are identical in the pre- and post-task
// placements, but the introductory wording differs by placement.
const CT_INTRO_PRE = [
  'Please indicate how well each statement describes the way you typically evaluate research claims, evidence, or explanations. Answer based on how you usually behave, not how you think you should behave. There are no right or wrong answers.'
];

const CT_INTRO_POST = [
  'Before finishing, we would like to ask a few general questions about how you typically evaluate research information.',
  'The following questions ask about your general habits when evaluating research claims, evidence, and explanations. Please answer based on how you usually approach these kinds of tasks, rather than only on the studies you completed today or how you think you should respond. There are no right or wrong answers.'
];

const CT_SCALE_NOTE = '1 = Not at all true for me, 7 = Very true for me';

// Spec section 6, "Standardized In-Task Questions For Each Assigned Study" —
// this exact 4-question set is repeated verbatim for Paper 1 and Paper 2
// (no per-paper custom wording), so the label lives here rather than per
// paper as in the previous version.
const STANDARD_Q_DEFS = [
  { suffix: 'q1', type: 'textarea', label: 'List 3 strengths of this study.' },
  { suffix: 'q2', type: 'textarea', label: 'List 3 limitations of this study.' },
  { suffix: 'q3', type: 'textarea', label: 'List 3 areas of improvement or follow-up experiments.' },
  { suffix: 'convincing', type: 'scale7', label: 'How convincing do you find this paper?' }
];

// ---------- Papers ----------
const PAPERS = {
  font: {
    id: 'font',
    title: 'Generational Differences in Font-Based Credibility Judgments Across Everyday Contexts',
    pdfFile: 'papers/font.pdf',
    quiz: [
      {
        q: 'Why did the researchers include three different serif/sans-serif font pairs?',
        options: [
          'A. To compare whether some font pairs produced stronger credibility judgments because they were easier to read',
          'B. To determine whether the generational difference remained when the specific typefaces changed, rather than depending on one familiar font contrast',
          'C. To ensure that each communicative context was presented in a different serif/sans-serif pair',
          'D. To examine whether older and younger adults differed in their familiarity with the six individual typefaces'
        ], correct: 'B'
      },
      {
        q: 'What is the best description of how trustworthiness was measured in the study?',
        options: [
          'A. Participants rated the trustworthiness of each font version separately, and the two ratings were compared',
          'B. Participants rated how well each typeface fit the context, which was used as an indirect measure of trust',
          'C. Participants selected the more trustworthy version and then ranked all three font pairs',
          'D. Participants chose which of two identically worded versions they found more trustworthy'
        ], correct: 'D'
      },
      {
        q: 'Which statement best describes the Generation × Scenario interaction?',
        options: [
          'A. Older adults showed their strongest serif preference in print-legacy contexts, whereas younger adults showed their clearest sans-serif preference in digitally native contexts',
          'B. Older adults preferred serif typefaces more than younger adults across all four scenarios, and the size of this difference remained constant across contexts',
          'C. Younger adults\' confidence ratings varied more across scenarios than older adults\' ratings did',
          'D. The interaction was driven mainly by the bank security notice, which produced the largest generational difference'
        ], correct: 'A'
      },
      {
        q: 'What explanation do the authors propose for the study\'s results?',
        options: [
          'A. Communication context determines which typeface category appears credible: serif fonts naturally fit formal contexts, whereas sans-serif fonts naturally fit digital contexts, regardless of the reader\'s background',
          'B. Age-related differences in visual processing make serif fonts easier for older adults to interpret and sans-serif fonts easier for younger adults to interpret',
          'C. Repeated exposure to a typeface category in particular communicative contexts builds familiarity with that pairing, so what feels credible depends on a person\'s exposure history',
          'D. Individual typefaces possess relatively stable credibility cues, but different scenarios change how strongly readers attend to those cues'
        ], correct: 'C'
      }
    ]
  },
  food: {
    id: 'food',
    title: 'Does Food Processing Change Blood Sugar and Insulin Responses to a Calorie-Matched Lunch?',
    pdfFile: 'papers/food.pdf',
    quiz: [
      {
        q: 'Why did the researchers use a within-subjects crossover design, with each participant eating both lunches on separate days?',
        options: [
          'A. To compare each participant\'s responses across lunches while reducing the influence of stable metabolic differences between individuals',
          'B. To isolate processing level by ensuring that the two lunches were identical in every respect except how they were prepared',
          'C. To test whether eating one lunch changed participants\' metabolic response to the lunch served at the later visit',
          'D. To increase the effective sample size by treating the two visits as independent observations from different participants'
        ], correct: 'A'
      },
      {
        q: 'Why did the researchers use two blood draws rather than repeated blood sampling across the entire visit?',
        options: [
          'A. Because the continuous glucose monitor captured the full metabolic response, making later insulin and triglyceride measurements unnecessary',
          'B. Because insulin and triglycerides were expected to remain relatively stable after the 60-minute measurement',
          'C. To ensure that collecting blood did not affect how much participants later ate from the snack tray',
          'D. To limit the burden of repeated blood draws while still measuring insulin and triglycerides at a time when post-meal responses typically peak'
        ], correct: 'D'
      },
      {
        q: 'What did the correlation between the post-lunch glucose dip and snack intake suggest?',
        options: [
          'A. Larger glucose drops were associated with greater snack intake, indicating that the glucose dip fully accounted for the lunch-condition difference in later eating',
          'B. Larger glucose drops were associated with greater snack intake only after the ultra-processed lunch, indicating that the relationship did not occur in the other condition',
          'C. Larger glucose drops were associated with greater snack intake, but the correlation alone could not establish that the glucose dip caused participants to eat more',
          'D. Larger glucose drops predicted greater snack intake even after differences in taste and texture were controlled statistically'
        ], correct: 'C'
      },
      {
        q: 'What mechanism do the authors propose linking food processing to the different metabolic responses?',
        options: [
          'A. Greater processing makes food easier to break down and absorb, which may produce a sharper glucose rise, a larger insulin response, and a later decline',
          'B. Ultra-processed foods contain more metabolizable calories than their labels report, even when labeled calories and macronutrients are matched',
          'C. Additives in ultra-processed foods directly impair insulin signaling, causing glucose to remain elevated throughout the observation period',
          'D. Minimally processed foods require more chewing, and the slower eating rate accounts for the observed glucose and insulin differences'
        ], correct: 'A'
      }
    ]
  },
  listing: {
    id: 'listing',
    title: 'Do Online Product Listings Accurately Describe What Arrives in the Package?',
    pdfFile: 'papers/listing.pdf',
    quiz: [
      {
        q: 'What did the researchers use as an external benchmark to assess whether audit-coded mismatch scores or star ratings reflected real-world listing problems?',
        options: [
          'A. Each listing\'s overall return rate, which combined returns due to inaccurate descriptions with returns for fit, preference, damage, and other reasons',
          'B. The proportion of written reviews that mentioned discrepancies between the listing and the delivered product',
          'C. Each listing\'s trailing 90-day item-not-as-described return rate, which recorded returns attributed specifically to the product not matching its listing',
          'D. The number of customer complaints or policy reports submitted against the seller during the preceding 90 days'
        ], correct: 'C'
      },
      {
        q: 'How did the researchers sample products across the three seller types within each product category?',
        options: [
          'A. They sampled seller types in proportion to their share of listings on the marketplace',
          'B. They sampled the same number of products from each seller type within every category',
          'C. They sampled more seller-shipped third-party listings in categories expected to have higher mismatch rates',
          'D. They sampled products from only one seller type within each category'
        ], correct: 'B'
      },
      {
        q: 'Which conclusion is best supported by the category-specific mismatch results?',
        options: [
          'A. Product categories differed mainly in how often mismatches occurred, while the types of claims that failed were broadly similar across categories',
          'B. Product categories differed both in their overall mismatch rates and in the kinds of listing claims that were most often inaccurate',
          'C. Differences between product categories were primarily caused by unequal representation of the three seller types',
          'D. Categories with more easily measurable physical features, such as dimensions or capacity, consistently showed the highest mismatch rates'
        ], correct: 'B'
      },
      {
        q: 'Why might star ratings fail to closely track objective listing accuracy, according to the authors?',
        options: [
          'A. Star ratings are calculated across all products sold by the same seller, whereas mismatch scores were calculated for individual listings',
          'B. Star ratings are based primarily on whether a product was returned, whereas mismatch scores were based on direct inspection',
          'C. Star ratings place greater weight on recent reviews, whereas mismatch scores weighted every audited claim equally',
          'D. Star ratings combine listing accuracy with other aspects of the purchase, such as shipping, customer service, packaging, and price satisfaction'
        ], correct: 'D'
      }
    ]
  }
};

const PAGE_IDS = [];
const PAPER_IDS = ['font', 'food', 'listing'];

// ===================== TEST MODE (DEV/QA ONLY — NOT PART OF NORMAL PARTICIPANT FLOW) =====================
// Lets a developer/tester force a specific assignment cell + paper order via
// URL params (?test=1&cell=AI_pre[&papers=font,food]), to deliberately
// exercise each experimental condition and inspect exactly what data gets
// captured, without ever touching real participant assignment counters.
//
// SECURITY: a URL param can NEVER activate test mode by itself. `test=1` is
// only a REQUEST to enter test mode; activateTestModeIfValid() below always
// confirms with the server (GET /api/test-mode-status, which only ever
// returns a boolean — no other env var or secret is exposed) before setting
// TEST_MODE_ACTIVE. If the server reports test mode disabled, the URL
// params are ignored entirely and the session proceeds as a normal
// participant with DATA.test_mode left at its default (false).
const TEST_VALID_CELLS = ['AI_pre', 'AI_post', 'noAI_pre', 'noAI_post'];
const TEST_VALID_PAPER_IDS = PAPER_IDS; // ['font','food','listing'] — kept as a single source of truth

let TEST_MODE_ACTIVE = false;          // only ever set true after server confirms ENABLE_TEST_MODE
let TEST_MODE_CELL = null;             // validated cell override, e.g. "AI_pre"
let TEST_MODE_PAPERS = null;           // validated 2-element papers override, or null (use default order)

// Parses and whitelist-validates the ?test=1&cell=...&papers=... params.
// Returns { requested: boolean, valid: boolean, cell, papers, error }.
// Never trusts free-form input past this point — cell must be an exact
// member of TEST_VALID_CELLS, and papers (if present) must be exactly two
// DISTINCT members of TEST_VALID_PAPER_IDS.
function parseTestModeParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('test') !== '1') {
    return { requested: false, valid: false, cell: null, papers: null, error: null };
  }
  const cell = params.get('cell');
  if (!cell || !TEST_VALID_CELLS.includes(cell)) {
    return {
      requested: true, valid: false, cell: null, papers: null,
      error: 'Invalid or missing ?cell= value. Must be exactly one of: ' + TEST_VALID_CELLS.join(', ')
    };
  }
  const papersRaw = params.get('papers');
  let papers = null;
  if (papersRaw != null && papersRaw !== '') {
    papers = papersRaw.split(',').map(s => s.trim()).filter(Boolean);
    const validPapers =
      papers.length === 2 &&
      papers[0] !== papers[1] &&
      papers.every(p => TEST_VALID_PAPER_IDS.includes(p));
    if (!validPapers) {
      return {
        requested: true, valid: false, cell: null, papers: null,
        error: 'Invalid ?papers= override. Must be exactly two distinct values from: ' + TEST_VALID_PAPER_IDS.join(', ')
      };
    }
  }
  return { requested: true, valid: true, cell, papers, error: null };
}

// Blocking, developer-facing error screen for invalid test params — this is
// NEVER shown to a real participant in a non-test URL, only when ?test=1 was
// explicitly supplied with bad cell/papers values. Intentionally styled
// distinctly from the survey UI (so it cannot be mistaken for a participant-
// facing screen) and built without touching any existing page markup/CSS.
function showTestModeDevError(message) {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:#1a0d0d;color:#ffdede;font-family:monospace;' +
    'padding:40px;z-index:99999;overflow:auto;';
  el.innerHTML = '<h1 style="color:#ff6b6b;">TEST MODE — Invalid configuration</h1>' +
    '<p style="font-size:16px;max-width:680px;">' + escapeHtml(message) + '</p>' +
    '<p style="opacity:.7;">Valid cells: ' + TEST_VALID_CELLS.join(', ') + '<br>' +
    'Valid papers: ' + TEST_VALID_PAPER_IDS.join(', ') + ' (exactly two, distinct)</p>';
  document.body.appendChild(el);
}

// Renders/updates the fixed test-mode banner. Only ever called after
// TEST_MODE_ACTIVE has been confirmed true; never appears during normal
// participation. Built dynamically (not static HTML) so the existing page
// markup/CSS is untouched — see also the "do not change styling" constraint.
function renderTestModeBanner() {
  let el = document.getElementById('testModeBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'testModeBanner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;' +
      'background:#7a1fa2;color:#fff;font-family:monospace;font-size:12px;' +
      'padding:5px 10px;text-align:center;pointer-events:none;';
    document.body.appendChild(el);
  }
  const papersLabel = TEST_MODE_PAPERS ? (TEST_MODE_PAPERS[0] + ' → ' + TEST_MODE_PAPERS[1]) : '(default order)';
  el.textContent = 'TEST MODE — ' + (TEST_MODE_CELL || '?') + ' — ' + papersLabel;
}

// Entry point, called once on load (see DOMContentLoaded below). Resolves
// the dual gate (URL param + server ENABLE_TEST_MODE) before anything else
// in the page touches DATA.test_mode or TEST_MODE_ACTIVE.
async function activateTestModeIfValid() {
  const parsed = parseTestModeParams();
  if (!parsed.requested) return; // no ?test=1 at all — completely normal session
  if (!parsed.valid) {
    showTestModeDevError(parsed.error);
    throw new Error('test_mode_invalid_params');
  }
  let statusOk = false;
  try {
    const resp = await fetch('/api/test-mode-status');
    const body = resp.ok ? await resp.json() : { enabled: false };
    statusOk = body && body.enabled === true;
  } catch (e) {
    statusOk = false; // network failure -> fail closed, never assume enabled
  }
  if (!statusOk) {
    // Server-side gate is OFF: per spec, the URL param alone must never
    // activate test mode. Silently proceed as a completely normal session —
    // DATA.test_mode stays false, no banner, no behavior change.
    console.warn('[test-mode] ?test=1 was supplied but ENABLE_TEST_MODE is not set on the server; ignoring and proceeding as a normal session.');
    return;
  }
  TEST_MODE_ACTIVE = true;
  TEST_MODE_CELL = parsed.cell;
  TEST_MODE_PAPERS = parsed.papers; // may be null -> default order
  DATA.test_mode = true;
  DATA.test_condition_override = parsed.cell;
  DATA.test_paper_override = parsed.papers ? [...parsed.papers] : null;
  renderTestModeBanner();
}

function getPlainStudyText(paperId) {
  return (window.PAPER_PLAIN_TEXT && window.PAPER_PLAIN_TEXT[paperId]) || '';
}

// ---------- Page order + section numbering ----------
let pageOrder = ['page-consent'];
let currentIdx = 0;
let QUIZ_PAGE_IDS = [];
let INSTRUCTIONS_PAGE_IDS = [];

function buildPageOrder() {
  const order = ['page-consent', 'page-about-you', 'page-srl'];
  if (DATA.ct_scale_placement === 'pre') order.push('page-ct');
  order.push('page-ai-experience');
  order.push(...(INSTRUCTIONS_PAGE_IDS.length ? INSTRUCTIONS_PAGE_IDS : ['page-instructions']));
  order.push('page-study-1', 'page-study-2', 'page-reflections');
  if (DATA.ct_scale_placement === 'post') order.push('page-ct');
  order.push('page-quiz-intro');
  order.push(...QUIZ_PAGE_IDS);
  order.push('page-debrief', 'page-submitted');
  pageOrder = order;
  applySectionNumbers();
}

function applySectionNumbers() {
  const pre = DATA.ct_scale_placement === 'pre';
  const map = pre
    ? { about_you: 1, srl: 2, ct: 3, ai_experience: 4, task: 5, reflections: 6, quiz: 7, debrief: 8 }
    : { about_you: 1, srl: 2, ai_experience: 3, task: 4, reflections: 5, ct: 6, quiz: 7, debrief: 8 };
  Object.keys(map).forEach(k => {
    const el = document.getElementById('secnum-' + k.replace(/_/g, '-'));
    if (el) el.textContent = map[k];
  });
}

// ---------- Stable participant identifier (for assignment only) ----------
// DATA.participant_id (genId(), above) is a per-page-load session/logging
// id — it's used to tag chat transcripts, behavioral events, etc., and is
// deliberately left unchanged. Condition/CT-placement and paper-order
// assignment instead need an id that is stable across refreshes and repeat
// visits, so they use a SEPARATE id computed here:
//   - the participant's entered Prolific ID, normalized (trimmed), when
//     available — this is the natural stable identifier for a real
//     Prolific-recruited participant and is already collected (and
//     required) on the consent page, before assignment ever runs; or
//   - for local testing/dev, or any case where no Prolific ID was entered, a
//     fallback UUID generated once and persisted in localStorage so it
//     survives refreshes on the same browser.
// This localStorage use is just an id cache, not a sample-balancing counter
// — nothing here is read by the assignment logic to decide cell counts.
const FALLBACK_ID_STORAGE_KEY = 'research_survey_fallback_participant_id';
const ASSIGNMENT_CACHE_PREFIX = 'research_survey_assignment_cache_';

// Trim + lowercase, matching the server's normalizeStableId() exactly, so a
// same-browser localStorage cache lookup (keyed on this value) lines up with
// however the server would normalize the same id, even if the participant
// types it with different capitalization across visits. The server remains
// the authoritative normalization for the actual hash/assignment.
function normalizeProlificId(raw) {
  return (raw || '').trim().toLowerCase();
}

function getOrCreateFallbackId() {
  try {
    let id = localStorage.getItem(FALLBACK_ID_STORAGE_KEY);
    if (!id) {
      id = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : ('fallback-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
      localStorage.setItem(FALLBACK_ID_STORAGE_KEY, id);
    }
    return id;
  } catch (e) {
    // localStorage unavailable (e.g. private browsing in some browsers) —
    // degrade to a per-call id; this only affects refresh-stability for the
    // no-Prolific-ID case, never the normal Prolific-ID path.
    return (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : genId();
  }
}

// Returns { id, source } where source is 'prolific_id' or 'generated_fallback'.
function getStableAssignmentId() {
  const prolific = normalizeProlificId(DATA.prolific_id);
  if (prolific) return { id: prolific, source: 'prolific_id' };
  return { id: getOrCreateFallbackId(), source: 'generated_fallback' };
}

function readAssignmentCache(stableId) {
  try {
    const raw = localStorage.getItem(ASSIGNMENT_CACHE_PREFIX + stableId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeAssignmentCache(stableId, record) {
  try {
    localStorage.setItem(ASSIGNMENT_CACHE_PREFIX + stableId, JSON.stringify(record));
  } catch (e) {
    // Non-fatal: the assignment itself still came from the server and is
    // stored in DATA; only the same-browser role-change guard degrades.
  }
}

// ---------- Stratified random assignment ----------
// Assignment happens exactly once per page-about-you visit, and is then
// frozen for the rest of the session by being written into DATA. A full
// browser refresh currently restarts the page flow from consent (existing,
// unchanged behavior — see DEPLOYMENT.md), but assignment itself is stable
// across that restart: it's a pure function of the STABLE id above (not the
// per-load DATA.participant_id), so re-entering the same Prolific ID (or
// having the fallback UUID restored from localStorage) and re-submitting
// About You reproduces the identical condition, CT placement, and paper
// selection/order every time.
//
// Requests the participant's condition/CT-placement/paper assignment from
// the server. The server is the ONLY source of truth for the actual
// hashing/mapping — see /api/assign-condition in server.js. This function
// does NOT compute an assignment itself and does NOT fall back to a
// random/local assignment on failure: per the study design, a participant
// must not proceed past the About You page without a valid server-issued
// assignment, so failures are thrown for the caller (requestAssignmentWithUI,
// below) to surface as a recoverable error with a Retry button.
async function assignConditionAndOrder(researchRole, researchRoleYears) {
  // ===================== TEST MODE (DEV/QA ONLY) =====================
  // When test mode is active, route entirely to the separate, server-gated
  // /api/test-assign-condition endpoint instead of the production
  // /api/assign-condition flow below — this branch never touches the stable
  // id, the same-browser assignment cache, or any real Firestore counters.
  if (TEST_MODE_ACTIVE) {
    return assignConditionAndOrderTestMode(researchRole, researchRoleYears);
  }

  const { id: stableId, source: idSource } = getStableAssignmentId();

  // Best-effort, same-browser guard against re-rolling the assignment by
  // changing role/stratum after already being assigned: if this stable id
  // already has a cached assignment on this browser and the role no longer
  // matches, use the ORIGINALLY recorded role for the request instead of
  // the newly selected one. (This cannot detect a role change made from a
  // different browser/device for the same Prolific ID — doing that would
  // require a shared server-side store, which is explicitly out of scope
  // here. The cell itself is keyed by expertise STRATUM, not exact role
  // text, so this only matters when a changed role would cross strata.)
  const cached = readAssignmentCache(stableId);
  let effectiveRole = researchRole;
  let roleLockedToOriginal = false;
  if (cached && cached.research_role && cached.research_role !== researchRole) {
    effectiveRole = cached.research_role;
    roleLockedToOriginal = true;
  }

  const resp = await fetch('/api/assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stable_participant_id: stableId,
      research_role: effectiveRole,
      research_role_years: researchRoleYears
    })
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(errBody.error || ('assign-condition request failed: ' + resp.status));
  }
  const data = await resp.json();

  // Authoritative, server-generated assignment. Frontend only stores/uses
  // these values, never generates or alters them. Note: we store the
  // server-returned ONE-WAY HASH of the stable id (data.stable_assignment_id_hash),
  // not the raw stableId variable above — the raw Prolific ID is already
  // recorded once in DATA.prolific_id, so this avoids writing the same
  // plaintext identifier into participant data under a second field name.
  DATA.stable_assignment_id_hash = data.stable_assignment_id_hash;
  DATA.assignment_id_source = idSource;
  DATA.role_locked_to_original = roleLockedToOriginal;
  DATA.research_role = data.research_role;
  DATA.research_role_years = data.research_role_years;
  DATA.research_expertise_stratum = data.research_expertise_stratum;
  DATA.expertise_tier = data.research_expertise_stratum; // legacy alias, kept for any export logic that still reads it
  DATA.ai_condition = data.ai_condition;
  DATA.condition = data.ai_condition; // legacy alias
  DATA.critical_thinking_placement = data.critical_thinking_placement;
  DATA.ct_scale_placement = data.critical_thinking_placement; // legacy alias
  DATA.assignment_cell = data.assignment_cell;
  DATA.assignment_assigned_at = data.assigned_at;
  DATA.assignment_source = data.assignment_source;
  DATA.assignment_version = data.assignment_version;
  DATA.paper_order_version = data.paper_order_version;

  document.body.classList.add(DATA.ai_condition === 'AI' ? 'condition-ai' : 'condition-noai');

  // Paper selection/order is now ALSO a deterministic server hash (separate
  // from the condition/CT hash above), keyed by the same stable id, so it
  // survives refresh/repeat requests exactly like the condition does.
  const order = data.paper_order;
  const unassigned = data.unassigned_paper_id;

  DATA.study_order = order;
  DATA.study_1_id = order[0]; DATA.study_2_id = order[1];
  DATA.study_1_title = PAPERS[order[0]].title;
  DATA.study_2_title = PAPERS[order[1]].title;

  DATA.paper_order = [...order];
  DATA.assigned_paper_1_id = order[0]; DATA.assigned_paper_1_title = PAPERS[order[0]].title;
  DATA.assigned_paper_2_id = order[1]; DATA.assigned_paper_2_title = PAPERS[order[1]].title;
  DATA.unassigned_paper_id = unassigned;

  writeAssignmentCache(stableId, {
    research_role: DATA.research_role,
    research_expertise_stratum: DATA.research_expertise_stratum,
    ai_condition: DATA.ai_condition,
    critical_thinking_placement: DATA.critical_thinking_placement,
    assignment_cell: DATA.assignment_cell,
    assignment_assigned_at: DATA.assignment_assigned_at,
    assignment_source: DATA.assignment_source,
    assignment_version: DATA.assignment_version,
    paper_order_version: DATA.paper_order_version,
    stable_assignment_id_hash: DATA.stable_assignment_id_hash,
    study_order: DATA.study_order,
    unassigned_paper_id: DATA.unassigned_paper_id
  });
}

// ===================== TEST MODE (DEV/QA ONLY) =====================
// Mirrors the DATA-field-setting half of assignConditionAndOrder() above,
// but sources the assignment from /api/test-assign-condition (forced
// cell/papers, server-validated, never touches Firestore) instead of
// /api/assign-condition. Deliberately skips getStableAssignmentId(),
// readAssignmentCache()/writeAssignmentCache(), and role-lock handling —
// none of those production-only mechanisms should apply to a test run.
async function assignConditionAndOrderTestMode(researchRole, researchRoleYears) {
  const resp = await fetch('/api/test-assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell: TEST_MODE_CELL,
      papers: TEST_MODE_PAPERS,
      research_role: researchRole,
      research_role_years: researchRoleYears
    })
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(errBody.error || ('test-assign-condition request failed: ' + resp.status));
  }
  const data = await resp.json();

  DATA.stable_assignment_id_hash = data.stable_assignment_id_hash;
  DATA.assignment_id_source = 'test_mode';
  DATA.role_locked_to_original = false;
  DATA.research_role = data.research_role;
  DATA.research_role_years = data.research_role_years;
  DATA.research_expertise_stratum = data.research_expertise_stratum;
  DATA.expertise_tier = data.research_expertise_stratum;
  DATA.ai_condition = data.ai_condition;
  DATA.condition = data.ai_condition;
  DATA.critical_thinking_placement = data.critical_thinking_placement;
  DATA.ct_scale_placement = data.critical_thinking_placement;
  DATA.assignment_cell = data.assignment_cell;
  DATA.assignment_assigned_at = data.assigned_at;
  DATA.assignment_source = data.assignment_source;
  DATA.assignment_version = data.assignment_version;
  DATA.paper_order_version = data.paper_order_version;

  document.body.classList.add(DATA.ai_condition === 'AI' ? 'condition-ai' : 'condition-noai');

  const order = data.paper_order;
  const unassigned = data.unassigned_paper_id;

  DATA.study_order = order;
  DATA.study_1_id = order[0]; DATA.study_2_id = order[1];
  DATA.study_1_title = PAPERS[order[0]].title;
  DATA.study_2_title = PAPERS[order[1]].title;

  DATA.paper_order = [...order];
  DATA.assigned_paper_1_id = order[0]; DATA.assigned_paper_1_title = PAPERS[order[0]].title;
  DATA.assigned_paper_2_id = order[1]; DATA.assigned_paper_2_title = PAPERS[order[1]].title;
  DATA.unassigned_paper_id = unassigned;

  // Keep the banner's paper labels in sync even when no ?papers= override
  // was supplied (i.e. the default combo came back from the server).
  TEST_MODE_PAPERS = [...order];
  renderTestModeBanner();

  // Deliberately no writeAssignmentCache() call: test runs must never read
  // from or write to the same-browser real-assignment cache.
}

// ---------- Assignment loading/error UI ----------
// Shows a brief loading state while /api/assign-condition is in flight, and
// a recoverable error + Retry button if it fails, per spec: the participant
// must not be able to proceed to condition-dependent sections until a valid
// server assignment has been returned.
function setAssignmentStatus(mode, message) {
  const wrap = document.getElementById('assignmentStatus');
  const spinner = document.getElementById('assignmentSpinner');
  const text = document.getElementById('assignmentStatusText');
  const retryBtn = document.getElementById('assignmentRetryBtn');
  if (!wrap) return;
  if (mode === 'hidden') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  wrap.classList.remove('loading', 'error');
  wrap.classList.add(mode);
  if (spinner) spinner.style.display = (mode === 'loading') ? 'inline-block' : 'none';
  if (text) text.textContent = message || '';
  if (retryBtn) retryBtn.style.display = (mode === 'error') ? 'inline-block' : 'none';
}

// Holds the role selected at the moment Continue was clicked, so the Retry
// button can re-run the exact same request without re-reading the form.
let pendingAssignmentRole = null;
let pendingAssignmentRoleYears = null;

async function requestAssignmentWithUI() {
  const btnNext = document.getElementById('btnNext');
  setAssignmentStatus('loading', 'Assigning your condition…');
  if (btnNext) btnNext.disabled = true;
  try {
    await assignConditionAndOrder(pendingAssignmentRole, pendingAssignmentRoleYears);
    setAssignmentStatus('hidden');
    if (btnNext) btnNext.disabled = false;
    return true;
  } catch (err) {
    console.error('[requestAssignmentWithUI] /api/assign-condition failed:', err);
    setAssignmentStatus('error', 'Could not assign your condition. Please check your connection and retry.');
    if (btnNext) btnNext.disabled = false;
    return false;
  }
}

async function retryAssignment() {
  if (navigateInFlight) return;
  navigateInFlight = true;
  const ok = await requestAssignmentWithUI();
  navigateInFlight = false;
  if (!ok) return;
  finalizeAboutYou();
  advanceFromIndex(pageOrder.indexOf('page-about-you'), 1);
}

// ---------- Navigation ----------
let quizTransitionTimer = null;

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
  document.getElementById('siteHeader').style.display = (id === 'page-consent') ? '' : 'none';
  updateNav();
  const m = /^page-study-(\d)$/.exec(id);
  if (m) {
    const slotNum = parseInt(m[1], 10);
    const paperId = DATA['study_' + slotNum + '_id'];
    if (paperId) {
      markStudyStart(id);
      renderStudyPdfIfNeeded(paperId);
    }
  }
  // Quiz transition pages have no Continue button — clear any previous
  // pending timer (so re-showing a page never stacks two timers) and, if the
  // page we just showed is a transition page, auto-advance after 3s.
  clearTimeout(quizTransitionTimer);
  if (/^page-quiz-transition-/.test(id)) {
    quizTransitionTimer = setTimeout(() => navigate(1), 3000);
  }
}

const selfNavPages = ['page-consent', 'page-exit', 'page-submitted'];

// Quiz transition pages (one per assigned paper, see buildQuizPages()) have
// dynamic ids ('page-quiz-transition-<paperId>') and, like selfNavPages,
// have no manual Continue button — they auto-advance instead (the 3s timer
// in showPage()). Matched by pattern rather than added to the fixed
// selfNavPages array since the ids depend on paper assignment.
function isSelfNavPage(id) {
  return selfNavPages.includes(id) || /^page-quiz-transition-/.test(id);
}

function updateNav() {
  const idx = pageOrder.indexOf(getCurrentPageId());
  const total = pageOrder.length;
  // Quiz transition pages are included in pageOrder (via QUIZ_PAGE_IDS), so
  // the progress bar automatically accounts for them without any extra math.
  const pct = total > 1 ? Math.round((idx / (total - 1)) * 100) : 0;
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = pct + '%';
  // Step-count text ("Step X of Y") removed per spec; the progress bar is
  // kept as the sole progress indicator.
  const stepLabel = document.getElementById('navStep');
  if (stepLabel) stepLabel.textContent = '';
  const btnNext = document.getElementById('btnNext');
  const curId = getCurrentPageId();
  if (isSelfNavPage(curId)) {
    if (btnNext) btnNext.style.display = 'none';
  } else {
    if (btnNext) btnNext.style.display = '';
    const lastInstrId = INSTRUCTIONS_PAGE_IDS[INSTRUCTIONS_PAGE_IDS.length - 1];
    if (btnNext) btnNext.textContent = (curId === 'page-debrief') ? 'Finish' : (curId === lastInstrId ? 'Begin Task →' : 'Continue →');
  }
  const topMeta = document.getElementById('topMeta');
  if (topMeta) topMeta.textContent = 'ID: ' + DATA.participant_id;
}

function getCurrentPageId() {
  const active = document.querySelector('.page.active');
  return active ? active.id : pageOrder[0];
}

let currentStudyPaperId = null;
let navigateInFlight = false;

async function navigate(dir) {
  // Guards the page-about-you branch below, which now awaits a network
  // round-trip (assignConditionAndOrder -> /api/assign-condition). Without
  // this, a double-click on Continue could fire two concurrent assignment
  // requests for the same participant.
  if (navigateInFlight) return;
  if (!validateCurrentPage()) return;
  const curId = getCurrentPageId();
  const idx = pageOrder.indexOf(curId);
  if (curId === 'page-debrief' && dir > 0) {
    finalizeSubmission();
    return;
  }

  const studyMatch = /^page-study-(\d)$/.exec(curId);
  if (studyMatch && dir > 0) {
    const paperId = DATA['study_' + studyMatch[1] + '_id'];
    if (paperId) finalizeStudyTiming(paperId);
  }

  collectFieldsNow();

  if (curId === 'page-about-you' && dir > 0) {
    // Gate: do not allow the participant to proceed until the server has
    // returned a valid assignment. requestAssignmentWithUI() shows a loading
    // state, then either succeeds (we continue below) or shows an inline
    // error + Retry button and leaves the participant on this page.
    navigateInFlight = true;
    const roleVal = document.querySelector('input[name="ay_role"]:checked');
    pendingAssignmentRole = roleVal ? roleVal.value : null;
    const roleYearsEl = document.getElementById('ay_role_years');
    pendingAssignmentRoleYears = (roleYearsEl && roleYearsEl.value !== '') ? Number(roleYearsEl.value) : null;
    const ok = await requestAssignmentWithUI();
    navigateInFlight = false;
    if (!ok) return;
    finalizeAboutYou();
  }

  advanceFromIndex(idx, dir);
}

// Shared "go to the next/previous page" logic, used both by the normal
// navigate() flow and by retryAssignment() (which needs to resume the
// page-about-you -> next-page transition after a successful retry, without
// re-running the validation/finalize steps above it in navigate()).
function advanceFromIndex(idx, dir) {
  let nextIdx = idx + dir;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= pageOrder.length) {
    finalizeSubmission();
    return;
  }
  const curId = pageOrder[idx];
  currentIdx = nextIdx;

  const lastInstrId = INSTRUCTIONS_PAGE_IDS[INSTRUCTIONS_PAGE_IDS.length - 1];
  if (curId === lastInstrId && dir > 0) {
    enterFullscreenAndStart();
  }
  if (curId === 'page-quiz-intro' && dir > 0 && QUIZ_PAGE_IDS.length === 0) {
    buildQuizPages();
    buildPageOrder();
    currentIdx = pageOrder.indexOf('page-quiz-intro') + 1;
  }

  showPage(pageOrder[currentIdx]);
}

// Builds everything that depends on the assignment just received from the
// server (condition-specific page order/sections/instructions/study pages).
// Pure/local — no network call here; assignConditionAndOrder() already ran
// inside requestAssignmentWithUI() before this is called.
function finalizeAboutYou() {
  buildInstructionsPages();
  buildPageOrder();
  renderAllSections();
  buildStudyPages();
}

function finalizeStudyTiming(paperId) {
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  DATA.timing[paperId].study_end_ts = nowTs();
  DATA.timing[paperId].study_end_iso = nowIso();
  if (DATA.timing[paperId].study_start_ts) {
    DATA.timing[paperId].duration_ms = DATA.timing[paperId].study_end_ts - DATA.timing[paperId].study_start_ts;
  }
}

function markStudyStart(slotId) {
  const m = /^page-study-(\d)$/.exec(slotId);
  if (!m) return;
  const paperId = DATA['study_' + m[1] + '_id'];
  if (!paperId) return;
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  if (!DATA.timing[paperId].study_start_ts) {
    DATA.timing[paperId].study_start_ts = nowTs();
    DATA.timing[paperId].study_start_iso = nowIso();
  }
  currentStudyPaperId = paperId;
}

// ---------- Validation (kept disabled per prior testing instruction) ----------
function isFieldVisible(el) {
  if (!el) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}
function clearValidationErrors(pageEl) {
  if (!pageEl) return;
  pageEl.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
  pageEl.querySelectorAll('.group-error').forEach(el => el.classList.remove('group-error'));
}
function flagGroupError(container) {
  if (container) container.classList.add('group-error');
}
function validateCurrentPage() {
  const pageEl = document.querySelector('.page.active');
  if (!pageEl) return true;

  // Pages containing instructions, transitions, or debrief text have
  // nothing for the participant to answer.
  const pageId = pageEl.id;
  const noResponseRequired =
    pageId === 'page-instructions' ||
    /^page-instructions-/.test(pageId) ||
    pageId === 'page-quiz-intro' ||
    pageId === 'page-debrief' ||
    pageId === 'page-submitted' ||
    pageId === 'page-exit' ||
    /^page-quiz-transition-/.test(pageId);

  if (noResponseRequired) return true;

  clearValidationErrors(pageEl);

  let valid = true;
  let firstInvalid = null;

  function markInvalid(element, groupElement) {
    valid = false;

    if (groupElement) {
      flagGroupError(groupElement);
      if (!firstInvalid) firstInvalid = groupElement;
    } else if (element) {
      element.classList.add('input-error');
      if (!firstInvalid) firstInvalid = element;
    }
  }

  // ------------------------------------------------------------
  // 1. Visible text, number, and select fields
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('input[type="text"], input[type="number"], select')
    .forEach(field => {
      if (!isFieldVisible(field) || field.disabled) return;

      const value = String(field.value || '').trim();

      if (!value || !field.checkValidity()) {
        markInvalid(field);
      }
    });

  // ------------------------------------------------------------
  // 2. Open-ended study responses
  //
  // Only textareas marked data-logfield are participant answers.
  // AI message boxes are deliberately excluded.
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('textarea[data-logfield]')
    .forEach(field => {
      if (!isFieldVisible(field) || field.disabled) return;

      if (!field.value.trim()) {
        markInvalid(field);
      }
    });

  // ------------------------------------------------------------
  // 3. Radio and checkbox question groups
  //
  // Each visible .options-grid is one question. At least one option
  // must be selected. This covers About You, AI experience,
  // AI-engagement reflections, and quiz choices.
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('.options-grid')
    .forEach(group => {
      if (!isFieldVisible(group)) return;

      const inputs = Array.from(
        group.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      ).filter(input => !input.disabled);

      // Ignore containers that do not contain an answer group.
      if (inputs.length === 0) return;

      const hasSelection = inputs.some(input => input.checked);

      if (!hasSelection) {
        markInvalid(null, group);
      }
    });

  // ------------------------------------------------------------
  // 4. "Other — please specify" fields
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('input[id$="-specify"]')
    .forEach(field => {
      if (!isFieldVisible(field) || field.disabled) return;

      if (!field.value.trim()) {
        markInvalid(field);
      }
    });

  // ------------------------------------------------------------
  // 5. SRL and critical-thinking Likert questions
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('.likert-item')
    .forEach(item => {
      if (!isFieldVisible(item)) return;

      if (!item.querySelector('.likert-btn.selected')) {
        markInvalid(null, item);
      }
    });

  // ------------------------------------------------------------
  // 6. Convincingness, confidence, understanding, and
  //    whose-thinking scales
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('.conf-scale')
    .forEach(scale => {
      if (!isFieldVisible(scale)) return;

      if (!scale.querySelector('.conf-btn.selected')) {
        markInvalid(null, scale);
      }
    });

  // ------------------------------------------------------------
  // 7. AI-experience sliders
  //
  // The sliders visually begin at 50, but a participant must move
  // each one so the survey records an intentional answer.
  // DATA.responses receives the value in each slider's oninput.
  // ------------------------------------------------------------
  pageEl
    .querySelectorAll('input[type="range"][data-key]')
    .forEach(slider => {
      if (!isFieldVisible(slider) || slider.disabled) return;

      const responseKey = slider.getAttribute('data-key');
      const wasAnswered =
        responseKey &&
        Object.prototype.hasOwnProperty.call(DATA.responses, responseKey);

      if (!wasAnswered) {
        const block = slider.closest('.slider-block') || slider;
        markInvalid(null, block);
      }
    });

  if (!valid) {
    if (firstInvalid) {
      firstInvalid.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }

    alert('Please answer all questions on this page before continuing.');
    return false;
  }

  return true;
}

// ---------- Consent page ----------
function toggleConsent(inputId, visualId) {
  const input = document.getElementById(inputId);
  const visual = document.getElementById(visualId);
  input.checked = !input.checked;
  visual.classList.toggle('checked', input.checked);
}

function renderRadioGroup(containerId, name, options, getLabel, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  type = type || 'radio';
  container.innerHTML = options.map((o, i) => {
    const value = getLabel ? getLabel(o) : o;
    const sub = (typeof o === 'object' && o.sub) ? `<div class="q-sublabel" style="margin:4px 0 0;">${escapeHtml(o.sub)}</div>` : '';
    return `<label class="option-item" data-group="${name}">
      <input type="${type}" name="${name}" value="${escapeHtml(value)}">
      <div class="option-dot"></div>
      <div><div class="option-text">${escapeHtml(value)}</div>${sub}</div>
    </label>`;
  }).join('');
}

function initConsentPage() {
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

function showExitScreen() {
  pageOrder = ['page-consent', 'page-exit'];
  currentIdx = 1;
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('navStep').textContent = '';
  document.getElementById('btnNext').style.display = 'none';
  document.getElementById('siteHeader').style.display = 'none';
  showPage('page-exit');
}

function declineConsent() {
  DATA.consent_status = 'declined';
  DATA.screening_exit_reason = 'declined_consent';
  DATA.completion_status = 'exited_early';
  DATA.session_end_iso = nowIso();
  showExitScreen();
}

function submitConsentPage() {
  const prolific = document.getElementById('prolific_id').value.trim();
  const prolificHint = document.getElementById('prolificErrorHint');
  const familiar = document.querySelector('input[name="familiar"]:checked');
  const consentCb = document.getElementById('consent-cb');
  const mediaCb = document.getElementById('media-cb');
  const errEl = document.getElementById('consent-error');

  let ok = true;
  if (!prolific) {
    document.getElementById('prolific_id').classList.add('input-error');
    if (prolificHint) prolificHint.style.display = 'block';
    ok = false;
  } else {
    document.getElementById('prolific_id').classList.remove('input-error');
    if (prolificHint) prolificHint.style.display = 'none';
  }
  if (!familiar) {
    flagGroupError(document.getElementById('rg-familiar'));
    ok = false;
  }
  if (!consentCb.checked || !mediaCb.checked) {
    ok = false;
  }
  if (!ok) {
    if (errEl) errEl.style.display = 'block';
    return;
  }
  if (errEl) errEl.style.display = 'none';

  if (familiar.value.startsWith('No')) {
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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Generic rendering helpers ----------
function updateSliderFill(el) {
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100;
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(to right, var(--terra) ${pct}%, var(--border) ${pct}%)`;
}

function likertItemHtml(name, label, leftLab, rightLab) {
  let btns = '';
  for (let i = 1; i <= 7; i++) {
    btns += `<button type="button" class="likert-btn" data-name="${name}" data-val="${i}" onclick="selectLikert(this)">${i}</button>`;
  }
  return `<div class="likert-item" data-name="${name}">
    <div class="likert-statement">${escapeHtml(label)}</div>
    <div class="likert-scale">${btns}</div>
    <div class="scale-ends">
      <div class="scale-end">${escapeHtml(leftLab || '')}</div>
      <div class="scale-end right">${escapeHtml(rightLab || '')}</div>
    </div>
  </div>`;
}

function selectLikert(btn) {
  const name = btn.getAttribute('data-name');
  document.querySelectorAll(`.likert-btn[data-name="${name}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  DATA.responses[name] = parseInt(btn.getAttribute('data-val'), 10);
}

function renderScale7Block(containerId, items, leftLab, rightLab, append) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const html = items.map(([key, label]) => likertItemHtml(key, label, leftLab, rightLab)).join('');
  if (append) container.innerHTML += html; else container.innerHTML = html;
}

// ---------- About You / SRL / CT / AI Experience rendering ----------
function renderAllSections() {
  // About You
  renderRadioGroup('rg-ay-lang', 'lang', LANG_OPTIONS);
  setupSpecifyField('rg-ay-lang', 'lang', 'Other');
  renderRadioGroup('rg-ay-role', 'ay_role', ROLE_OPTIONS, o => o.l);
  setupRoleYearsField('rg-ay-role', 'ay_role', ROLE_OPTIONS);
  renderRadioGroup('rg-ay-reviewed', 'reviewed', REVIEWED_OPTIONS);

  // SRL
  renderScale7Block(
    'srlWrap',
    SRL_ITEMS.map(([k, l]) => [k, l]),
    'Not at all true for me',
    'Very true for me'
  );

  // Critical-Thinking shared template
  const ctIntroEl = document.getElementById('ctIntroText');
  if (ctIntroEl) {
    const introParagraphs =
      DATA.ct_scale_placement === 'pre'
        ? CT_INTRO_PRE
        : CT_INTRO_POST;

    ctIntroEl.innerHTML = introParagraphs
      .map((text, index) => `
        <p class="muted" style="margin-bottom:${index === introParagraphs.length - 1 ? '16px' : '10px'};">
          ${escapeHtml(text)}
        </p>
      `)
      .join('');
  }

  renderScale7Block(
    'ctWrap',
    CT_ITEMS_LIST.map(item => [item.key, item.label]),
    'Not at all true for me',
    'Very true for me'
  );

  // AI Experience
  renderRadioGroup('rg-ai-purpose', 'ai_purpose', AI_PURPOSE_OPTIONS, o => o.l, 'checkbox');
  setupSpecifyField('rg-ai-purpose', 'ai_purpose', 'Other');
  renderRadioGroup('rg-ai-tenure', 'ai_tenure', TENURE_OPTIONS);
  renderRadioGroup('rg-ai-understanding', 'ai_understanding', UNDERSTANDING_OPTIONS);

}

// Shows/hides a free-text "specify" input next to a checkbox/radio group
// whenever the option literally labeled `triggerLabel` (e.g. "Other") is
// checked — used for the spec's "Other [specify]" options. Stores the typed
// text in DATA.responses[fieldName + '_specify'].
function setupSpecifyField(containerId, fieldName, triggerLabel) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let specifyEl = document.getElementById(containerId + '-specify');
  if (!specifyEl) {
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

// Conditional "number of years" follow-up for the research-role question
// (Master's student / PhD student / Postdoctoral scholar — see ROLE_OPTIONS).
// Mirrors setupSpecifyField's show/hide pattern, but is numeric and its
// label text changes depending on which of the three roles is selected.
function setupRoleYearsField(containerId, fieldName, options) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let wrapEl = document.getElementById(containerId + '-years-wrap');
  if (!wrapEl) {
    wrapEl = document.createElement('div');
    wrapEl.id = containerId + '-years-wrap';
    wrapEl.style.marginTop = '10px';
    wrapEl.style.display = 'none';
    wrapEl.innerHTML = `<div class="q-sublabel" id="${containerId}-years-label" style="margin-bottom:6px;"></div>
      <input type="number" id="${fieldName}_years" min="0" step="1" placeholder="Number of years">`;
    container.insertAdjacentElement('afterend', wrapEl);
  }
  const labelEl = document.getElementById(containerId + '-years-label');
  const inputEl = document.getElementById(fieldName + '_years');
  const sync = () => {
    const checked = container.querySelector(`input[name="${fieldName}"]:checked`);
    const opt = checked && options.find(o => o.l === checked.value);
    if (opt && opt.years) {
      wrapEl.style.display = '';
      if (labelEl) labelEl.textContent = opt.yearsLabel || 'Number of years';
    } else {
      wrapEl.style.display = 'none';
      if (inputEl) inputEl.value = '';
      DATA.responses[fieldName + '_years'] = '';
    }
  };
  container.addEventListener('change', sync);
  sync();
}

// ---------- Instructions pages ----------
// Verbatim from the spec doc's "Instructions Shown to All Participants"
// section, split per mentor comments #4/#5 ("Split instructions into
// separate pages where participants have to click next to encourage
// reading. Maybe to one paragraph per page.") into one page object per
// spec-doc "Page N" — see buildInstructionsPages() below, which renders
// each entry as its own page with a normal Continue button.
const INSTRUCTIONS_PAGES_COMMON = [
  { paragraphs: [
    'You will now read two short research studies, presented one at a time.',
    'For each study, the paper will appear on the left side of the page, and the response questions will appear on the right. After reading the study, you will identify its strengths and limitations, suggest improvements or future directions, and rate how convincing you find its conclusions.'
  ] },
  { paragraphs: [
    'The studies in this task were artificially constructed. When reviewing each study, please apply the same analytical and scientific reasoning and judgment that you would use when assessing real research.'
  ] },
  { paragraphs: [
    'Please complete the task without using any outside tools or resources. Your activity will be recorded, and the task will be displayed in full-screen mode to help you stay focused.'
  ] }
];

// Verbatim from the spec doc's "Additional Instructions: AI Condition
// Only" section, split into "Page 4"/"Page 5"/"Page 6". Page 6 also shows
// the AI-condition interface demonstration per "[Show AI-condition
// interface demonstration.]".
const INSTRUCTIONS_PAGES_AI_ONLY = [
  { paragraphs: [
      'You will have access to an AI assistant (ChatGPT) during the paper evaluation task. At the top of the right panel, you will see two tabs:'
    ],
    bullets: [
      'Questions, where you will enter your responses',
      'AI Assistant, where you can interact with the AI assistant who has context of the study you are reviewing (no need to copy and paste the study to the AI)'
    ]
  },
  { paragraphs: [
    'The AI assistant will have access to the paper currently displayed, so you may ask about the paper without pasting the full text.'
  ] },
  { paragraphs: [
      'You may send up to FIVE queries to the AI assistant for each study. The number of messages remaining will be displayed in the AI Assistant tab. You will receive the SAME compensation regardless of how much you use AI.'
    ],
    mockup: 'ai'
  }
];

// Verbatim from the spec doc's "Additional Instructions: No-AI Condition
// Only" section ("Page 4"), which also shows the No-AI-condition interface
// demonstration per "[Show No-AI-condition interface demonstration.]".
const INSTRUCTIONS_PAGES_NOAI_ONLY = [
  { paragraphs: [
      'Please complete the task using only the research papers provided on this page and your own understanding.',
      'Do not use AI assistants, search engines, websites, notes, or other outside tools or materials.'
    ],
    mockup: 'noai'
  }
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

// No-AI-condition interface demonstration: same paper-pane + workspace
// layout as the AI mockups above, but with a single full-width "Questions"
// header and no AI Assistant tab, matching the real no-AI task UI (which
// never renders the ai-only tab button at all).
const INSTRUCTIONS_MOCKUP_SVG_NOAI = `<svg viewBox="0 0 560 280" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="556" height="276" rx="12" fill="#fff" stroke="#d9e2ec" stroke-width="2"/>
  <rect x="20" y="20" width="230" height="240" rx="8" fill="#eef2f6" stroke="#d9e2ec"/>
  <text x="135" y="145" text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#5f6f82">Research paper</text>
  <rect x="270" y="20" width="270" height="34" rx="8" fill="#f3f7fb" stroke="#d7e0ea"/>
  <rect x="278" y="27" width="254" height="20" rx="6" fill="#003262"/>
  <text x="405" y="41" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="#fff">Questions</text>
  <rect x="270" y="64" width="270" height="196" rx="8" fill="#fff" stroke="#d9e2ec"/>
  <text x="280" y="92" font-family="Inter,sans-serif" font-size="11.5" font-weight="600" fill="#172033">1. What was the purpose of this study?</text>
  <rect x="280" y="102" width="252" height="52" rx="6" fill="#f3f5f8" stroke="#d9e2ec"/>
  <text x="280" y="178" font-family="Inter,sans-serif" font-size="11.5" font-weight="600" fill="#172033">2. How was the data collected?</text>
  <rect x="280" y="188" width="252" height="52" rx="6" fill="#f3f5f8" stroke="#d9e2ec"/>
</svg>`;

// Builds one <div class="page"> per instructions-page entry (spec doc
// "Page 1", "Page 2", ... ) into #instructionsPagesContainer, and records
// their ids in INSTRUCTIONS_PAGE_IDS so buildPageOrder() can splice them
// into the normal forward/back page sequence — participants click the
// same Continue button used everywhere else in the survey to move between
// them, one page per click, per mentor comments #4/#5. Mirrors the
// existing buildQuizPages() pattern (dynamic sub-pages inserted into
// pageOrder) used for the comprehension quiz.
function buildInstructionsPages() {
  const container = document.getElementById('instructionsPagesContainer');
  if (!container) return;
  INSTRUCTIONS_PAGE_IDS = [];
  const isAI = DATA.condition === 'AI';
  const pages = INSTRUCTIONS_PAGES_COMMON.concat(isAI ? INSTRUCTIONS_PAGES_AI_ONLY : INSTRUCTIONS_PAGES_NOAI_ONLY);
  let html = '';
  pages.forEach((page, i) => {
    const pageId = 'page-instructions-' + i;
    INSTRUCTIONS_PAGE_IDS.push(pageId);

    // Only the very first instructions page shows the section header (and
    // task title) — later pages are a continuation of the same section, as
    // with the quiz transition/question pages.
    const headerHtml = i === 0
      ? `<div class="section-label"><div class="section-number" id="secnum-task">5</div><div class="section-title">Paper Evaluation Task</div></div>`
      : '';
    const paraHtml = page.paragraphs.map(t => `<p style="margin-bottom:14px;">${escapeHtml(t)}</p>`).join('');
    const bulletsHtml = page.bullets
      ? `<ul class="instructions-bullets">${page.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
      : '';
    let mockupHtml = '';
    if (page.mockup === 'ai') {
      mockupHtml = `<div class="instructions-mockup">
        <div class="mockup-block">${INSTRUCTIONS_MOCKUP_SVG_QUESTIONS}</div>
        <p class="mockup-note">${escapeHtml(INSTRUCTIONS_MOCKUP_NOTE)}</p>
        <div class="mockup-block">${INSTRUCTIONS_MOCKUP_SVG_AI}</div>
      </div>`;
    } else if (page.mockup === 'noai') {
      mockupHtml = `<div class="instructions-mockup">
        <div class="mockup-block">${INSTRUCTIONS_MOCKUP_SVG_NOAI}</div>
      </div>`;
    }

    html += `<div class="page survey-page" id="${pageId}">
      ${headerHtml}
      <div class="q-card">
        ${paraHtml}
        ${bulletsHtml}
        ${mockupHtml}
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

// ---------- Study pages ----------
const STUDY_PDF_QUEUE = {};

function buildStudyPages() {
  DATA.study_order.forEach((paperId, i) => {
    const slotId = 'page-study-' + (i + 1);
    const slotEl = document.getElementById(slotId);
    if (!slotEl) return;
    const paper = PAPERS[paperId];
    const isAI = DATA.condition === 'AI';

    const questionsHtml = STANDARD_Q_DEFS.map(def => {
      const label = def.label;
      const fieldId = paperId + '_' + def.suffix;
      if (def.type === 'scale7') {
        let btns = '';
        for (let v = 1; v <= 7; v++) {
          btns += `<button type="button" class="conf-btn" data-name="${fieldId}" data-val="${v}" onclick="selectConvincing(this)">${v}</button>`;
        }
        return `<div class="q-card">
          <div class="q-label">${escapeHtml(label)}</div>
          <div class="conf-scale" data-name="${fieldId}">${btns}</div>
          <div class="scale-ends">
            <div class="scale-end">Not at all convincing</div>
            <div class="scale-end right">Completely convincing</div>
          </div>
        </div>`;
      }
      return `<div class="q-card">
        <div class="q-label">${escapeHtml(label)}</div>
        <textarea id="${fieldId}" data-logfield="${fieldId}" placeholder="Type your response here..."></textarea>
      </div>`;
    }).join('');

    slotEl.innerHTML = `
      <div class="section-label"><div class="section-title">Study ${i + 1} of 2</div></div>
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

    STUDY_PDF_QUEUE[paperId] = { url: paper.pdfFile, containerId: 'pdfWrap-' + paperId, rendered: false };
    if (isAI) updateAiRemainingUI(paperId);
  });
  attachLoggingListeners();
}

function selectConvincing(btn) {
  const name = btn.getAttribute('data-name');
  document.querySelectorAll(`.conf-btn[data-name="${name}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  DATA.responses[name] = parseInt(btn.getAttribute('data-val'), 10);
}

function renderStudyPdfIfNeeded(paperId) {
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

async function renderPDF(url, containerId, paperId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    container.innerHTML = '';
    const dpr = window.devicePixelRatio || 1;
    const capturedImages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
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

      if (paperId && capturedImages.length < MAX_AI_VISION_PAGES) {
        try {
          capturedImages.push(downscaleCanvasToJpeg(canvas, AI_VISION_MAX_DIMENSION));
        } catch (captureErr) {
          console.error('Could not capture page image for AI vision', paperId, pageNum, captureErr);
        }
      }
    }
    if (paperId) STUDY_PDF_IMAGES[paperId] = capturedImages;
  } catch (err) {
    console.error('PDF render failed for', url, err);
    container.innerHTML = '<p class="pdf-status-msg">Could not load the paper. Please contact the study team.</p>';
  }
}

// Re-draws an already-rendered page canvas at a smaller resolution and
// returns a JPEG data URL. Keeps the on-screen canvas at full
// (device-pixel-ratio-scaled) resolution for readability while sending the
// AI assistant a much lighter copy.
function downscaleCanvasToJpeg(sourceCanvas, maxDimension) {
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

function getStudyPdfImages(paperId) {
  return STUDY_PDF_IMAGES[paperId] || [];
}

// ---------- AI chat panel ----------
function switchWorkspaceTab(paperId, tab) {
  const scope = document.getElementById('paperPane-' + paperId)?.closest('.study-page') || document;
  scope.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
  scope.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.getAttribute('data-tab') === tab));
  if (tab === 'ai') {
    renderAIMessages(paperId);
    document.querySelectorAll('.ai-tab-btn').forEach(b => { b.classList.remove('attention'); b.querySelector('.tab-badge')?.remove(); });
    recordAiTabOpened(paperId);
    updateAiRemainingUI(paperId);
  }
}

const MAX_AI_MESSAGES_PER_PAPER = 5;

function getAiAggregate(paperId) {
  // DATA.ai_paper_aggregates pre-populates each pool paper as an empty {}
  // object (see the DATA literal above), which is truthy — so a plain
  // "if (!DATA.ai_paper_aggregates[paperId])" guard never actually fills in
  // the default fields, leaving successful_messages as undefined. That
  // turned "remaining = MAX - successful_messages" into NaN, which made the
  // UI report the 5-message limit as already reached on first load. Always
  // merge in any missing default fields instead of only checking truthiness.
  const existing = DATA.ai_paper_aggregates[paperId];
  if (!existing || typeof existing.successful_messages !== 'number') {
    DATA.ai_paper_aggregates[paperId] = Object.assign({
      tab_opened: false, first_open_ts: null, time_to_first_open_ms: null,
      time_to_first_message_ms: null, total_messages: 0, successful_messages: 0,
      limit_reached: false
    }, existing || {});
  }
  return DATA.ai_paper_aggregates[paperId];
}

function recordAiTabOpened(paperId) {
  const agg = getAiAggregate(paperId);
  if (agg.tab_opened) return; // only the first open counts
  agg.tab_opened = true;
  agg.first_open_ts = nowTs();
  const startTs = DATA.timing[paperId] && DATA.timing[paperId].study_start_ts;
  if (startTs) agg.time_to_first_open_ms = agg.first_open_ts - startTs;
}

function updateAiRemainingUI(paperId) {
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

function formatAIMessage(content) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return escapeHtml(content).replace(/\n/g, '<br>');
  }

  const rendered = marked.parse(content, {
    breaks: true,
    gfm: true
  });

  return DOMPurify.sanitize(rendered);
}

function renderAIMessages(paperId) {
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
  wrap.innerHTML = DATA.ai_chats[paperId].map((m, messageIndex) => `
  <div
    class="ai-msg ${m.role}"
    data-paper-id="${paperId}"
    data-message-index="${messageIndex}"
    data-message-role="${m.role}"
  >
    <span class="ai-msg-role">${m.role === 'user' ? 'You' : 'AI Assistant'}</span>
    <div class="ai-msg-content">
      ${m.role === 'assistant'
      ? formatAIMessage(m.content)
      : escapeHtml(m.content).replace(/\n/g, '<br>')}
    </div>
  </div>
`).join('');
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

function createThinkingMessage(paperId, messagesContainer) {
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

function removeThinkingMessage(paperId) {
  const el = aiThinkingEls[paperId];
  if (el && el.isConnected) el.remove();
  delete aiThinkingEls[paperId];
}

async function callBackendChat(paperId, userMessage, priorHistory) {
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
      // Must be the history BEFORE this turn, not a live reference to
      // DATA.ai_chats[paperId] — by the time this fetch fires, the caller has
      // already pushed the current message into that array, which would (a)
      // send the current message to the model twice (once here, once via
      // user_message below) and (b) make the server's re-derived per-paper
      // message count include the very message currently being sent, off-by-
      // one-ing the 5-message cap so it always blocks on the 5th message.
      conversation_history: priorHistory
    })
  });
  if (!response.ok) {
    throw new Error('Backend chat request failed with status ' + response.status);
  }
  const data = await response.json();
  return data.reply;
}

let aiSendInFlight = {};

function handleAIInputKeydown(e, paperId) {
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return; // allow newline
  if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
  e.preventDefault(); // stop Enter from inserting a newline when used to send
  sendAIMessage(paperId);
}

async function sendAIMessage(paperId) {
  if (aiSendInFlight[paperId]) return; // prevent duplicate requests (Send click or repeated Enter)
  const agg = getAiAggregate(paperId);
  if (agg.successful_messages >= MAX_AI_MESSAGES_PER_PAPER) return; // 5-message cap reached; input should already be disabled
  const input = document.getElementById('aiInput-' + paperId);
  const sendBtn = document.getElementById('aiSendBtn-' + paperId);
  const messagesContainer = document.getElementById('aiMessages-' + paperId);
  const text = (input.value || '').trim();
  if (!text) return; // ignore empty / whitespace-only submissions

  aiSendInFlight[paperId] = true;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Thinking…'; }
  if (input) input.disabled = true;

  const sendStartTs = nowTs();
  agg.total_messages++;
  // Pushed optimistically so the participant sees their own message right
  // away; kept as a direct object reference (not just an index) so it can be
  // precisely identified and rolled back below if this attempt fails. A
  // failed turn must NEVER remain in DATA.ai_chats: this array is sent back
  // to the server as conversation_history on the next request, and the
  // server independently re-derives the 5-message-per-paper cap by counting
  // 'user' turns in that history. If a failed attempt were left in here, it
  // would permanently inflate the server's count without ever consuming a
  // slot the client's own successful_messages-based "remaining" UI shows —
  // eventually blocking every future attempt for that paper with a 429 the
  // participant has no way to recover from.
  // Snapshot of the history as it stood BEFORE this turn — this, not a live
  // reference, is what gets sent to the backend as conversation_history (see
  // callBackendChat). Must be captured before pushing userTurn below.
  const priorHistory = DATA.ai_chats[paperId].slice();
  const userTurn = { role: 'user', content: text, ts: nowIso() };
  DATA.ai_chats[paperId].push(userTurn);
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  if (!DATA.timing[paperId].first_ai_message_ts) {
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
    reply = await callBackendChat(paperId, text, priorHistory);
    // Remove the temporary indicator BEFORE the real reply is stored/rendered.
    removeThinkingMessage(paperId);
    DATA.ai_chats[paperId].push({ role: 'assistant', content: reply, ts: nowIso() });
    success = true;
  } catch (err) {
    console.error('AI chat error for', paperId, err); // detailed error stays in the console only
    errorType = (err && err.message) || 'unknown_error';
    removeThinkingMessage(paperId);
    reply = 'The assistant could not respond right now. Please try again.';
    // Roll back the optimistic user turn pushed above — a failed exchange
    // must not remain in DATA.ai_chats (see comment at the push site), so it
    // is never resent as conversation_history and never counted by either
    // the client or server message cap. The participant still sees their
    // message and this error via the transient (non-persisted) render below.
    const idx = DATA.ai_chats[paperId].indexOf(userTurn);
    if (idx !== -1) DATA.ai_chats[paperId].splice(idx, 1);
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
    // The failed turn was deliberately rolled back out of DATA.ai_chats above
    // (so it's never resent as context or counted against the cap), so
    // renderAIMessages alone would now make the participant's own message
    // and the error notice both vanish. Append them as DOM-only nodes —
    // never written back into DATA.ai_chats — purely so the participant can
    // still see what happened.
    if (!success) appendTransientFailedTurn(paperId, text, reply);
    aiSendInFlight[paperId] = false;
    if (sendBtn) sendBtn.textContent = 'Send';
    updateAiRemainingUI(paperId); // re-enables (or permanently disables at the cap) input/button
    input && !input.disabled && input.focus();
  }
}

function appendTransientFailedTurn(paperId, userText, errorText) {
  const wrap = document.getElementById('aiMessages-' + paperId);
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', `
  <div class="ai-msg user">
    <span class="ai-msg-role">You</span>
    <div class="ai-msg-content">${escapeHtml(userText).replace(/\n/g, '<br>')}</div>
  </div>
  <div class="ai-msg assistant">
    <span class="ai-msg-role">AI Assistant</span>
    <div class="ai-msg-content">${escapeHtml(errorText)}</div>
  </div>
`);
  wrap.scrollTop = wrap.scrollHeight;
}

// ---------- Anti-cheat / fullscreen monitoring ----------
let inTaskPhase = false;

function showWarnBanner(msg) {
  const banner = document.getElementById('warnBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.style.display = 'block';
  clearTimeout(showWarnBanner._t);
  showWarnBanner._t = setTimeout(() => { banner.style.display = 'none'; }, 4000);
}

function violationMessage(type) {
  const map = {
    visibility: 'Please stay on this tab while completing the task.',
    blur: 'Please keep this window focused while completing the task.',
    fullscreen_exit: 'Please remain in fullscreen mode while completing the task.',
    contextmenu: 'Right-click is disabled during the task.',
    devtools_shortcut: 'Developer tools are disabled during the task.'
  };
  return map[type] || 'Please follow the task instructions.';
}

function logViolation(type) {
  DATA.violations.push({ type, ts: nowIso(), paper_id: currentStudyPaperId });
  logBehavioralEvent(type);
  showWarnBanner(violationMessage(type));
}

// General-purpose behavioral event log (fullscreen enter/exit/re-entry,
// visibility change, window blur/focus). Kept separate from DATA.violations
// (which only records the negative/warning-worthy events) so both the
// existing violations-based logic and the new spec's broader behavioral
// event log have what they each expect.
function logBehavioralEvent(type) {
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
  if (inTaskPhase) {
    if (!document.fullscreenElement) {
      logViolation('fullscreen_exit');
      showFullscreenRequiredOverlay();
    } else {
      logBehavioralEvent('fullscreen_enter');
      hideFullscreenRequiredOverlay();
    }
  }
});
document.addEventListener('contextmenu', (e) => {
  if (inTaskPhase) { e.preventDefault(); logViolation('contextmenu'); }
});
document.addEventListener('keydown', (e) => {
  if (!inTaskPhase) return;
  const isDevtools = e.key === 'F12' ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
    ((e.metaKey) && e.altKey && e.key === 'I');
  if (isDevtools) { e.preventDefault(); logViolation('devtools_shortcut'); }
});

function showFullscreenRequiredOverlay() {
  document.getElementById('fsRequiredOverlay')?.classList.add('open');
}
function hideFullscreenRequiredOverlay() {
  document.getElementById('fsRequiredOverlay')?.classList.remove('open');
}

function enterFullscreenAndStart() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (req) {
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

function diffCounts(oldVal, newVal) {
  let prefix = 0;
  const maxPrefix = Math.min(oldVal.length, newVal.length);
  while (prefix < maxPrefix && oldVal[prefix] === newVal[prefix]) prefix++;
  let oldEnd = oldVal.length, newEnd = newVal.length;
  while (oldEnd > prefix && newEnd > prefix && oldVal[oldEnd - 1] === newVal[newEnd - 1]) { oldEnd--; newEnd--; }
  const charsDeleted = Math.max(0, oldEnd - prefix);
  const charsInserted = Math.max(0, newEnd - prefix);
  return { charsDeleted, charsInserted };
}

function fieldIdToPaperId(fieldId) {
  const match = PAPER_IDS.find(pid => fieldId === pid || fieldId.startsWith(pid + '_'));
  return match || null;
}

function attachLoggingListeners() {
  document.querySelectorAll('textarea[data-logfield]').forEach(ta => {
    const id = ta.getAttribute('data-logfield');
    if (ta._loggingAttached) return;
    ta._loggingAttached = true;
    if (!DATA.logs[id]) DATA.logs[id] = { keystrokes: 0, pastes: 0, drafts: [] };
    ta._revisionSnapshot = ta.value || '';
    ta.addEventListener('keydown', () => { DATA.logs[id].keystrokes++; });
    ta.addEventListener('paste', () => {
      DATA.logs[id].pastes++;
    });
    ta.addEventListener('input', () => {
      clearTimeout(ta._revisionTimer);
      ta._revisionTimer = setTimeout(() => {
        const before = ta._revisionSnapshot;
        const after = ta.value || '';
        const { charsDeleted, charsInserted } = diffCounts(before, after);
        if (charsDeleted >= SUBSTANTIAL_REVISION_MIN_CHARS) {
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

// ---------- Clipboard-transfer logging ----------
// Tracks meaningful transfers among task questions, participant answers,
// AI prompts, and AI responses. Clipboard text is retained only temporarily
// in memory so a later paste can be classified. The actual copied/pasted
// text is never stored in DATA.

const INTERNAL_COPY_MATCH_WINDOW_MS = 2 * 60 * 1000;

let lastInternalCopy = null;

function normalizeClipboardText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getElementFromCopyEvent(event) {
  const target = event.target;

  // Text selected inside a textarea/input does not appear in
  // window.getSelection(), so use the event target directly.
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  ) {
    return target;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode) {
    return target instanceof Element ? target : null;
  }

  return selection.anchorNode.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection.anchorNode.parentElement;
}

function getSelectedTextForCopy(event) {
  const target = event.target;

  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  ) {
    const start = target.selectionStart;
    const end = target.selectionEnd;

    if (
      typeof start === 'number' &&
      typeof end === 'number' &&
      end > start
    ) {
      return target.value.slice(start, end);
    }

    return '';
  }

  const selection = window.getSelection();
  return selection ? selection.toString() : '';
}

function getPaperIdFromElement(element) {
  if (!element) return currentStudyPaperId || null;

  const explicitPaperElement = element.closest('[data-paper-id]');
  if (explicitPaperElement) {
    return explicitPaperElement.getAttribute('data-paper-id');
  }

  const answerField = element.closest('textarea[data-logfield]');
  if (answerField) {
    return fieldIdToPaperId(answerField.getAttribute('data-logfield'));
  }

  const aiInput = element.closest('textarea[id^="aiInput-"]');
  if (aiInput) {
    return aiInput.id.replace('aiInput-', '');
  }

  return currentStudyPaperId || null;
}

function inferQuestionId(questionElement) {
  if (!questionElement) return null;

  const card = questionElement.closest('.q-card');
  if (!card) return null;

  const textarea = card.querySelector('textarea[data-logfield]');
  if (textarea) return textarea.getAttribute('data-logfield');

  const scale = card.querySelector('[data-name]');
  if (scale) return scale.getAttribute('data-name');

  return null;
}

function classifyCopySource(element) {
  if (!element) {
    return {
      source_type: 'external_or_unknown',
      source_id: null,
      paper_id: currentStudyPaperId || null
    };
  }

  const assistantMessage = element.closest('.ai-msg.assistant');
  if (assistantMessage) {
    return {
      source_type: 'ai_response',
      source_id:
        'ai_message_' +
        assistantMessage.getAttribute('data-message-index'),
      paper_id:
        assistantMessage.getAttribute('data-paper-id') ||
        currentStudyPaperId ||
        null
    };
  }

  const userAiMessage = element.closest('.ai-msg.user');
  if (userAiMessage) {
    return {
      source_type: 'participant_ai_prompt',
      source_id:
        'ai_message_' +
        userAiMessage.getAttribute('data-message-index'),
      paper_id:
        userAiMessage.getAttribute('data-paper-id') ||
        currentStudyPaperId ||
        null
    };
  }

  const answerField = element.closest('textarea[data-logfield]');
  if (answerField) {
    const fieldId = answerField.getAttribute('data-logfield');

    return {
      source_type: 'participant_answer',
      source_id: fieldId,
      paper_id: fieldIdToPaperId(fieldId)
    };
  }

  const aiInput = element.closest('textarea[id^="aiInput-"]');
  if (aiInput) {
    return {
      source_type: 'ai_input_draft',
      source_id: aiInput.id,
      paper_id: aiInput.id.replace('aiInput-', '')
    };
  }

  const question = element.closest('.q-label');
  if (question) {
    return {
      source_type: 'question',
      source_id: inferQuestionId(question),
      paper_id: getPaperIdFromElement(question)
    };
  }

  return {
    source_type: 'other_internal',
    source_id: element.id || null,
    paper_id: getPaperIdFromElement(element)
  };
}

function classifyPasteTarget(element) {
  if (!element) return null;

  const answerField = element.closest('textarea[data-logfield]');
  if (answerField) {
    const fieldId = answerField.getAttribute('data-logfield');

    return {
      target_type: 'participant_answer',
      target_id: fieldId,
      paper_id: fieldIdToPaperId(fieldId)
    };
  }

  const aiInput = element.closest('textarea[id^="aiInput-"]');
  if (aiInput) {
    return {
      target_type: 'ai_input',
      target_id: aiInput.id,
      paper_id: aiInput.id.replace('aiInput-', '')
    };
  }

  return null;
}

function inferTransferPathway(sourceType, targetType) {
  const sourceLabels = {
    question: 'question',
    participant_answer: 'answer',
    ai_response: 'ai_response',
    participant_ai_prompt: 'ai_prompt',
    ai_input_draft: 'ai_input_draft',
    other_internal: 'other_internal',
    external_or_unknown: 'external_or_unknown'
  };

  const targetLabels = {
    participant_answer: 'answer',
    ai_input: 'ai'
  };

  const source = sourceLabels[sourceType] || 'external_or_unknown';
  const target = targetLabels[targetType] || 'unknown';

  return source + '_to_' + target;
}

document.addEventListener('copy', event => {
  if (!inTaskPhase) return;

  const copiedText = getSelectedTextForCopy(event);
  const normalizedText = normalizeClipboardText(copiedText);

  if (!normalizedText) return;

  const element = getElementFromCopyEvent(event);
  const source = classifyCopySource(element);
  const timestamp = nowIso();

  // Temporarily retain text only for matching a subsequent paste.
  // It is not written into DATA or submitted to the server.
  lastInternalCopy = {
    normalized_text: normalizedText,
    source_type: source.source_type,
    source_id: source.source_id,
    paper_id: source.paper_id,
    copied_at_ms: nowTs()
  };

  DATA.copy_events.push({
    participant_id: DATA.participant_id,
    paper_id: source.paper_id,
    event_type: 'copy',
    source_type: source.source_type,
    source_id: source.source_id,
    character_count: copiedText.length,
    ts: timestamp
  });
});

document.addEventListener('paste', event => {
  if (!inTaskPhase) return;

  const target = classifyPasteTarget(event.target);

  // Ignore pastes outside the participant-answer and AI-input fields.
  if (!target) return;

  const pastedText = (
    event.clipboardData ||
    window.clipboardData
  )?.getData('text') || '';

  const normalizedPastedText = normalizeClipboardText(pastedText);
  if (!normalizedPastedText) return;

  let sourceType = 'external_or_unknown';
  let sourceId = null;
  let sourcePaperId = null;
  let matchedInternalCopy = false;
  let millisecondsSinceCopy = null;

  if (lastInternalCopy) {
    millisecondsSinceCopy =
      nowTs() - lastInternalCopy.copied_at_ms;

    const withinTimeWindow =
      millisecondsSinceCopy >= 0 &&
      millisecondsSinceCopy <= INTERNAL_COPY_MATCH_WINDOW_MS;

    const exactMatch =
      normalizedPastedText === lastInternalCopy.normalized_text;

    if (withinTimeWindow && exactMatch) {
      sourceType = lastInternalCopy.source_type;
      sourceId = lastInternalCopy.source_id;
      sourcePaperId = lastInternalCopy.paper_id;
      matchedInternalCopy = true;
    }
  }

  DATA.paste_events.push({
    participant_id: DATA.participant_id,
    paper_id: target.paper_id,
    event_type: 'paste',
    source_type: sourceType,
    source_id: sourceId,
    source_paper_id: sourcePaperId,
    target_type: target.target_type,
    target_id: target.target_id,
    character_count: pastedText.length,
    matched_internal_copy: matchedInternalCopy,
    milliseconds_since_copy: matchedInternalCopy
      ? millisecondsSinceCopy
      : null,
    inferred_pathway: inferTransferPathway(
      sourceType,
      target.target_type
    ),
    ts: nowIso()
  });
});

// ---------- Reflections page ----------
function buildPaperScaleRows(containerId, fieldPrefix) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let leftLabel = '';
  let rightLabel = '';

  if (fieldPrefix === 'confidence') {
    leftLabel = 'Not at all confident';
    rightLabel = 'Completely confident';
  } else if (fieldPrefix === 'understood') {
    leftLabel = 'Not at all well';
    rightLabel = 'Very well';
  }

  container.innerHTML = DATA.study_order.map((paperId, i) => {
    const name = fieldPrefix + '_' + paperId;
    let btns = '';
    for (let v = 1; v <= 7; v++) {
      btns += `<button type="button" class="conf-btn" data-name="${name}" data-val="${v}" onclick="selectConvincing(this)">${v}</button>`;
    }
    return `<div class="conf-row" style="display:block;">
      <div class="conf-label" style="margin-bottom:8px;">Paper ${i + 1}: ${escapeHtml(PAPERS[paperId].title)}</div>
      <div class="conf-scale" data-name="${name}">${btns}</div>
      <div class="scale-ends">
        <div class="scale-end">${escapeHtml(leftLabel)}</div>
        <div class="scale-end right">${escapeHtml(rightLabel)}</div>
      </div>
    </div>`;
  }).join('');
}

function prepareReflectionsPage() {
  inTaskPhase = false;
  buildPaperScaleRows('confWrap', 'confidence');
  buildPaperScaleRows('understandWrap', 'understood');
  if (DATA.condition === 'AI') {
    buildPerPaperAiReflections();
  }
}

// Shared ownership (1-7 scale) question, asked once across both papers —
// per the spec's "Overall, whose thinking..." wording (verbatim, not
// per-paper). Field name is fixed ('whose_thinking') and picked up by
// collectFieldsNow()'s generic name-based collection.
function buildPerPaperAiReflections() {
  const wrap = document.getElementById('perPaperAiReflectionsWrap');
  if (!wrap) return;

  const wtName = 'whose_thinking';

  wrap.innerHTML = `
    <div class="q-card">
      <div class="q-label">
        Overall, whose thinking is reflected in your responses?
      </div>

      <div class="conf-scale" data-name="${wtName}">
        ${(function () {
      let btns = '';

      for (let v = 1; v <= 7; v++) {
        btns += `
              <button
                type="button"
                class="conf-btn"
                data-name="${wtName}"
                data-val="${v}"
                onclick="selectConvincing(this)"
              >
                ${v}
              </button>
            `;
      }

      return btns;
    })()}
      </div>

      <div class="scale-ends">
        <div class="scale-end">Mostly the AI assistant's thinking</div>
        <div class="scale-end right">Mostly my own thinking</div>
      </div>
    </div>
  `;
}

// Selected-state styling for radio/checkbox option cards.
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('.option-item input[type="radio"], .option-item input[type="checkbox"]')) {
    const item = t.closest('.option-item');
    if (t.type === 'radio') {
      document.querySelectorAll(`input[name="${t.name}"]`).forEach(inp => inp.closest('.option-item')?.classList.remove('selected'));
      item.classList.add('selected');
    } else {
      item.classList.toggle('selected', t.checked);
    }
  }
});

// ---------- Quiz ----------
// Renders one page per comprehension-quiz question, plus a short transition
// page before each paper's block of questions ("You will first/Next answer
// four questions about: <title>") so participants can tell which paper a
// question belongs to and when the quiz moves to the second paper. The
// transition page auto-advances after 5s (see showPage()/quizTransitionTimer)
// rather than using the Continue button. DATA.study_order holds the two
// assigned paper ids in the same order the participant evaluated them (the
// unassigned third pool paper is never in this array, so its quiz/transition
// is never built/shown here) — iterating it in order naturally satisfies
// "same order participant evaluated papers" + "no unassigned paper" without
// any extra bookkeeping. PAPERS[paperId].title is read fresh for both the
// transition page and every question (not just the first per paper) so the
// title always reflects the paper the current page belongs to.
// Fisher-Yates shuffle. Returns a NEW array — never mutates the input —
// since PAPERS[paperId].quiz and its per-question `options` arrays are
// shared, reused data (e.g. across a retried submission) and must stay in
// their original, canonical order.
function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Per spec section 9 ("make sure we randomize the question and answer
// option orders"): for each paper, both the order the four quiz questions
// are shown in, and the order each question's four answer options are
// shown in, are randomized once per participant. Quiz pages are only ever
// built once per session (guarded by QUIZ_PAGE_IDS.length === 0 at the
// call site), so this randomization is stable for the rest of the survey.
// Built here, read by finishQuiz() below: maps each quiz field name to the
// option letter that is CORRECT in that participant's shuffled rendering
// (which will generally differ from qObj.correct, the canonical/original
// letter, once options have been reshuffled).
const QUIZ_RUNTIME_CORRECT = {};

function buildQuizPages() {
  const container = document.getElementById('quizPagesContainer');
  if (!container) return;
  QUIZ_PAGE_IDS = [];
  let html = '';
  DATA.study_order.forEach((paperId, paperIdx) => {
    const paperTitle = PAPERS[paperId].title;
    const transitionId = 'page-quiz-transition-' + paperId;
    QUIZ_PAGE_IDS.push(transitionId);
    const transitionLead = paperIdx === 0
      ? 'You will first answer four questions about:'
      : 'Next, you will answer four questions about:';
    html += `<div class="page quiz-transition-page" id="${transitionId}">
      <div class="quiz-transition-inner">
        <p class="quiz-transition-lead">${escapeHtml(transitionLead)}</p>
        <p class="quiz-transition-title">${escapeHtml(paperTitle)}</p>
      </div>
    </div>`;
    const questionOrder = shuffleArray(PAPERS[paperId].quiz.map((_, i) => i));
    questionOrder.forEach(qi => {
      const qObj = PAPERS[paperId].quiz[qi];
      const pageId = 'page-quiz-' + paperId + '-' + qi;
      QUIZ_PAGE_IDS.push(pageId);
      const name = 'quiz_' + paperId + '_' + qi;

      // Strip each option's original "X. " letter prefix, shuffle the
      // remaining option texts, then relabel A/B/C/D in the new order —
      // this is what makes the rendered letters independent of which
      // letter was originally correct.
      const letters = ['A', 'B', 'C', 'D'];
      const plainOptions = qObj.options.map(opt => opt.replace(/^[A-D]\.\s*/, ''));
      const shuffledIdx = shuffleArray(plainOptions.map((_, i) => i));
      QUIZ_RUNTIME_CORRECT[name] = letters[shuffledIdx.indexOf(qObj.correct.charCodeAt(0) - 'A'.charCodeAt(0))];

      const optsHtml = shuffledIdx.map((origIdx, newPos) => {
        const newLetter = letters[newPos];
        const text = `${newLetter}. ${plainOptions[origIdx]}`;
        return `<label class="option-item" data-group="${name}">
          <input type="radio" name="${name}" value="${newLetter}">
          <div class="option-dot"></div>
          <div class="option-text">${escapeHtml(text)}</div>
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

function finishQuiz() {
  let score = 0, total = 0;
  DATA.study_order.forEach(paperId => {
    PAPERS[paperId].quiz.forEach((qObj, qi) => {
      total++;
      const name = 'quiz_' + paperId + '_' + qi;
      const chosen = document.querySelector(`input[name="${name}"]:checked`);
      const val = chosen ? chosen.value : null;
      DATA.responses[name] = val;
      const correctLetter = QUIZ_RUNTIME_CORRECT[name] || qObj.correct;
      if (val === correctLetter) score++;
    });
  });
  DATA.quiz_score = score;
  DATA.quiz_total = total;
}

// ---------- Field collection ----------
function collectFieldsNow() {
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
function flattenForExport() {
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
    research_role: DATA.research_role,
    research_role_years: DATA.research_role_years,
    assignment_cell: DATA.assignment_cell,
    assignment_assigned_at: DATA.assignment_assigned_at,
    assignment_source: DATA.assignment_source,
    assignment_version: DATA.assignment_version,
    stable_assignment_id_hash: DATA.stable_assignment_id_hash,
    assignment_id_source: DATA.assignment_id_source,
    role_locked_to_original: DATA.role_locked_to_original,
    paper_order_version: DATA.paper_order_version,
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
    flat['study_' + (i + 1) + '_id'] = paperId;
    flat['study_' + (i + 1) + '_title'] = PAPERS[paperId].title;
    flat['study_' + (i + 1) + '_duration_ms'] = t.duration_ms || '';
    flat['study_' + (i + 1) + '_ai_turns'] = DATA.ai_chats[paperId].filter(m => m.role === 'user').length;
    flat['study_' + (i + 1) + '_ai_transcript'] = JSON.stringify(DATA.ai_chats[paperId]);
    flat['study_' + (i + 1) + '_ai_tab_opened'] = agg.tab_opened || false;
    flat['study_' + (i + 1) + '_ai_time_to_first_open_ms'] = agg.time_to_first_open_ms || '';
    flat['study_' + (i + 1) + '_ai_time_to_first_message_ms'] = agg.time_to_first_message_ms || '';
    flat['study_' + (i + 1) + '_ai_limit_reached'] = agg.limit_reached || false;
  });
  Object.assign(flat, DATA.responses);
  return flat;
}

// ===================== TEST MODE (DEV/QA ONLY) — Data Audit Summary =====================
// Computed entirely by reading the existing DATA object and existing logs
// already populated elsewhere in this file (ai_message_log, ai_paper_aggregates,
// behavioral_events, revision_log, copy_events, paste_events, responses, etc.)
// — deliberately NOT a second/independent data model, per spec section 4.
function computeAuditSummary() {
  collectFieldsNow(); // make sure DATA.responses reflects whatever is on screen right now

  const answeredFields = Object.entries(DATA.responses)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0));
  const requiredEls = Array.from(document.querySelectorAll('[required]'));
  const unansweredRequired = requiredEls.filter(el => {
    if (el.type === 'checkbox' || el.type === 'radio') {
      return !document.querySelector(`[name="${el.name}"]:checked`);
    }
    return !el.value;
  });

  const aiMessagesPerPaper = {};
  const timeToFirstAiUsePerPaper = {};
  PAPER_IDS.forEach(pid => {
    const agg = (DATA.ai_paper_aggregates && DATA.ai_paper_aggregates[pid]) || {};
    aiMessagesPerPaper[pid] = agg.total_messages || 0;
    timeToFirstAiUsePerPaper[pid] = (agg.time_to_first_message_ms != null) ? agg.time_to_first_message_ms : null;
  });

  const totalPrompts = (DATA.ai_message_log || []).length;
  const totalResponses = (DATA.ai_message_log || []).filter(m => m.success === true).length;

  const tabSwitchEvents = (DATA.behavioral_events || []).filter(e => e.type === 'visibility' || e.type === 'blur').length;
  const fullscreenExitEvents = (DATA.behavioral_events || []).filter(e => e.type === 'fullscreen_exit').length;

  const quizAnswers = {};
  Object.keys(DATA.responses).forEach(k => { if (k.indexOf('quiz_') === 0) quizAnswers[k] = DATA.responses[k]; });

  const importantFields = [
    'participant_id', 'prolific_id', 'research_role', 'research_expertise_stratum',
    'assignment_cell', 'ai_condition', 'critical_thinking_placement',
    'assigned_paper_1_id', 'assigned_paper_2_id', 'paper_order',
    'consent_status', 'quiz_score', 'final_submission_timestamp', 'submission_status'
  ];
  const missingFields = importantFields.filter(f => {
    const v = DATA[f];
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  });

  return {
    test_mode: DATA.test_mode,
    test_condition_override: DATA.test_condition_override,
    test_paper_override: DATA.test_paper_override,
    participant_or_test_id: DATA.participant_id,
    research_expertise_stratum: DATA.research_expertise_stratum,
    assignment_cell: DATA.assignment_cell,
    ai_condition: DATA.ai_condition,
    critical_thinking_placement: DATA.critical_thinking_placement,
    assigned_paper_ids_and_order: DATA.paper_order,
    current_page: (typeof pageOrder !== 'undefined' && typeof currentIdx !== 'undefined') ? pageOrder[currentIdx] : null,
    answered_field_count: answeredFields.length,
    unanswered_required_field_count: unansweredRequired.length,
    ai_message_count_per_paper: aiMessagesPerPaper,
    total_participant_prompts: totalPrompts,
    total_assistant_responses: totalResponses,
    time_to_first_ai_use_ms_per_paper: timeToFirstAiUsePerPaper,
    answer_revision_count: (DATA.revision_log || []).length,
    copy_event_count: (DATA.copy_events || []).length,
    paste_event_count: (DATA.paste_events || []).length,
    tab_switch_or_visibility_event_count: tabSwitchEvents,
    fullscreen_exit_count: fullscreenExitEvents,
    quiz_answers: quizAnswers,
    quiz_score: DATA.quiz_score,
    quiz_total: DATA.quiz_total,
    final_submission_attempted: DATA.submission_status !== 'not_attempted',
    final_submission_confirmed_by_server: DATA.submission_status === 'confirmed',
    submission_status: DATA.submission_status,
    submission_attempted_at: DATA.submission_attempted_at,
    submission_confirmed_at: DATA.submission_confirmed_at,
    submission_error: DATA.submission_error,
    missing_or_empty_important_fields: missingFields
  };
}

// Strips anything that isn't alphanumeric/dash/underscore so user-influenced
// values (assignment cell, paper ids) can never inject path separators or
// other special characters into a downloaded filename.
function sanitizeFilenameComponent(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function testExportFilenameBase() {
  const cell = sanitizeFilenameComponent(DATA.test_condition_override || DATA.assignment_cell || 'na');
  const papers = (DATA.paper_order || []).map(sanitizeFilenameComponent).join('-') || 'na';
  const date = sanitizeFilenameComponent(new Date().toISOString().slice(0, 10));
  return `${cell}-${papers}-${date}`;
}

function exportRawDataJson() {
  const base = testExportFilenameBase();
  downloadBlob(JSON.stringify(DATA, null, 2), `survey-test-${base}.json`, 'application/json');
}

function exportAuditSummaryJson() {
  const base = testExportFilenameBase();
  downloadBlob(JSON.stringify(computeAuditSummary(), null, 2), `survey-audit-${base}.json`, 'application/json');
}

function exportComparisonCsv() {
  const base = testExportFilenameBase();
  const summary = computeAuditSummary();
  const flat = {};
  Object.entries(summary).forEach(([k, v]) => {
    flat[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  const keys = Object.keys(flat);
  const escapeCsv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = keys.join(',') + '\n' + keys.map(k => escapeCsv(flat[k])).join(',');
  downloadBlob(csv, `survey-audit-comparison-${base}.csv`, 'text/csv');
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadJSON() {
  downloadBlob(JSON.stringify(DATA, null, 2), DATA.participant_id + '.json', 'application/json');
}

function downloadCSV() {
  const flat = flattenForExport();
  const keys = Object.keys(flat);
  const escapeCsv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = keys.join(',') + '\n' + keys.map(k => escapeCsv(flat[k])).join(',');
  downloadBlob(csv, DATA.participant_id + '.csv', 'text/csv');
}

function openAdminOverlay() {
  const overlay = document.getElementById('adminOverlay');
  const pre = document.getElementById('adminPreview');
  if (pre) pre.textContent = JSON.stringify(DATA, null, 2);
  const auditPre = document.getElementById('adminAuditSummary');
  if (auditPre) auditPre.textContent = JSON.stringify(computeAuditSummary(), null, 2);
  if (overlay) overlay.classList.add('open');
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
    openAdminOverlay();
  }
});

// ---------- Submission ----------
// Mirrors setAssignmentStatus() above, targeting the separate
// #submissionStatus block (same reused CSS classes, different element ids)
// so the assignment-loading UI on page-about-you and the submission-loading
// UI on page-debrief never fight over the same DOM nodes.
function setSubmissionStatus(mode, message) {
  const wrap = document.getElementById('submissionStatus');
  const spinner = document.getElementById('submissionSpinner');
  const text = document.getElementById('submissionStatusText');
  const retryBtn = document.getElementById('submissionRetryBtn');
  if (!wrap) return;
  if (mode === 'hidden') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  wrap.classList.remove('loading', 'error');
  wrap.classList.add(mode);
  if (spinner) spinner.style.display = (mode === 'loading') ? 'inline-block' : 'none';
  if (text) text.textContent = message || '';
  if (retryBtn) retryBtn.style.display = (mode === 'error') ? 'inline-block' : 'none';
}

// Throws on any non-success response or network failure, rather than
// swallowing the error — the caller (finalizeSubmission) is responsible for
// deciding what the participant sees, including whether to retry.
async function submitToServer() {
  const response = await fetch('/api/submit-survey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DATA)
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error || ''; } catch (e) { /* ignore */ }
    throw new Error('submit-survey failed with status ' + response.status + (detail ? (': ' + detail) : ''));
  }
}

// Guards against duplicate concurrent submit requests (double-click on
// "Finish", or a click on Retry while the original request is still in
// flight) — mirrors the existing navigateInFlight pattern used for
// assignment requests.
let submitInFlight = false;

function finalizeSubmission() {
  if (submitInFlight) return;
  if (document.fullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen)?.call(document);
  }
  collectFieldsNow();
  finishQuiz();
  // All survey data stays in DATA (in browser memory) regardless of what
  // happens next — nothing here clears or rewrites it before a confirmed
  // success, so a failed attempt can be retried with the exact same payload.
  DATA.session_end_iso = nowIso();
  DATA.completion_status = 'completed';
  DATA.final_submission_timestamp = nowIso();
  attemptSubmission();
}

async function attemptSubmission() {
  submitInFlight = true;
  const btnNext = document.getElementById('btnNext');
  setSubmissionStatus('loading', 'Submitting your responses…');
  if (btnNext) btnNext.disabled = true;
  // Submission-status fields (spec section 7) — derived straight from this
  // existing flow, not a separate tracker: 'not_attempted' is the DATA
  // default, this call moves it to 'submitting', and the try/catch below
  // resolves it to 'confirmed' or 'failed'.
  DATA.submission_status = 'submitting';
  DATA.submission_attempted_at = nowIso();
  try {
    await submitToServer();
    DATA.submission_status = 'confirmed';
    DATA.submission_confirmed_at = nowIso();
    DATA.submission_error = null;
    setSubmissionStatus('hidden');
    // Only now — after a confirmed server success — does the participant
    // see the submitted screen. On any failure (network error or non-2xx
    // response) we never reach this line, so the participant stays on the
    // current page with their data intact and an inline retry affordance.
    currentIdx = pageOrder.indexOf('page-submitted');
    showPage('page-submitted');
  } catch (err) {
    console.error('[attemptSubmission] /api/submit-survey failed:', err);
    DATA.submission_status = 'failed';
    DATA.submission_error = (err && err.message) || 'unknown_error';
    setSubmissionStatus('error', 'Could not submit your responses. Please check your connection and retry.');
    if (btnNext) btnNext.disabled = false;
  } finally {
    submitInFlight = false;
  }
}

function retrySubmission() {
  if (submitInFlight) return;
  attemptSubmission();
}

// ---------- Autosave ----------
function autosave() {
  collectFieldsNow();
  try { localStorage.setItem('research_survey_autosave', JSON.stringify(DATA)); } catch (e) { }
}
setInterval(autosave, 10000);

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  // ===================== TEST MODE (DEV/QA ONLY) =====================
  // Must resolve before anything else touches the page: on invalid test
  // params this replaces the entire page with a developer-facing error and
  // throws, which the catch below uses to skip the rest of normal init.
  try {
    await activateTestModeIfValid();
  } catch (e) {
    if (e && e.message === 'test_mode_invalid_params') return;
    throw e;
  }

  initConsentPage();
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

  document.querySelectorAll('#page-reflections').forEach(() => { });
  const origNavigate = navigate;
  // Hook to build reflections content right when that page is about to show.
  const observer = new MutationObserver(() => {
    const reflPage = document.getElementById('page-reflections');
    if (reflPage && reflPage.classList.contains('active') && !reflPage._prepared) {
      reflPage._prepared = true;
      prepareReflectionsPage();
    }
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  const params = new URLSearchParams(window.location.search);
  if (params.get('admin') === '1') openAdminOverlay();
});
