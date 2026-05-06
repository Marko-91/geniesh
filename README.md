# ai-dev-llama-cli

A local AI developer assistant powered by **Llama 3** and a **RAG (Retrieval-Augmented Generation)** pipeline. Runs entirely on your machine — no API keys, no data leaving your system.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Pull required Ollama models
ollama pull llama3
ollama pull nomic-embed-text

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

Starts an interactive multi-turn chat session. If a `.ai-index.json` exists, each message is automatically augmented with relevant code context from the index.

```bash
ai chat
```

```
You: how does the login flow work?
Assistant: ...

You: what could go wrong with the token validation?
Assistant: ...

You: exit
```

Type `exit` or press `Ctrl+C` to quit.

---

## How It Works

```
Indexing pipeline:
  scan dir → read files → chunk (300 lines, 50-line overlap)
           → embed each chunk (nomic-embed-text)
           → save to .ai-index.json

Query pipeline (--dir mode):
  embed query → cosine similarity over index
              → retrieve top 5 chunks
              → build prompt with retrieved code
              → stream response from llama3
```

The LLM never reads files directly — all filesystem access happens in the CLI, which passes only the relevant retrieved code as context.

## Project Structure

```
src/
├── cli.js          Entry point — all commands
├── fs-utils.js     Directory scanning and file reading
├── chunker.js      Line-based code chunking
├── embedder.js     Ollama nomic-embed-text embedding
├── indexer.js      Build, load, and save the RAG index
├── search.js       Cosine similarity search
├── extractor.js    Named function extraction
├── prompt.js       Prompt templates with context injection
└── runner.js       Streaming Ollama LLM calls
```

## Notes

- The `.ai-index.json` file is excluded from git by default.
- Re-run `ai index` whenever your codebase changes significantly.
- Ollama must be running (`ollama serve`) before using any command.
- Context is capped at 8,000 characters to keep responses fast.
