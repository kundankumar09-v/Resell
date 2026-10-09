# AGENTS.md — ReSell Agent Guide

Working conventions for AI agents and contributors on this repo.

## SCRUM story convention

- Work is tracked as `SCRUM-n` stories; commits are prefixed `SCRUM-n` (e.g. `SCRUM-27 mirror-hash duplicate detection: ...`).
- **Next free number: SCRUM-30** (1–25 are historical; 26–29 are the SCRUM-26..29 fix series on branch `fix/scrum-26-29`).
- New bugs discovered during a story go to a `SCRUM-30+` candidate list — do **not** fix them inside an unrelated story's commit.
- One commit per story. Run the test suites before committing and report pass/fail counts.

### SCRUM-27 semantics note

Implemented per platform semantics: 409 at upload gate only; createProduct stores flat hash list + feeds detectRisk(). Do NOT add a creation-time hard block — deliberate semantic change requiring updates to fraud.test.js / identity.test.js per README §7.4.

Candidate note: createProduct trusts client-echoed hash/mirrorHash — now implemented as SCRUM-31 (mark resolved when the session completes).

## Commit hygiene

- Commit ONLY files touched by the current story, with explicit `git add <paths>`.
- **Never** `git add -A` or `git add .` — the tree regularly carries uncommitted WIP from other stories.
- Untracked throwaway data (`__pycache__/`, `ml-service/eval/data/`) is gitignored — keep it that way.

## Current SCRUM-30+ candidate backlog

1. **Pre-existing frontend test failure:** `frontend/src/test/__tests__/theme-call.test.jsx` — `ThemeContext` does not persist `'light'` to `localStorage` on init (`expect(localStorage.getItem('resell-theme')).toBe('light')` fails; verified failing on the clean baseline before any SCRUM-26..29 changes).
2. **First backend boot takes ~35s** while MobileNet weights are fetched over the network (`server.js` warm-up) — consider caching weights to disk or pinning a local copy.
3. **`cvAdapter.js:31–69` `RemoteMLProvider` is an explicit stub** — logs a warning and always falls back to local heuristics, even when `ML_SERVICE_URL` is set. Real remote CV integration is deferred.
4. **Dead config remnants:** `CNN_SIMILARITY_THRESHOLD`, `SIFT_THRESHOLD`, `DUPLICATE_CHECK_TIMEOUT` are defaulted in `validateEnv.js` but never read anywhere.
5. **Dead code:** `backend/src/services/chatService.js` exports broadcast helpers imported by no file — `sockets/index.js` reimplements equivalent logic inline (drift-prone).
6. **`hashing sha256 fallback` in `imageHash.js:113,115`** — when sharp is unavailable, a non-perceptual sha256 slice is stored; those images are invisible to pHash duplicate checks.

## Out of scope (deferred — do not touch without an explicit story)

- `ml-service/` Python FastAPI microservice (CLIP, LightGBM v2 pipelines, HNSW ANN index, shadow mode)
- Redis/BullMQ behavior beyond what exists (queues already degrade gracefully when Redis is down)
- Stripe checkout, offers, orders
- Identity/provenance beyond what exists, seller trust score
- Admin panel, multi-currency / exchange rates
- `cvAdapter.js` RemoteMLProvider stub (see SCRUM-30+ #3)

## Commands

| Task | Command |
|---|---|
| Backend tests | `cd backend && npm test` |
| Frontend tests | `cd frontend && npm test` |
| Backend dev | `cd backend && npm run dev` (port 5000) |
| Frontend dev | `cd frontend && npm run dev` (port 3000, proxies `/api` + `/socket.io` to :5000) |
| Backend syntax check | `node --check backend/src/<file>` |
