# geniesh

A local AI developer assistant powered by **qwen3-coder** and a **RAG (Retrieval-Augmented Generation)** pipeline with **transitive grep**. Runs entirely on your machine — no API keys, no data leaving your system.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally
- `ollama serve` -> to run locally

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Pull required Ollama models
ollama pull nomic-embed-text
ollama pull qwen3-coder

# 3. Link globally so `ai` works anywhere (run from the project directory)
cd /path/to/ai-dev-llama-cli && npm link

# Or run without linking, using node directly:
# node src/cli.js index --dir .
```

## Commands

### `ai index --dir <path>`

Scans a directory, chunks all source files, generates embeddings, and saves a local index to `.ai-index.json`. Run this once before using `--dir` queries.

```bash
ai index --dir src/
ai index --dir .
```

Files in `node_modules`, `dist`, `.git`, `build`, `coverage`, and hidden directories are automatically ignored.

---

### `ai "<query>" --file <path>`

Reads a file and sends it directly to the LLM.

```bash
ai "find bugs" --file src/auth.ts
ai "are there any security issues?" --file src/api/routes.js
```

---

### `ai "<query>" --file <path> --fn <function-name>`

Extracts a single named function from a file and analyzes only that function.

```bash
ai "explain this function" --fn login --file src/auth.ts
ai "find edge cases" --fn validateToken --file src/middleware.js
```

Supports function declarations, arrow functions, async functions, and class methods.

---

### `ai "<query>" --dir <path>`

Uses the RAG index to retrieve the most relevant code chunks for the query, then sends only those chunks to the LLM. **Requires running `ai index` first.**

```bash
ai "how does authentication work?" --dir src/
ai "where are database queries made?" --dir .
ai "find potential memory leaks" --dir src/
```

The top 5 most semantically similar chunks (by cosine similarity) are retrieved and used as context.

---

### `ai chat`

Starts an intelligent multi-turn chat session with auto-indexing, **transitive grep**, and RAG augmentation.

```bash
ai chat
ai chat --dir /path/to/project
ai chat --model qwen3-coder
```

If no `.ai-index.json` exists in the current directory, the index is built automatically before the session starts.

**How context is built per turn:**

Each message triggers a two-tier context pipeline:

1. **Transitive grep (depth 0 → 1)**  
   Structural code symbols are extracted from your question (`camelCase`, `PascalCase`, `snake_case`, `ALL_CAPS`, `dotted.paths`). Those symbols are grepped across all files. The code windows found at depth 0 are then scanned for *new* symbols, which are grepped again at depth 1. This pulls in call targets, referenced constants, and related methods the model would otherwise never see.

2. **RAG (remaining budget)**  
   Cosine similarity search fills any remaining context budget, with README and `.md` files prioritised.

During context building, the depth log is printed in grey:
```
  [depth 0] grepping: methodName, itemTypeUtil
  [depth 0] added 3 window(s), budget used: 4120/10000
  [depth 0→1] discovered: piq, apiResponse, integrationId
  [depth 1] grepping: piq, apiResponse, integrationId
  [depth 1] added 2 window(s), budget used: 7340/10000
```

```
You: how does methodName work?
Assistant: ...

You: exit
```

Type `exit` or press `Ctrl+C` to quit.

---

### `ai refs <name> --dir <path>`

Finds all usages of a symbol (function calls, definitions, imports) across a directory using word-boundary matching. **No index required** — runs in milliseconds directly on the source files.

```bash
ai refs login --dir src/
ai refs validateToken --dir .
```

Optionally ask the LLM a question about all the found usages:

```bash
ai refs login --dir src/ --ask "are there any security issues with how login is called?"
ai refs db.query --dir src/ --ask "could any of these queries be vulnerable to injection?"
```

Or use `--explain` for a one-shot summary of what the symbol does and how it is used across the codebase:

```bash
ai refs login --dir src/ --explain
ai refs fetchUser --dir src/ --explain
```

Control how many lines of surrounding context are captured per match (default 20):

```bash
ai refs fetchUser --dir src/ --context 10
```

Use this instead of `--dir` RAG when you want to find **where** something is called, defined, or imported — structural questions RAG is not suited for.

---

## How It Works

```
Indexing pipeline:
  scan dir → skip .min.js/.min.css → chunk (150 lines, 50-line overlap)
           → embed each chunk (nomic-embed-text, truncated to 6000 chars)
           → save to .ai-index.json

Chat context pipeline (per turn):
  extract symbols from question (camelCase/PascalCase/snake_case/ALL_CAPS/dotted)
    → depth-0 grep across all files
    → extract new symbols from grep results
    → depth-1 grep for discovered symbols
    → fill remaining budget with RAG (cosine similarity, MD files first)
    → inject as context prefix to LLM message

Query pipeline (--dir mode):
  embed query → cosine similarity over index
              → retrieve top 5 chunks
              → build prompt with retrieved code
              → stream response (buffered, typewriter output)
```

The LLM never reads files directly — all filesystem access happens in the CLI.

## Project Structure

```
src/
├── cli.js              Entry point — all commands
├── fs-utils.js         Directory scanning and file reading
├── chunker.js          Line-based code chunking
├── embedder.js         Ollama nomic-embed-text embedding
├── indexer.js          Build, load, and save the RAG index
├── search.js           Cosine similarity search
├── extractor.js        Named function extraction
├── grep.js             Symbol search and context extraction
├── context-builder.js  Transitive grep + RAG context pipeline
├── prompt.js           Prompt templates with context injection
└── runner.js           Streaming Ollama LLM calls
```

## Notes

- The `.ai-index.json` file is excluded from git by default.
- Re-run `ai index` whenever your codebase changes significantly.
- Ollama must be running (`ollama serve`) before using any command.
- Context budget is capped at 10,000 characters per turn.
- Minified files (`.min.js`, `.min.css`) are automatically skipped during indexing.
- Transitive grep depth is capped at 2 levels with max 6 new symbols per level to prevent runaway context expansion.
