# geniesh

Local AI dev assistant. Runs on Ollama — no API keys, no data leaving your machine.

```
User: "how does tryAdd handle errors?"
        │
        ▼
  ┌─────────────────────────────────┐
  │  genx (geniesh context pipeline)│
  │  mapx → symbol search + call    │
  │         graph via grep/BM25     │
  │  genx → assemble snippets,      │
  │         build context doc        │
  └──────────┬──────────────────────┘
             │ context document
             ▼
  ┌─────────────────────────────────┐
  │  LLM (Ollama qwen3-coder)       │
  │  reply: "tryAdd is defined in…" │
  └─────────────────────────────────┘
             │ answer
             ▼
          stdout
```

## Quick Start

```bash
# Prerequisites
npm install
ollama pull qwen3-coder    # chat model
ollama pull nomic-embed-text  # optional: RAG index

# Link globally
npm link
```

### Chat mode (main interface)

```bash
cd /path/to/any/project
geniesh chat                           # start interactive chat
geniesh chat --dir .                   # explicit project root
geniesh chat --model llama3.1          # use a different model
```

Chat commands (type at the `You:` prompt):

| Command | What it does |
|---------|-------------|
| `how does methodName work?` | Prose question — uses RAG (if indexed) for symbol discovery |
| `/context "symbol1, symbol2"` | Explicit genx context fetch for exact symbols |
| `/search "query"` | DuckDuckGo search + fetch top pages |
| `/file "path1, path2"` | Load full file(s) into context |
| `/edit` | Enable SEARCH/REPLACE edit approval in replies |
| `exit` / Ctrl+C | Quit |

During chat, genx only runs on explicit `/context` commands — prose questions skip it for speed.

### One-shot queries

```bash
geniesh "what does the render function do?" --file lib/app.js
geniesh "find security issues" --file src/auth.js
geniesh refs validateToken --dir src/
geniesh review "find bugs" --file src/auth.js
```

### RAG index (optional, improves vague queries)

```bash
geniesh index --dir .
geniesh "how does authentication work?" --dir src/
```

## Architecture

```
geniesh/
├── src/
│   ├── cli.js              Entry point, chat loop, command dispatch
│   ├── genx.js             Context pipeline: calls mapx, builds context doc
│   ├── diff-apply.js       SEARCH/REPLACE edit parser + apply
│   ├── runner.js           Streaming Ollama LLM calls
│   ├── prompt.js           System prompt templates
│   ├── embedder.js         Ollama embedding
│   ├── search.js           Cosine-similarity search over RAG index
│   ├── indexer.js          Build/load RAG index
│   └── ...
├── packages/kernel/        Pure code navigation (no LLM deps)
│   └── src/
│       ├── parsers/        Tree-sitter + generic symbol extractors
│       ├── grep.js         Word-boundary grep
│       └── ...
└── genx/                   Python adapter (deprecated, kept for reference)
```

### How context is built (`/context` command)

1. **mapx** (separate Rust binary) — BM25 symbol search + call-graph extraction via grep
2. **genx.js** — reads mapx JSON output, pulls code snippets around matched lines, assembles a context document with preamble + history
3. **LLM** — receives the context doc as a system prefix, answers with full file/line references

The history (`.genx_history.md`) accumulates across sessions and is optionally compressed when it exceeds 80% of the context window (`--compress-model`).

### Options

```
geniesh chat --model qwen3-coder       # default
geniesh chat --compress-model llama3.1  # history summarizer model
geniesh chat --full-index               # pre-build RAG index at startup
geniesh --embedder mxbai-embed-large chat
```

No config files. No API keys. Just Ollama running in the background.
