# Final Implementation Plan: Geniesh v3.0 — AST Graph Engine

## Summary

Replace grep-based BFS context retrieval with AST-level code graph (tree-sitter) for precise, zero-noise context building. Retains RAG fallback for discovery.

## Decision

| Question | Choice |
|---|---|
| Graph engine | Native Node.js tree-sitter (not Python graphify) |
| Default context budget | 128k chars (~32k tokens) |
| Graph build timing | Auto-index on `geniesh chat` with progress spinner |
| Graphify relationship | Optional subprocess for viz only; no runtime dep |

## Files to Create/Modify

### Phase 1 — Graph Engine (kernel)

| File | Action | What it does |
|---|---|---|
| `packages/kernel/src/graph-engine.js` | Create | Central graph builder. Walks all files, calls language-specific tree-sitter parsers, emits a unified graph with nodes (symbols+files) and typed edges (calls, imports, extends, implements, references) |
| `packages/kernel/src/parsers/` | Create dir | Per-language tree-sitter wrappers. Each parser knows how to walk that language's AST for definitions, references, call expressions, imports |
| `packages/kernel/src/parsers/js-ts.js` | Create | JS/TS/JSX/TSX — extract from existing symbol-utils.js tree-sitter code, add call-expression and reference resolution |
| `packages/kernel/src/parsers/ts-based.js` | Create | Python, Go, Rust, Java, C/C++ — web-tree-sitter WASM based parsers |
| `packages/kernel/src/parsers/php.js` | Create | PHP — uses existing tree-sitter-php dep, function/class/interface, use/include |
| `packages/kernel/src/parsers/generic.js` | Create | Fallback regex parser — extended with better scope detection |
| `packages/kernel/src/community.js` | Create | Connected-components clustering (simplified from Leiden). Groups related files into modules by graph connectivity |
| `packages/kernel/src/relations.js` | Rewrite | Now delegates to `graph-engine.js`. Output format becomes v3 (`geniesh-graph.json`). Retains incremental-merge by file hash |
| `packages/kernel/src/symbol-utils.js` | Minimal changes | Keep `extractSymbols` and `extractDiscoverySymbols` for question parsing. Move AST extraction to parsers |

### Phase 2 — Graph-Aware Context Builder (kernel)

| File | Action |
|---|---|
| `packages/kernel/src/context-builder.js` | Rewrite — graph-aware BFS rounds, 128k budget |
| `packages/kernel/src/graph-query.js` | Create — callers/callees/neighbors query layer |
| `packages/kernel/src/grep.js` | Keep — fallback for non-indexed repos |

### Phase 3 — CLI / Adapter (src/)

| File | Action |
|---|---|
| `src/cli.js` | Update — `--budget` flag, graph loading, auto-index flow |
| `src/indexer.js` | Update — builds graph + embeddings in parallel |
| `src/embedder.js` | Keep |
| `src/search.js` | Keep |
| `src/relations.js` | Update — adapter: save/load `geniesh-graph.json` |

### Phase 4 — Package Dependencies

| Package | Action |
|---|---|
| `packages/kernel/package.json` | Add web-tree-sitter grammars: Python, Go, Rust, Java, C/C++ |
| `package.json` | No new deps (version bump to 3.0.0) |

## Graph Schema (v3)

```json
{
  "version": 3,
  "meta": {
    "builtAt": "2026-05-27T...",
    "commit": "abc123",
    "stats": { "files": 152, "symbols": 1470, "edges": 8200, "communities": 12 }
  },
  "nodes": {
    "file://src/app.js": { "type": "file", "community": 1 },
    "sym://src/app.js:Router": {
      "type": "symbol",
      "name": "Router",
      "kind": "class",
      "file": "src/app.js",
      "lineRange": [15, 95],
      "exported": true,
      "community": 1
    }
  },
  "edges": [
    { "from": "sym://src/app.js:Router", "to": "sym://src/router.js:handle",
      "relation": "calls", "at": [{ "file": "src/app.js", "line": 42 }] },
    { "from": "file://src/app.js", "to": "file://src/router.js",
      "relation": "imports" }
  ],
  "embeddings": [
    { "node": "file://src/app.js", "chunk": "lines 1-100...",
      "startLine": 1, "endLine": 100, "vector": [...] }
  ],
  "incremental": {
    "fileHashes": { "src/app.js": "12345-67890-abc..." }
  }
}
```

## Context Budget Allocation (128k chars default)

```
128,000 chars total (~32k tokens)
├── 76,800 (60%) — Graph BFS context (neighbor code)
├── 25,600 (20%) — RAG chunks (discovery)
├── 12,800 (10%) — Conversation history (sliding window)
└── 12,800 (10%) — System prompt + overhead
```

- Configurable via `--budget <chars>` flag
- Model-aware: `--model-window 128k` sets budget to 77k chars (60% of window)
- Per-file cap: 38,400 (30% of budget) to prevent single-file domination

## BFS Traversal Algorithm (New)

1. **Seed**: `extractSymbols(question)` → graph nodes
2. **Round 0** — Direct neighbors:
   - For each seed symbol node:
     - Get ALL callers (who calls this function)
     - Get ALL callees (what does this function call)
     - Get file-level neighbors (same file)
   - Score: `exact query match × 1e6 + exported × 1e4 + (6 - graphDist) × 1e3`
3. **Round 1** — Community cluster:
   - For each discovered symbol:
     - Get all symbols in same community (same module)
     - Get import/export edges
   - Score: same as Round 0 + community bonus +1000
4. **Round 2** — Cross-community (budget permitting):
   - Follow import edges to other files
   - Follow symbol cross-references to other communities
   - Score: penalize by graph distance × community distance
5. **Budget fill**: Remaining → RAG (cosine similarity)
6. **Zero-noise guarantee**: Every code window added has an explicit AST edge from a question symbol → that code.

## Monorepo Support

| Scenario | Approach |
|---|---|
| Multiple package.json dirs | Discover all workspaces via root package.json workspaces field |
| Cross-package references | Edges reference absolute file paths; cross-package imports resolved via node_modules symlinks |
| 100k+ files | Streaming graph build, memory-mapped edge storage |
| Turborepo / Nx workspaces | Read workspace config from turbo.json or nx.json |

## Incremental Build Performance

| Scale | Current (v2.2) | Target (v3.0) |
|---|---|---|
| 152 files (Express) | ~14s | ~8s |
| 1,000 files (small monorepo) | ~90s | ~45s |
| 10,000 files (large monorepo) | ~15min (OOM) | ~3min |
| Changed file re-index | ~0.5s per file | ~0.3s per file |

## Optional: Graphify Integration (no runtime dep)

```
# Only if user has Python + graphify installed:
geniesh graph --viz
# → Runs graphify as subprocess on current geniesh-graph.json
# → Produces graphify-out/graph.html with interactive visualization
```

This is purely additive — not required for the core feature.
