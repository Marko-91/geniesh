# Round-Robin BFS: Investigation Report

**Date:** 2026-05-09  
**Branch:** `pragmatic-graph` (round-robin commit)  
**Repo:** expressjs/express (5.x) — 152 files, 502 chunks, 1470 symbols  
**Model:** qwen3-coder  
**Context budget:** 10,000 characters  

---

## 1. Improvement: Round-Robin Window Picking

The inner BFS loop was changed from linear-greedy (eat all windows from one `(symbol, file)` pair before moving to the next) to round-robin (one window per `(symbol, file)` pair per cycle).

### Q2: "How does application.handle work?"

| Metric | Linear (before) | Round-robin (after) | Δ |
|--------|----------------|-------------------|---|
| BFS rounds | 1 | **2** | +1 |
| Round 0 windows | 24 | 13 | -11 |
| Round 0 budget | 9940/10000 | **5741/10000** | -4199 |
| Round 1 windows | — | 7 | +7 |
| Total windows | 24 | 20 | -4 |
| Unique files in trace | 4 | **8** | +4 |
| Cross-file diversity | 25% impl, 75% test | **50% impl, 50% test** | balanced |

The budget carve-out from round-robin was large enough (5741/10000, 43% remaining) to trigger **BFS round 2**. The discovery symbols `Router, app.init, defaultConfiguration` were promoted by the export-priority sort, so round 1 explored `lib/response.js`, `lib/utils.js`, and `lib/application.js` — meaningful implementation files.

### Q3: "Trace the middleware chain"

| Metric | Linear (before) | Round-robin (after) | Δ |
|--------|----------------|-------------------|---|
| BFS rounds | 1 | 1 | 0 |
| Round 0 windows | 27 | 24 | -3 |
| Round 0 budget | 9998/10000 | 9955/10000 | -43 |
| Unique files in trace | 2 | **6** | +4 |
| Files/lines per file | `lib/application.js` (25 windows) | `lib/app.js` (6), `examples/` (6), `test/app.router.js` (5), `test/app.use.js` (3), `test/express.json.js` (1) | diverse |

Round-robin distributed 24 windows across **6 files** instead of 2. The model saw usage sites in examples (`examples/error-pages/`, `examples/view-locals/`) and test files (`test/app.router.js`, `test/app.use.js`) alongside the implementation file. This gave it a broader understanding of how `app.use` is called in practice.

### Q1: "What does Express lib contain?" (no change)
No BFS seeds (natural language query) → pure RAG. Identical behavior.

---

## 2. Key Problems

### P1: Budget still saturates too fast for multi-hop BFS

Even with round-robin, Q3 hit 9955/10000 in round 0. The 5 symbols (`app.use`, `Layer`, `Route`, `Router.handle`, `Trace`) produced enough grep hits across the project to fill the budget in one pass.

**Root cause:** the 10k character budget is eaten by context-window wrappers (`// file:path (lines X–Y)\n…\n---\n`). Each window averages ~400 chars including framing. 24 windows × 400 = 9600.

**Impact:** export-priority sorting, incremental index, and grep-bootstrap all sit dormant when BFS can't reach round 2.

**Possible mitigations:**
- Budget carve-out: reserve 30% for rounds ≥1 (guarantees multi-hop, but round 0 delivers less)
- Window size reduction: use 5 context lines in round 0, expand to 15 in later rounds
- Dynamic budget: increase to 15k–20k for large repos (configurable)

### P2: `LOW_PRIORITY_DIRS` regex misses paths starting with `test/`

Current pattern: `/[/\\](test|spec|__tests__|__mocks__|fixtures|examples)[/\\]/`

This requires a separator character before the directory name. Paths like `test/express.urlencoded.js` don't match (no `/` or `\` before `test`). Only `lib/test/foo.js` or `src//test/foo.js` would match.

**Impact:** test files are not deprioritized for paths at the project root. 16/24 linear-greedy Q2 windows came from `test/express.urlencoded.js` — test noise filled the budget.

**Fix:** add `^` anchor: `/^|[/\\](test|spec|__tests__)[/\\]/`

### P3: `node_modules/router/` is invisible

Express 5 ships its router as a separate npm package (`router`). The actual `Layer`, `Route`, and `Router` classes live in `node_modules/router/` — which geniesh skips entirely. The model infers their behavior from usage sites in `lib/application.js`, which is surprisingly accurate but misses:
- Actual `Layer.prototype.match` implementation
- `Route.prototype.dispatch` internals
- `Router.prototype.use` parameter handling

**This is by design** (node_modules are huge), but silently limits BFS depth for framework codebases.

### P4: False positives in `exported` detection

The heuristic `/\bexport\b/.test(line)` matches any line containing the word "export", including copyright headers like `Copyright (c) 2016 AkaHarshit`. In Q2's discovery, `Copyright` was promoted to position 2 in the frontier because `exported: true` made it score 0.

**Impact:** one wasted BFS slot per round (minor, but compounds over rounds).

**Fix:** filter out symbols that start with uppercase and appear on lines without actual `export` keyword at the statement level. Or: only mark `exported: true` if the line starts with `export` or contains `module.exports`.

### P5: RAG dependence for natural language queries

Q1 had no code symbols. The only path to context is the RAG index (`.ai-index.json`). The grep-bootstrap fallback exists in code but was never triggered because the auto-indexer always builds the index first.

**Impact:** queries like "how does routing work?" (no PascalCase/camelCase) depend entirely on embedding quality. If embeddings fail (Ollama down, model missing), the query gets zero code context.

---

## 3. Limitations

| Limitation | Why | Severity |
|------------|-----|----------|
| 10k budget arbitrary | Chosen for small-context LLMs. 32k-context models could use 15k-20k for better multi-hop | Medium |
| Regex symbol extraction misses many patterns | `async function* gen()`, decorators, type-only imports not matched | Low (coverage ~85%) |
| Single-threaded grep | `grepFiles` loops files synchronously (in sequence). Large repos (10k+ files) slow | Low for now |
| Kind detection is heuristic | `res.redirect = function()` detected as `function`; `const x = { y }` detected as `variable` for both keys and values | Low (good enough for sorting) |
| No cross-session graph persistence | BFS discovers symbols per session but doesn't save them back to `.ai-relations.json` | Medium (warm-start opportunity) |
| Readline piped input unreliable | `readline.question()` with piped stdin only processes first line on Windows | Low (one-shot mode works) |

---

## 4. Constraints

1. **Language-agnostic by choice** — no AST, no per-language parser. Regex heuristics for everything. This limits symbol-level precision but keeps the tool working on any codebase.

2. **Zero external dependencies for indexing** — no tree-sitter, no LSP, no language servers. Everything is built on Node.js built-ins + `ora` + `commander`. This is a feature, not a bug.

3. **Node.js 18+** — uses `Object.hasOwn()`, `performance.now()`, ESM modules. No backporting to older Node versions.

4. **Ollama must be running** — all embedding and LLM calls go through local Ollama. No cloud fallback, no API key alternative. This is deliberate for privacy.

5. **10k context budget** — tuned for 7B-14B parameter local models. Larger models (30B+) could handle more, but 10k keeps inference fast on consumer hardware.

---

## 5. Actionable Next Steps

| Priority | Fix | Effort | Impact |
|----------|-----|--------|--------|
| P1 | Budget carve-out: reserve 30% for rounds ≥1 | 15 min | Guarantees multi-hop BFS |
| P2 | Fix `LOW_PRIORITY_DIRS` regex: add `^` anchor | 5 min | Deprioritizes root-level test files |
| P4 | Stricter `exported` detection: require statement-level `export` | 15 min | Reduces frontier pollution |
| P2 | Dynamic budget: scale by repo size or make configurable | 30 min | Better experience on large repos |
| P5 | Auto-detect missing embeddings, enable grep-bootstrap silently | 20 min | Graceful degradation |

The round-robin change alone improved cross-file coverage by 2-4×. Combined with a budget carve-out, it unlocks multi-hop BFS exploration for most queries.
