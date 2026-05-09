# E2E Test: pragmatic-graph on Express 5.x

**Date:** 2026-05-09  
**Branch:** `pragmatic-graph` (commit `cc37a77`)  
**Repo:** expressjs/express (5.x) — 152 files, 502 chunks, 1470 symbols  
**Model:** qwen3-coder  
**Test:** 3 one-shot queries on a single fresh index (no re-build between queries)

---

## How It Was Run

1. `geniesh index --dir .` — fresh build on Express root
2. `echo "Q1" | geniesh chat` — one-shot via piped stdin + "exit"
3. `echo "Q2" | geniesh chat` — same session, reuses `.ai-relations.json` (unchanged)
4. `echo "Q3" | geniesh chat` — same session, reuses `.ai-relations.json`

Each chat invocation loaded the same index and relations — no re-indexing between queries.

---

## Question 1: "What does express lib contain structure wise?"

### BFS Behavior
- **Seed symbols:** `What` — not a code symbol, no BFS triggered
- **Retrieval:** Pure RAG (5 chunks from `Readme.md`, `index.js`, `lib/express.js`, `lib/request.js`, `lib/view.js`)
- **Budget used:** N/A (RAG only)

### Answer Quality
The model correctly described Express's module structure:
- Entry point (`index.js`)
- Core factory (`lib/express.js` — `createApplication`)
- Application prototype (`lib/application.js`)
- Request/Response prototypes (`lib/request.js`, `lib/response.js`)
- View engine (`lib/view.js`)

**Good level of detail** considering no code context was injected. The model relied on RAG chunks + training knowledge.

---

## Question 2: "How does application.handle work?"

### BFS Behavior
- **Seed symbols:** `application.handle` (extracted from query)
- **BFS Round 0:** 24 windows added
- **Files hit:** `lib/application.js` (5 windows), `lib/request.js` (2 windows), `examples/error-pages/index.js` (1), `test/express.urlencoded.js` (16)
- **Budget:** 9940/10000 — saturated in 1 round
- **Test noise:** 16/24 windows from test file `express.urlencoded.js` — the directory priority system `dirScore()` did NOT filter these because the path `test/express.urlencoded.js` doesn't match the `LOW_PRIORITY_DIRS` pattern `[/\\](test|spec|__tests__|__mocks__|fixtures|examples)[/\\]`. The `test/` dir on its own without preceding separator is missed (the path starts with `test/`).

### Answer Quality
The model correctly:
- Identified `app.handle` at `lib/application.js:17` and `152–178`
- Traced the flow: `app.handle` → `this.router.handle(req, res, done)`
- Described `req`/`res` prototype manipulation
- Explained middleware iteration and final handler setup

**Strong answer** with specific file and line references from BFS context.

---

## Question 3: "Trace the full middleware chain from app.use through Layer, Route, to Router.handle"

### BFS Behavior
- **Seed symbols:** `Trace, app.use, Layer, Route, Router.handle` (5 symbols extracted)
- **BFS Round 0:** 27 windows added
- **Files hit:** `lib/application.js` (26 windows), `test/express.json.js` (1 window for `Trace`)
- **Budget:** 9998/10000 — saturated in 1 round
- **Implementation vs test:** 26/27 windows from implementation (`lib/`), only 1 from test

### Answer Quality
The model correctly traced:
- `app.use(fn)` → `this.router.use(path, fn)` at `lib/application.js:221`
- Middleware stored in router's internal `stack` as `Layer` objects
- `Router.handle` iterates the stack, matching layers by path
- Final handler via `finalhandler` for unmatched routes

**Notable limitation:** The actual `Layer` and `Route` class implementations live in `node_modules/router/` (a separate npm package) which geniesh skips during scanning. The model correctly inferred their role from usage sites in `lib/application.js`.

### BFS Priority in Action
The seed symbols `Trace, app.use, Layer, Route, Router.handle` were used by BFS. On `main` branch, the non-code seed `Trace` would have polluted grep results. On `pragmatic-graph`, the relation graph correctly mapped `app.use` → `lib/application.js`, and grep found `Layer`, `Route`, `Router.handle` in the same file — filling the budget with implementation code (26/27 windows).

---

## Summary

| Metric | Q1 (lib structure) | Q2 (app.handle) | Q3 (middleware chain) |
|--------|-------------------|-----------------|----------------------|
| BFS seeds | None (RAG) | `application.handle` | `Trace, app.use, Layer, Route, Router.handle` |
| BFS rounds | 0 | 1 (saturated at 9940) | 1 (saturated at 9998) |
| Windows added | 5 (RAG) | 24 (16 test, 8 lib) | 27 (26 lib, 1 test) |
| Budget used | — | 9940/10000 | 9998/10000 |
| Answer quality | Good | Strong (with line refs) | Strong (with chain trace) |

### Observations

1. **BFS saturates budget in 1 round** for all symbol-rich queries. The 10k budget is too small for multi-hop discovery on a 152-file project. A single well-connected symbol like `app.use` fills the entire budget.

2. **Test noise still leaks through.** The `dirScore()` pattern `/[/\\](test|spec|__tests__).../` doesn't match paths starting with `test/` (no leading separator). 16/24 windows in Q2 were from `test/express.urlencoded.js`.

3. **`node_modules/router/` is invisible.** The actual `Layer`, `Route`, `Router` classes live in the `router` npm package (a dependency). geniesh skips `node_modules`. The model inferred their behavior from usage sites — correctly, but without source-level accuracy.

4. **The export/kind prioritization didn't fire** because the budget saturated in round 0 before discovery happened. To see the prioritization in action, the budget needs slack for a second BFS round.

---

## Raw Output Files

- `__tests__/e2e-q1-express-lib-structure.md` — Q1 output (4792 bytes)
- `__tests__/e2e-q2-app-handle.md` — Q2 output (5851 bytes)
- `__tests__/e2e-q3-middleware-chain.md` — Q3 output (6996 bytes)
