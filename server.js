// server.js — Express backend for the researcher AI survey.
// Holds the OpenAI API key as a server-side environment variable ONLY.
// The frontend never sees the key; it calls /api/chat on this server,
// and this server calls the OpenAI API.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore');
const { cleanRecord, buildAccumulatedCsv } = require('./lib/export-csv');

const app = express();
const PORT = process.env.PORT || 3000;

// Strip zero-width/invisible characters before using a secret pulled from an
// env var. Pasted keys can pick up a stray zero-width space, BOM, or
// non-breaking space that plain .trim() does NOT remove, which then breaks
// request header construction (ByteString conversion) at request time.
var INVISIBLE_CHARS_RE = new RegExp('[\\u200B\\u200C\\u200D\\uFEFF\\u00A0]', 'g');
function sanitizeSecret(raw) {
  if (!raw) return '';
  return raw.replace(INVISIBLE_CHARS_RE, '').trim();
}

const OPENAI_API_KEY = sanitizeSecret(process.env.OPENAI_API_KEY);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // e.g. https://your-survey.onrender.com

// Render (and most PaaS hosts) sit behind a reverse proxy; trust the first
// hop so express-rate-limit can read X-Forwarded-For correctly.
app.set('trust proxy', 1);

if (!OPENAI_API_KEY) {
  console.error('[startup] WARNING: OPENAI_API_KEY is not set. /api/chat will return an error to participants until it is configured.');
}

// ---------- Google Cloud clients (Storage + Firestore) ----------
// Authentication is Application Default Credentials ONLY: locally this is
// whatever `gcloud auth application-default login` set up; in Cloud Run this
// is the runtime service account automatically supplied by the platform. No
// service-account JSON key is read, created, or referenced anywhere in this
// file, and no credential ever appears in frontend code.
//
// USE_LOCAL_SUBMISSION_FILE=true is a DEV-ONLY escape hatch that restores the
// old append-only data/submissions.jsonl behavior (no GCS, no bucket needed)
// for running the survey on a laptop with no GCP project configured at all.
// The production default (this flag unset/false) requires GCS_SUBMISSIONS_BUCKET
// and will refuse to silently fall back to the local filesystem if it's
// missing — see /api/submit-survey below.
const USE_LOCAL_SUBMISSION_FILE = String(process.env.USE_LOCAL_SUBMISSION_FILE || '').toLowerCase() === 'true';
const GCS_SUBMISSIONS_BUCKET = process.env.GCS_SUBMISSIONS_BUCKET || null;

if (!USE_LOCAL_SUBMISSION_FILE && !GCS_SUBMISSIONS_BUCKET) {
  console.error('[startup] WARNING: GCS_SUBMISSIONS_BUCKET is not set and USE_LOCAL_SUBMISSION_FILE is not "true". /api/submit-survey will return an error to participants until one of these is configured.');
}

// ===================== TEST MODE (DEV/QA ONLY — NOT PART OF NORMAL PARTICIPANT FLOW) =====================
// Lets a developer/tester force a specific assignment cell + paper order via
// URL params (?test=1&cell=...&papers=...), to exercise each experimental
// condition deterministically and inspect exactly what data gets captured.
//
// SECURITY: this is gated SOLELY by this server-side env var. A URL param
// alone (test=1) can NEVER activate test mode — every test-only endpoint
// below re-checks ENABLE_TEST_MODE itself, and the frontend independently
// confirms server-side enablement (GET /api/test-mode-status) before it will
// ever treat a session as a test session. Disabled (false/unset) by default;
// set ENABLE_TEST_MODE=false (or leave unset) before real recruitment.
const ENABLE_TEST_MODE = String(process.env.ENABLE_TEST_MODE || '').toLowerCase() === 'true';
if (ENABLE_TEST_MODE) {
  console.warn('[startup] ENABLE_TEST_MODE=true — test-mode endpoints are ACTIVE. Do not use this setting in a real-recruitment deployment.');
}

// Only constructed when actually needed, so a dev running with
// USE_LOCAL_SUBMISSION_FILE=true and no GCP credentials at all never touches
// the Storage SDK.
const storage = USE_LOCAL_SUBMISSION_FILE ? null : new Storage();

// Firestore-backed assignment balancing (see the assignment section below)
// is used in every environment, including local dev — there is no in-memory
// or file-based substitute for it, per the requirement that balancing must
// be exact and transactionally safe under concurrent participants. Local
// development authenticates to the real Firestore database via the same ADC
// mechanism (see DEPLOYMENT.md for the exact `gcloud auth application-default
// login` step).
//
// Constructed LAZILY (on first actual use) rather than at module load. The
// Firestore client constructor can block for a long time trying to discover
// Application Default Credentials when none are configured and there is no
// reachable metadata server (e.g. a CI box or this app's own HTTP-level
// tests). Routes that don't touch Firestore-backed assignment — admin
// export, static assets, health checks, etc. — must be able to boot the
// server without ever paying that cost. Production behavior is unchanged:
// any request that actually needs Firestore still constructs and uses a
// real client exactly as before, on first use.
let firestoreClient = null;
function getFirestore() {
  if (!firestoreClient) {
    firestoreClient = new Firestore();
  }
  return firestoreClient;
}

// ---------- Security middleware ----------
// Raised from 256kb: requests may now include downscaled JPEG page images
// (see MAX_VISION_IMAGES / MAX_IMAGE_DATA_URL_LEN below) so the assistant can
// see figures/tables, not just extracted text. Still well under typical
// reverse-proxy/body-size defaults.
app.use(express.json({ limit: '12mb' }));

const corsOptions = ALLOWED_ORIGIN
  ? { origin: ALLOWED_ORIGIN }
  : { origin: true }; // falls back to permissive during local development only
app.use(cors(corsOptions));

// NOTE: there is intentionally no global/per-IP rate limiter on /api/chat.
// Participants may be sharing a network (lab, office, campus Wi-Fi), so a
// per-IP cap would throttle one participant's usage based on another's
// activity. The only request limit enforced is the per-paper, per-participant
// 5-message cap below, which is derived from each request's own
// conversation_history and so cannot be affected by other participants.

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// Serve the survey as the root page (the HTML file isn't named index.html,
// so express.static won't pick it up automatically at "/").
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'researcher_ai_survey.html'));
});

// ---------- Input limits ----------
const MAX_USER_MESSAGE_LEN = 4000;
const MAX_STUDY_TEXT_LEN = 60000;
const MAX_HISTORY_TURNS = 40;
const MAX_HISTORY_MSG_LEN = 4000;
const MAX_VISION_IMAGES = 8; // matches MAX_AI_VISION_PAGES in the frontend
const MAX_USER_TURNS_PER_PAPER = 5; // matches MAX_AI_MESSAGES_PER_PAPER in the frontend
const MAX_IMAGE_DATA_URL_LEN = 1500000; // ~1.5MB per data URL, generous for a downscaled JPEG

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidImageDataUrl(v) {
  return typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_IMAGE_DATA_URL_LEN &&
    /^data:image\/(jpeg|jpg|png);base64,/.test(v);
}

// ---------- POST /api/chat ----------
app.post('/api/chat', async (req, res) => {
  try {
    const {
      participant_id,
      condition,
      paper_id,
      study_title,
      study_text,
      study_images,
      user_message,
      conversation_history
    } = req.body || {};

    // Validate required fields
    if (!isNonEmptyString(participant_id) || !isNonEmptyString(condition) ||
      !isNonEmptyString(paper_id) || !isNonEmptyString(study_title) ||
      !isNonEmptyString(user_message)) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (typeof study_text !== 'string') {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!Array.isArray(conversation_history)) {
      return res.status(400).json({ error: 'Invalid conversation history.' });
    }

    // study_images is optional (older clients / failed PDF renders won't send
    // it); when present it must be a small array of well-formed JPEG/PNG
    // data URLs — these came from the participant's own browser canvas, not
    // a trusted source, so validate shape/size before ever forwarding them.
    let images = [];
    if (study_images !== undefined) {
      if (!Array.isArray(study_images) || study_images.length > MAX_VISION_IMAGES) {
        return res.status(400).json({ error: 'Invalid study images.' });
      }
      if (!study_images.every(isValidImageDataUrl)) {
        return res.status(400).json({ error: 'Invalid study images.' });
      }
      images = study_images;
    }

    // Size limits
    if (user_message.length > MAX_USER_MESSAGE_LEN) {
      return res.status(400).json({ error: 'Message is too long.' });
    }
    if (study_text.length > MAX_STUDY_TEXT_LEN) {
      return res.status(400).json({ error: 'Study context is too long.' });
    }
    if (conversation_history.length > MAX_HISTORY_TURNS) {
      return res.status(400).json({ error: 'Conversation history is too long.' });
    }
    // Defense-in-depth for the spec's 5-message-per-paper cap: the frontend
    // already disables the input/button once the cap is reached, but a
    // participant could in principle replay a request, so re-derive the
    // count server-side from the conversation history rather than trusting
    // a client-supplied counter.
    const priorUserTurns = conversation_history.filter(t => t && t.role === 'user').length;
    if (priorUserTurns >= MAX_USER_TURNS_PER_PAPER) {
      return res.status(429).json({ error: 'Message limit reached for this paper.' });
    }
    for (const turn of conversation_history) {
      if (!turn || typeof turn.content !== 'string' || turn.content.length > MAX_HISTORY_MSG_LEN) {
        return res.status(400).json({ error: 'Invalid conversation history.' });
      }
    }

    if (!OPENAI_API_KEY) {
      console.error('[api/chat] OPENAI_API_KEY missing — cannot fulfill request.');
      return res.status(500).json({ error: 'The AI assistant is temporarily unavailable. Please try again later.' });
    }

    const systemPrompt =
      'You are a helpful assistant supporting a user who is evaluating a research study. ' +
      'The full text of the study is provided in this conversation, and for the current question you may also ' +
      'be shown images of the study\'s pages so you can read figures, tables, and other visual elements directly. ' +
      'Answer the user\'s question using only the supplied study (text and/or images) and sound general reasoning; ' +
      'if the study does not contain enough information to answer, say so rather than speculating. ' +
      'The supplied text may not fully capture figures, tables, or other visual elements of the study; if no page ' +
      'images were provided and a question depends on such content, say so explicitly rather than guessing. ' +
      'Do not reference studies outside this task. ' +
      'Keep each response under about 200 words and make sure it is complete and self-contained within that limit. ' +
      'Format responses for easy reading in a narrow chat panel. Use short paragraphs or a brief numbered list when discussing multiple points. ' +
      'Avoid large headings. Do not place several numbered points in one paragraph. ' +
      'If needed, narrow the scope of your answer rather than running long. ' +
      'Do not provide content that would facilitate harm or illegal activity; if a request cannot be answered safely, briefly note why.\n\n' +
      'Study title: ' + study_title + '\n\n' +
      'Study text:\n' + study_text;

    const messages = [{ role: 'system', content: systemPrompt }];
    conversation_history.forEach(turn => {
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: String(turn.content) });
    });

    // Attach page images (if any) to this turn's user message only — they're
    // sent fresh on every request since Chat Completions has no server-side
    // session state, but only the current message needs them; the
    // conversation_history above stays text-only.
    if (images.length > 0) {
      const content = [{ type: 'text', text: user_message }];
      images.forEach(dataUrl => {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: user_message });
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 800,
        temperature: 0.7
      })
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text().catch(() => '');
      console.error('[api/chat] OpenAI API error', openaiResponse.status, errText);
      return res.status(502).json({ error: 'The AI assistant could not respond right now. Please try again.' });
    }

    const data = await openaiResponse.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      console.error('[api/chat] OpenAI response missing content', JSON.stringify(data));
      return res.status(502).json({ error: 'The AI assistant could not respond right now. Please try again.' });
    }

    // Server-side log (participant_id, paper_id, condition, turn count) — no API key, no provider error details to client.
    console.log('[api/chat]', { participant_id, condition, paper_id, turn: conversation_history.length + 1 });

    return res.json({ reply });
  } catch (err) {
    console.error('[api/chat] Unexpected error', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Stratified condition/CT-placement + paper-order assignment ----------
// Exact-balance, Firestore-transaction-backed server-side assignment.
// Within each expertise stratum, this keeps the four AI x CT-placement cells
// (AI_pre, AI_post, noAI_pre, noAI_post) and the six ordered two-of-three
// paper combinations as evenly filled as possible: every new assignment goes
// to whichever cell (and, independently, whichever paper combo) currently
// has the LOWEST count in that stratum, with ties broken at random. Counts
// live in Firestore (assignment_counters/{stratum}) and are read+incremented
// inside the same transaction as the assignment write, so two participants
// arriving at the same instant cannot both be assigned based on the same
// stale counts — Firestore detects the read/write conflict and retries one
// of the transactions automatically.
//
// A participant's assignment is permanent: the result is stored at
// assignments/{hashedParticipantId}, keyed by a one-way SHA-256 hash of their
// normalized stable id (Prolific ID, or local fallback UUID) — never the raw
// id. A repeated request for the same hashed id (refresh, reopening the
// survey, a different browser/device with the same Prolific ID) returns the
// EXISTING stored assignment as-is and does not touch the counters again.
// If the request also includes a different research_role than what was
// originally stored, the original is kept — this is now an authoritative,
// cross-device guarantee (not just the same-browser localStorage guard the
// frontend also keeps as a fast-path).
//
// Research-expertise stratum is derived here from the exact role string,
// not trusted from the client, and must match ROLE_OPTIONS in
// researcher_ai_survey.js exactly.
//
// Per mentor (Eunice Yiu) comments on the spec doc, "PhD student" is now a
// single option (no longer split into per-year radio options) with a
// free-typed number of years collected separately; its stratum must be
// derived from that number (1 year = lower, 2+ years = higher) rather than
// looked up by label here — see deriveExpertiseStratum() below.
const ROLE_TIER_MAP = {
  'Undergraduate research assistant': 'lower',
  'Post-baccalaureate research assistant or lab manager': 'lower',
  "Master's student": 'lower',
  'Postdoctoral scholar': 'higher'
};

// Returns the expertise stratum ('lower' | 'higher') for a given role, or
// null if the role/years combination is invalid or unrecognized. PhD
// student is the only role whose stratum depends on a second value
// (years in the program); every other role maps directly via
// ROLE_TIER_MAP.
function deriveExpertiseStratum(research_role, research_role_years) {
  if (research_role === 'PhD student') {
    const years = Number(research_role_years);
    if (!Number.isFinite(years) || years < 1) return null;
    return years <= 1 ? 'lower' : 'higher';
  }
  return ROLE_TIER_MAP[research_role] || null;
}

// The four cells within each stratum. Index in this array is what hashed
// values are mapped onto via modulo — order matters for reproducibility,
// but is otherwise arbitrary.
const ASSIGNMENT_CELLS = [
  { ai_condition: 'AI', ct_placement: 'pre', cell: 'AI_pre' },
  { ai_condition: 'AI', ct_placement: 'post', cell: 'AI_post' },
  { ai_condition: 'noAI', ct_placement: 'pre', cell: 'noAI_pre' },
  { ai_condition: 'noAI', ct_placement: 'post', cell: 'noAI_post' }
];

// The 3-paper pool, and every way to pick an ordered pair of 2 from it
// (3 choices of which paper to drop x 2 orderings of the remaining two = 6).
// Kept in sync with PAPER_IDS / PAPERS in researcher_ai_survey.js.
const PAPER_COMBOS = [
  { order: ['font', 'food'], unassigned: 'listing' },
  { order: ['food', 'font'], unassigned: 'listing' },
  { order: ['font', 'listing'], unassigned: 'food' },
  { order: ['listing', 'font'], unassigned: 'food' },
  { order: ['food', 'listing'], unassigned: 'font' },
  { order: ['listing', 'food'], unassigned: 'font' }
];

// Bumped from v1 (the old deterministic-hash scheme) to v2 because the
// METHOD changed (hash-modulo -> exact Firestore-balanced counters) — not
// because the cells/combos themselves changed. Per the existing
// versioning convention, this is just a record of which logic produced a
// given assignment; it does not by itself reassign anyone.
const ASSIGNMENT_VERSION = 'v2_firestore_balanced';
const PAPER_ORDER_VERSION = 'v2_firestore_balanced';
const ASSIGNMENT_SOURCE = 'firestore_balanced_transaction';

// Canonical normalization for whatever identifier is being hashed (Prolific
// ID or fallback UUID): trim whitespace and lowercase, so "ABC123", "abc123",
// and " abc123 " all hash identically. This is the server's responsibility —
// it must not depend on the client having normalized consistently, since the
// server is the only source of truth for the actual assignment.
function normalizeStableId(raw) {
  return String(raw).trim().toLowerCase();
}

// One-way digest of the normalized stable id. This is BOTH the Firestore
// assignments/{id} document id AND what gets stored/exported in participant
// data as stable_assignment_id_hash — never the raw Prolific ID/UUID.
// DATA.prolific_id (entered by the participant) remains the sole plaintext
// copy on the frontend; Firestore never receives the raw id at all.
function hashStableId(normalizedId) {
  return crypto.createHash('sha256').update(normalizedId).digest('hex');
}

const ASSIGNMENTS_COLLECTION = 'assignments';
const ASSIGNMENT_COUNTERS_COLLECTION = 'assignment_counters';

// Returns the index (into `counts`) of the lowest value, breaking ties
// uniformly at random across all indices tied for lowest. crypto.randomInt
// is used rather than Math.random() for a better-quality, non-deterministic
// tie-break (callers cannot predict or influence which tied cell/combo a
// given request will land in).
function pickLeastFilledIndex(counts) {
  const min = Math.min(...counts);
  const tiedIndices = [];
  counts.forEach((c, i) => { if (c === min) tiedIndices.push(i); });
  return tiedIndices[crypto.randomInt(tiedIndices.length)];
}

app.post('/api/assign-condition', async (req, res) => {
  try {
    const rawStableId = req.body && req.body.stable_participant_id;
    const research_role = req.body && req.body.research_role;
    const research_role_years = req.body && req.body.research_role_years;

    if (!isNonEmptyString(rawStableId) || rawStableId.length > 200) {
      return res.status(400).json({ error: 'Invalid stable_participant_id.' });
    }
    const stable_participant_id = normalizeStableId(rawStableId);
    if (!stable_participant_id) {
      return res.status(400).json({ error: 'Invalid stable_participant_id.' });
    }
    // Expertise stratum is derived here entirely server-side (role string,
    // plus years-in-program for PhD student) — the client never sends a
    // stratum, and nothing here trusts one even if it did.
    const expertise_stratum = deriveExpertiseStratum(research_role, research_role_years);
    if (!expertise_stratum) {
      return res.status(400).json({ error: 'Invalid or unrecognized research_role (or missing/invalid research_role_years for PhD student).' });
    }

    const hashed_participant_id = hashStableId(stable_participant_id);
    const assignmentRef = getFirestore().collection(ASSIGNMENTS_COLLECTION).doc(hashed_participant_id);
    const counterRef = getFirestore().collection(ASSIGNMENT_COUNTERS_COLLECTION).doc(expertise_stratum);

    const assignment = await getFirestore().runTransaction(async (t) => {
      // Both reads happen before any write, as Firestore transactions
      // require — this is what lets Firestore detect a concurrent
      // conflicting transaction and retry one of them automatically.
      const [assignmentSnap, counterSnap] = await Promise.all([t.get(assignmentRef), t.get(counterRef)]);

      if (assignmentSnap.exists) {
        // Idempotent: already-assigned participants (refresh, reopening the
        // survey, a different browser with the same Prolific ID, or a role
        // resubmitted differently than originally) always get back the
        // ORIGINAL stored assignment untouched. Counters are not incremented
        // again on this path.
        return assignmentSnap.data();
      }

      const counterData = counterSnap.exists ? counterSnap.data() : null;
      const cellCounts = ASSIGNMENT_CELLS.map(c => (counterData && counterData.cell_counts && counterData.cell_counts[c.cell]) || 0);
      const comboCounts = PAPER_COMBOS.map((c, i) => (counterData && counterData.paper_combo_counts && counterData.paper_combo_counts['combo_' + i]) || 0);

      // The two balancing tasks are independent of each other, per spec:
      // pick the least-filled cell, and SEPARATELY pick the least-filled
      // paper combo, within this stratum.
      const chosenCell = ASSIGNMENT_CELLS[pickLeastFilledIndex(cellCounts)];
      const chosenComboIdx = pickLeastFilledIndex(comboCounts);
      const chosenCombo = PAPER_COMBOS[chosenComboIdx];

      const newCellCounts = Object.assign({}, counterData && counterData.cell_counts);
      newCellCounts[chosenCell.cell] = (newCellCounts[chosenCell.cell] || 0) + 1;
      const newComboCounts = Object.assign({}, counterData && counterData.paper_combo_counts);
      newComboCounts['combo_' + chosenComboIdx] = (newComboCounts['combo_' + chosenComboIdx] || 0) + 1;

      const assignedAt = new Date().toISOString();
      const assignmentDoc = {
        hashed_participant_id,
        research_role,
        research_role_years: (research_role === 'PhD student') ? Number(research_role_years) : null,
        research_expertise_stratum: expertise_stratum,
        ai_condition: chosenCell.ai_condition,
        critical_thinking_placement: chosenCell.ct_placement,
        assignment_cell: chosenCell.cell,
        paper_ids: chosenCombo.order,
        paper_order: chosenCombo.order,
        unassigned_paper_id: chosenCombo.unassigned,
        assigned_at: assignedAt,
        assignment_source: ASSIGNMENT_SOURCE,
        assignment_version: ASSIGNMENT_VERSION,
        paper_order_version: PAPER_ORDER_VERSION,
        // Kept conceptually and physically separate from assignment_counters
        // (which only ever counts ASSIGNMENTS): this field is set to
        // 'completed' later by /api/submit-survey, and is never read or
        // written by the balancing logic above.
        completion_status: 'assigned',
        completed_at: null
      };

      t.set(counterRef, {
        stratum: expertise_stratum,
        cell_counts: newCellCounts,
        paper_combo_counts: newComboCounts,
        updated_at: assignedAt
      }, { merge: true });
      t.set(assignmentRef, assignmentDoc);

      return assignmentDoc;
    });

    return res.json({
      stable_assignment_id_hash: hashed_participant_id,
      research_role: assignment.research_role,
      research_role_years: assignment.research_role_years,
      research_expertise_stratum: assignment.research_expertise_stratum,
      ai_condition: assignment.ai_condition,
      critical_thinking_placement: assignment.critical_thinking_placement,
      assignment_cell: assignment.assignment_cell,
      assigned_at: assignment.assigned_at,
      assignment_source: assignment.assignment_source,
      assignment_version: assignment.assignment_version,
      paper_order_version: assignment.paper_order_version,
      paper_order: assignment.paper_order,
      unassigned_paper_id: assignment.unassigned_paper_id
    });
  } catch (err) {
    console.error('[api/assign-condition] Unexpected error', err);
    return res.status(500).json({ error: 'Could not assign condition. Please retry.' });
  }
});

// ===================== TEST MODE (DEV/QA ONLY) =====================
// Whitelists for the test-mode override params. Deliberately re-derived from
// the same authoritative arrays used by real assignment (ASSIGNMENT_CELLS,
// PAPER_COMBOS) rather than hand-duplicated, so the two can never drift out
// of sync with each other.
const TEST_VALID_CELLS = ASSIGNMENT_CELLS.map(c => c.cell); // ['AI_pre','AI_post','noAI_pre','noAI_post']
const TEST_VALID_PAPER_IDS = Array.from(new Set(PAPER_COMBOS.flatMap(c => c.order))); // ['font','food','listing']

// Exposes ONLY a boolean. Never exposes the value of any other env var or
// secret — this is the sole piece of server state the frontend is allowed to
// learn about test mode before a session can ever be flagged as a test run.
app.get('/api/test-mode-status', (req, res) => {
  res.json({ enabled: ENABLE_TEST_MODE });
});

// TEST-ONLY assignment endpoint. Computes a forced cell + paper order
// in-memory and returns it in the same shape as /api/assign-condition, but:
//   - never reads or writes ASSIGNMENT_COUNTERS_COLLECTION (no balancing
//     counters are touched, so test runs cannot skew real study balance);
//   - never reads or writes ASSIGNMENTS_COLLECTION (no permanent Firestore
//     assignment record is created for a test run);
//   - only accepts `cell` from TEST_VALID_CELLS and `papers` (optional) as
//     exactly two distinct values from TEST_VALID_PAPER_IDS — any other
//     input is rejected with a clear 400 error rather than silently falling
//     back to a default/unintended condition.
app.post('/api/test-assign-condition', (req, res) => {
  if (!ENABLE_TEST_MODE) {
    return res.status(403).json({ error: 'Test mode is disabled on this server (ENABLE_TEST_MODE is not "true").' });
  }

  const cell = req.body && req.body.cell;
  const chosenCell = ASSIGNMENT_CELLS.find(c => c.cell === cell);
  if (!chosenCell) {
    return res.status(400).json({ error: 'Invalid or missing test cell. Must be exactly one of: ' + TEST_VALID_CELLS.join(', ') });
  }

  let order, unassigned;
  const papersOverride = req.body && req.body.papers;
  if (papersOverride !== undefined && papersOverride !== null) {
    const valid =
      Array.isArray(papersOverride) &&
      papersOverride.length === 2 &&
      papersOverride[0] !== papersOverride[1] &&
      papersOverride.every(p => TEST_VALID_PAPER_IDS.includes(p));
    if (!valid) {
      return res.status(400).json({ error: 'Invalid test papers override. Must be exactly two distinct values from: ' + TEST_VALID_PAPER_IDS.join(', ') });
    }
    order = [papersOverride[0], papersOverride[1]];
    unassigned = TEST_VALID_PAPER_IDS.find(p => !order.includes(p));
  } else {
    // No override supplied: a fixed, reproducible default pair (no
    // randomness, no Firestore lookup involved).
    order = PAPER_COMBOS[0].order;
    unassigned = PAPER_COMBOS[0].unassigned;
  }

  const research_role = (req.body && typeof req.body.research_role === 'string') ? req.body.research_role : null;
  const research_role_years = req.body && req.body.research_role_years;
  const research_expertise_stratum = deriveExpertiseStratum(research_role, research_role_years);

  // Synthetic id: a SHA-256-shaped string (so it satisfies isSha256Hex(), the
  // same format real assignments use) but derived purely from random bytes —
  // it is never looked up against, or written into, any real Firestore
  // collection, and is only ever used to name the throwaway test-submission
  // file below.
  const syntheticHash = crypto.createHash('sha256')
    .update('TEST_MODE::' + crypto.randomBytes(16).toString('hex'))
    .digest('hex');

  return res.json({
    stable_assignment_id_hash: syntheticHash,
    research_role,
    research_role_years: (research_role === 'PhD student' && Number.isFinite(Number(research_role_years))) ? Number(research_role_years) : null,
    research_expertise_stratum,
    ai_condition: chosenCell.ai_condition,
    critical_thinking_placement: chosenCell.ct_placement,
    assignment_cell: chosenCell.cell,
    assigned_at: new Date().toISOString(),
    assignment_source: 'test_mode_override',
    assignment_version: ASSIGNMENT_VERSION,
    paper_order_version: PAPER_ORDER_VERSION,
    paper_order: order,
    unassigned_paper_id: unassigned
  });
});

// ---------- Submission persistence ----------
// Production default: one JSON object per participant, written to Cloud
// Storage at submissions/YYYY-MM-DD/<hashed-participant-id>.json, using a
// GCS creation precondition (ifGenerationMatch: 0) so an existing
// participant's file can never be silently overwritten — a second write
// attempt for the same hash gets an HTTP 412 from GCS, which is treated as
// "already saved" rather than an error. Success is returned to the
// participant ONLY after the GCS write itself has completed; any storage
// failure is returned as an error rather than silently falling back to the
// Cloud Run container's local (ephemeral, non-durable) filesystem.
//
// USE_LOCAL_SUBMISSION_FILE=true is the ONLY way to get the old append-only
// data/submissions.jsonl behavior back, for local development without a GCP
// project configured at all. This must never be the default in production.
//
// SUBMISSION_DATA_DIR is an optional override of where that local file lives,
// used ONLY by the HTTP-level test suite so it can read/write throwaway
// submissions.jsonl / test-submissions.jsonl files in a temp directory
// instead of touching this repo's real local data/ files. Unset in normal
// (dev or production) use, so the default path below is unchanged.
const DATA_DIR = process.env.SUBMISSION_DATA_DIR
  ? path.resolve(process.env.SUBMISSION_DATA_DIR)
  : path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.jsonl');
const MAX_SUBMISSION_BODY_LEN = 5_000_000; // ~5MB, generous for a full participant record incl. AI transcripts

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* already exists */ }
}

function isSha256Hex(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

// UTC calendar date for the submissions/YYYY-MM-DD/ path prefix. This is the
// date the submission was RECEIVED, not the date the participant was
// originally assigned a condition (those can differ if someone starts the
// survey one day and finishes the next).
function todayDateStringUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Writes the full submitted DATA object as its own JSON file, named with the
// same SHA-256 hash already used as the Firestore assignments/{hash} doc id
// (stable_assignment_id_hash) — never the raw Prolific ID. The
// ifGenerationMatch: 0 precondition means this call only succeeds if no
// object already lives at this exact path; a 412 means someone already
// submitted under this hash today, which we treat as already-saved rather
// than re-throwing, since the participant's data is in fact already durably
// stored.
async function saveSubmissionToGcs(body, hashedId) {
  const objectPath = `submissions/${todayDateStringUTC()}/${hashedId}.json`;
  const file = storage.bucket(GCS_SUBMISSIONS_BUCKET).file(objectPath);
  try {
    await file.save(Buffer.from(JSON.stringify(body), 'utf8'), {
      resumable: false,
      contentType: 'application/json',
      preconditionOpts: { ifGenerationMatch: 0 }
    });
    return { objectPath, alreadyExisted: false };
  } catch (err) {
    if (err && Number(err.code) === 412) {
      console.warn('[api/submit-survey] Submission object already exists (treating as already saved):', objectPath);
      return { objectPath, alreadyExisted: true };
    }
    throw err;
  }
}

function saveSubmissionLocally(body) {
  ensureDataDir();
  fs.appendFileSync(SUBMISSIONS_FILE, JSON.stringify(body) + '\n', 'utf8');
}

// Marks the existing assignments/{hash} document completed. This is
// deliberately best-effort and non-fatal: the participant's actual survey
// data has already been durably written to GCS (or the local file) by the
// time this runs, so a Firestore hiccup here must not turn into an error
// shown to the participant or a lost submission. Assignment COUNTS
// (assignment_counters/{stratum}) are never touched here — only this status
// flag on the individual assignment document — keeping "how many were
// assigned" and "how many completed" tracked completely separately.
async function markAssignmentCompleted(hashedId) {
  if (!isSha256Hex(hashedId)) return;
  try {
    await getFirestore().collection(ASSIGNMENTS_COLLECTION).doc(hashedId).set({
      completion_status: 'completed',
      completed_at: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.error('[api/submit-survey] Failed to mark assignment completed (non-fatal):', err);
  }
}

// TEST MODE: completely separate storage from production submissions, so a
// test record can never be mistaken for a real participant's data. Local
// JSONL goes to its own file; GCS goes to its own top-level prefix
// (test-submissions/ instead of submissions/). Filenames are randomized
// (not derived from any real assignment hash) since test runs are disposable
// and never need to be looked up by participant identity.
const TEST_SUBMISSIONS_FILE = path.join(DATA_DIR, 'test-submissions.jsonl');

function saveTestSubmissionLocally(body) {
  ensureDataDir();
  fs.appendFileSync(TEST_SUBMISSIONS_FILE, JSON.stringify(body) + '\n', 'utf8');
}

async function saveTestSubmissionToGcs(body) {
  const objectPath = `test-submissions/${todayDateStringUTC()}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`;
  const file = storage.bucket(GCS_SUBMISSIONS_BUCKET).file(objectPath);
  await file.save(Buffer.from(JSON.stringify(body), 'utf8'), {
    resumable: false,
    contentType: 'application/json'
    // No ifGenerationMatch precondition here: the filename is already
    // randomized and collision-free, and unlike real submissions this path
    // is never relied on for "exactly-once" guarantees.
  });
  return { objectPath };
}

app.post('/api/submit-survey', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || !isNonEmptyString(body.participant_id)) {
      return res.status(400).json({ error: 'Invalid submission.' });
    }
    const serialized = JSON.stringify(body);
    if (serialized.length > MAX_SUBMISSION_BODY_LEN) {
      return res.status(400).json({ error: 'Submission too large.' });
    }

    // ===================== TEST MODE (DEV/QA ONLY) =====================
    // A record can only be routed to test storage if it both (a) claims
    // test_mode and (b) the server itself has test mode enabled — a client
    // claiming test_mode:true while ENABLE_TEST_MODE is false is rejected
    // outright rather than silently stored as either a real or test record,
    // since neither destination would be correct for that combination.
    if (body.test_mode === true) {
      if (!ENABLE_TEST_MODE) {
        return res.status(403).json({ error: 'Test mode is disabled on this server; refusing to store a test_mode submission.' });
      }
      if (USE_LOCAL_SUBMISSION_FILE) {
        saveTestSubmissionLocally(body);
        console.log('[api/submit-survey][TEST MODE] stored test submission locally for', body.participant_id);
      } else {
        if (!GCS_SUBMISSIONS_BUCKET) {
          console.error('[api/submit-survey][TEST MODE] GCS_SUBMISSIONS_BUCKET is not configured; refusing to fall back to local disk.');
          return res.status(500).json({ error: 'Could not store test submission. Please try again later.' });
        }
        const { objectPath } = await saveTestSubmissionToGcs(body);
        console.log('[api/submit-survey][TEST MODE] stored test submission in GCS at', objectPath);
      }
      // Deliberately never calls markAssignmentCompleted() here — test runs
      // have no real assignments/{hash} Firestore document to update, and
      // must never touch one even if a colliding hash existed.
      return res.json({ ok: true, test_mode: true });
    }

    if (USE_LOCAL_SUBMISSION_FILE) {
      saveSubmissionLocally(body);
      console.log('[api/submit-survey] stored submission locally for', body.participant_id);
    } else {
      if (!GCS_SUBMISSIONS_BUCKET) {
        console.error('[api/submit-survey] GCS_SUBMISSIONS_BUCKET is not configured; refusing to fall back to local disk.');
        return res.status(500).json({ error: 'Could not store submission. Please try again later.' });
      }
      if (!isSha256Hex(body.stable_assignment_id_hash)) {
        return res.status(400).json({ error: 'Invalid submission: missing assignment identifier.' });
      }
      const { objectPath } = await saveSubmissionToGcs(body, body.stable_assignment_id_hash);
      console.log('[api/submit-survey] stored submission in GCS at', objectPath);
    }

    // Best-effort completion-status update; never blocks the success
    // response to the participant since the data above is already saved.
    await markAssignmentCompleted(body.stable_assignment_id_hash);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[api/submit-survey] Unexpected error', err);
    return res.status(500).json({ error: 'Could not store submission. Please try again.' });
  }
});

// ===================== ADMIN-ONLY BULK EXPORT (RESEARCHER USE — NOT PARTICIPANT-FACING) =====================
// Reads ALL accumulated submission records from backend storage (GCS or the
// local .jsonl file, whichever USE_LOCAL_SUBMISSION_FILE selects), across
// every participant/date — distinct from the Ctrl+Shift+E admin panel in the
// frontend, which only ever exports the CURRENT browser session's in-memory
// DATA object. Nothing here is reachable from the participant-facing survey
// UI; there is no button or link to these routes anywhere in the frontend.
//
// SECURITY:
//   - Gated by a single shared secret, ADMIN_EXPORT_KEY, set as a server env
//     var only. It is never sent to, stored in, or referenced by any frontend
//     file, and is never accepted via a query string (only the X-Admin-Key
//     request header) so it can't end up logged in server access logs or
//     browser history the way a URL param would.
//   - If ADMIN_EXPORT_KEY is not configured, both routes always return 401 —
//     there is no "open by default" state.
//   - Comparison is constant-time (crypto.timingSafeEqual) to avoid leaking
//     the key length/contents via response-time differences.
//   - Production submissions (submissions/ or submissions.jsonl) and test
//     submissions (test-submissions/ or test-submissions.jsonl) are exported
//     via the same two routes but are selected explicitly with
//     ?type=production (default) or ?type=test — the two record sets are
//     never combined into one response.
const ADMIN_EXPORT_KEY = sanitizeSecret(process.env.ADMIN_EXPORT_KEY);
if (!ADMIN_EXPORT_KEY) {
  console.warn('[startup] ADMIN_EXPORT_KEY is not set — /api/admin/export-submissions.* will return 401 for every request until it is configured.');
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare bufA against itself so a length mismatch doesn't resolve
    // measurably faster than a same-length-but-wrong-content comparison.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminExportKey(req, res, next) {
  const provided = sanitizeSecret(req.get('X-Admin-Key'));
  if (!ADMIN_EXPORT_KEY || !provided || !timingSafeEqualStrings(provided, ADMIN_EXPORT_KEY)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

const ADMIN_EXPORT_TYPES = {
  production: { local: SUBMISSIONS_FILE, gcsPrefix: 'submissions/' },
  test: { local: TEST_SUBMISSIONS_FILE, gcsPrefix: 'test-submissions/' }
};

function parseAdminExportType(req) {
  const t = (req.query && req.query.type) || 'production';
  return Object.prototype.hasOwnProperty.call(ADMIN_EXPORT_TYPES, t) ? t : null;
}

// Reads every accumulated record for the requested type. Local mode parses
// the append-only .jsonl file line by line; GCS mode lists every object
// under the type's prefix (across all date subfolders) and downloads+parses
// each one. A single unparsable line/object is logged and skipped rather
// than failing the whole export.
async function loadAllSubmissionRecords(type) {
  const cfg = ADMIN_EXPORT_TYPES[type];
  const records = [];
  if (USE_LOCAL_SUBMISSION_FILE) {
    let raw = '';
    try {
      raw = fs.readFileSync(cfg.local, 'utf8');
    } catch (e) {
      raw = ''; // file doesn't exist yet = zero submissions of this type
    }
    raw.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        records.push(JSON.parse(trimmed));
      } catch (e) {
        console.error('[admin-export] Skipping unparsable local record line for type', type);
      }
    });
  } else {
    if (!GCS_SUBMISSIONS_BUCKET) {
      throw new Error('GCS_SUBMISSIONS_BUCKET is not configured.');
    }
    const [files] = await storage.bucket(GCS_SUBMISSIONS_BUCKET).getFiles({ prefix: cfg.gcsPrefix });
    for (const file of files) {
      if (file.name.endsWith('/')) continue; // skip folder placeholder objects
      try {
        const [contents] = await file.download();
        records.push(JSON.parse(contents.toString('utf8')));
      } catch (e) {
        console.error('[admin-export] Skipping unreadable GCS object', file.name, e && e.message);
      }
    }
  }
  return records;
}

// The canonical, researcher-friendly CSV schema (flattened responses,
// fixed-width AI transcript columns, derived AI/behavioral summaries, and a
// handful of selected nested *_json columns) lives in lib/export-csv.js —
// kept out of this file so it can be unit-tested directly against fixtures
// without booting Express, GCS, or Firestore (see test/export.test.js). The
// CSV deliberately does NOT include ai_message_log_json, behavioral_events_json,
// or a raw_record_json column (removed per a later revision request, since
// the fixed transcript/summary columns plus the JSON export below already
// cover that information without duplicating large raw blobs into every
// CSV row).
//
// The JSON export endpoint below deliberately does NOT use cleanRecord(): it
// must return every complete stored record exactly as stored, with no
// flattening, truncation, or deletion (spec point #3) — this is the
// authoritative archive that still contains the complete ai_message_log,
// behavioral_events, and all other original data for every record. Only the
// CSV export uses cleanRecord() (via buildAccumulatedCsv, to strip the three
// dead placeholder fields — see lib/export-csv.js — for a consistent column
// set across old and new records).

app.get('/api/admin/export-submissions.json', requireAdminExportKey, async (req, res) => {
  const type = parseAdminExportType(req);
  if (!type) {
    return res.status(400).json({ error: 'Invalid type query param. Use ?type=production or ?type=test.' });
  }
  try {
    const records = await loadAllSubmissionRecords(type);
    res.setHeader('Content-Disposition', `attachment; filename="submissions-${type}-${todayDateStringUTC()}.json"`);
    return res.json(records);
  } catch (err) {
    console.error('[api/admin/export-submissions.json] Error', err);
    return res.status(500).json({ error: 'Could not export submissions.' });
  }
});

app.get('/api/admin/export-submissions.csv', requireAdminExportKey, async (req, res) => {
  const type = parseAdminExportType(req);
  if (!type) {
    return res.status(400).json({ error: 'Invalid type query param. Use ?type=production or ?type=test.' });
  }
  try {
    const records = await loadAllSubmissionRecords(type);
    const csv = buildAccumulatedCsv(records); // includes leading UTF-8 BOM for Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="submissions-${type}-${todayDateStringUTC()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('[api/admin/export-submissions.csv] Error', err);
    return res.status(500).json({ error: 'Could not export submissions.' });
  }
});

// Researcher-facing export page. Deliberately NOT linked from the
// participant-facing survey HTML/JS anywhere. The static file served below
// contains no record counts, filenames, or any participant data — it is just
// a key-entry form; every actual data request still goes through
// requireAdminExportKey above and returns 401 without a valid key. The route
// is reachable by direct URL (spec point #18, user correction #9), which is
// fine as long as nothing protected is exposed before a valid X-Admin-Key
// request succeeds — this static file alone never makes that request
// automatically on load.
app.get('/admin/export', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-export.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

