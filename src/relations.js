import { readFile as fsReadFile, writeFile, stat } from 'fs/promises';
import { scanDir, readFile } from './fs-utils.js';
import { extractAllSymbols, extractAllSymbolsWithMetadata } from './symbol-utils.js';

const RELATIONS_FILE = '.ai-relations.json';

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

function pruneStaleKeys(map) {
  for (const key of Object.keys(map)) {
    if (map[key].length === 0) delete map[key];
  }
}

function metadataToV1(entry) {
  return entry.name;
}

function metadataToV2(entry) {
  return {
    name: entry.name,
    kind: entry.kind,
    exported: entry.exported,
    lineRange: entry.lineRange,
  };
}

/**
 * Converts v1 relations to v2 format by re-extracting metadata from files.
 * This is a one-time migration — run when first reading a v1 file.
 */
async function migrateV1toV2(relations, files) {
  const newBySymbol = {};
  const newByFile = {};
  const fileMeta = {};

  for (const file of files) {
    const meta = await getFileMeta(file);
    if (meta) fileMeta[file] = meta;
    let content;
    try { content = await readFile(file); } catch { continue; }

    const symbols = extractAllSymbolsWithMetadata(content);
    const fileEntry = symbols.map(metadataToV2);
    newByFile[file] = fileEntry;

    for (const sym of fileEntry) {
      if (!Object.hasOwn(newBySymbol, sym.name)) newBySymbol[sym.name] = [];
      newBySymbol[sym.name].push({ file, kind: sym.kind, exported: sym.exported, lineRange: sym.lineRange });
    }
  }

  return { version: 2, bySymbol: newBySymbol, byFile: newByFile, fileMeta };
}

export async function buildRelations(dir) {
  const files = await scanDir(dir);
  const existing = await tryLoadRelations();

  // If relations already exist, do incremental update
  if (existing && existing.version === 2) {
    return incrementalMerge(existing, files);
  }

  // First build or v1 migration
  if (existing && existing.version === 1) {
    const migrated = await migrateV1toV2(existing, files);
    return migrated;
  }

  // Fresh build
  const bySymbol = {};
  const byFile = {};
  const fileMeta = {};

  for (const file of files) {
    const meta = await getFileMeta(file);
    if (meta) fileMeta[file] = meta;
    let content;
    try { content = await readFile(file); } catch { continue; }

    const symbols = extractAllSymbolsWithMetadata(content);
    const fileEntry = symbols.map(metadataToV2);
    byFile[file] = fileEntry;

    for (const sym of fileEntry) {
      if (!Object.hasOwn(bySymbol, sym.name)) bySymbol[sym.name] = [];
      bySymbol[sym.name].push({ file, kind: sym.kind, exported: sym.exported, lineRange: sym.lineRange });
    }
  }

  return { version: 2, bySymbol, byFile, fileMeta };
}

export async function tryLoadRelations() {
  try {
    const raw = await fsReadFile(RELATIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function incrementalMerge(existing, currentFiles) {
  const currentSet = new Set(currentFiles);
  const existingFiles = Object.keys(existing.byFile);
  const bySymbol = existing.bySymbol;
  const byFile = existing.byFile;
  const fileMeta = existing.fileMeta || {};

  // Find deleted files — remove them
  const removed = existingFiles.filter(f => !currentSet.has(f));
  for (const file of removed) {
    const symbols = byFile[file] || [];
    delete byFile[file];
    delete fileMeta[file];
    for (const sym of symbols) {
      if (bySymbol[sym.name]) {
        bySymbol[sym.name] = bySymbol[sym.name].filter(e => e.file !== file);
      }
    }
  }

  // Find new or changed files — re-scan
  for (const file of currentFiles) {
    const meta = await getFileMeta(file);
    const oldMeta = fileMeta[file];

    if (oldMeta && meta && oldMeta.hash === meta.hash) continue; // unchanged

    // Remove old entries for this file
    if (byFile[file]) {
      const oldSyms = byFile[file];
      delete byFile[file];
      for (const sym of oldSyms) {
        if (bySymbol[sym.name]) {
          bySymbol[sym.name] = bySymbol[sym.name].filter(e => e.file !== file);
        }
      }
    }

    // Re-scan file
    let content;
    try { content = await readFile(file); } catch { continue; }

    const symbols = extractAllSymbolsWithMetadata(content);
    const fileEntry = symbols.map(metadataToV2);
    byFile[file] = fileEntry;
    if (meta) fileMeta[file] = meta;

    for (const sym of fileEntry) {
      if (!Object.hasOwn(bySymbol, sym.name)) bySymbol[sym.name] = [];
      bySymbol[sym.name].push({ file, kind: sym.kind, exported: sym.exported, lineRange: sym.lineRange });
    }
  }

  // Prune stale symbol entries (symbols that no longer appear in any file)
  pruneStaleKeys(bySymbol);

  return { version: 2, bySymbol, byFile, fileMeta };
}

export function saveRelations(relations) {
  return writeFile(RELATIONS_FILE, JSON.stringify(relations), 'utf-8');
}

export async function loadRelations() {
  const raw = await fsReadFile(RELATIONS_FILE, 'utf-8');
  return JSON.parse(raw);
}

export async function relationsExist() {
  try {
    await fsReadFile(RELATIONS_FILE, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function fileRelationsToNames(byFileEntry) {
  return byFileEntry ? byFileEntry.map(s => s.name) : [];
}

export function symbolRelationsToFiles(bySymbolEntry) {
  return bySymbolEntry ? bySymbolEntry.map(e => e.file) : [];
}
