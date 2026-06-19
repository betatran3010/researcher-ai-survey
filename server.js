// server.js — Express backend for the researcher AI survey.
// Holds the OpenAI API key as a server-side environment variable ONLY.
// The frontend never sees the key; it calls /api/chat on this server,
// and this server calls the OpenAI API.

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // e.g. https://your-survey.onrender.com

if (!OPENAI_API_KEY) {
  console.error('[startup] WARNING: OPENAI_API_KEY is not set. /api/chat will return an error to participants until it is configured.');
}

// ---------- Security middleware ----------
app.use(express.json({ limit: '256kb' }));

const corsOptions = ALLOWED_ORIGIN
  ? { origin: ALLOWED_ORIGIN }
  : { origin: true }; // falls back to permissive during local development only
app.use(cors(corsOptions));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Input limits ----------
const MAX_USER_MESSAGE_LEN = 4000;
const MAX_STUDY_TEXT_LEN = 60000;
const MAX_HISTORY_TURNS = 40;
const MAX_HISTORY_MSG_LEN = 4000;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---------- POST /api/chat ----------
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const {
      participant_id,
      condition,
      paper_id,
      study_title,
      study_text,
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
      'You are a normal helpful AI assistant. The participant is working with the study provided below. ' +
      'Use the study title and text as context when answering questions about it. Do not invent details about the study. ' +
      'Follow normal safety requirements.\n\n' +
      'Study title: ' + study_title + '\n\n' +
      'Study text:\n' + study_text;

    const messages = [{ role: 'system', content: systemPrompt }];
    conversation_history.forEach(turn => {
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: String(turn.content) });
    });
    messages.push({ role: 'user', content: user_message });

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

// ---------- Future secure submission endpoint ----------
// TODO: implement a real /api/submit-survey endpoint here that persists
// the full survey DATA object (participant_id, responses, ai_chats, timing,
// violations, quiz_score, etc.) to a database or file store. The frontend
// already POSTs the full DATA object to this path; for now it is a stub
// that 404s and the client logs a console.warn on failure.

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
