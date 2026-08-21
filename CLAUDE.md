# CafeBot

## Purpose
CafeBot is a café web app that lets customers interact with a chatbot-style interface (e.g. browsing menu items, asking questions, placing orders). This file guides Claude Code when working in this repository.

## Architecture Overview
- `frontend/` — static client: `index.html`, `styles.css`, `app.js`. Talks to the backend over HTTP.
- `backend/` — server-side logic and API endpoints that the frontend calls.
- `data/` — static or persisted data (e.g. menu items, orders) used by the backend.
- `prompts/` — prompt templates used for any LLM-driven behavior.
- `README.md` — project overview and structure.

Data flow: frontend → backend API → data/prompts as needed → response back to frontend. Keep this separation; don't blur frontend/backend responsibilities.

## Coding Rules
- Keep changes minimal and scoped to the task — no speculative features, no premature abstractions.
- Match existing structure and naming; don't introduce new top-level folders without a clear need.
- No comments unless they explain a non-obvious "why".
- Prefer plain, readable code over clever code.

## Security Rules
- Never hardcode secrets, API keys, or credentials in source files — use environment variables.
- Validate and sanitize all user input on the backend before use (e.g. before storage, rendering, or passing to prompts).
- Never trust data coming from the frontend as safe by default.
- Avoid introducing injection vectors (HTML/JS injection, prompt injection via unsanitized user input into prompts, etc.).

## Token-Saving Rules
- Read only the files relevant to the current task, not the whole repo.
- Avoid regenerating unchanged files; make targeted edits instead of full rewrites.
- Keep responses and generated code concise — no filler, no restating unchanged context.

## Scope Discipline
- Only modify the files strictly needed for the current task. Do not touch unrelated files, folders, or configuration as a side effect.
