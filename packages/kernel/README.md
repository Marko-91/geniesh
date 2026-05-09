# @geniesh/kernel

Pure code-navigation engine — zero LLM dependencies, zero I/O beyond the filesystem.
Can be imported by any tool (n8n, OpenCLAW, agent workers) without Ollama or a CLI.

## Purpose

The kernel does everything that **doesn't** need an LLM or embedding model:

- Directory scanning and file reading
- Symbol extraction (camelCase, PascalCase, snake_case, ALL_CAPS, dotted.paths)
- Word-boundary grep with scope-aware windows
- Relation-graph building (symbol ↔ file maps, import edges)
- Line-based code chunking (used during indexing)
- BFS traversal + budgeted retrieval + RAG merge (used per chat turn)

Everything **provider-specific** (embedding, cosine search, LLM chat) lives in the adapter layer. Swap Ollama for OpenAI — swap the adapter; the kernel never changes.

## Modules

| Module | Responsibility |
|--------|---------------|
| `fs-utils.js` | Recursive directory scan, file read, file-reference extraction from text |
| `symbol-utils.js` | Extract code symbols from text / source files |
| `grep.js` | Word-boundary grep with scope windows (finds function/class bodies) |
| `relations.js` | Build relation graph: symbol-to-files, file-to-symbols, import edges |
| `chunker.js` | Split source files into overlapping chunks (100 lines, 50 overlap) |
| `context-builder.js` | BFS retrieval + budget management + RAG merge. Accepts `search()` as injected dependency |

## Usage with an adapter

### The `search()` contract

`context-builder.js` accepts a `searchFn` parameter. If provided, it is called during `buildChatContext()`:

```js
const scoredChunks = await searchFn(question, index, topK)
// Returns: Array<{ file, chunk, startLine, endLine, score }>
```

The kernel uses these scored chunks to:
1. **Seed BFS** when the question has no recognizable code symbols
2. **Restrict grep targets** — BFS greps `ragFiles` first (faster, more relevant)
3. **Fill remaining budget** — after BFS rounds exhaust the frontier, unused budget is topped up with the highest-scoring RAG chunks

### Minimal adapter example

```js
import { buildChatContext } from '@geniesh/kernel';

// Your adapter: embed query → cosine similarity → return scored chunks
async function mySearch(question, index, topK) {
  const embedding = await myEmbedder.embed(question);
  return cosineSearch(index, embedding, topK);
}

// Load index + relations
const index = JSON.parse(await readFile('.ai-index.json'));
const relations = JSON.parse(await readFile('.ai-relations.json'));
const allFiles = await scanDir(process.cwd());

// Build context for a question
const { contextString, trace } = await buildChatContext(
  'how does authenticate work?',
  index,
  allFiles,
  relations,
  [],            // fileRefs (explicit file paths to inject)
  mySearch,      // injected adapter — can be null (grep-only BFS)
);

// Build prompt and call your LLM
const answer = await myLLM.chat(
  `You are a senior engineer.\n\n${contextString}\n\nQuestion: how does authenticate work?`
);
```

### Without an adapter (grep-only BFS)

Pass `null` as `searchFn`. The kernel falls back to grep-bootstrapping for seed symbols:

```js
const { contextString } = await buildChatContext(
  question, index, allFiles, relations, fileRefs, null
);
```

No embeddings, no vector search — pure structural navigation.
Useful when you only have grep and a relation graph.

## Indexing

Indexing (chunk → embed → persist) is **not** in the kernel because embedding is provider-specific. The kernel supplies `chunkFile()` and `buildRelations()` — you call embed yourself:

```js
import { chunkFile, scanDir, readFile } from '@geniesh/kernel';
import { buildRelations } from '@geniesh/kernel';

const files = await scanDir('./src');
for (const file of files) {
  const content = await readFile(file);
  const chunks = chunkFile(file, content);
  const embeddings = await myEmbedder.embedBatch(chunks.map(c => c.chunk));
  // persist: { file, chunk, startLine, endLine, embedding }
}

const relations = await buildRelations('./src');
// persist: { bySymbol, byFile, byImports, byImporters, fileMeta }
```

## Architecture notes

- The kernel never reads or writes `.ai-index.json` or `.ai-relations.json` — those are the adapter's concern.
- `search()` is injected rather than imported so the kernel stays importable without an embedder module installed.
- All file paths are relative to `process.cwd()` — the adapter should resolve them before passing to the kernel.
