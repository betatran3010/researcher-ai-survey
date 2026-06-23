# Research Scholars AI Survey

A Node.js and Express web application for a study of how research scholars evaluate scientific papers with or without access to an embedded AI assistant.

## Core features

- Stratified AI vs. No-AI assignment
- Pre/post critical-thinking placement
- Two papers selected from a three-paper pool
- Embedded AI assistant in the AI condition
- Behavioral, timing, revision, and clipboard-transfer logging
- Durable submission storage
- Protected accumulated CSV and JSON exports
- Separate QA/test and production records

## Local setup

1. Install Node.js.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Configure the required environment variables.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Tests

Run:

```bash
npm run test:export