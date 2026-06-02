# geniesh — AI-powered code genie

**geniesh** is a local command-line AI assistant for code analysis, refactoring, and interactive exploration. It uses **Ollama** to run LLMs locally on your machine.

## Quick start

```bash
# Start interactive chat in a project directory
geniesh chat --dir /path/to/project

# One-shot analysis
geniesh "What does handleSignals do?" --file src/cli.js
```

## Features

- **Chat**: Interactive REPL with code context, token budget tracking, and conversation compaction
- **Code analysis with `/file`**: Load full source files into context for targeted questions
- **Symbol-aware context with `/ctx`**: Pull code context via genx call-graph analysis
- **Edits with `/edit`**: Ask the LLM to write code, review diffs, and apply
- **Web search**: Paste URLs or use `/search "query"` to fetch web content
- **RAG index**: Index a codebase for semantic search with `geniesh index`
- **One-shot mode**: `geniesh "query" --file path` for non-interactive use
- **Code review**: `geniesh review "query" --file path` (analysis + critique with two models)
- **Conversation compaction**: Automatic two-tier compaction when approaching context limit

## Requirements

- **Node.js 20+**
- **Ollama** running locally with at least one model pulled (e.g., `qwen3-coder`, `qwen3:32b`, `llama3.1`)
- **mapx** binary for `/ctx` and genx features

## Two-turn workflow for best results

When loading a file with `/file`, models often give a generic "file overview" on their first response. For specific answers, use two separate turns:

```
You: /file "src/cli.js"
  [geniesh] loaded src/cli.js (10,084 tok)
  Assistant: <overview — can be ignored>

You: What does handleSignals() do?
  Assistant: handleSignals() processes special instructions in the
  model's reply such as REQUERY or bash commands.
```

The file content persists in the conversation history, so the second turn reads it and answers accurately. This has been verified with qwen3:32b, qwen3-coder, and qwen2.5-coder:14b.

## Commands

| Command | Description |
|---------|-------------|
| `/file "path1, path2"` | Load full file(s) into context |
| `/ctx "symbol1, symbol2"` | Pull genx call-graph context for symbols |
| `/edit` | Enable SEARCH/REPLACE edit mode |
| `/search "query"` | Web search + fetch top pages |
| `/budget` | Show token budget breakdown |
| `/compact` | Manually trigger conversation compaction |
| `https://...` | Paste a URL to fetch its content |
| `exit` | Quit |

## Edit pipeline

1. Load a file: `/file "src/search.js"`
2. Enable edit mode: `/edit`
3. Ask for a change: `Add a null check to cosine()`
4. Review the diff and approve
5. File is patched and syntax-checked

## Token budget

geniesh tracks token usage per model and auto-compacts conversation history when you approach the context limit. Displayed after each turn as `[tok: used / limit pct%]`.

Run `/budget` anytime for details.

## Architecture

```
Chat loop ──► Ollama API ──► local LLM
    │
    ├── /file ──► reads files into context
    ├── /ctx  ──► mapx call-graph ──► genx context
    ├── /edit ──► diff display ──► apply ──► syntax check
    └── /search ──► DuckDuckGo API ──► fetch pages
```

## Related

- **`analyze-cli.mjs`** (`~/agents/analyze-cli.mjs`): Standalone script for reliable per-function analysis without chat history overhead.
