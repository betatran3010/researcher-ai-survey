# Deployment & Testing Guide

## Project structure

```
gopnik-ai/
  public/
    researcher_ai_survey.html
    researcher_ai_survey.js
    paper_text_data.js
    papers/
      font.pdf
      food.pdf
      listing.pdf
  server.js
  package.json
  .env.example
  .gitignore
```

This is a real Node.js + Express app, not a static site. It must be deployed somewhere that can run a persistent Node process with a server-side environment variable (Render, Railway, Vercel serverless, Fly.io, or equivalent) — **not** GitHub Pages, which can only serve static files and cannot hold a secret API key.

## Recommended platform: Render

### 1. Push the project to GitHub

Before pushing, double check `.env` is **not** tracked (it's in `.gitignore`) and that no file in the repo contains the real API key. Only `.env.example` (with the placeholder `OPENAI_API_KEY=your_key_here`) should be committed.

```
git init
git add .
git commit -m "Researcher AI survey full-stack app"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Create the Web Service on Render

1. Go to Render → New → Web Service.
2. Connect the GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start` (runs `node server.js`)
   - **Environment:** Node
4. Add environment variables under the service's "Environment" tab:
   - `OPENAI_API_KEY` = your real OpenAI key (paste it directly into Render's env var field — never into any file in the repo)
   - `ALLOWED_ORIGIN` = the exact deployed URL Render gives you, e.g. `https://researcher-ai-survey.onrender.com` (set this **after** the first deploy, once you know the URL, then redeploy)
   - `PORT` is set automatically by Render; you don't need to set it.
5. Click "Create Web Service." Render will install dependencies and start the server.

AI/no-AI condition and CT-placement assignment requires no database or other external setup: it's computed deterministically on the server from a hash of the participant ID (see the "Stratified condition/CT-placement assignment" section of `server.js`), so there's nothing to provision here.

### 3. Confirm `/api/chat` works

Once deployed, open the deployed URL in a browser — the survey should load. To confirm the backend route itself responds (without needing to click through the whole survey), run from any machine:

```bash
curl -X POST https://your-app.onrender.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"participant_id":"test","condition":"AI","paper_id":"font","study_title":"Test","study_text":"Test study text.","user_message":"Hello","conversation_history":[]}'
```

A healthy response looks like `{"reply":"..."}`. If `OPENAI_API_KEY` isn't set yet, you'll get `{"error":"The AI assistant is temporarily unavailable. Please try again later."}` with status 500 — the real cause is only in Render's server logs, never shown to the participant.

### 4. Test from another computer

Open the deployed URL on a separate device/browser (e.g., your phone, or ask someone else to open it). The survey, PDFs, and AI assistant should all work without anyone needing local files or an API key — everything is served from Render.

## Local development

```
npm install
cp .env.example .env   # then edit .env and paste your real key locally — never commit it
npm start
```

Visit `http://localhost:3000`.

## Security checklist (already implemented in server.js)

- API key read only from `process.env.OPENAI_API_KEY`; never appears in any file under `public/` or in `server.js` itself.
- `.env` is git-ignored; only `.env.example` (placeholder) is committed.
- CORS restricted to `ALLOWED_ORIGIN` once set (defaults to permissive only for local dev when unset).
- No global/per-IP rate limit on `/api/chat` (participants may share a network); the only request limit is a per-paper, per-participant 5-message cap, derived server-side from each request's own conversation history.
- Request body size capped at 256kb; `user_message` capped at 4000 chars; `study_text` capped at 60000 chars; conversation history capped at 40 turns.
- Participant-facing errors are generic ("The AI assistant could not respond right now..."); full provider/error detail is only `console.error`'d server-side.

**If the previously-shared API key (pasted in plaintext in chat) hasn't been rotated yet, do that now in the OpenAI dashboard before deploying** — treat any key that was ever typed into a chat as compromised, regardless of where it ends up being used.

## Testing checklist

- [ ] AI condition: full flow from consent through debrief, all 3 studies, AI tab present and functional.
- [ ] No-AI condition: full flow, AI tab and AI-only instructions/reflections items are hidden (no `.ai-only` content visible).
- [ ] All 3 papers (font, food, listing) render correctly in the PDF pane on a study page.
- [ ] Multi-turn AI chat: ask 3+ follow-up questions in the same paper's AI tab; conversation history is sent and the assistant's replies stay coherent with prior turns.
- [ ] AI responses are accurate to the study text provided (ask a question whose answer is only in the paper, confirm the assistant answers correctly and doesn't invent details).
- [ ] Refreshing mid-survey: confirm autosave to `localStorage` and that behavior on reload is acceptable (currently restarts at consent — note if a resume-from-autosave feature is wanted later).
- [ ] Per-paper message cap: send 5 AI chat messages on one paper and confirm the 6th is blocked with the cap message, while a different participant (or a second browser) is unaffected and a *different* paper's count starts fresh.
- [ ] Condition assignment: confirm the About You "Continue" button briefly shows a loading state, then advances normally (no database/env var needed — assignment is computed deterministically from a hash of the participant ID). Submit the same `stable_participant_id` (e.g. a Prolific ID) to `/api/assign-condition` twice with the same `research_role` (e.g. via `curl`) and confirm both responses return the identical `assignment_cell`, `ai_condition`, `critical_thinking_placement`, `paper_order`, and `stable_assignment_id_hash`. Also try the same id with different capitalization/whitespace (e.g. `" ABC123 "` vs `"abc123"`) and confirm identical results, since the server normalizes (trim + lowercase) before hashing.
- [ ] Missing API key: temporarily unset `OPENAI_API_KEY` on the server and confirm `/api/chat` returns the generic unavailable message (not a raw error) and the real cause is in server logs only.
- [ ] Invalid/failed OpenAI response: simulate (e.g., temporarily use a bad model name) and confirm the frontend shows "Sorry, the AI assistant is unavailable right now" rather than crashing or exposing provider error text.
- [ ] Mobile and desktop browser pass: layout, fullscreen prompt, and AI chat all usable on both.
- [ ] Deployed PDF paths: confirm `papers/font.pdf`, `papers/food.pdf`, `papers/listing.pdf` load correctly from the deployed domain (not just localhost).
- [ ] Send button disables while waiting for an AI reply and re-enables after; rapid double-clicking does not produce duplicate sent messages.
- [ ] CT-placement stratification: open the survey several times in fresh sessions within the same expertise tier and condition, confirm `ct_scale_placement` alternates pre/post roughly evenly (check via the admin export, `Ctrl+Shift+E`).
