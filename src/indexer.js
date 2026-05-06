import { readFile as fsReadFile, writeFile, unlink, access } from 'fs/promises';
import { scanDir, readFile as readSourceFile } from './fs-utils.js';
import { chunkFile } from './chunker.js';
import { embed } from './embedder.js';

const INDEX_FILE = '.ai-index.json';

/**
 * Scans a directory, chunks all files, embeds each chunk,
 * and saves the index to .ai-index.json.
 *
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function buildIndex(dir) {
  // Remove stale index so we always start fresh
  try {
    await unlink(INDEX_FILE);
    console.log(`Removed existing ${INDEX_FILE}`);
  } catch {
    // No existing index — that's fine
  }

  console.log(`Scanning ${dir} ...`);
  const files = await scanDir(dir);
  console.log(`Found ${files.length} files. Embedding chunks (this may take a few minutes)...\n`);

  const index = [];
  let processed = 0;
  let skipped = 0;

  for (const filePath of files) {
    try {
      const content = await readSourceFile(filePath);
      const chunks = chunkFile(filePath, content);

      for (const c of chunks) {
        const embedding = await embed(c.chunk);
        index.push({ file: c.file, chunk: c.chunk, startLine: c.startLine, endLine: c.endLine, embedding });
        process.stdout.write('.');
      }

      processed++;
    } catch (err) {
      process.stderr.write(`\nSkipping ${filePath}: ${err.message}\n`);
      skipped++;
    }
  }

  console.log(`\n\nIndexed ${processed}/${files.length} files → ${index.length} chunks`);
  if (skipped > 0) console.warn(`Skipped ${skipped} files due to errors.`);

  await saveIndex(index);
  console.log(`Saved index → ${INDEX_FILE}`);
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
