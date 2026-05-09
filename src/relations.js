import { readFile as fsReadFile, writeFile, stat } from 'fs/promises';
import { dirname, join, extname } from 'path';
import { scanDir, readFile } from './fs-utils.js';
import { extractAllSymbols, extractAllSymbolsWithMetadata } from './symbol-utils.js';

const RELATIONS_FILE = '.ai-relations.json';

function fileHash(mtimeMs, size) {
  return `${mtimeMs}-${size}`;
}

const RESOLVE_EXTS = [
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
  '.rb', '.lisp', '.lsp', '.cl', '.cs', '.fs', '.fsx', '.vb',
  '.md', '.sh', '.php',
];

function tryResolve(basePath, knownFiles) {
  const normalized = basePath.replace(/\\/g, '/');
  for (const f of knownFiles) {
    const fn = f.replace(/\\/g, '/');
    if (fn === normalized || fn === normalized + '/' || fn.startsWith(normalized + '/.')) return f;
  }

  const ext = extname(basePath).toLowerCase();
  if (ext) {
    if (knownFiles.has(basePath)) return basePath;
  } else {
    for (const e of RESOLVE_EXTS) {
      const withExt = basePath + e;
      if (knownFiles.has(withExt)) return withExt;
    }
  }

  for (const e of RESOLVE_EXTS) {
    const index = join(basePath, 'index' + e);
    if (knownFiles.has(index)) return index;
  }

  return null;
}

function extractImportPaths(content, filePath, knownFiles) {
  const rawModules = new Set();
  const sourceDir = dirname(filePath);

  const collect = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) rawModules.add(m[1].trim());
    }
  };

  collect(/(?:from|import)\s+['"]([^'"]+)['"]/g);
  collect(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  collect(/#include\s+"([^"]+)"/g);
  collect(/require(?:_relative)?\s+['"]([^'"]+)['"]/g);
  collect(/\((?:require|import)\s+'([^']+)'\)/g);
  collect(/^\s*import\s+(\S+)/gm);
  collect(/^\s*from\s+(\S+)\s+import/gm);

  const resolved = [];
  for (const mod of rawModules) {
    const r = resolveImportPath(mod, sourceDir, knownFiles);
    if (r && !resolved.includes(r)) resolved.push(r);
  }
  return resolved;
}

function resolveImportPath(mod, sourceDir, knownFiles) {
  let p = mod.replace(/^['"]+|['"]+$/g, '');
  if (!p) return null;

  if (p.includes('.') && !p.includes('/') && !p.includes('\\')) {
    if (p.startsWith('.')) {
      let relDepth = 0;
      let clean = p;
      while (clean.startsWith('.')) {
        if (clean.startsWith('..')) { relDepth++; clean = clean.slice(1); }
        else { clean = clean.slice(1); break; }
      }
      let baseDir = sourceDir;
      for (let i = 0; i < relDepth && baseDir.length > 0; i++) {
        const parent = dirname(baseDir);
        if (parent === baseDir) break;
        baseDir = parent;
      }
      if (clean) {
        const r = tryResolve(join(baseDir, clean.replace(/\./g, '/')), knownFiles);
        if (r) return r;
      }
    } else {
      const r = tryResolve(join(sourceDir, p.replace(/\./g, '/')), knownFiles);
      if (r) return r;
    }
  }

  const r = tryResolve(join(sourceDir, p), knownFiles);
  if (r) return r;

  return null;
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

  // If relations already exist (v2 with import edges), do incremental update
  if (existing && existing.version === 2 && existing.byImports) {
    return incrementalMerge(existing, files);
  }

  // First build or v1/v2 migration (v2 without byImports needs full rebuild)
  if (existing && existing.version === 1) {
    const migrated = await migrateV1toV2(existing, files);
    return migrated;
  }

  // Fresh build
  const bySymbol = {};
  const byFile = {};
  const fileMeta = {};
  const byImports = {};
  const byImporters = {};
  const knownFiles = new Set(files);

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

    const imports = extractImportPaths(content, file, knownFiles);
    if (imports.length > 0) byImports[file] = imports;
  }

  for (const [file, importedFiles] of Object.entries(byImports)) {
    for (const impFile of importedFiles) {
      if (!Object.hasOwn(byImporters, impFile)) byImporters[impFile] = [];
      byImporters[impFile].push(file);
    }
  }

  return { version: 2, bySymbol, byFile, fileMeta, byImports, byImporters };
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
  const byImports = existing.byImports || {};
  const knownFiles = new Set(currentFiles);

  // Find deleted files — remove them
  const removed = existingFiles.filter(f => !currentSet.has(f));
  for (const file of removed) {
    const symbols = byFile[file] || [];
    delete byFile[file];
    delete fileMeta[file];
    delete byImports[file];
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
      delete byImports[file];
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

    const imports = extractImportPaths(content, file, knownFiles);
    if (imports.length > 0) byImports[file] = imports;
  }

  // Prune stale symbol entries (symbols that no longer appear in any file)
  pruneStaleKeys(bySymbol);

  // Rebuild byImporters from clean state
  const byImporters = {};
  for (const [file, importedFiles] of Object.entries(byImports)) {
    if (!byFile[file]) continue;
    for (const impFile of importedFiles) {
      if (!byFile[impFile]) continue;
      if (!Object.hasOwn(byImporters, impFile)) byImporters[impFile] = [];
      byImporters[impFile].push(file);
    }
  }

  return { version: 2, bySymbol, byFile, fileMeta, byImports, byImporters };
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
