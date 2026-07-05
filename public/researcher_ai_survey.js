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

// Single source of truth for the participant-facing estimated-duration text,
// shown in both the intro card and the consent-form procedures paragraph.
// Kept as a configurable value (not yet finalized): this estimate reflects
// the current one-paper task. It MUST be reviewed and updated once the
// one-paper version (see PAPER_COMBOS / B1) has actually been timed.
const OFFICIAL_ESTIMATED_DURATION = '30–45 minutes';

// Exact wording requested for the alertness/focus note shown alongside the
// estimated duration on the first participant-facing page, before consent.
const ALERTNESS_FOCUS_NOTE =
  'This study involves sustained reading and evaluation of research materials. ' +
  'Please begin only when you have enough uninterrupted time and feel alert and able to concentrate.';

function renderEstimatedDurationAndAlertnessNote() {
  ['officialEstimatedDurationIntro', 'officialEstimatedDurationProcedures'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = OFFICIAL_ESTIMATED_DURATION;
  });

  const noteEl = document.getElementById('officialAlertnessNote');
  if (noteEl) {
    noteEl.textContent = ALERTNESS_FOCUS_NOTE;
    noteEl.style.fontWeight = '700';
  }
}

const DATA = {
  participant_id: genId(),
  session_start_iso: nowIso(),
  session_end_iso: null,
  prolific_id: '',
  consent: false,
  consent_status: null,        // 'granted' | 'declined'
  media_release_status: null,  // 'granted' | 'declined'
  screening_exit_reason: null, // 'declined_consent' | null
  completion_status: 'in_progress', // 'in_progress' | 'completed' | 'exited_early'
  final_submission_timestamp: null,

  // Legacy fields, kept for backward compatibility with existing export logic.
  expertise_tier: null,
  condition: null,
  ct_scale_placement: null,
  study_order: [],
  study_1_id: null,
  study_1_title: null,

  // New backend randomization variables (spec-required names). Mirror the
  // legacy fields above so neither the existing export pipeline nor the new
  // spec's required variable names need to be removed.
  research_expertise_stratum: null, // mirrors expertise_tier
  ai_condition: null,               // mirrors condition
  critical_thinking_placement: null,// mirrors ct_scale_placement
  research_role: null,              // exact selected role string, as returned by the server
  research_role_years: null,        // years in program/position when applicable, as returned by the server
  assignment_cell: null,            // combined cell label, e.g. "AI_pre" — authoritative, server-generated
  assignment_assigned_at: null,     // server timestamp the assignment was made
  assignment_source: null,          // assignment method, e.g. "deterministic_server_hash"
  assignment_version: null,         // version tag baked into the server's condition/CT hash input (e.g. "v1")
  stable_assignment_id_hash: null,  // one-way SHA-256 digest (server-computed) of the normalized id actually hashed for assignment (prolific_id or fallback UUID) — NOT the raw value, so it is never the same plaintext as prolific_id under a second field name
  assignment_id_source: null,       // 'prolific_id' | 'generated_fallback'
  role_locked_to_original: false,   // true if a role change on this browser was overridden to keep the original assignment stable
  paper_order_version: null,        // version tag baked into the server's paper-order hash input (e.g. "v1")
  assigned_paper_1_id: null, assigned_paper_1_title: null,
  unassigned_paper_ids: [],
  paper_order: [], // mirrors study_order (one entry)

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
  // component_log: per-paper sequence of active-component states for
  // computing component_navigation_sequence and component_transition_count.
  // Each entry is a string: 'Paper', 'Questions', or 'AI'. Recorded by
  // recordComponentState() which is called from switchWorkspaceTab() and
  // the study-page entry point.
  component_log: { font: [], food: [], listing: [] },
  quiz_score: 0,
  quiz_total: 0,

  quiz_paper_scores: {
    font: null,
    food: null,
    listing: null
  },

  quiz_option_orders: {},
  quiz_question_orders: {},

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
  {
    l: 'Post-baccalaureate research assistant or lab manager',
    tier: 'lower'
  },
  { l: "Master's student", tier: 'lower' },
  {
    l: 'PhD student',
    tier: null,
    years: true,
    yearsLabel:
      'What year of your PhD program are you in? (Round up to the nearest whole number.)'
  },
  { l: 'Postdoctoral scholar', tier: 'higher' }
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

// SRL — one item per construct, in the participant-facing order.
const SRL_ITEMS = [
  ['srl_goal_setting', 'I set specific goals for what I want to accomplish in my research work.'],
  ['srl_strategic_planning', 'I begin a research task before deciding how I will approach it.'],
  ['srl_task_strategies', 'I adjust how I organize my time and tasks when my current approach is not helping me make progress.'],
  ['srl_elaboration', 'When learning something new, I connect it with what I already know to make it more meaningful and memorable.'],
  ['srl_self_evaluation', 'I rarely compare my research work against the standards or goals I have set for it.'],
  ['srl_help_seeking', 'When I need help with a research task, I seek assistance from other people or consult additional tools and sources.']
];

// General critical-thinking items. The attention check is administered here
// but excluded from the substantive composite in the export layer.
const CT_ITEMS_LIST = [
  {
    key: 'ct_credibility',
    label: 'I critically evaluate the credibility of the sources of information I encounter.'
  },
  {
    key: 'ct_understand_vs_judge',
    label: 'When reading a paper, I distinguish between what I need to understand and what I need to judge.'
  },
  {
    key: 'ct_evidence',
    label: 'I sometimes accept a conclusion without checking whether the evidence supports it.'
  },
  {
    key: 'ct_alternatives',
    label: 'I consider alternative explanations before accepting a research claim.'
  },
  {
    key: 'ct_weaknesses',
    label: 'I look for weaknesses or limitations in the evidence before accepting a claim.'
  },
  {
    key: 'attention_check',
    label: 'Please select 2 for this item.'
  }
];

const AI_EVALUATION_ITEMS = [
  {
    key: 'ai_eval_summarize_clarify',
    label: 'I use AI tools to summarize or clarify text.'
  },
  {
    key: 'ai_eval_before_own_judgment',
    label: 'I use AI tools before forming my own judgment about a paper.'
  },
  {
    key: 'ai_eval_question_assumptions',
    label: 'I question the assumptions underlying information or suggestions provided by AI tools.'
  },
  {
    key: 'ai_eval_rely_without_comparing',
    label: 'I rely on AI-generated information or recommendations without comparing them with other sources.'
  },
  {
    key: 'ai_eval_bias_concern',
    label: 'I worry that AI tools could bias my judgment of a paper if I rely on them too early.'
  },
  {
    key: 'ai_eval_question_assumptions_repeat',
    label: 'I question the assumptions underlying information or suggestions provided by AI tools.'
  }
];

const CT_INTRO = [
  'Please indicate how well each statement describes how you typically evaluate research claims, evidence, or explanations. Answer based on how you usually behave, not how you think you should behave.'
];

const AI_EVALUATION_INTRO = [
  'Please indicate how well each statement describes how you typically use AI tools when evaluating research papers or research-related information. Answer based on how you usually behave, not how you think you should behave.'
];

const CT_SCALE_NOTE = '1 = Not at all true for me, 7 = Very true for me';

// Spec section 6, "Standardized In-Task Questions For Each Assigned Study" —
// this exact question set is used for whichever paper is assigned
// (no per-paper custom wording), so the label lives here rather than per
// paper as in the previous version.
const STANDARD_Q_DEFS = [
  {
    suffix: 'strength', type: 'text', label: 'Identify one strength of this study.'
  },
  {
    suffix: 'limitation', type: 'text', label: 'Identify one limitation of this study.'
  },
  {
    suffix: 'improvement', type: 'text', label: 'Suggest one improvement or follow-up experiment.'
  },
  {
    suffix: 'understood', type: 'scale7', label: 'How well do you feel you understood this paper?',
    scaleEndLow: 'Not at all well', scaleEndHigh: 'Completely well'
  },
  {
    suffix: 'convincing', type: 'scale7', label: 'How convincing do you find this paper?',
    scaleEndLow: 'Not at all convincing', scaleEndHigh: 'Completely convincing'
  },
  {
    suffix: 'confidence', type: 'scale7', label: 'How confident are you about your responses to this study’s questions?',
    scaleEndLow: 'Not at all confident', scaleEndHigh: 'Completely confident'
  }
];

// ---------- Papers ----------
const PAPERS = {
  font: {
    id: 'font',
    title: 'Typeface–Context Congruence and the Cohort-Dependent Basis of Font Credibility',
    pdfFile: 'papers/font.pdf',
    quiz: [
      {
        q: 'What pattern produced the cohort interaction in credibility ratings?',
        options: [
          'A. Both mismatch types reduced credibility for older adults, while mainly interpersonal mismatches did so for younger adults',
          'B. Mainly institutional mismatches reduced credibility for older adults, while both mismatch types did so for younger adults',
          'C. Both mismatch types reduced credibility for both cohorts, with a larger effect among younger adults',
          'D. Mainly interpersonal mismatches reduced credibility for both cohorts, with a larger effect among older adults'
        ], correct: 'A'
      },
      {
        q: 'Which measure was rated first, and why?',
        options: [
          'A. Credibility was rated first to reduce priming from the appropriateness judgment',
          'B. Credibility was rated first to capture participants\' initial evaluation of the message',
          'C. Appropriateness was rated first to anchor later credibility judgments to typeface fit',
          'D. Appropriateness was rated first to separate style judgments from trust judgments'
        ], correct: 'A'
      },
      {
        q: 'Why did the study include three different exemplar families?',
        options: [
          'A. To compare whether some font pairs were easier to read',
          'B. To ensure each participant saw several individual typefaces',
          'C. To test whether the pattern generalized beyond one font contrast',
          'D. To determine which font family participants preferred overall'
        ], correct: 'C'
      },
      {
        q: 'How did younger adults respond to sans-serif institutional messages?',
        options: [
          'A. They judged them less appropriate but nearly as credible',
          'B. They judged them more appropriate but less credible',
          'C. They judged them low on both appropriateness and credibility',
          'D. They judged them high on both appropriateness and credibility'
        ], correct: 'A'
      },
      {
        q: 'Which set of messages was used in the experiment?',
        options: [
          'A. A residential lease clause, a bank account-security notice, a note from a friend, and a message from a coworker',
          'B. A news report, a medical consent form, a text from a family member, and a workplace announcement',
          'C. A rental advertisement, a credit-card offer, a social-media post, and an email from a supervisor',
          'D. A legal warning, an insurance notice, a personal invitation, and an online product review'
        ], correct: 'A'
      }
    ]
  },
  food: {
    id: 'food',
    title: 'Matched Calories, Matched Responses? Comparing Post-Lunch Metabolic Patterns',
    pdfFile: 'papers/food.pdf',
    quiz: [
      {
        q: 'Which feature of the glucose curves most clearly distinguished the two lunches after their peaks?',
        options: [
          'A. The minimally processed curve stayed below baseline for most of the afternoon',
          'B. The ultra-processed curve fell below baseline for a longer period',
          'C. Both curves returned to baseline at approximately the same time',
          'D. Both curves remained above baseline until the final measurement'
        ], correct: 'B'
      },
      {
        q: 'Why did the glucose measurements provide more information about the response over time?',
        options: [
          'A. Glucose was measured repeatedly, while insulin and triglycerides had one post-lunch measurement',
          'B. Glucose was measured after both lunches, while insulin and triglycerides were measured after only one lunch',
          'C. Glucose was measured with a wearable sensor, while insulin and triglycerides came from self-reports',
          'D. Glucose was measured across the afternoon, while insulin and triglycerides were measured only before lunch'
        ], correct: 'A'
      },
      {
        q: 'How did self-reported hunger compare with later snack intake?',
        options: [
          'A. Participants reported similar hunger but ate different amounts from the snack tray',
          'B. Participants reported different hunger but ate similar amounts from the snack tray',
          'C. Participants reported greater hunger and ate more after the minimally processed meal',
          'D. Participants reported less hunger and ate less after the ultra-processed meal'
        ], correct: 'A'
      },
      {
        q: 'Which comparison is best supported by the study design?',
        options: [
          'A. The short-term responses to two different meal patterns in the same participants',
          'B. The long-term health effects of regularly eating either meal pattern',
          'C. The independent causal effect of processing while all other meal features are fixed',
          'D. The responses of people with diabetes compared with people without diabetes'
        ], correct: 'A'
      },
      {
        q: 'Which account was better supported by the study\'s findings?',
        options: [
          'A. The energy-equivalence account',
          'B. The food-structure account',
          'C. The hunger-compensation account',
          'D. The calorie-mismeasurement account'
        ], correct: 'B'
      }
    ]
  },
  listing: {
    id: 'listing',
    title: 'Do Online Product Listings Accurately Describe What Arrives in the Package?',
    pdfFile: 'papers/listing.pdf',
    quiz: [
      {
        q: 'What could the study not determine?',
        options: [
          'A. Whether different categories tended to involve different types of inaccurate claims',
          'B. How much discrepancy buyers would tolerate before judging a product unacceptable',
          'C. Whether mismatch rates differed across seller types',
          'D. Whether audit-coded mismatch scores predicted item-not-as-described returns'
        ], correct: 'B'
      },
      {
        q: 'Which procedure did the researchers use to classify listing accuracy?',
        options: [
          'A. Blinded coders compared each delivered product with category standards and assigned an overall accuracy judgment',
          'B. Blinded coders checked each delivered product against its applicable listing claims, and any failed claim counted as a mismatch',
          'C. Researchers combined star ratings and item-not-as-described returns to identify listings likely to contain inaccurate claims',
          'D. Researchers classified products as mismatched only when both blinded coders identified failures in multiple claim types'
        ], correct: 'B'
      },
      {
        q: 'What did examining four product categories allow the researchers to compare?',
        options: [
          'A. Whether listing mismatch rates and types differed across kinds of products',
          'B. Whether listing star ratings were equally reliable in every category',
          'C. Whether each seller type performed best in a different category',
          'D. Whether item-not-as-described returns were concentrated in one category'
        ], correct: 'A'
      },
      {
        q: 'Why do the authors argue that star ratings may not closely track item-not-as-described returns?',
        options: [
          'A. Ratings may combine reviews from product variants with different features or specifications',
          'B. Ratings may remain attached after a seller changes the listing or replaces the product',
          'C. Ratings may overrepresent buyers who had unusually positive or negative experiences',
          'D. Ratings reflect overall purchase satisfaction rather than listing accuracy alone'
        ], correct: 'D'
      },
      {
        q: 'Which description best matches the mismatch-rate results?',
        options: [
          'A. Platform-sold listings were lowest and seller-shipped listings highest in every category; skincare and phone chargers had the highest overall rates',
          'B. Fulfilled-by-platform listings were lowest and platform-sold listings highest in every category; clothing and storage goods had the highest overall rates',
          'C. Seller-shipped listings were highest only for skincare and phone chargers; platform-sold listings were highest for clothing and storage goods',
          'D. Seller-type rankings varied across categories; clothing had the highest overall rate and skincare had the lowest'
        ], correct: 'A'
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
let TEST_MODE_PAPERS = null;           // validated one-paper override, or null (use default paper)

// Parses and whitelist-validates the ?test=1&cell=...&papers=... params.
// Returns { requested: boolean, valid: boolean, cell, papers, error }.
// Never trusts free-form input past this point — cell must be an exact
// member of TEST_VALID_CELLS, and papers (if present) must contain exactly
// one member of TEST_VALID_PAPER_IDS.
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
      papers.length === 1 &&
      papers.every(p => TEST_VALID_PAPER_IDS.includes(p));
    if (!validPapers) {
      return {
        requested: true, valid: false, cell: null, papers: null,
        error: 'Invalid ?papers= override. Must be exactly one value from: ' + TEST_VALID_PAPER_IDS.join(', ')
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
    'Valid papers: ' + TEST_VALID_PAPER_IDS.join(', ') + ' (exactly one)</p>';
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
  const papersLabel = TEST_MODE_PAPERS ? (TEST_MODE_PAPERS[0]) : '(default order)';
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

function hasPriorResearchAiUse() {
  return DATA.responses.ai_research_use === 'Yes';
}

// Page order + section numbering are computed by the shared, pure
// window.SurveyRouting module (public/survey-routing.js), so the exact
// ordering rules can be unit-tested in Node and used unchanged here. See that
// file for the full CT-before / CT-after ordering spec.
function buildPageOrder() {
  pageOrder = window.SurveyRouting.computePageOrder(
    DATA.ct_scale_placement,
    hasPriorResearchAiUse(),
    INSTRUCTIONS_PAGE_IDS,
    QUIZ_PAGE_IDS
  );
  applySectionNumbers();
}

function applySectionNumbers() {
  const map = window.SurveyRouting.computeSectionNumbers(
    DATA.ct_scale_placement,
    hasPriorResearchAiUse()
  );
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

// ---------- Persistent server-side balanced assignment ----------
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
  let effectiveRoleYears = researchRoleYears;
  let roleLockedToOriginal = false;
  if (cached && cached.research_role && cached.research_role !== researchRole) {
    effectiveRole = cached.research_role;
    effectiveRoleYears = cached.research_role_years ?? researchRoleYears;
    roleLockedToOriginal = true;
  }

  const resp = await fetch('/api/assign-condition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stable_participant_id: stableId,
      research_role: effectiveRole,
      research_role_years: effectiveRoleYears
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

  // The server returns the participant's permanent one-paper assignment.
  // Firestore idempotency ensures the same stable id receives the same paper
  // after refreshes or repeat requests.
  const order = Array.isArray(data.paper_order) ? data.paper_order.slice(0, 1) : [];
  const unassigned = Array.isArray(data.unassigned_paper_ids) ? data.unassigned_paper_ids : [];
  if (order.length !== 1 || !PAPERS[order[0]]) throw new Error('Server returned an invalid one-paper assignment.');

  DATA.study_order = order;
  DATA.study_1_id = order[0];
  DATA.study_1_title = PAPERS[order[0]].title;

  DATA.paper_order = [...order];
  DATA.assigned_paper_1_id = order[0];
  DATA.assigned_paper_1_title = PAPERS[order[0]].title;
  DATA.unassigned_paper_ids = [...unassigned];

  writeAssignmentCache(stableId, {
    research_role: DATA.research_role,
    research_role_years: DATA.research_role_years,
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
    unassigned_paper_ids: DATA.unassigned_paper_ids
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

  const order = Array.isArray(data.paper_order) ? data.paper_order.slice(0, 1) : [];
  const unassigned = Array.isArray(data.unassigned_paper_ids) ? data.unassigned_paper_ids : [];
  if (order.length !== 1 || !PAPERS[order[0]]) throw new Error('Server returned an invalid one-paper assignment.');

  DATA.study_order = order;
  DATA.study_1_id = order[0];
  DATA.study_1_title = PAPERS[order[0]].title;

  DATA.paper_order = [...order];
  DATA.assigned_paper_1_id = order[0];
  DATA.assigned_paper_1_title = PAPERS[order[0]].title;
  DATA.unassigned_paper_ids = [...unassigned];

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
    if (btnNext) btnNext.textContent = (curId === 'page-debrief') ? 'Submit responses' : (curId === lastInstrId ? 'Begin Task →' : 'Continue →');
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
  let idx = pageOrder.indexOf(curId);
  if (curId === 'page-debrief' && dir > 0) {
    finalizeSubmission();
    return;
  }

  const studyMatch = /^page-study-(\d)$/.exec(curId);

  if (studyMatch && dir > 0) {
    const studyNumber = parseInt(studyMatch[1], 10);
    const paperId = DATA['study_' + studyNumber + '_id'];

    if (paperId) {
      finalizeStudyTiming(paperId);
    }

    // The single assigned paper is the final in-task page.
    if (studyNumber === 1) {
      await endTaskPhaseAndExitFullscreen();
    }
  }

  collectFieldsNow();

  if (curId === 'page-ai-use-gate' && dir > 0) {
    if (DATA.responses.ai_research_use === 'No') clearConditionalAiResponses();
    buildPageOrder();
    idx = pageOrder.indexOf(curId);
  }

  if (curId === 'page-about-you' && dir > 0) {
    // Gate: do not allow the participant to proceed until the server has
    // returned a valid assignment. requestAssignmentWithUI() shows a loading
    // state, then either succeeds (we continue below) or shows an inline
    // error + Retry button and leaves the participant on this page.
    navigateInFlight = true;
    const roleVal = document.querySelector('input[name="ay_role"]:checked');
    pendingAssignmentRole = roleVal ? roleVal.value : null;
    const roleYearsEl = document.getElementById('ay_role_years');

    pendingAssignmentRoleYears =
      pendingAssignmentRole === 'PhD student' &&
        roleYearsEl &&
        roleYearsEl.value !== ''
        ? Number(roleYearsEl.value)
        : null;
    const ok = await requestAssignmentWithUI();
    navigateInFlight = false;
    if (!ok) return;
    finalizeAboutYou();
    markAutosaveDirty();
    saveProgressNow();
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
  if (dir > 0) { markAutosaveDirty(); saveProgressNow(); }
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
  // Flush and compute the viewport-tracking measures BEFORE duration_ms is
  // touched below -- stopViewportTracking() only writes into
  // DATA.timing[paperId].{pdf_exposure_proportion_30s,region_exposed_30s_count,
  // paper_navigation_sequence,backward_transition_count}
  // and never reads or sets duration_ms/study_end_ts/study_start_ts, so
  // ordering here only matters for making sure the final (still-open) viewport
  // segment gets closed out using "now" rather than some later timestamp.
  stopViewportTracking(paperId);
  // Commit component-navigation measures (component_navigation_sequence and
  // component_transition_count) derived from DATA.component_log[paperId].
  commitComponentMeasures(paperId);
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
  startViewportTracking(paperId);
  // Record the initial component state: on study-page entry the PDF tab is
  // active by default, so the starting component is 'Paper'.
  recordComponentState(paperId, 'Paper');
  // Active-interaction triggers: PDF scroll or click re-asserts 'Paper';
  // response textarea focus asserts 'Questions'. These supplement the tab-
  // switch triggers in switchWorkspaceTab so that active engagement is
  // captured even when a tab switch event alone would be ambiguous.
  const pdfPane = document.getElementById('paperPane-' + paperId);
  if (pdfPane) {
    pdfPane.addEventListener('scroll', () => recordComponentState(paperId, 'Paper'), { passive: true, capture: false });
    pdfPane.addEventListener('click', () => recordComponentState(paperId, 'Paper'));
  }
}

// ---------- Required-response validation ----------
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
// Minimum word count required for each written evaluation response
// (strengths / limitations / improvements).
const MIN_RESPONSE_WORDS = 50;
const SHORT_RESPONSE_ALERT =
  'Please add more detail. Your response should be at least 50 words and explain the specific feature and why it matters.';

// Counts words in a response: trims, treats any whitespace run (spaces or line
// breaks) as a single separator, and returns 0 for blank text.
function countResponseWords(text) {
  const trimmed = String(text == null ? '' : text).trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Remove the red validation state as soon as an evaluation response reaches
// the required word count. Short responses remain outlined until corrected;
// blank-response handling continues to use the normal required-field flow.
function initializeResponseWordValidation() {
  document.addEventListener('input', event => {
    const field = event.target;
    if (!field || field.tagName !== 'TEXTAREA' || !field.hasAttribute('data-logfield')) return;

    const logField = field.getAttribute('data-logfield') || '';
    const isEvalResponse = /_(strength|limitation|improvement)$/.test(logField);
    if (!isEvalResponse) return;

    if (countResponseWords(field.value) >= MIN_RESPONSE_WORDS) {
      field.classList.remove('input-error');
      field.removeAttribute('aria-invalid');
    }
  });
}

function validateCurrentPage() {
  const pageEl = document.querySelector('.page.active');
  if (!pageEl) return true;

  // Pages containing instructions, transitions, or debrief text have
  // nothing for the participant to answer.
  const pageId = pageEl.id;
  const isStudyPage = /^page-study-\d+$/.test(pageId);
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
  let emptyResponseInvalid = false;
  let shortResponseInvalid = false;

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
      // On study pages, validate task answers even when the participant
      // currently has the AI Assistant tab open and the Questions tab hidden.
      // AI chat inputs do not have data-logfield, so they are never required.
      if ((!isStudyPage && !isFieldVisible(field)) || field.disabled) return;

      const responseValue = field.value;
      const logField = field.getAttribute('data-logfield') || '';
      const isEvalResponse = /_(strength|limitation|improvement)$/.test(logField);

      if (!responseValue.trim()) {
        // Empty required response: keep the existing unanswered-response behavior.
        markInvalid(field);
        if (isEvalResponse) emptyResponseInvalid = true;
      } else if (isEvalResponse && countResponseWords(responseValue) < MIN_RESPONSE_WORDS) {
        // 1-74 words in an evaluation box: same red outline plus the specific alert.
        markInvalid(field);
        shortResponseInvalid = true;
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
      // The convincingness scale remains required even if it is temporarily
      // hidden because the participant is viewing the AI Assistant tab.
      if (!isStudyPage && !isFieldVisible(scale)) return;

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
    // If the participant is viewing the AI tab, return them to Questions
    // so they can see and complete the required in-task responses.
    if (isStudyPage) {
      const studyMatch = /^page-study-(\d+)$/.exec(pageId);
      const paperId = studyMatch
        ? DATA['study_' + studyMatch[1] + '_id']
        : null;

      if (paperId) {
        switchWorkspaceTab(paperId, 'questions');
      }
    }

    if (firstInvalid) {
      setTimeout(() => {
        firstInvalid.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        if (
          firstInvalid.tagName === 'INPUT' ||
          firstInvalid.tagName === 'TEXTAREA' ||
          firstInvalid.tagName === 'SELECT'
        ) {
          firstInvalid.focus({ preventScroll: true });
        }
      }, 0);
    }

    const invalidNumberInput = Array.from(
      pageEl.querySelectorAll('input[type="number"]')
    ).find(input => {
      if (!isFieldVisible(input) || input.disabled) {
        return false;
      }

      return getNumberInputError(input) !== '';
    });

    if (invalidNumberInput) {
      const message = getNumberInputError(invalidNumberInput);
      showNumberInputError(invalidNumberInput, message);
    } else if (emptyResponseInvalid) {
      showWarnBanner(
        'Please answer all questions on this page before continuing.'
      );
    } else if (shortResponseInvalid) {
      showWarnBanner(SHORT_RESPONSE_ALERT);
    } else {
      showWarnBanner(
        'Please answer all questions on this page before continuing.'
      );
    }
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
  // No AI-familiarity screening is administered on the consent page.
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
  if (!consentCb.checked) {
    ok = false;
  }
  if (!ok) {
    if (errEl) errEl.style.display = 'block';
    return;
  }
  if (errEl) errEl.style.display = 'none';


  DATA.prolific_id = prolific;
  DATA.consent = true;
  DATA.consent_status = 'granted';
  DATA.media_release_status = mediaCb.checked ? 'granted' : 'declined';

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
function clearConditionalAiResponses() {
  [
    'ai_tenure',
    'ai_hours_per_week',
    'ai_purpose',
    'ai_purpose_specify',
    'ai_purpose_other',
    'ai_understanding',
    'ai_eval_summarize_clarify',
    'ai_eval_before_own_judgment',
    'ai_eval_question_assumptions',
    'ai_eval_rely_without_comparing',
    'ai_eval_bias_concern',
    'ai_eval_question_assumptions_repeat'
  ].forEach(key => { delete DATA.responses[key]; });

  const hours = document.getElementById('ai_hours_per_week');
  if (hours) hours.value = '';
  document.querySelectorAll(
    'input[name="ai_tenure"], input[name="ai_purpose"], input[name="ai_understanding"]'
  ).forEach(input => {
    input.checked = false;
    const label = input.closest('.option-item');
    if (label) label.classList.remove('selected');
  });
  document.querySelectorAll('#page-ai-evaluation .likert-btn')
    .forEach(button => button.classList.remove('selected'));

  const specify = document.getElementById('rg-ai-purpose-specify');
  if (specify) {
    specify.value = '';
    specify.style.display = 'none';
  }
}

function handleAiResearchUseChange(value) {
  DATA.responses.ai_research_use = value;
  if (value === 'No') clearConditionalAiResponses();
  buildPageOrder();
  markAutosaveDirty();
  scheduleAutosave();
}

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
    SRL_ITEMS,
    'Not at all true for me',
    'Very true for me'
  );

  // General critical thinking
  const ctIntroEl = document.getElementById('ctIntroText');
  if (ctIntroEl) {
    ctIntroEl.innerHTML = CT_INTRO
      .map((text, index) => `
        <p class="muted" style="margin-bottom:${index === CT_INTRO.length - 1 ? '16px' : '10px'};">
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

  // AI-use routing page
  renderRadioGroup('rg-ai-research-use', 'ai_research_use', ['Yes', 'No']);
  document.querySelectorAll('input[name="ai_research_use"]').forEach(input => {
    input.addEventListener('change', event => handleAiResearchUseChange(event.target.value));
  });

  // Conditional AI Experience
  renderRadioGroup('rg-ai-purpose', 'ai_purpose', AI_PURPOSE_OPTIONS, o => o.l, 'checkbox');
  setupSpecifyField('rg-ai-purpose', 'ai_purpose', 'Other');
  renderRadioGroup('rg-ai-tenure', 'ai_tenure', TENURE_OPTIONS);
  renderRadioGroup('rg-ai-understanding', 'ai_understanding', UNDERSTANDING_OPTIONS);

  // Conditional AI-specific evaluation
  const aiEvalIntroEl = document.getElementById('aiEvaluationIntroText');
  if (aiEvalIntroEl) {
    aiEvalIntroEl.innerHTML = AI_EVALUATION_INTRO
      .map((text, index) => `
        <p class="muted" style="margin-bottom:${index === AI_EVALUATION_INTRO.length - 1 ? '16px' : '10px'};">
          ${escapeHtml(text)}
        </p>
      `)
      .join('');
  }
  renderScale7Block(
    'aiEvaluationWrap',
    AI_EVALUATION_ITEMS.map(item => [item.key, item.label]),
    'Not at all true for me',
    'Very true for me'
  );
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
    wrapEl.innerHTML = `
  <div
    class="q-sublabel"
    id="${containerId}-years-label"
    style="margin-bottom:6px;"
  ></div>

  <input
  type="number"
  id="${fieldName}_years"
  min="1"
  max="10"
  step="1"
  inputmode="numeric"
  placeholder="Year in PhD program"
>
`;
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
  {
    paragraphs: [
      'You will now read one short research study.',
      'The paper will appear on the left side of the page, and the response questions will appear on the right. After reading the study, you will identify its strengths and limitations, suggest improvements or future directions, and rate how convincing you find its conclusions.'
    ]
  },
  {
    paragraphs: [
      'The studies in this task were artificially constructed. When reviewing each study, please apply the same analytical and scientific reasoning and judgment that you would use when assessing real research.'
    ]
  },
  {
    paragraphs: [
      'Your written responses must be [[B]]specific to the study[[/B]]. General statements such as "the aim is clear," "the study is good," "it needs more detail," or "N/A" are not sufficient on their own. For each response, identify the specific feature of the study you are referring to and explain why it strengthens, weakens, or could improve the research.'
    ]
  },
  {
    paragraphs: [
      'Please provide enough detail to fully explain your reasoning. As a guide, each response should be about [[B]]50 words or more (around 3 sentences) [[/B]].'
    ]
  },
  {
    paragraphs: [
      'Please complete the task without using any outside tools or resources. Your activity will be recorded, and the task will be displayed in full-screen mode to help you stay focused.'
    ]
  }
];

// Verbatim from the spec doc's "Additional Instructions: AI Condition
// Only" section, split into "Page 4"/"Page 5"/"Page 6". Page 6 also shows
// the AI-condition interface demonstration per "[Show AI-condition
// interface demonstration.]".
const INSTRUCTIONS_PAGES_AI_ONLY = [
  {
    paragraphs: [
      'You will have access to an AI assistant (ChatGPT) during the paper evaluation task. At the top of the right panel, you will see two tabs:'
    ],
    bullets: [
      {
        label: 'Questions',
        text: 'where you will enter your responses'
      },
      {
        label: 'AI Assistant',
        text: 'where you can interact with the AI assistant who has context of the study you are reviewing (no need to copy and paste the study to the AI)'
      }
    ],
    mockup: 'ai'
  },
  {
    paragraphs: [
      'The AI assistant will have access to the paper currently displayed, so you may ask about the paper without pasting the full text.'
    ]
  },
  {
    paragraphs: [
      'You may send up to [[FIVE]] queries to the AI assistant for the study. The number of messages remaining will be displayed in the AI Assistant tab. You will receive the [[SAME]] compensation regardless of how much you use AI.'
    ]
  }
];

// Verbatim from the spec doc's "Additional Instructions: No-AI Condition
// Only" section ("Page 4"), which also shows the No-AI-condition interface
// demonstration per "[Show No-AI-condition interface demonstration.]".
const INSTRUCTIONS_PAGES_NOAI_ONLY = [
  {
    paragraphs: [
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
// Renders [[B]]...[[/B]] spans in instruction text as bold, matching the
// existing [[FIVE]]/[[SAME]] bold-token convention. Input is already escaped.
function applyBold(html) {
  return String(html == null ? '' : html)
    .replace(/\[\[B\]\]([\s\S]*?)\[\[\/B\]\]/g, '<strong>$1</strong>');
}

function buildInstructionsPages() {
  const container = document.getElementById('instructionsPagesContainer');
  if (!container) return;

  INSTRUCTIONS_PAGE_IDS = [];

  const isAI = DATA.condition === 'AI';
  const pages = INSTRUCTIONS_PAGES_COMMON.concat(
    isAI ? INSTRUCTIONS_PAGES_AI_ONLY : INSTRUCTIONS_PAGES_NOAI_ONLY
  );

  // Derive the task section number from the same single source of truth used
  // by applySectionNumbers(), so the instruction-page headers can never drift
  // from the rebuilt page order (it depends on placement AND prior-AI-use).
  const taskSectionNumber = window.SurveyRouting.computeSectionNumbers(
    DATA.ct_scale_placement,
    hasPriorResearchAiUse()
  ).task;

  container.innerHTML = '';

  pages.forEach((page, i) => {
    const pageId = 'page-instructions-' + i;
    INSTRUCTIONS_PAGE_IDS.push(pageId);

    const headerHtml = `
      <div class="section-label">
        <div
          class="section-number"
          ${i === 0 ? 'id="secnum-task"' : ''}
        >
          ${taskSectionNumber}
        </div>
        <div class="section-title">Paper Evaluation Task</div>
      </div>
    `;

    const paragraphs = Array.isArray(page.paragraphs)
      ? page.paragraphs
      : [];

    const paraHtml = paragraphs
      .map(text => {
        const safeText = applyBold(escapeHtml(text))
          .replace(/\[\[FIVE\]\]/g, '<strong>FIVE</strong>')
          .replace(/\[\[SAME\]\]/g, '<strong>SAME</strong>');

        return `
      <p style="margin-bottom:14px;">
        ${safeText}
      </p>
    `;
      })
      .join('');

    const bulletsHtml = Array.isArray(page.bullets)
      ? `
    <ul class="instructions-bullets">
      ${page.bullets
        .map(bullet => {
          if (
            bullet &&
            typeof bullet === 'object'
          ) {
            return `
              <li>
                <strong>${escapeHtml(bullet.label)}</strong>,
                ${escapeHtml(bullet.text)}
              </li>
            `;
          }

          return `<li>${escapeHtml(bullet)}</li>`;
        })
        .join('')}
    </ul>
  `
      : '';

    let mockupHtml = '';

    if (page.mockup === 'ai') {
      mockupHtml = `
        <div class="instructions-mockup">
          <div class="mockup-block">
            ${INSTRUCTIONS_MOCKUP_SVG_QUESTIONS}
          </div>

          <p class="mockup-note">
            ${escapeHtml(INSTRUCTIONS_MOCKUP_NOTE)}
          </p>

          <div class="mockup-block">
            ${INSTRUCTIONS_MOCKUP_SVG_AI}
          </div>
        </div>
      `;
    } else if (page.mockup === 'noai') {
      mockupHtml = `
        <div class="instructions-mockup">
          <div class="mockup-block">
            ${INSTRUCTIONS_MOCKUP_SVG_NOAI}
          </div>
        </div>
      `;
    }

    container.insertAdjacentHTML(
      'beforeend',
      `
        <div class="page survey-page" id="${pageId}">
          ${headerHtml}

          <div class="q-card">
            ${paraHtml}
            ${bulletsHtml}
            ${mockupHtml}
          </div>
        </div>
      `
    );
  });
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
            <div class="scale-end">${escapeHtml(def.scaleEndLow || '')}</div>
            <div class="scale-end right">${escapeHtml(def.scaleEndHigh || '')}</div>
          </div>
        </div>`;
      }
      if (def.type === 'textgroup') {
        const itemsHtml = def.items.map(item => {
          const itemFieldId = paperId + '_' + item.suffix;
          return `<div class="list-item-block">
            <div class="list-item-label">${escapeHtml(item.itemLabel)}</div>
            <textarea class="list-item-textarea" id="${itemFieldId}" data-logfield="${itemFieldId}" placeholder="Type your response here..."></textarea>
          </div>`;
        }).join('');
        return `<div class="q-card">
          <div class="q-label">${escapeHtml(label)}</div>
          ${itemsHtml}
        </div>`;
      }
      return `<div class="q-card">
        <div class="q-label">${escapeHtml(label)}</div>
        <textarea id="${fieldId}" data-logfield="${fieldId}" placeholder="Type your response here..."></textarea>
      </div>`;
    }).join('');

    slotEl.innerHTML = `
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
  const scale = document.querySelector(`.conf-scale[data-name="${name}"]`);
  if (scale && scale.classList.contains('locked')) {
    showWarnBanner("You can't change your response.");
    return;
  }
  document.querySelectorAll(`.conf-btn[data-name="${name}"]`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  DATA.responses[name] = parseInt(btn.getAttribute('data-val'), 10);
  if (scale) {
    scale.classList.add('locked');
    const card = scale.closest('.q-card');
    if (card) card.classList.add('locked-question');
  }
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
    // Accumulates downscaled page images for the AI vision context. Declared
    // before the page-rendering loop so a capture failure (handled per-page
    // below) never leaves this undefined and never aborts PDF rendering.
    const capturedImages = [];
    const browserPixelRatio = window.devicePixelRatio || 1;
    const renderPixelRatio = Math.min(
      3,
      Math.max(2, browserPixelRatio)
    );

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });

      const targetWidth = container.clientWidth || 700;
      const scale =
        (targetWidth / viewport.width) *
        renderPixelRatio;

      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(scaledViewport.width);
      canvas.height = Math.floor(scaledViewport.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
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
    // All pages have now been appended to the container, so
    // pdfWrap-<paperId>.scrollHeight reflects the FINAL, complete content
    // height. Gate exposure-bucket allocation on this rather than on the
    // first non-trivial scrollHeight, since each page is rendered and
    // appended one at a time across real async yields (see the for-loop
    // above) -- allocating buckets earlier would size them against a
    // partial (e.g. single-page) height for multi-page papers.
    if (paperId) markPdfContentReady(paperId);
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

// ============================================================
// PDF viewport-tracking measures
// ------------------------------------------------------------
// Adapted from two strands of the reading-behavior literature:
//  - Lagun & Lalmas (2016): cumulative time-in-viewport with a
//    30-second dwell threshold per content region. Used here as
//    EXPOSURE_THRESHOLD_MS for pdf_exposure_proportion_30s.
//  - AOI (Area-of-Interest) Markov-chain navigation models: we
//    discretize the viewport's vertical position into named
//    six half-page regions (Top-Half/Bottom-Half per PDF page) and track visits to compute
//    paper_navigation_sequence and backward_transition_count.
//  - Lagun & Lalmas (2016) preprocessing requirement: an AOI visit
//    is only retained in the navigation sequence once its
//    continuous dwell time reaches MIN_DWELL_MS. This is NOT
//    optional -- a state a participant passed through for under a
//    second (e.g. while scrolling past it en route elsewhere) is
//    not a genuine "visit" to that region and must not appear in
//    paper_navigation_sequence or backward_transition_count. See aggregateNavigationSequence()
//    below for the exact 4-step procedure (aggregate consecutive
//    same-AOI intervals -> drop any whose total is under
//    MIN_DWELL_MS -> re-collapse newly-adjacent duplicates).
//
// IMPLEMENTATION ADAPTATIONS (ours, specific to this split-panel
// survey -- NOT specified by the cited papers):
//  1. Each of the three actual rendered PDF pages is divided into
//     Top-Half/Bottom-Half, yielding two regions per page (six total). The geometry,
//     overlap-crediting, dominant-state, and hysteresis rules are
//     study-specific deterministic implementation choices.
//  2. Exposure-bucket accumulation excludes time when the tab is
//     hidden or the window is unfocused (seg.visible/seg.focused
//     below). This does NOT change duration_ms, which still counts
//     all elapsed time regardless of visibility/focus -- it only
//     keeps the exposure measure from crediting time the page could
//     not actually have been looked at.
//  3. Exposure is measured over up to MAX_EXPOSURE_BUCKETS equal-
//     height buckets spanning the full rendered PDF content height
//     (#pdfWrap-<paperId>.scrollHeight), NOT the scrollable pane
//     (#paperPane-<paperId>), so the measure is independent of pane
//     height and consistent across window sizes.
//  4. The MIN_DWELL_MS filter applies only to paper_navigation_sequence /
//     backward_transition_count. It
//     never affects pdf_exposure_proportion_30s, which still credits
//     a bucket's actual visible/focused milliseconds regardless of
//     how long any single visit lasted -- a participant who
//     revisits a region in several short bursts that add up past
//     EXPOSURE_THRESHOLD_MS has genuinely been exposed to it, even
//     though none of those bursts individually survives the
//     navigation-sequence dwell filter.
//  5. Before the MIN_DWELL_MS aggregation step runs, filterNavigableSegments()
//     drops any raw segment that was hidden (visible !== true), unfocused
//     (focused !== true), or not a real content region (Unrendered /
//     Unclassified). A participant who tabs away or alt-tabs out never gets
//     that dead time credited as a "visit" to whatever region happened to be
//     on screen, and indeterminate/not-yet-rendered states never appear in
//     paper_navigation_sequence either.
//  6. pdf_exposure_proportion_30s uses a strict > EXPOSURE_THRESHOLD_MS
//     comparison ("viewport time longer than 30 seconds"), so a bucket
//     exposed for exactly 30000ms does not count -- only buckets exposed for
//     more than 30000ms do.
//  7. paper_navigation_sequence does not include explicit Start/Leave sentinel
//     markers. The sequence already implicitly begins when markStudyStart()
//     starts the tracker and ends when finalizeStudyTiming() stops it, so an
//     explicit "Start"/"Leave" token in the exported string would only
//     duplicate information already carried by the page-entry/exit timing
//     fields, without adding anything the AOI/Markov-chain literature itself
//     requires. This is a deliberate, documented omission, not an oversight.
//
// NOT used as primary measures, per spec: raw scroll_event_count and
// mouse hover are deliberately excluded from this module. Time spent
// in a viewport region is reported only as an exposure proportion and
// is never described as proof of attentive reading or comprehension.
// ============================================================

const EXPOSURE_THRESHOLD_MS = 30000;
const MAX_EXPOSURE_BUCKETS = 2000;
const VIEWPORT_HEARTBEAT_MS = 1000;
const MIN_DWELL_MS = 1000;
// "Tied or nearly tied" tolerance for dominant-region assignment: the
// runner-up region is treated as tied with the leader when the gap between
// their visible-overlap heights is within this fraction of the leader's
// overlap. Not specified numerically by the governing spec (which only says
// "tied or nearly tied"); chosen small enough to only catch genuine boundary
// flicker, not real region changes. Documented here as an explicit,
// disclosed implementation decision -- see the Phase 3 final report.
const DOMINANT_REGION_TIE_RATIO = 0.01;

const VIEWPORT_TRACKERS = {};

// Canonical six-region reading order for a three-page paper, 0-indexed per
// the governing spec's explicit backward-transition table (P1-Top = 0 ...
// P3-Bottom-Half = 5). Used only to rank regions for backward-transition
// counting and first-state tie-breaking; actual region BOUNDARIES always
// come from the real rendered page geometry (see buildSixRegions below),
// never from this list.
const SIX_REGION_ORDER = [
  'P1-Top-Half', 'P1-Bottom-Half',
  'P2-Top-Half', 'P2-Bottom-Half',
  'P3-Top-Half', 'P3-Bottom-Half'
];
const SIX_REGION_INDEX = {};
SIX_REGION_ORDER.forEach((label, i) => { SIX_REGION_INDEX[label] = i; });

// Sentinel, non-navigable states: 'Unrendered' (PDF/page geometry not yet
// available) and 'Unclassified' (no region had any visible overlap, e.g.
// the viewport sits entirely in the gap between two stacked page canvases).
// Neither is a real AOI visit.
const NON_NAVIGABLE_REGIONS = new Set(['Unrendered', 'Unclassified']);

function getPdfViewportRange(paperId) {
  const pane = document.getElementById('paperPane-' + paperId);
  const wrap = document.getElementById('pdfWrap-' + paperId);
  if (!pane || !wrap) return null;
  const paneRect = pane.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const contentHeight = wrap.scrollHeight;
  if (!contentHeight) return null;
  const viewportHeight = pane.clientHeight;
  let visibleTop = paneRect.top - wrapRect.top;
  let visibleBottom = visibleTop + viewportHeight;
  visibleTop = Math.max(0, Math.min(contentHeight, visibleTop));
  visibleBottom = Math.max(0, Math.min(contentHeight, visibleBottom));
  return { contentHeight, viewportHeight, visibleTop, visibleBottom };
}

// Reads the ACTUAL rendered per-page canvas boundaries (one <canvas> per
// PDF page, appended in page order by renderPDF()) in the same
// wrap-content-relative coordinate space as getPdfViewportRange()'s
// visibleTop/visibleBottom (i.e. (rect.top - wrapRect.top), which is
// scroll-position-independent since both the wrap and its canvas children
// move together when the pane scrolls). Per spec, page boundaries for the
// six-region scheme must come from this real geometry, never from
// dividing the whole multi-page document height into nine equal slices.
function getPageGeometry(paperId) {
  const wrap = document.getElementById('pdfWrap-' + paperId);
  if (!wrap) return [];
  const wrapRect = wrap.getBoundingClientRect();
  const canvases = wrap.querySelectorAll ? wrap.querySelectorAll('canvas') : [];
  const pages = [];
  for (let i = 0; i < canvases.length; i += 1) {
    const rect = canvases[i].getBoundingClientRect();
    pages.push({ top: rect.top - wrapRect.top, bottom: rect.bottom - wrapRect.top });
  }
  return pages;
}

// Splits each real rendered page into two equal-height regions (Top-Half /
// Bottom-Half), producing the six ordered P<n>-Top-Half..P<n>-Bottom-Half
// regions in reading order. Degenerate pages (zero/negative height, e.g. a
// page whose canvas hasn't actually rendered yet) are skipped rather than
// producing a malformed region.
function buildSixRegions(pages) {
  const names = ['Top-Half', 'Bottom-Half'];
  const regions = [];
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p];
    const height = page.bottom - page.top;
    if (!(height > 0)) continue;
    const half = height / 2;
    for (let n = 0; n < 2; n += 1) {
      regions.push({
        label: 'P' + (p + 1) + '-' + names[n],
        top: page.top + n * half,
        bottom: n === 1 ? page.bottom : page.top + (n + 1) * half
      });
    }
  }
  return regions;
}

// Re-reads page geometry and rebuilds the six-region list for `paperId`.
// Safe to call on every viewport-change event (scroll/resize/visibility/
// focus): re-deriving boundaries from current canvas rects is the only way
// to stay correct across window resizes (the canvases are CSS
// width:100%/height:auto, so their on-screen extent changes with the pane).
// Accumulated per-region exposure (tracker.regionExposedMs) is preserved
// across a geometry refresh as long as the region COUNT is unchanged (the
// normal case -- the page count of a given paper never changes mid-task);
// it is only (re)initialized to zeros the first time geometry becomes
// available or if the region count itself changes.
function refreshRegionGeometry(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker) return;
  const pages = getPageGeometry(paperId);
  const regions = pages.length ? buildSixRegions(pages) : [];
  // The finalized study design requires exactly three rendered pages,
  // yielding exactly six regions. Partial geometry (e.g. while canvases
  // are still rendering) is not measurement-ready and must not generate
  // page/region outcomes.
  const geometryReady = regions.length === SIX_REGION_ORDER.length;
  tracker.regions = geometryReady ? regions : [];
  if (geometryReady && (!tracker.regionExposedMs || tracker.regionExposedMs.length !== regions.length)) {
    tracker.regionExposedMs = new Array(regions.length).fill(0);
  }
  if (!geometryReady) tracker.regionExposedMs = null;
}

// Picks the single dominant region (largest visible-overlap share) from a
// parallel `overlaps` array, applying the spec's hysteresis rule: when the
// runner-up is tied or nearly tied with the leader, retain `previousRegion`
// if it is one of the tied candidates; otherwise (including the very first
// assignment, when there is no previous state) deterministically pick the
// earliest-in-reading-order region among the tied candidates. Returns null
// when no region has any visible overlap at all (viewport sits in a gap
// between pages, or off the rendered content).
function pickDominantRegion(overlaps, regions, previousRegion) {
  let bestIdx = -1;
  let bestVal = 0;
  for (let i = 0; i < overlaps.length; i += 1) {
    if (overlaps[i] > bestVal) { bestVal = overlaps[i]; bestIdx = i; }
  }
  if (bestIdx === -1 || bestVal <= 0) return null;

  const tieThreshold = bestVal * DOMINANT_REGION_TIE_RATIO;
  const tiedIdxs = [];
  for (let i = 0; i < overlaps.length; i += 1) {
    if (overlaps[i] > 0 && (bestVal - overlaps[i]) <= tieThreshold) tiedIdxs.push(i);
  }
  if (tiedIdxs.length <= 1) return regions[bestIdx].label;

  if (previousRegion) {
    for (let i = 0; i < tiedIdxs.length; i += 1) {
      if (regions[tiedIdxs[i]].label === previousRegion) return previousRegion;
    }
  }
  tiedIdxs.sort((a, b) => a - b);
  return regions[tiedIdxs[0]].label;
}

// Computes the single dominant six-region AOI state for the current
// viewport `range`, using tracker.regions (refreshed by the caller via
// refreshRegionGeometry just before this runs). Maintains
// tracker.lastValidDominantRegion as the rolling hysteresis state across
// calls -- including across hidden/unfocused intervals, since the
// visible/focused gating that excludes those intervals from
// paper_navigation_sequence happens later, in filterNavigableSegments(), not
// here.
function computeDominantRegion(paperId, range) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker || !tracker.contentReady) return 'Unrendered';
  const regions = tracker.regions;
  if (!regions || !regions.length || !range) return 'Unrendered';
  const overlaps = regions.map((r) =>
    Math.max(0, Math.min(r.bottom, range.visibleBottom) - Math.max(r.top, range.visibleTop))
  );
  const label = pickDominantRegion(overlaps, regions, tracker.lastValidDominantRegion);
  if (label) {
    tracker.lastValidDominantRegion = label;
    return label;
  }
  return 'Unclassified';
}

function numBucketsFor(contentHeight) {
  return Math.max(1, Math.min(MAX_EXPOSURE_BUCKETS, Math.ceil(contentHeight)));
}

function bucketIndexRange(top, bottom, contentHeight, bucketCount) {
  const bucketHeight = contentHeight / bucketCount;
  if (bucketHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(top / bucketHeight));
  const end = Math.min(bucketCount, Math.ceil(bottom / bucketHeight));
  return { start, end };
}

function startViewportTracking(paperId) {
  if (VIEWPORT_TRACKERS[paperId]) return;
  const tracker = {
    contentReady: false,
    bucketCount: 0,
    bucketExposedMs: null,
    regions: [],
    regionExposedMs: null,
    lastValidDominantRegion: null,
    rawLog: [],
    stopped: false,
    current: {
      region: 'Unrendered',
      top: 0,
      bottom: 0,
      contentHeight: 0,
      viewportHeight: 0,
      regions: [],
      startedAt: nowTs(),
      openedAt: nowTs(),
      accumulatedMs: 0,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus()
    },
    heartbeatHandle: null,
    listeners: null,
    resizeObserver: null
  };
  VIEWPORT_TRACKERS[paperId] = tracker;

  const onScroll = () => updateViewportSegment(paperId);
  const onResize = () => updateViewportSegment(paperId);
  const onVisibility = () => updateViewportSegment(paperId);
  const onFocus = () => updateViewportSegment(paperId);
  const onBlur = () => updateViewportSegment(paperId);

  const pane = document.getElementById('paperPane-' + paperId);
  if (pane) pane.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  tracker.listeners = { pane, onScroll, onResize, onVisibility, onFocus, onBlur };

  if (typeof ResizeObserver !== 'undefined' && pane) {
    tracker.resizeObserver = new ResizeObserver(() => updateViewportSegment(paperId));
    tracker.resizeObserver.observe(pane);
  }

  tracker.heartbeatHandle = setInterval(() => tickSegment(paperId), VIEWPORT_HEARTBEAT_MS);
}

function markPdfContentReady(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker || tracker.contentReady) return;
  const wrap = document.getElementById('pdfWrap-' + paperId);
  const contentHeight = wrap ? wrap.scrollHeight : 0;
  if (!contentHeight) return;
  tracker.bucketCount = numBucketsFor(contentHeight);
  tracker.bucketExposedMs = new Array(tracker.bucketCount).fill(0);
  tracker.contentReady = true;
  updateViewportSegment(paperId);
}

function tickSegment(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker) return;
  const seg = tracker.current;
  const now = nowTs();
  const elapsed = Math.max(0, now - seg.startedAt);
  seg.startedAt = now;
  seg.accumulatedMs += elapsed;

  if (!tracker.contentReady || !seg.visible || !seg.focused) return;
  const wrap = document.getElementById('pdfWrap-' + paperId);
  const contentHeight = wrap ? wrap.scrollHeight : 0;
  if (!contentHeight) return;
  const { start, end } = bucketIndexRange(seg.top, seg.bottom, contentHeight, tracker.bucketCount);
  for (let i = start; i < end; i += 1) tracker.bucketExposedMs[i] += elapsed;

  // Six-region proportional exposure crediting (legacy regionExposedMs accumulator):
  // each region accumulates this tick's elapsed ms multiplied by the
  // fraction of that region's own height which is currently visible, so a
  // viewport straddling the boundary of two regions (e.g. the bottom of one
  // page and the top of the next) credits both proportionally, per spec.
  const regions = seg.regions || tracker.regions;
  if (regions && regions.length && tracker.regionExposedMs && tracker.regionExposedMs.length === regions.length) {
    for (let i = 0; i < regions.length; i += 1) {
      const region = regions[i];
      const regionHeight = region.bottom - region.top;
      if (!(regionHeight > 0)) continue;
      const overlap = Math.max(0, Math.min(region.bottom, seg.bottom) - Math.max(region.top, seg.top));
      if (overlap <= 0) continue;
      tracker.regionExposedMs[i] += elapsed * (overlap / regionHeight);
    }
  }
}

function updateViewportSegment(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker || tracker.stopped) return;
  tickSegment(paperId);

  refreshRegionGeometry(paperId);
  const range = getPdfViewportRange(paperId);
  const region = tracker.contentReady ? computeDominantRegion(paperId, range) : 'Unrendered';
  const visible = document.visibilityState === 'visible';
  const focused = document.hasFocus();
  const seg = tracker.current;

  const sameRange =
    Math.abs(seg.top - (range ? range.visibleTop : 0)) < 1 &&
    Math.abs(seg.bottom - (range ? range.visibleBottom : 0)) < 1;
  if (seg.region === region && seg.visible === visible && seg.focused === focused && sameRange) {
    return;
  }

  closeSegment(paperId);
  openSegment(paperId, region, range, visible, focused);
}

// Raw segments are kept rich enough to be independently recomputed/audited
// (verification-only -- see DATA.viewport_raw_log -- never a primary export
// field): wall-clock start/end, the duration actually accumulated for this
// segment, the content/viewport dimensions and visible-range pixels used to
// classify its AOI, a normalized scroll position, and the visibility/focus
// state and AOI region itself.
function closeSegment(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker) return;
  const seg = tracker.current;
  const endTs = nowTs();
  const contentHeight = seg.contentHeight || 0;
  const viewportHeight = seg.viewportHeight || 0;
  const scrollRange = contentHeight - viewportHeight;
  const normalizedPosition = scrollRange > 0
    ? Math.max(0, Math.min(1, Number((seg.top / scrollRange).toFixed(4))))
    : null;
  tracker.rawLog.push({
    region: seg.region,
    start_ts: seg.openedAt,
    end_ts: endTs,
    duration_ms: Math.round(seg.accumulatedMs),
    content_height: Math.round(contentHeight),
    viewport_height: Math.round(viewportHeight),
    visible_top: Math.round(seg.top),
    visible_bottom: Math.round(seg.bottom),
    normalized_position: normalizedPosition,
    visible: seg.visible,
    focused: seg.focused
  });
}

// Implements the Lagun & Lalmas (2016) preprocessing step required before
// deriving a navigation sequence from raw, possibly-noisy dwell intervals:
//   1. (caller) rawLog is already an ordered list of {region, ms} visits.
//   2. Aggregate consecutive intervals that belong to the SAME AOI into one
//      continuous visit (sums their durations).
//   3. Drop any aggregated visit whose total continuous duration is under
//      MIN_DWELL_MS -- a region passed through too briefly to count as a
//      real "visit".
//   4. Re-collapse any AOIs that become adjacent duplicates as a result of
//      step 3 (e.g. Top, <1s Middle, Top -> after dropping Middle, the two
//      Top visits are now adjacent and must merge into a single Top).
// Returns a plain array of region names (already deduplicated/adjacent-
// collapsed), e.g. ['Top', 'Bottom']. Exported standalone so it can be
// exercised directly with synthetic intervals in tests.
function aggregateNavigationSequence(rawLog) {
  const merged = [];
  for (const seg of rawLog) {
    const last = merged[merged.length - 1];
    if (last && last.region === seg.region) {
      last.ms += seg.ms;
    } else {
      merged.push({ region: seg.region, ms: seg.ms });
    }
  }

  const longEnough = merged.filter((visit) => visit.ms >= MIN_DWELL_MS);

  const collapsed = [];
  for (const visit of longEnough) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== visit.region) {
      collapsed.push(visit.region);
    }
  }
  return collapsed;
}

// Drops raw segments that cannot represent genuine attention to a region:
// hidden-tab time (visible !== true), unfocused-window time (focused !==
// true), and Unrendered/Unclassified states (see NON_NAVIGABLE_REGIONS
// above). This runs BEFORE aggregateNavigationSequence(), so hidden/
// unfocused/indeterminate dwell time can never inflate paper_navigation_sequence
// or backward_transition_count -- matching the same visible/focused gating
// tickSegment() already applies to pdf_exposure_proportion_30s. Returns
// plain {region, ms} pairs, the input shape aggregateNavigationSequence()
// expects.
function filterNavigableSegments(rawLog) {
  return rawLog
    .filter((seg) => seg.visible === true && seg.focused === true && !NON_NAVIGABLE_REGIONS.has(seg.region))
    .map((seg) => ({ region: seg.region, ms: seg.duration_ms }));
}

// Counts forward/backward transitions across an already-aggregated,
// already-filtered sequence of six-region AOI names (see
// aggregateNavigationSequence above). Backward = a transition whose
// destination has a LOWER index than its source in the canonical
// SIX_REGION_INDEX reading order (P1-Top-Half = 0 ... P3-Bottom-Half = 5). Labels not
// present in SIX_REGION_INDEX (should not occur for the 3-page papers this
// study uses) are simply never counted as forward or backward, rather than
// throwing.
function countNavigationTransitions(sequence) {
  let transitions = 0;
  let backward = 0;
  for (let i = 1; i < sequence.length; i += 1) {
    transitions += 1;
    const prev = sequence[i - 1];
    const next = sequence[i];
    if (Object.prototype.hasOwnProperty.call(SIX_REGION_INDEX, prev) &&
      Object.prototype.hasOwnProperty.call(SIX_REGION_INDEX, next) &&
      SIX_REGION_INDEX[next] < SIX_REGION_INDEX[prev]) {
      backward += 1;
    }
  }
  return { transitions, backward };
}

function openSegment(paperId, region, range, visible, focused) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker) return;
  const now = nowTs();
  tracker.current = {
    region,
    top: range ? range.visibleTop : 0,
    bottom: range ? range.visibleBottom : 0,
    contentHeight: range ? range.contentHeight : 0,
    viewportHeight: range ? range.viewportHeight : 0,
    regions: tracker.regions,
    startedAt: now,
    openedAt: now,
    accumulatedMs: 0,
    visible,
    focused
  };
}

function stopViewportTracking(paperId) {
  const tracker = VIEWPORT_TRACKERS[paperId];
  if (!tracker || tracker.stopped) return;
  if (tracker.heartbeatHandle) clearInterval(tracker.heartbeatHandle);
  // Flush time elapsed since the last 1s heartbeat into the current segment
  // BEFORE closing it. Without this, a participant who leaves the paper
  // between heartbeat ticks loses that trailing partial interval entirely --
  // e.g. a 6-second dwell that ends 900ms after the last tick would credit
  // only up to the last tick, which can wrongly produce zero exposure for a
  // dwell that in fact crossed EXPOSURE_THRESHOLD_MS.
  tickSegment(paperId);
  closeSegment(paperId);
  tracker.stopped = true;

  if (tracker.listeners) {
    const { pane, onScroll, onResize, onVisibility, onFocus, onBlur } = tracker.listeners;
    if (pane) pane.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  }
  if (tracker.resizeObserver) tracker.resizeObserver.disconnect();

  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  const navigable = filterNavigableSegments(tracker.rawLog);
  const collapsed = aggregateNavigationSequence(navigable);
  const { backward } = countNavigationTransitions(collapsed);

  // pdf_exposure_proportion_30s: document-wide bucket proportion exposed for
  // strictly more than EXPOSURE_THRESHOLD_MS (30000 ms). Blank only when the
  // PDF/page never finished rendering (tracker.contentReady false or zero
  // buckets); a genuine measured 0 is preserved.
  let exposureProportion = '';
  if (tracker.contentReady && tracker.bucketExposedMs && tracker.bucketExposedMs.length) {
    // Strict ">" per spec ("viewport time longer than 30 seconds"): a bucket
    // exposed for exactly EXPOSURE_THRESHOLD_MS does not count.
    const exposedCount = tracker.bucketExposedMs.reduce(
      (count, ms) => count + (ms > EXPOSURE_THRESHOLD_MS ? 1 : 0),
      0
    );
    exposureProportion = Number((exposedCount / tracker.bucketExposedMs.length).toFixed(4));
  }

  // paper_navigation_sequence / backward_transition_count:
  // blank only when no valid region survived the visible/focused/min-dwell
  // preprocessing pipeline (collapsed.length === 0) -- a single retained
  // state with zero transitions is a genuine, measured "0", not a blank.
  DATA.timing[paperId].pdf_exposure_proportion_30s = exposureProportion;
  DATA.timing[paperId].region_exposed_30s_count = tracker.regionExposedMs
    ? tracker.regionExposedMs.reduce((n, ms) => n + (ms > EXPOSURE_THRESHOLD_MS ? 1 : 0), 0)
    : '';
  DATA.timing[paperId].paper_navigation_sequence = collapsed.length ? collapsed.join('>') : '';
  DATA.timing[paperId].backward_transition_count = collapsed.length ? backward : '';

  if (!DATA.viewport_raw_log) DATA.viewport_raw_log = {};
  DATA.viewport_raw_log[paperId] = tracker.rawLog;
}

// ---------- Component navigation tracking ----------
// Records the currently active component for a paper ('Paper', 'Questions',
// or 'AI') into DATA.component_log[paperId] for later collapse into
// component_navigation_sequence / component_transition_count at submit time.
// Consecutive duplicates are collapsed (only state changes are recorded).
function recordComponentState(paperId, component) {
  if (!DATA.component_log[paperId]) DATA.component_log[paperId] = [];
  const log = DATA.component_log[paperId];
  if (log.length && log[log.length - 1] === component) return; // no-op for no-change
  log.push(component);
}

// Collapses a component log into a '>'-separated sequence string and
// transition count, then writes them into DATA.timing[paperId].
// Called from commitComponentMeasures() at study-page completion.
function commitComponentMeasures(paperId) {
  if (!DATA.timing[paperId]) DATA.timing[paperId] = {};
  const log = DATA.component_log[paperId] || [];
  DATA.timing[paperId].component_navigation_sequence = log.join('>');
  DATA.timing[paperId].component_transition_count = log.length > 0 ? log.length - 1 : 0;
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
    recordComponentState(paperId, 'AI');
  } else if (tab === 'paper') {
    recordComponentState(paperId, 'Paper');
  } else if (tab === 'questions') {
    recordComponentState(paperId, 'Questions');
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
  DATA.ai_chats[paperId].push(userTurn); markAutosaveDirty(); saveProgressNow();
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

// ---------- Immediate validation for numerical responses ----------
function getNumberInputError(input) {
  const rawValue = String(input.value || '').trim();

  // Leave empty-field feedback to the normal required-response validation.
  if (rawValue === '') {
    return '';
  }

  if (input.validity.badInput) {
    return 'Please enter a valid number.';
  }

  if (input.validity.rangeUnderflow) {
    return `Please enter a value of at least ${input.min}.`;
  }

  if (input.validity.rangeOverflow) {
    return `Please enter a value no greater than ${input.max}.`;
  }

  if (input.validity.stepMismatch) {
    if (input.step === '0.5') {
      return 'Please enter a value rounded to the nearest half hour.';
    }

    if (input.step === '1') {
      return 'Please enter a whole number.';
    }

    return 'Please enter a valid value.';
  }

  return '';
}

function clearNumberInputError(input) {
  input.classList.remove('input-error');
  input.removeAttribute('aria-invalid');

  const existingHint = input.nextElementSibling;

  if (
    existingHint &&
    existingHint.classList.contains('number-error-hint')
  ) {
    existingHint.remove();
  }
}

function showNumberInputError(input, message) {
  input.classList.add('input-error');
  input.setAttribute('aria-invalid', 'true');

  let hint = input.nextElementSibling;

  if (
    !hint ||
    !hint.classList.contains('number-error-hint')
  ) {
    hint = document.createElement('div');
    hint.className = 'error-hint number-error-hint';
    hint.setAttribute('role', 'alert');
    hint.setAttribute('aria-live', 'polite');
    input.insertAdjacentElement('afterend', hint);
  }

  hint.textContent = message;
  hint.style.display = 'block';
}

function validateNumberInputImmediately(input) {
  const message = getNumberInputError(input);

  if (message) {
    showNumberInputError(input, message);
    return false;
  }

  clearNumberInputError(input);
  return true;
}

function initializeImmediateNumberValidation() {
  function isNumberInput(input) {
    return (
      input &&
      input.tagName === 'INPUT' &&
      input.type === 'number'
    );
  }

  function allowsDecimal(input) {
    return input.step === '0.5' || input.step === 'any';
  }

  function isPermittedNumberText(input, value) {
    if (value === '') return true;

    if (allowsDecimal(input)) {
      // Allows nonnegative whole numbers or decimals, such as 2, 2.5, or .5.
      return /^(?:\d+\.?\d*|\.\d*)$/.test(value);
    }

    // Integer-only fields.
    return /^\d+$/.test(value);
  }

  // Block characters that browsers may otherwise allow in number fields,
  // including exponent notation and signs.
  document.addEventListener('keydown', event => {
    const input = event.target;
    if (!isNumberInput(input)) return;

    const blockedKeys = ['e', 'E', '+', '-'];

    if (
      blockedKeys.includes(event.key) ||
      (event.key === '.' && !allowsDecimal(input))
    ) {
      event.preventDefault();
    }
  });

  // Validate pasted and inserted text before it enters the field.
  document.addEventListener('beforeinput', event => {
    const input = event.target;
    if (!isNumberInput(input)) return;

    // Deletions, undo, and similar editing operations should remain allowed.
    if (!event.inputType || !event.inputType.startsWith('insert')) return;

    const insertedText = event.data;

    // Paste is handled separately below because event.data can be null.
    if (insertedText == null) return;

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;

    const proposedValue =
      input.value.slice(0, start) +
      insertedText +
      input.value.slice(end);

    if (!isPermittedNumberText(input, proposedValue)) {
      event.preventDefault();
    }
  });

  // Reject invalid pasted content rather than allowing the browser to
  // partially interpret or silently clear it.
  document.addEventListener('paste', event => {
    const input = event.target;
    if (!isNumberInput(input)) return;

    const pastedText = event.clipboardData
      ? event.clipboardData.getData('text').trim()
      : '';

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;

    const proposedValue =
      input.value.slice(0, start) +
      pastedText +
      input.value.slice(end);

    if (!isPermittedNumberText(input, proposedValue)) {
      event.preventDefault();
      showNumberInputError(
        input,
        allowsDecimal(input)
          ? 'Please enter numbers only, rounded to the nearest half hour.'
          : 'Please enter whole numbers only.'
      );
    }
  });

  // Validate the completed response when the participant leaves the field.
  document.addEventListener(
    'blur',
    event => {
      const input = event.target;

      if (isNumberInput(input)) {
        validateNumberInputImmediately(input);
      }
    },
    true
  );

  // Remove an existing error as soon as the participant corrects the value.
  document.addEventListener('input', event => {
    const input = event.target;
    if (!isNumberInput(input)) return;

    const value = String(input.value || '').trim();

    if (
      value !== '' &&
      !isPermittedNumberText(input, value)
    ) {
      input.value = value.replace(
        allowsDecimal(input) ? /[^\d.]/g : /\D/g,
        ''
      );
    }

    if (input.classList.contains('input-error')) {
      const message = getNumberInputError(input);

      if (!message) {
        clearNumberInputError(input);
      }
    }
  });
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
    if (!DATA.logs[id]) DATA.logs[id] = { keystrokes: 0, pastes: 0, drafts: [], first_keystroke_ts: null };
    ta._revisionSnapshot = ta.value || '';
    ta.addEventListener('keydown', () => {
      DATA.logs[id].keystrokes++;
      // Capture ISO timestamp of the participant's first keystroke in this
      // textarea (first_keystroke_ts). Only set once; subsequent keydowns
      // are ignored for this field.
      if (!DATA.logs[id].first_keystroke_ts) {
        DATA.logs[id].first_keystroke_ts = nowIso();
      }
    });
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

  // Event delegation for Questions-component tracking. A single focusin or
  // click listener on each Questions-panel container covers all response
  // controls (textareas, conf-btn scale buttons, likert-btn scale buttons,
  // and any future controls) without needing per-element attachment or
  // re-attachment when controls are re-rendered. focusin is used instead of
  // focus because focusin bubbles; click covers pointer-driven selections.
  // Do NOT use mouseover/mouseenter — tracking must require deliberate input.
  document.querySelectorAll('[id^="questionsTab-"]').forEach(panel => {
    const pid = panel.id.replace('questionsTab-', '');
    panel.addEventListener('focusin', () => recordComponentState(pid, 'Questions'));
    panel.addEventListener('click', () => recordComponentState(pid, 'Questions'));
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

  // If the card holds exactly one logged textarea, that's an unambiguous
  // match. If it holds more than one (e.g. a "List 3..." card with three
  // separate item textareas under one shared heading), there is no single
  // correct field to attribute a heading-level copy event to, so we
  // deliberately return null rather than silently picking the first one.
  const textareas = card.querySelectorAll('textarea[data-logfield]');
  if (textareas.length === 1) return textareas[0].getAttribute('data-logfield');
  if (textareas.length > 1) return null;

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

  const pasteEvent = {
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
  };

  DATA.paste_events.push(pasteEvent);

  // Capture the answer state immediately after the browser applies the paste.
  // The exporter uses this snapshot to quantify how much the final answer
  // changed after the latest verified AI-to-answer paste.
  if (
    target.target_type === 'participant_answer' &&
    event.target instanceof HTMLTextAreaElement
  ) {
    const answerField = event.target;
    setTimeout(() => {
      pasteEvent.answer_value_after_paste = answerField.value;
      pasteEvent.answer_state_captured_at = nowIso();
    }, 0);
  }
});

async function endTaskPhaseAndExitFullscreen() {
  // Stop behavioral-violation monitoring before exiting fullscreen,
  // so this expected task-completion exit is not logged as a violation.
  inTaskPhase = false;
  currentStudyPaperId = null;

  hideFullscreenRequiredOverlay();

  if (document.fullscreenElement) {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;

    if (exit) {
      try {
        await exit.call(document);
      } catch (err) {
        console.warn(
          'Could not automatically exit fullscreen after the task:',
          err
        );
      }
    }
  }
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
// five questions about: <title>") so participants can tell which paper a
// question belongs to and when the quiz moves to the second paper. The
// transition page auto-advances after 3s (see showPage()/quizTransitionTimer)
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
// option orders"): for each paper, both the order the five quiz questions
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
      ? 'You will first answer five questions about:'
      : 'Next, you will answer five questions about:';
    html += `<div class="page quiz-transition-page" id="${transitionId}">
      <div class="quiz-transition-inner">
        <p class="quiz-transition-lead">${escapeHtml(transitionLead)}</p>
        <p class="quiz-transition-title">${escapeHtml(paperTitle)}</p>
      </div>
    </div>`;
    const questionOrder = shuffleArray(PAPERS[paperId].quiz.map((_, i) => i));
    DATA.quiz_question_orders[paperId] = questionOrder.slice();
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
      DATA.quiz_option_orders[name] = shuffledIdx.map(origIdx => letters[origIdx]);
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
  DATA.quiz_paper_scores = { font: null, food: null, listing: null };

  DATA.study_order.forEach(paperId => {
    let paperScore = 0;
    PAPERS[paperId].quiz.forEach((qObj, qi) => {
      total++;
      const name = 'quiz_' + paperId + '_' + qi;
      const chosen = document.querySelector(`input[name="${name}"]:checked`);
      const displayedLetter = chosen ? chosen.value : null;

      // Preserve scoring against the randomized displayed letter.
      const correctLetter = QUIZ_RUNTIME_CORRECT[name] || qObj.correct;

      if (displayedLetter === correctLetter) {
        score++;
        paperScore++;
      }

      // Convert the randomized displayed letter back to the stable original option.
      let selectedAnswerText = null;

      if (displayedLetter) {
        const displayedIndex = ['A', 'B', 'C', 'D'].indexOf(displayedLetter);
        const originalOptionLetter =
          DATA.quiz_option_orders[name] &&
          DATA.quiz_option_orders[name][displayedIndex];

        const originalOptionIndex =
          ['A', 'B', 'C', 'D'].indexOf(originalOptionLetter);

        if (originalOptionIndex >= 0) {
          selectedAnswerText = qObj.options[originalOptionIndex]
            .replace(/^[A-D]\.\s*/, '');
        }
      }

      // Keep the internal randomized-letter response if other code needs it.
      DATA.responses[name] = displayedLetter;

      // Save the analysis-ready stable answer content.
      DATA.responses[
        `quiz_${paperId}_q${qi + 1}_response`
      ] = selectedAnswerText;
    });
    DATA.quiz_paper_scores[paperId] = paperScore;
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
    unassigned_paper_ids: DATA.unassigned_paper_ids,
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
    'assigned_paper_1_id', 'paper_order',
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

  setSubmissionStatus(
    'loading',
    'Submitting your responses… Please do not close this page.'
  );

  if (btnNext) {
    btnNext.disabled = true;
    btnNext.textContent = 'Submitting…';
  }
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
    maybeRedirectToProlific();
  } catch (err) {
    console.error('[attemptSubmission] /api/submit-survey failed:', err);
    DATA.submission_status = 'failed';
    DATA.submission_error = (err && err.message) || 'unknown_error';
    setSubmissionStatus(
      'error',
      'We could not submit your responses. Please check your connection and try again.'
    );

    if (btnNext) {
      btnNext.disabled = false;
      btnNext.textContent = 'Retry submission';
    }
  } finally {
    submitInFlight = false;
  }
}

function retrySubmission() {
  if (submitInFlight) return;
  attemptSubmission();
}

// ---------- Prolific redirect (official survey only — never present in the
// pilot survey codebase) ----------
// Finalized values for the live Prolific study. PROLIFIC_COMPLETION_URL is
// derived from PROLIFIC_COMPLETION_CODE (not hand-duplicated) so the
// displayed code/link and the automatic redirect can never drift apart.
const PROLIFIC_COMPLETION_CODE = 'C1G769NX';
const PROLIFIC_COMPLETION_URL = 'https://app.prolific.com/submissions/complete?cc=' + PROLIFIC_COMPLETION_CODE;

// Called only from the success branch of attemptSubmission(), i.e. only
// after a confirmed server-side save — never on a failed/retrying attempt.
// Both conditions below must hold for a redirect to occur:
//   - DATA.assignment_id_source === 'prolific_id': only participants who
//     actually arrived with a real Prolific ID (excludes 'generated_fallback'
//     and 'test_mode' assignment sources).
//   - DATA.test_mode !== true: explicit second guard so a test-mode session
//     can never redirect even if assignment_id_source were ever misreported.
function maybeRedirectToProlific() {
  const isRealProlificParticipant =
    DATA.assignment_id_source === 'prolific_id' &&
    DATA.test_mode !== true;

  const isTestMode = DATA.test_mode === true;

  // Show the Prolific completion information for real participants and
  // during QA testing, but not for generated non-Prolific sessions.
  if (!isRealProlificParticipant && !isTestMode) return;

  const block = document.getElementById('prolificReturnBlock');
  const link = document.getElementById('prolificReturnLink');
  const codeEl = document.getElementById('prolificCompletionCode');
  const textEl = document.getElementById('prolificReturnText');

  if (link) link.href = PROLIFIC_COMPLETION_URL;
  if (codeEl) codeEl.textContent = PROLIFIC_COMPLETION_CODE;
  if (block) block.style.display = '';

  // Test sessions show the code and link, but never redirect automatically.
  if (isTestMode) {
    if (textEl) {
      textEl.textContent =
        'Test mode: automatic redirection is disabled. The production completion information is shown below for verification.';
    }
    return;
  }

  // Real Prolific participants are redirected after confirmed submission.
  setTimeout(() => {
    window.location.href = PROLIFIC_COMPLETION_URL;
  }, 1500);
}

// ---------- Autosave ----------
const AUTOSAVE_LOCAL_KEY = 'research_survey_autosave';
let autosaveDirty = false;
let autosaveInFlight = false;
let autosaveQueued = false;
let autosaveDebounceTimer = null;

function autosaveAllowed() {
  return DATA.consent === true && Boolean(DATA.assignment_cell) &&
    DATA.submission_status !== 'submitting' && DATA.submission_status !== 'confirmed';
}

function markAutosaveDirty() {
  if (!autosaveAllowed()) return;
  autosaveDirty = true;
  try { localStorage.setItem(AUTOSAVE_LOCAL_KEY, JSON.stringify(DATA)); } catch (e) { }
}

function scheduleAutosave(delayMs = 700) {
  markAutosaveDirty();
  clearTimeout(autosaveDebounceTimer);
  autosaveDebounceTimer = setTimeout(() => saveProgressNow(), delayMs);
}

async function saveProgressNow({ useBeacon = false } = {}) {
  if (!autosaveAllowed() || !autosaveDirty) return;
  collectFieldsNow();
  if (autosaveInFlight) { autosaveQueued = true; return; }
  autosaveInFlight = true;
  autosaveDirty = false;
  const payload = JSON.stringify(DATA);
  try {
    if (useBeacon && navigator.sendBeacon) {
      const accepted = navigator.sendBeacon('/api/save-progress', new Blob([payload], { type: 'application/json' }));
      if (!accepted) autosaveDirty = true;
    } else {
      const response = await fetch('/api/save-progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true
      });
      if (!response.ok) autosaveDirty = true;
    }
  } catch (e) {
    autosaveDirty = true; // silent to participants
  } finally {
    autosaveInFlight = false;
    if (autosaveQueued || autosaveDirty) {
      autosaveQueued = false;
      setTimeout(() => saveProgressNow(), 0);
    }
  }
}

function installAutosaveTriggers() {
  document.addEventListener('input', (event) => {
    if (event.target.matches('textarea, input[type="text"], input[type="number"]')) markAutosaveDirty();
  }, true);
  document.addEventListener('focusout', (event) => {
    if (event.target.matches('textarea, input[type="text"], input[type="number"]')) saveProgressNow();
  }, true);
  document.addEventListener('change', (event) => {
    if (event.target.matches('input[type="radio"], input[type="checkbox"], input[type="range"], select')) scheduleAutosave();
  }, true);
  window.addEventListener('pagehide', () => saveProgressNow({ useBeacon: true }));
}

setInterval(() => { if (autosaveDirty) saveProgressNow(); }, 30000);

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  // Turn on immediate feedback for all number inputs, including the
  // dynamically created PhD-year field.
  initializeImmediateNumberValidation();
  initializeResponseWordValidation();

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

  installAutosaveTriggers();
  initConsentPage();
  renderEstimatedDurationAndAlertnessNote();

  // Populate the About You, SRL, CT, AI-routing, and AI-experience controls.
  renderAllSections();

  pageOrder = ['page-consent'];
  currentIdx = 0;
  showPage('page-consent');
  updateNav();


  const params = new URLSearchParams(window.location.search);

  if (params.get('admin') === '1') {
    openAdminOverlay();
  }
});
