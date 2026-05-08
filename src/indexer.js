import { performance } from 'perf_hooks';
import { readFile as fsReadFile, writeFile, unlink, access } from 'fs/promises';
import { scanDir, readFile as readSourceFile } from './fs-utils.js';
import { chunkFile } from './chunker.js';
import { embed, embedBatch } from './embedder.js';
import { buildRelations, saveRelations } from './relations.js';
import ora from 'ora';

const INDEX_FILE = '.ai-index.json';
const CONCURRENCY = 4; // embed N files in parallel

// Simple concurrent pool — no extra deps needed
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

export async function buildIndex(dir) {
  const t0 = performance.now();

  // Remove stale index so we always start fresh
  try {
    await unlink(INDEX_FILE);
    console.log(`  ↺  Removed existing ${INDEX_FILE}`);
  } catch {
    // No existing index — that's fine
  }

  const scanSpinner = ora(`Scanning ${dir}…`).start();
  const files = await scanDir(dir);
  const scanMs = ((performance.now() - t0) / 1000).toFixed(1);
  scanSpinner.succeed(`Found ${files.length} file(s) to index  (${scanMs}s)`);

  if (files.length === 0) {
    console.log('Nothing to index.');
    return [];
  }

  const embedStart = performance.now();
  let done = 0;
  let totalChunks = 0;
  const spinner = ora(`Indexing 0/${files.length} files…`).start();

  const results = await concurrentMap(CONCURRENCY, files, async (filePath) => {
    const t0 = performance.now();
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);

      if (chunks.length === 0) {
        done++;
        return [];
      }

      const texts = chunks.map(c => c.chunk);
      const embeddings = await embedBatch(texts);

      const entries = chunks.map((c, i) => ({
        file: c.file,
        chunk: c.chunk,
        startLine: c.startLine,
        endLine: c.endLine,
        embedding: embeddings[i],
      }));

      done++;
      totalChunks += chunks.length;
      const ms = (performance.now() - t0).toFixed(0);
      spinner.text = `Indexing ${done}/${files.length} files  (${ms}ms · ${filePath})`;
      return entries;
    } catch (err) {
      done++;
      spinner.text = `Indexing ${done}/${files.length} files  (skipped: ${filePath} — ${err.message})`;
      return [];
    }
  });

  const index = results.flat();
  const embedSec = ((performance.now() - embedStart) / 1000).toFixed(1);
  spinner.succeed(`Indexed ${done} files, ${totalChunks} chunks  (${embedSec}s)`);

  const saveStart = performance.now();
  await saveIndex(index);
  const saveMs = (performance.now() - saveStart).toFixed(0);
  console.log(`  → Saved ${INDEX_FILE}  (${saveMs}ms)`);

  const relStart = performance.now();
  try {
    const relations = await buildRelations(dir);
    await saveRelations(relations);
    const symCount = Object.keys(relations.bySymbol).length;
    const relMs = (performance.now() - relStart).toFixed(0);
    console.log(`  → Saved .ai-relations.json  (${symCount} symbols, ${relMs}ms)`);
  } catch (err) {
    console.log(`  → Relation graph skipped: ${err.message}`);
  }

  const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  → Total: ${totalSec}s`);
  return index;
}

/**
 * Loads the index from disk.
 * @returns {Promise<object[]>}
 */
export async function loadIndex() {
  let raw;
  try {
    raw = await fsReadFile(INDEX_FILE, 'utf-8');
  } catch {
    throw new Error(`Index file "${INDEX_FILE}" not found. Run: ai index --dir <path>`);
  }
  return JSON.parse(raw);
}

/**
 * Persists the index to disk.
 * @param {object[]} index
 */
export async function saveIndex(index) {
  await writeFile(INDEX_FILE, JSON.stringify(index), 'utf-8');
}

/**
 * Returns true if an index file exists in the current working directory.
 * @returns {Promise<boolean>}
 */
export async function indexExists() {
  try {
    await access(INDEX_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds an in-memory index from an explicit list of file paths.
 * Does NOT write to disk and does NOT delete any existing index.
 * Used by `ai chat --files / --dirs` for explicit context sessions.
 *
 * @param {string[]} files
 * @returns {Promise<object[]>}
 */
export async function buildIndexFromFileList(files) {
  if (files.length === 0) return [];

  const t0 = performance.now();
  let done = 0;
  let totalChunks = 0;
  const spinner = ora(`Indexing ${files.length} file(s)…`).start();

  const results = await concurrentMap(CONCURRENCY, files, async (filePath) => {
    const t0 = performance.now();
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);

      if (chunks.length === 0) {
        done++;
        return [];
      }

      const texts = chunks.map(c => c.chunk);
      const embeddings = await embedBatch(texts);

      const entries = chunks.map((c, i) => ({
        file: c.file,
        chunk: c.chunk,
        startLine: c.startLine,
        endLine: c.endLine,
        embedding: embeddings[i],
      }));

      done++;
      totalChunks += chunks.length;
      const ms = (performance.now() - t0).toFixed(0);
      spinner.text = `Indexing ${done}/${files.length}  (${ms}ms · ${filePath})`;
      return entries;
    } catch (err) {
      done++;
      spinner.text = `Indexing ${done}/${files.length}  (skipped: ${filePath})`;
      return [];
    }
  });

  const index = results.flat();
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  spinner.succeed(`Indexed ${done} files, ${totalChunks} chunks  (${elapsed}s)`);
  return index;
}
