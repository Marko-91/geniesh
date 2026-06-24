# geniesh — AI-powered code genie

**geniesh** is a local command-line AI assistant for code analysis, refactoring, and interactive exploration. It uses **Ollama** to run LLMs locally on your machine.

## Quick start

```bash
# Start interactive chat in a project directory
geniesh chat --dir /path/to/project

# One-shot analysis
geniesh "explain the main loop" --file src/cli.js

# PR-style code review between two branches
geniesh diff main my-feature

# Generate a commit message from staged changes
git add -A && geniesh commit

# Generate a PR description between branches
geniesh pr main my-feature
```

## Features

- **Chat**: Interactive REPL with code context, token budget tracking, and conversation compaction
- **Code analysis with `/file`**: Load full source files into context for targeted questions
- **Symbol-aware context with `/ctx`**: Pull code context via genx call-graph analysis
- **Edits with `/edit`**: Ask the LLM to write code, review diffs, and apply
- **Web search**: Paste URLs or use `/search "query"` to fetch web content
- **RAG index**: Index a codebase for semantic search with `geniesh index`
- **One-shot mode**: `geniesh "query" --file path` for non-interactive use
- **PR diff review**: `geniesh diff <base> [head]` — PR-style review of changes between branches with gap analysis
- **Commit messages**: `geniesh commit` — generate conventional commit messages from staged changes
- **PR descriptions**: `geniesh pr <base> [head]` — generate markdown PR descriptions, optionally create via `--open`
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

You: How does the chat loop work?
  Assistant: The chat loop processes user input, loads file context,
  calls the LLM, and displays the response.
```

The file content persists in the conversation history, so the second turn reads it and answers accurately. This has been verified with qwen3:32b, qwen3-coder, and qwen2.5-coder:14b.

## Diff review

Analyze changes between two branches as a structured PR review.

```bash
# Review feature branch against main
geniesh diff main my-feature

# Review current branch against main (head defaults to HEAD)
geniesh diff main

# Use a different model
geniesh diff main my-feature --model qwen2.5-coder:14b
```

The command:
1. Computes the merge-base for true PR semantics
2. Gathers commit log, diff stat, and full unified diff
3. Feeds everything to the LLM with a structured review prompt
4. Streams the review covering: summary, file-by-file review, gaps & risks, and suggestions

## Commit messages

Generate conventional commit messages from staged changes.

```bash
# Generate from staged changes
geniesh commit

# Print without committing
geniesh commit --dry-run

# Auto-stage all tracked files first
geniesh commit --all
```

The command:
1. Reads staged diff via `git diff --cached`
2. Generates a conventional commit message (type, scope, subject, body)
3. Displays it for review: `Y` to commit, `e` to edit, `n` to cancel

## PR descriptions

Generate a pull request description from changes between two branches.

```bash
# Generate PR description (streams to stdout)
geniesh pr main my-feature

# Create the PR via GitHub CLI
geniesh pr main my-feature --open

# Current branch vs main
geniesh pr main
```

The command:
1. Same merge-base logic as `diff`
2. LLM generates a markdown PR description with title, summary, changes, testing notes, and checklist
3. With `--open`: creates the PR via `gh pr create`

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
    ├── /file   ──► reads files into context
    ├── /ctx    ──► mapx call-graph ──► genx context
    ├── /edit   ──► diff display ──► apply ──► syntax check
    ├── /search ──► DuckDuckGo API ──► fetch pages
    │
    └── CLI commands
         ├── geniesh chat      ──► interactive REPL
         ├── geniesh diff      ──► git merge-base ──► git diff ──► PR review
         ├── geniesh commit    ──► git diff --cached ──► commit message ──► git commit
         ├── geniesh pr        ──► git merge-base ──► PR description
         └── geniesh index     ──► RAG embedding index
```

## Related

- **`analyze-cli.mjs`** (`~/agents/analyze-cli.mjs`): Standalone script for reliable per-function analysis without chat history overhead.
