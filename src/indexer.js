import { readFile as fsReadFile, writeFile, unlink, access } from 'fs/promises';
import { scanDir, readFile as readSourceFile } from './fs-utils.js';
import { chunkFile } from './chunker.js';
import { embed } from './embedder.js';
import ora from 'ora';

const INDEX_FILE = '.ai-index.json';

export async function buildIndex(dir) {
  // Remove stale index so we always start fresh
  try {
    await unlink(INDEX_FILE);
    console.log(`  ↺  Removed existing ${INDEX_FILE}`);
  } catch {
    // No existing index — that's fine
  }

  const scanSpinner = ora(`Scanning ${dir}…`).start();
  const files = await scanDir(dir);
  scanSpinner.succeed(`Found ${files.length} file(s) to index`);

  if (files.length === 0) {
    console.log('Nothing to index.');
    return [];
  }

  const index = [];
  let processed = 0;
  let skipped = 0;
  let totalChunks = 0;

  for (const filePath of files) {
    const fileSpinner = ora({ text: `Chunking  ${filePath}`, prefixText: '' }).start();
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);
      fileSpinner.text = `Embedding ${filePath}  (${chunks.length} chunk${chunks.length !== 1 ? 's' : ''})`;

      for (const c of chunks) {
        const embedding = await embed(c.chunk);
        index.push({ file: c.file, chunk: c.chunk, startLine: c.startLine, endLine: c.endLine, embedding });
        totalChunks++;
      }

      fileSpinner.succeed(`${filePath}  — ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''} embedded`);
      processed++;
    } catch (err) {
      fileSpinner.fail(`${filePath}  — skipped: ${err.message}`);
      skipped++;
    }
  }

  const saveSpinner = ora('Saving index…').start();
  await saveIndex(index);
  saveSpinner.succeed(`Index saved → ${INDEX_FILE}  (${processed} files, ${totalChunks} chunks${skipped ? `, ${skipped} skipped` : ''})`);

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
 * Index a single file
 * @param {string} filePath
 */
export async function buildIndexFromFile(filePath) {
  try {
    const content = await readSourceFile(filePath);
    const chunks = chunkFile(filePath, content);
    
    const index = [];
    for (const c of chunks) {
      const embedding = await embed(c.chunk);
      index.push({ file: c.file, chunk: c.chunk, startLine: c.startLine, endLine: c.endLine, embedding });
      process.stdout.write('.');
    }
    
    console.log(`\nIndexed 1 file → ${index.length} chunks`);
    await saveIndex(index);
    console.log(`Saved index → ${INDEX_FILE}`);
    return index;
  } catch (err) {
    throw new Error(`Failed to index file ${filePath}: ${err.message}`);
  }
}
