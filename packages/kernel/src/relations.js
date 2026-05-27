import { stat } from 'fs/promises';
import { scanDir, readFile } from './fs-utils.js';
import { buildGraph, buildChunks, CodeGraph } from './graph-engine.js';
import { SOURCE_EXTS } from './parsers/index.js';

function fileHash(mtimeMs, size) {
  return `${mtimeMs}-${size}`;
}

async function getFileMeta(filePath) {
  try {
    const s = await stat(filePath);
    return { mtime: s.mtimeMs, size: s.size, hash: fileHash(s.mtimeMs, s.size) };
  } catch {
    return null;
  }
}

export async function buildRelations(dir, prevGraph = null, ignorePatterns = [], onProgress = null) {
  const files = await scanDir(dir, ignorePatterns);
  const sourceFiles = files.filter(f => SOURCE_EXTS.has(f.slice(f.lastIndexOf('.')).toLowerCase()));

  const graph = await buildGraph(dir, sourceFiles, prevGraph, onProgress);

  const contentMap = new Map();
  for (const file of sourceFiles) {
    try {
      const content = await readFile(file);
      contentMap.set(file, content);
    } catch {}
  }

  buildChunks(graph, sourceFiles, contentMap);

  const fileMeta = {};
  for (const file of sourceFiles) {
    const meta = await getFileMeta(file);
    if (meta) fileMeta[file] = meta;
  }

  return { graph, fileMeta };
}

export function fileRelationsToNames() {
  return [];
}

export function symbolRelationsToFiles() {
  return [];
}
