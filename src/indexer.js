import { performance } from 'perf_hooks';
import { readFile as fsReadFile, writeFile, unlink, access, stat } from 'fs/promises';
import { scanDir, readFile as readSourceFile } from './fs-utils.js';
import { chunkFile } from './chunker.js';
import { embed, embedBatch } from './embedder.js';
import { buildRelations, saveGraph, tryLoadGraph } from './relations.js';
import ora from 'ora';

const INDEX_FILE = 'geniesh-index.json';
const CONCURRENCY = 4;

async function concurrentMap(concurrency, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function tryLoadIndex() {
  try {
    const raw = await fsReadFile(INDEX_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function buildIndex(dir) {
  const t0 = performance.now();

  const scanSpinner = ora(`Scanning ${dir}…`).start();
  const files = await scanDir(dir);
  const scanMs = ((performance.now() - t0) / 1000).toFixed(1);
  scanSpinner.succeed(`Found ${files.length} file(s) to index  (${scanMs}s)`);

  if (files.length === 0) {
    console.log('Nothing to index.');
    return [];
  }

  // Phase 1: Build the AST graph
  const graphSpinner = ora('Building AST graph…').start();
  const { graph } = await buildRelations(dir);
  const graphMs = ((performance.now() - t0 - scanMs * 1000) / 1000).toFixed(1);
  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.length;
  graphSpinner.succeed(`Graph built — ${nodeCount} nodes, ${edgeCount} edges, ${graph.communityCount} communities  (${graphMs}s)`);

  // Phase 2: Chunk and embed
  const embedStart = performance.now();
  let done = 0;
  let totalChunks = 0;
  const sourceFiles = [...new Set(
    [...graph.nodes.values()]
      .filter(n => n.type === 'symbol')
      .map(n => n.file)
  )];
  const spinner = ora(`Embedding chunks 0/${sourceFiles.length}…`).start();

  const results = await concurrentMap(CONCURRENCY, sourceFiles, async (filePath) => {
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);
      if (chunks.length === 0) { done++; return []; }

      const texts = chunks.map(c => c.chunk);
      const embeddings = await embedBatch(texts);

      done++;
      totalChunks += chunks.length;
      spinner.text = `Embedding ${done}/${sourceFiles.length} files  (${filePath})`;
      return chunks.map((c, i) => ({
        file: c.file, chunk: c.chunk,
        startLine: c.startLine, endLine: c.endLine,
        embedding: embeddings[i],
      }));
    } catch {
      done++;
      spinner.text = `Embedding ${done}/${sourceFiles.length}  (skipped: ${filePath})`;
      return [];
    }
  });

  const index = results.flat();
  const embedSec = ((performance.now() - embedStart) / 1000).toFixed(1);
  spinner.succeed(`Indexed ${done} files, ${totalChunks} chunks  (${embedSec}s)`);

  // Phase 3: Save
  const saveStart = performance.now();
  await saveIndex(index);
  await saveGraph(graph);
  const saveMs = (performance.now() - saveStart).toFixed(0);
  console.log(`  → Saved ${INDEX_FILE} and geniesh-graph.json  (${saveMs}ms)`);

  const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  → Total: ${totalSec}s`);
  return index;
}

export async function loadIndex() {
  let raw;
  try {
    raw = await fsReadFile(INDEX_FILE, 'utf-8');
  } catch {
    throw new Error(`Index file "${INDEX_FILE}" not found. Run: geniesh index --dir <path>`);
  }
  return JSON.parse(raw);
}

export async function saveIndex(index) {
  await writeFile(INDEX_FILE, JSON.stringify(index), 'utf-8');
}

export async function indexExists() {
  try {
    await access(INDEX_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function buildIndexFromFileList(files) {
  if (files.length === 0) return [];
  const t0 = performance.now();
  let done = 0;
  let totalChunks = 0;
  const spinner = ora(`Indexing ${files.length} file(s)…`).start();

  const results = await concurrentMap(CONCURRENCY, files, async (filePath) => {
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);
      if (chunks.length === 0) { done++; return []; }
      const texts = chunks.map(c => c.chunk);
      const embeddings = await embedBatch(texts);
      done++;
      totalChunks += chunks.length;
      const ms = (performance.now() - t0).toFixed(0);
      spinner.text = `Indexing ${done}/${files.length}  (${ms}ms · ${filePath})`;
      return chunks.map((c, i) => ({
        file: c.file, chunk: c.chunk,
        startLine: c.startLine, endLine: c.endLine,
        embedding: embeddings[i],
      }));
    } catch {
      done++;
      return [];
    }
  });

  const index = results.flat();
  spinner.succeed(`Indexed ${done} files, ${totalChunks} chunks  (${(performance.now() - t0) / 1000 | 0}s)`);
  return index;
}
