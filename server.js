// server.js — Express backend for the researcher AI survey.
// Holds the OpenAI API key as a server-side environment variable ONLY.
// The frontend never sees the key; it calls /api/chat on this server,
// and this server calls the OpenAI API.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

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

// ---------- Submission persistence ----------
// Simple append-only file store: each participant's full DATA object is
// written as one line of JSON to data/submissions.jsonl. This is a pragmatic
// minimum (not a database) so that participant data survives even if the
// browser's localStorage is cleared or the export panel is never opened —
// swap this for a real database later without changing the frontend, since
// the frontend already just POSTs the whole DATA object to this path.
const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.jsonl');
const MAX_SUBMISSION_BODY_LEN = 5_000_000; // ~5MB, generous for a full participant record incl. AI transcripts

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* already exists */ }
}

app.post('/api/submit-survey', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || !isNonEmptyString(body.participant_id)) {
      return res.status(400).json({ error: 'Invalid submission.' });
    }
    const serialized = JSON.stringify(body);
    if (serialized.length > MAX_SUBMISSION_BODY_LEN) {
      return res.status(400).json({ error: 'Submission too large.' });
    }
    ensureDataDir();
    fs.appendFileSync(SUBMISSIONS_FILE, serialized + '\n', 'utf8');
    console.log('[api/submit-survey] stored submission for', body.participant_id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api/submit-survey] Unexpected error', err);
    return res.status(500).json({ error: 'Could not store submission.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
