# A/B Test Report: `main` vs `pragmatic-graph`

**Date:** 2026-05-09  
**Tester:** geniesh E2E  
**Repo:** expressjs/express (5.x) — 152 files, 502 chunks, 1470 symbols  
**Model:** qwen3-coder (via Ollama)  
**Branch:** `pragmatic-graph` (commit `cc37a77`)

---

## Test 1: Generic query — no code symbols

**Query:** `"how does routing work?"`

### BFS Discovery

| Metric | `main` | `pragmatic-graph` |
|--------|--------|-------------------|
| Seed symbols | RAG fallback → `Route, route.dispatch, this.timeout, route.get, req.counter, route.all` | RAG fallback → `Route, route.dispatch, this.timeout, route.get, req.counter, route.all` |
| BFS rounds | 1 (budget saturated) | 1 (budget saturated) |
| Windows added | 43 | 43 |
| Files hit | `test/Route.js`, `test/Router.js`, `test/app.router.js` | `test/Route.js`, `test/Router.js`, `test/app.router.js` |
| Budget used | 9946 / 10000 | 9946 / 10000 |

### LLM Answer

Both branches answered with correct general descriptions of Express routing:
- Route creation (`new Route('/foo')`, `route.get()`, `route.post()`, `route.all()`)
- Handler dispatching via `route.dispatch()`
- Middleware chaining with `next()`, `next(err)`, `next("route")`
- Router integration and error handling

### Verdict

**Equivalent.** Generic queries with no code symbols hit the same RAG fallback on both branches. BFS saturates budget in one round, making export prioritization irrelevant.

---

## Test 2: Code symbol query

**Query:** `"how does Router.handle dispatch requests?"`

### BFS Discovery

| Metric | `main` | `pragmatic-graph` |
|--------|--------|-------------------|
| Seed symbols | `Router.handle` (from query) | `Router.handle` (from query) |
| BFS rounds | 2 | 2 |
| Round 0 windows | 11 (budget 9895/10000) | 11 (budget 9895/10000) |
| Round 0 files | `lib/application.js`, `lib/express.js`, `History.md` | `lib/application.js`, `lib/express.js`, `History.md` |

### Critical Difference: Round 0→1 Discovery Ordering

| `main` (top 8) | `pragmatic-graph` (top 8) |
|----------------|--------------------------|
| `Unreleased` ← changelog | `express.static.mime` |
| `Changes` ← changelog | `res.redirect` ✅ exported function |
| `Improvements` ← changelog | `res.send` ✅ exported function |
| `Improve` ← changelog | `sendFile` ✅ exported function |
| `res.redirect` ✅ | `res.links` ✅ method |
| `When` ← changelog | `res.status` ✅ exported function |
| `app.render` ✅ | `res.location` ✅ exported function |
| `AkaHarshit` ← contributor name | `req.get` ✅ exported method |
| **2/8 useful (25%)** | **8/8 useful (100%)** |

On `main`, `History.md` changelog entries (`kind: reference`, `exported: false`) flood the discovery queue.  
On `pragmatic-graph`, discovered symbols are sorted: **exported > class > function > variable > reference**, pushing changelog noise to the bottom.

### LLM Answer

Both branches produced high-quality answers referencing the same implementation file (`lib/application.js` lines 152–178):
- `app.handle` → `this.router.handle(req, res, done)`
- Middleware iteration via `fn.handle`
- `next()`, `next(err)` error handling
- Prototype manipulation for `req`/`res`

### Verdict

**`pragmatic-graph` wins on discovery quality.** The export/kind prioritization ensures the BFS frontier fills with implementation symbols rather than changelog noise. When budget allows multiple BFS rounds, `pragmatic-graph` explores meaningful code first.

---

## Performance

| Metric | `main` | `pragmatic-graph` |
|--------|--------|-------------------|
| Fresh index build | 14.1s (relations: 42ms) | 14.2s (relations: 467ms) ⚠️ v2 metadata overhead |
| Rebuild (no changes) | 14.0s (full rebuild) | **1.2s** (relations: 5ms via hash) 🏆 |
| Symbol count | 1470 | 1470 (identical) |
| Chunk count | 502 | 502 (identical) |

---

## Summary

| Criterion | Result |
|-----------|--------|
| No regression in answer quality | ✅ |
| No regression in test suite (106 tests) | ✅ |
| BFS export/kind prioritization works | ✅ changelog noise demoted |
| Incremental rebuild (hash-based) | ✅ 12x faster on unchanged files |
| Grep-bootstrap fallback | ✅ implemented (not triggered — auto-indexer always runs) |

**The prioritization signal is real but quiet on this dataset** — it only matters when BFS has budget slack for >1 round. On queries that saturate budget immediately, both branches behave identically.
