// server.js — Express backend for the researcher AI survey.
//
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
const { cleanRecord, buildAccumulatedCsv, buildAiTranscriptCsv } = require('./lib/export-csv');
const {
  ASSIGNMENT_CELLS,
  PAPER_IDS,
  COUNTER_COLLECTION,
  COUNTER_DOC_ID,
  assignWithinTransaction
} = require('./lib/assignment-balancing');

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

// Firestore-backed assignment idempotency (see the assignment section below)
// is used in every environment, including local dev — there is no in-memory
// or file-based substitute for it, per the requirement that idempotency must
// be transactionally safe under concurrent requests for the same participant.
// Local development authenticates to the real Firestore database via the same
// ADC mechanism (see DEPLOYMENT.md for the exact `gcloud auth application-default
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
const MAX_USER_TURNS_PER_PAPER = 6; // matches MAX_AI_MESSAGES_PER_PAPER in the frontend
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
      "You are a critical and rigorous research evaluator assisting a peer reviewer. " +
      "The study text and figures are provided in this conversation. " +
      "Answer the user's question using only the supplied study and sound analytical reasoning. " +
      "If the study does not contain enough information to answer, say so rather than speculating. " +
      "Do not reference outside studies. Focus on methodology, evidence quality, and reasoning. " +
      "Answer directly without prefacing the response with phrases such as 'Here is your answer,' 'Certainly,' or similar introductory language. " +
      "Keep the entire response under 100 words and make sure it is complete and self-contained within that limit. " +
      "If needed, narrow the scope of your answer rather than running long." +
      "Follow the user's requested number of points, format, or approximate length when one is provided. " +
      "Do not provide content that would facilitate harm or illegal activity; if a request cannot be answered safely, briefly note why.\n\n" +
      "Study title: " + study_title + "\n\n" +
      "Study text:\n" + study_text;

    const retryPrompt =
      "Rewrite the answer as a complete response under 100 words. " +
      "Preserve the most important information, answer the user's question directly, and complete every sentence. " +
      "Return only the revised response.";

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

    // Single source of truth for the OpenAI Chat Completions call, used
    // identically for the initial request and the silent length-retry below.
    // max_tokens (250) is a guardrail, not the length control — the LENGTH
    // RULE in the system prompt keeps replies well under it. Model and
    // temperature are unchanged and identical across both calls.
    const callOpenAI = (msgs) => fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: msgs,
        max_tokens: 250,
        temperature: 0.3
      })
    });

    const openaiResponse = await callOpenAI(messages);

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text().catch(() => '');
      console.error('[api/chat] OpenAI API error', openaiResponse.status, errText);
      return res.status(502).json({ error: 'The AI assistant could not respond right now. Please try again.' });
    }

    const data = await openaiResponse.json();
    const choice = data?.choices?.[0];
    let reply = choice?.message?.content;
    const finishReason = choice?.finish_reason;

    if (!reply) {
      console.error('[api/chat] OpenAI response missing content', JSON.stringify(data));
      return res.status(502).json({
        error: 'The AI assistant could not respond right now. Please try again.'
      });
    }

    if (finishReason === 'length') {
      const retryMessages = messages.concat([
        { role: 'assistant', content: reply },
        { role: 'user', content: retryPrompt }
      ]);

      const retryResponse = await callOpenAI(retryMessages);

      if (!retryResponse.ok) {
        const retryErrText = await retryResponse.text().catch(() => '');
        console.error(
          '[api/chat] silent retry OpenAI API error',
          retryResponse.status,
          retryErrText
        );

        return res.status(502).json({
          error: 'The AI assistant could not respond right now. Please try again.'
        });
      }

      const retryData = await retryResponse.json();
      const retryChoice = retryData?.choices?.[0];
      const retryReply = retryChoice?.message?.content;

      if (!retryReply || retryChoice?.finish_reason === 'length') {
        console.error(
          '[api/chat] silent retry did not yield a complete reply',
          JSON.stringify(retryData)
        );

        return res.status(502).json({
          error: 'The AI assistant could not respond right now. Please try again.'
        });
      }

      reply = retryReply;
    }

    // Server-side log (participant_id, paper_id, condition, turn count) — no API key, no provider error details to client.
    console.log('[api/chat]', { participant_id, condition, paper_id, turn: conversation_history.length + 1 });

    // Only the final reply is returned — never finish_reason, truncation, or
    // retry metadata.
    return res.json({ reply });
  } catch (err) {
    console.error('[api/chat] Unexpected error', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Condition/CT-placement + paper assignment ----------
// Count-based ("balanced"), Firestore-transaction-backed server-side
// assignment. Each new participant is assigned by HIERARCHICAL balancing that
// reads the current running counts before choosing (see
// lib/assignment-balancing.js for the full algorithm and counter-document
// shape):
//   1. Pick the primary AI x CT-placement cell (AI_pre, AI_post, noAI_pre,
//      noAI_post) with the lowest running count; ties are broken by a secure
//      random pick among ONLY the tied cells.
//   2. Within that cell, pick the paper (font, food, listing) with the lowest
//      running count; ties are broken among ONLY the tied papers.
// Four-cell balance is the primary target; paper balance is nested within the
// chosen cell. The running counts live in a single Firestore document
// (assignment_counters/counts) and are incremented in the SAME transaction as
// the new assignment, so the assignment and the counters can never be left
// partially updated and the scheme is safe under concurrent participants,
// multiple Cloud Run instances, and retries. Balancing NEVER reads role,
// expertise, or demographics.
//
// A participant's assignment is permanent: the result is stored at
// assignments/{hashedParticipantId}, keyed by a one-way SHA-256 hash of their
// normalized stable id (Prolific ID, or local fallback UUID) — never the raw
// id. A repeated request for the same hashed id (refresh, reopening the
// survey, a different browser/device with the same Prolific ID) returns the
// EXISTING stored assignment as-is without issuing a new random draw.
// If the request also includes a different research_role than what was
// originally stored, the original is kept — this is now an authoritative,
// cross-device guarantee (not just the same-browser localStorage guard the
// frontend also keeps as a fast-path).
//
// Research-expertise stratum is derived here from the exact role string,
// not trusted from the client, and must match ROLE_OPTIONS in
// researcher_ai_survey.js exactly. The stratum is stored for analysis only
// and does not influence which cell or paper is selected.
//
// PhD students receive a conditional program-year question.
// First-year PhD students are classified as lower expertise;
// second-year-or-later PhD students are classified as higher expertise.
// Conditional PhD-program-year follow-up used for expertise classification.
const ROLE_TIER_MAP = {
  'Undergraduate research assistant': 'lower',
  'Post-baccalaureate research assistant or lab manager': 'lower',
  "Master's student": 'lower',
  'Postdoctoral scholar': 'higher'
};

const ROLES_REQUIRING_YEARS = new Set([
  'PhD student'
]);

function normalizeResearchRoleYears(research_role, rawYears) {
  if (research_role !== 'PhD student') return null;

  const programYear = Number(rawYears);

  return Number.isInteger(programYear) && programYear >= 1
    ? programYear
    : null;
}

// Returns the expertise stratum ('lower' | 'higher') for a given role, or
// null if the role/years combination is invalid or unrecognized. PhD
// student's stratum depends on years in the program (1 = lower, 2+ = higher).
function deriveExpertiseStratum(
  research_role,
  research_role_years
) {
  if (research_role === 'PhD student') {
    const programYear = Number(research_role_years);

    if (
      !Number.isInteger(programYear) ||
      programYear < 1
    ) {
      return null;
    }

    return programYear === 1
      ? 'lower'
      : 'higher';
  }

  return ROLE_TIER_MAP[research_role] || null;
}

// The four primary experimental cells. Imported from the balancing module so
// there is a single source of truth shared by the live assignment path, the
// test-mode override endpoint, and the reconciliation script.
// (ASSIGNMENT_CELLS and PAPER_IDS are required at the top of this file.)

// The 3-paper pool. Each participant is assigned exactly ONE paper; the other
// two are recorded as unassigned_paper_ids. Derived from PAPER_IDS so it can
// never drift from the balancing module or researcher_ai_survey.js.
const PAPER_ASSIGNMENTS = PAPER_IDS.map(p => ({
  paper_id: p,
  unassigned_paper_ids: PAPER_IDS.filter(x => x !== p)
}));

// Bumped to v5 because assignment logic changed from uniform random (v4) to
// persistent count-based balancing (v5): each new participant is assigned to
// the least-filled primary cell and, within it, the least-filled paper, using
// running counts kept in assignment_counters/counts. Per the existing
// versioning convention, this is just a record of which logic produced a given
// assignment; it does not by itself reassign anyone, and older assignment
// documents keep their original version label untouched.
const ASSIGNMENT_VERSION = 'v5_balanced_counts_one_paper';
const PAPER_ORDER_VERSION = 'v5_balanced_counts_one_paper';
const ASSIGNMENT_SOURCE = 'firestore_balanced_counts';

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

app.post('/api/assign-condition', async (req, res) => {
  try {
    const rawStableId = req.body && req.body.stable_participant_id;
    const research_role = req.body && req.body.research_role;
    const research_role_years = normalizeResearchRoleYears(
      research_role,
      req.body && req.body.research_role_years
    );

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
      return res.status(400).json({ error: 'Invalid or unrecognized research_role, or missing/invalid research_role_years for the selected role.' });
    }

    const hashed_participant_id = hashStableId(stable_participant_id);
    const firestore = getFirestore();
    const assignmentRef = firestore.collection(ASSIGNMENTS_COLLECTION).doc(hashed_participant_id);
    const counterRef = firestore.collection(COUNTER_COLLECTION).doc(COUNTER_DOC_ID);

    // Builds the participant's assignment document from the balanced cell/paper
    // choice. Participant-specific fields (role, stratum) live here; the
    // cell/paper selection and counter bookkeeping live in the balancing
    // module. research_expertise_stratum is still STORED for analysis/backward
    // compatibility, but it plays no part in balancing.
    function makeAssignmentDoc(choice, unassignedPaperIds) {
      const assignedAt = new Date().toISOString();
      return {
        hashed_participant_id,
        research_role,
        research_role_years,
        research_expertise_stratum: expertise_stratum,
        ai_condition: choice.cell.ai_condition,
        critical_thinking_placement: choice.cell.ct_placement,
        assignment_cell: choice.cell.cell,
        paper_ids: [choice.paper_id],
        paper_order: [choice.paper_id],
        unassigned_paper_ids: unassignedPaperIds,
        assigned_at: assignedAt,
        assignment_source: ASSIGNMENT_SOURCE,
        assignment_version: ASSIGNMENT_VERSION,
        paper_order_version: PAPER_ORDER_VERSION,
        // This field is set to 'completed' later by /api/submit-survey and
        // is never read by the assignment logic.
        completion_status: 'assigned',
        completed_at: null
      };
    }

    const assignment = await firestore.runTransaction(async (t) => {
      // Hierarchical count-based balancing. For a returning participant the
      // ORIGINAL stored assignment is returned unchanged and the counters are
      // not touched; for a new participant the least-filled cell + least-filled
      // paper-within-cell are chosen and both counters are incremented in this
      // same transaction. See lib/assignment-balancing.js.
      const { assignment: doc } = await assignWithinTransaction(t, {
        assignmentRef,
        counterRef,
        makeAssignmentDoc
      });
      return doc;
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
      unassigned_paper_ids: assignment.unassigned_paper_ids
    });
  } catch (err) {
    console.error('[api/assign-condition] Unexpected error', err);
    return res.status(500).json({ error: 'Could not assign condition. Please retry.' });
  }
});

// ===================== TEST MODE (DEV/QA ONLY) =====================
// Whitelists for the test-mode override params. Deliberately re-derived from
// the same authoritative arrays used by real assignment (ASSIGNMENT_CELLS,
// PAPER_ASSIGNMENTS) rather than hand-duplicated, so the two can never drift
// out of sync with each other.
const TEST_VALID_CELLS = ASSIGNMENT_CELLS.map(c => c.cell); // ['AI_pre','AI_post','noAI_pre','noAI_post']
const TEST_VALID_PAPER_IDS = PAPER_ASSIGNMENTS.map(p => p.paper_id); // ['font','food','listing']

// Exposes ONLY a boolean. Never exposes the value of any other env var or
// secret — this is the sole piece of server state the frontend is allowed to
// learn about test mode before a session can ever be flagged as a test run.
app.get('/api/test-mode-status', (req, res) => {
  res.json({ enabled: ENABLE_TEST_MODE });
});

// TEST-ONLY assignment endpoint. Computes a forced cell + single paper
// assignment in-memory and returns it in the same shape as
// /api/assign-condition, but:
//   - never reads or writes ASSIGNMENTS_COLLECTION (no permanent Firestore
//     assignment record is created for a test run);
//   - only accepts `cell` from TEST_VALID_CELLS and `papers` (optional) as
//     EXACTLY ONE value from TEST_VALID_PAPER_IDS — a comma-separated or
//     multi-paper override (the old two-paper shape) is rejected with a
//     clear 400 error rather than silently falling back to a default/
//     unintended condition.
app.post('/api/test-assign-condition', (req, res) => {
  if (!ENABLE_TEST_MODE) {
    return res.status(403).json({ error: 'Test mode is disabled on this server (ENABLE_TEST_MODE is not "true").' });
  }

  const cell = req.body && req.body.cell;
  const chosenCell = ASSIGNMENT_CELLS.find(c => c.cell === cell);
  if (!chosenCell) {
    return res.status(400).json({ error: 'Invalid or missing test cell. Must be exactly one of: ' + TEST_VALID_CELLS.join(', ') });
  }

  let paperId, unassignedPaperIds;
  const papersOverride = req.body && req.body.papers;
  if (papersOverride !== undefined && papersOverride !== null) {
    // Exactly one valid paper id, either as a bare string or a one-element
    // array. A two-(or more-)paper override — including the old
    // comma-separated two-paper shape — is rejected outright; this is a
    // one-paper survey now, so there is no valid multi-paper override.
    const candidate = Array.isArray(papersOverride)
      ? (papersOverride.length === 1 ? papersOverride[0] : null)
      : papersOverride;
    const valid =
      Array.isArray(papersOverride)
        ? (papersOverride.length === 1 && TEST_VALID_PAPER_IDS.includes(candidate))
        : (typeof papersOverride === 'string' && !papersOverride.includes(',') && TEST_VALID_PAPER_IDS.includes(candidate));
    if (!valid) {
      return res.status(400).json({ error: 'Invalid test papers override. Must be exactly one value from: ' + TEST_VALID_PAPER_IDS.join(', ') + ' (multi-paper overrides are no longer supported).' });
    }
    paperId = candidate;
    unassignedPaperIds = TEST_VALID_PAPER_IDS.filter(p => p !== paperId);
  } else {
    // No override supplied: a fixed, reproducible default paper (no
    // randomness, no Firestore lookup involved).
    paperId = PAPER_ASSIGNMENTS[0].paper_id;
    unassignedPaperIds = PAPER_ASSIGNMENTS[0].unassigned_paper_ids;
  }

  const research_role = (req.body && typeof req.body.research_role === 'string') ? req.body.research_role : null;
  const research_role_years = normalizeResearchRoleYears(
    research_role,
    req.body && req.body.research_role_years
  );
  const research_expertise_stratum = deriveExpertiseStratum(research_role, research_role_years);
  if (!research_expertise_stratum) {
    return res.status(400).json({
      error: 'Invalid or unrecognized research_role, or missing/invalid research_role_years for the selected role.'
    });
  }

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
    research_role_years,
    research_expertise_stratum,
    ai_condition: chosenCell.ai_condition,
    critical_thinking_placement: chosenCell.ct_placement,
    assignment_cell: chosenCell.cell,
    assigned_at: new Date().toISOString(),
    assignment_source: 'test_mode_override',
    assignment_version: ASSIGNMENT_VERSION,
    paper_order_version: PAPER_ORDER_VERSION,
    paper_order: [paperId],
    unassigned_paper_ids: unassignedPaperIds
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
const AUTOSAVES_FILE = path.join(DATA_DIR, 'autosaves.jsonl');
const TEST_AUTOSAVES_FILE = path.join(DATA_DIR, 'test-autosaves.jsonl');
const PROGRESS_COLLECTION = 'survey_progress';
const TEST_PROGRESS_COLLECTION = 'survey_progress_test';
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
  const objectPath = `submissions/${hashedId}.json`;
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


function withProgressMetadata(body) {
  return Object.assign({}, body, {
    record_source: 'autosave',
    last_saved_at: new Date().toISOString(),
    completion_status: body.completion_status === 'completed' ? 'in_progress' : (body.completion_status || 'in_progress')
  });
}

app.post('/api/save-progress', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || !isNonEmptyString(body.participant_id) || body.consent !== true || !body.assignment_cell) {
      return res.status(400).json({ error: 'Invalid progress record.' });
    }
    if (body.submission_status === 'submitting' || body.submission_status === 'confirmed') return res.json({ ok: true, skipped: true });
    const record = withProgressMetadata(body);
    if (JSON.stringify(record).length > MAX_SUBMISSION_BODY_LEN) return res.status(400).json({ error: 'Progress record too large.' });
    if (record.test_mode === true && !ENABLE_TEST_MODE) return res.status(403).json({ error: 'Test mode is disabled.' });
    if (USE_LOCAL_SUBMISSION_FILE) {
      ensureDataDir();
      fs.appendFileSync(record.test_mode === true ? TEST_AUTOSAVES_FILE : AUTOSAVES_FILE, JSON.stringify(record) + '\n', 'utf8');
    } else {
      const collection = record.test_mode === true ? TEST_PROGRESS_COLLECTION : PROGRESS_COLLECTION;
      await getFirestore().collection(collection).doc(record.participant_id).set(record, { merge: false });
    }
    return res.json({ ok: true, last_saved_at: record.last_saved_at });
  } catch (err) {
    console.error('[api/save-progress] Unexpected error', err);
    return res.status(500).json({ error: 'Could not save progress.' });
  }
});

app.post('/api/submit-survey', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || !isNonEmptyString(body.participant_id)) {
      return res.status(400).json({ error: 'Invalid submission.' });
    }
    const confirmedAt = new Date().toISOString();

    body.record_source = 'final_submission';
    body.last_saved_at = confirmedAt;
    body.completion_status = 'completed';
    body.submission_status = 'confirmed';
    body.submission_confirmed_at = confirmedAt;
    body.submission_error = null;
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
  production: { local: SUBMISSIONS_FILE, autosaveLocal: AUTOSAVES_FILE, gcsPrefix: 'submissions/', progressCollection: PROGRESS_COLLECTION },
  test: { local: TEST_SUBMISSIONS_FILE, autosaveLocal: TEST_AUTOSAVES_FILE, gcsPrefix: 'test-submissions/', progressCollection: TEST_PROGRESS_COLLECTION }
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
function parseJsonlFile(filePath, typeLabel) {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return []; }
  const records = [];
  raw.split('\n').forEach((line) => {
    if (!line.trim()) return;
    try { records.push(JSON.parse(line)); }
    catch (e) { console.error('[admin-export] Skipping unparsable local record line for', typeLabel); }
  });
  return records;
}

function latestRecordTime(record) {
  const value = record.last_saved_at || record.submission_confirmed_at || record.final_submission_timestamp || record.session_end_iso || record.session_start_iso;
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function mergeParticipantRecords(finals, autosaves) {
  const merged = new Map();
  for (const record of autosaves) {
    if (!record || !record.participant_id) continue;
    const current = merged.get(record.participant_id);
    if (!current || latestRecordTime(record) >= latestRecordTime(current)) merged.set(record.participant_id, Object.assign({}, record, { record_source: 'autosave' }));
  }
  for (const record of finals) {
    if (!record || !record.participant_id) continue;
    merged.set(record.participant_id, Object.assign({}, record, { record_source: 'final_submission' }));
  }
  return Array.from(merged.values());
}

async function loadAllSubmissionRecords(type) {
  const cfg = ADMIN_EXPORT_TYPES[type];
  const finals = [];
  const autosaves = [];
  if (USE_LOCAL_SUBMISSION_FILE) {
    finals.push(...parseJsonlFile(cfg.local, type + ' final'));
    autosaves.push(...parseJsonlFile(cfg.autosaveLocal, type + ' autosave'));
  } else {
    if (!GCS_SUBMISSIONS_BUCKET) throw new Error('GCS_SUBMISSIONS_BUCKET is not configured.');
    const [files] = await storage.bucket(GCS_SUBMISSIONS_BUCKET).getFiles({ prefix: cfg.gcsPrefix });
    for (const file of files) {
      if (file.name.endsWith('/')) continue;
      try { const [contents] = await file.download(); finals.push(JSON.parse(contents.toString('utf8'))); }
      catch (e) { console.error('[admin-export] Skipping unreadable GCS object', file.name); }
    }
    const snapshot = await getFirestore().collection(cfg.progressCollection).get();
    snapshot.forEach((doc) => autosaves.push(doc.data()));
  }
  return mergeParticipantRecords(finals, autosaves);
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


app.get('/api/admin/export-ai-transcript.csv', requireAdminExportKey, async (req, res) => {
  const type = parseAdminExportType(req);
  if (!type) {
    return res.status(400).json({ error: 'Invalid type query param. Use ?type=production or ?type=test.' });
  }
  try {
    const records = await loadAllSubmissionRecords(type);
    const csv = buildAiTranscriptCsv(records);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-transcript-${type}-${todayDateStringUTC()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('[api/admin/export-ai-transcript.csv] Error', err);
    return res.status(500).json({ error: 'Could not export AI transcript.' });
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
