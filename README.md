# geniesh — AI-powered code genie

**geniesh** is a local command-line AI assistant for code analysis, refactoring, and interactive exploration. It uses **Ollama** to run LLMs locally on your machine.

## Quick start

```bash
# For a list of commands type
geniesh

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

# Review any diff via stdin
git diff | geniesh review

# Generate a changelog between tags
geniesh changelog v1.0.0 v1.1.0

# Manage and review git stashes
geniesh stash list

# Generate and run shell commands
geniesh shell "find large files"

# Generate documentation from code
geniesh docs --file src/search.js

# Explain code with git blame history
geniesh blame src/cli.js --lines 50-80
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
- **Arbitrary diff review**: `geniesh review` — review code/diff from stdin, `--file`, or `--staged`
- **Changelogs**: `geniesh changelog <from> [to]` — generate categorized changelogs from git log
- **Stash management**: `geniesh stash list|show|review` — list, inspect, and review git stashes
- **Shell commands**: `geniesh shell <query>` — generate and interactively run shell commands
- **Code documentation**: `geniesh docs` — generate markdown docs from `--file`, `--staged`, or stdin
- **Git blame analysis**: `geniesh blame <file>` — explain code with git blame annotations
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

## Diff review (stdin)

Review any code or diff without needing a branch comparison.

```bash
# Pipe a diff from anywhere
git diff | geniesh review
git diff --cached | geniesh review

# Review a patch file
geniesh review --file changes.patch

# Review staged changes
geniesh review --staged

# Label the review for context
git diff | geniesh review --label "WIP: refactor auth"
```

The command reads from stdin (if piped), `--file`, or `--staged` and passes the content to the LLM for summary, observations, and suggestions.

## Changelog

Generate a categorized changelog from git log between two refs.

```bash
# Between two tags
geniesh changelog v1.0.0 v1.1.0

# From a tag to current HEAD (omit end ref)
geniesh changelog v1.0.0

# Between branches
geniesh changelog main my-feature
```

The LLM categorizes commits into Features, Bug Fixes, Refactors, Deprecations, Documentation, and Other, with a high-level summary at the top.

## Stash management

Manage and review git stashes with LLM-powered summaries.

```bash
# List all stashes with AI-generated summaries
geniesh stash list

# Show details for a specific stash (default: 0)
geniesh stash show 1

# Get a full code review of a stashed change
geniesh stash review 0
```

The `list` command shows a table with index, branch, summary, and file count. `show` describes each file changed and why. `review` runs the full review prompt from `geniesh review` on the stashed diff.

## Shell commands

Generate and interactively run shell commands using natural language.

```bash
# Ask what you want to do
geniesh shell "find all test files that haven't been run recently"
geniesh shell "compress all logs older than 7 days"
geniesh shell "show disk usage by directory"
```

The command:
1. Sends your query to the LLM, which returns a shell command
2. Displays the command with explanation
3. Prompts `Run this command? [Y/n/s how]` — `Y` to execute, `n` to skip, `s` to show more detail
4. If the LLM returns a ` ```bash ` block, the first one is used; otherwise the first non-empty line

## Code documentation

Generate markdown documentation from source code.

```bash
# Document a file
geniesh docs --file src/search.js

# Document staged changes
geniesh docs --staged

# Pipe code from anywhere
cat src/search.js | geniesh docs

# Label the output
geniesh docs --file src/search.js --label "Search module"
```

The command:
1. Reads source code via `--file`, `--staged`, or stdin (same 3-way input as `review`)
2. LLM generates markdown covering: high-level summary, per-function docs (purpose, parameters, return value, edge cases), and usage examples
3. Streams to stdout

## Git blame analysis

Explain code through `git blame` history with LLM-powered annotations.

```bash
# Analyze entire file
geniesh blame src/cli.js

# Specific line range
geniesh blame src/prompt.js --lines 40-70

# Recent changes only
geniesh blame src/search.js --since "2 weeks ago"
```

The command:
1. Runs `git blame --date=short` on the file
2. Groups consecutive lines by commit
3. LLM explains each group: what changed, why (based on code + commit context), and any patterns or concerns
4. Streams the analysis to stdout

## Commands

| Command / CLI | Description |
|---------------|-------------|
| `/file "path1, path2"` | Load full file(s) into context |
| `/ctx "symbol1, symbol2"` | Pull genx call-graph context for symbols |
| `/edit` | Enable SEARCH/REPLACE edit mode |
| `/search "query"` | Web search + fetch top pages |
| `/budget` | Show token budget breakdown |
| `/compact` | Manually trigger conversation compaction |
| `https://...` | Paste a URL to fetch its content |
| `exit` | Quit |
| `geniesh stash list` | List stashes with AI summaries |
| `geniesh stash show <n>` | Show details for stash N |
| `geniesh stash review <n>` | Full code review of stash N |
| `geniesh shell <query>` | Generate and run shell commands |
| `geniesh docs --file <path>` | Generate documentation from code |
| `geniesh blame <file>` | Explain code with git blame history |

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
          ├── geniesh review    ──► stdin / --file / --staged ──► code review
          ├── geniesh commit    ──► git diff --cached ──► commit message ──► git commit
          ├── geniesh pr        ──► git merge-base ──► PR description
          ├── geniesh changelog ──► git log ──► categorized changelog
          ├── geniesh stash     ──► git stash list/show -p ──► summaries & review
           ├── geniesh shell     ──► LLM ──► bash command ──► confirm ──► run
           ├── geniesh docs      ──► --file / --staged / stdin ──► markdown docs
           ├── geniesh blame     ──► git blame ──► group by commit ──► LLM explanation
           └── geniesh index     ──► RAG embedding index
```

## Related

- **`analyze-cli.mjs`** (`~/agents/analyze-cli.mjs`): Standalone script for reliable per-function analysis without chat history overhead.
