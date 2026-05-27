import { readFile as fsReadFile } from 'fs/promises';
import { readdir } from 'fs/promises';
import { join, extname, basename, relative, sep } from 'path';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out',
  'coverage', '__pycache__', 'venv', '.venv', 'vendor', '.cache',
  'target', '.gradle', 'Pods', '.build', 'deps', '_build',
  'tmp', 'temp', '.idea', '.vscode', '.DS_Store',
  'bazel-bin', 'bazel-out', 'bazel-genfiles', 'bazel-testlogs',
]);

const ALLOWED_DOT_DIRS = new Set(['.github']);

const SUPPORTED_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
  '.rb', '.md', '.sh', '.sql', '.yaml', '.yml', '.json', '.php',
  '.lisp', '.lsp', '.cl',
  '.cs', '.fs', '.fsx', '.vb',
]);

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
  '.zip', '.tar', '.gz', '.7z', '.pdf', '.docx', '.xlsx',
  '.mp4', '.mp3', '.avi', '.mov',
]);

const IGNORED_FILES = new Set([
  'geniesh-index.json', 'geniesh-relations.json',
  'geniesh-graph.json',
  '.ai-index.json', '.ai-relations.json',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.genieshignore',
]);

export function parseIgnoreFile(content) {
  const patterns = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let pattern = line;
    let negate = false;

    if (pattern.startsWith('\\!')) {
      pattern = pattern.slice(1);
    } else if (pattern.startsWith('!')) {
      negate = true;
      pattern = pattern.slice(1);
    }

    if (!pattern) continue;

    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);

    const regex = gitignoreToRegex(pattern);
    patterns.push({ pattern, negate, dirOnly, anchored, regex });
  }
  return patterns;
}

function gitignoreToRegex(pattern) {
  let src = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && i + 1 < pattern.length && pattern[i + 1] === '*') {
      src += '.*';
      i += 2;
      if (i < pattern.length && pattern[i] === '/') i++;
    } else if (ch === '*') {
      src += '[^/]*';
      i++;
    } else if (ch === '?') {
      src += '[^/]';
      i++;
    } else if (ch === '.') {
      src += '\\.';
      i++;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) { src += '\\['; i++; }
      else { src += pattern.slice(i, end + 1); i = end + 1; }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      src += '\\' + pattern[i + 1];
      i += 2;
    } else {
      src += ch;
      i++;
    }
  }
  src += '$';
  try { return new RegExp(src); } catch { return null; }
}

function isIgnored(relPath, isDir, patterns) {
  if (patterns.length === 0) return false;
  const normalized = relPath.replace(/\\/g, '/');

  let result = false;
  for (const p of patterns) {
    if (!p.regex) continue;
    if (p.dirOnly && !isDir) continue;

    if (p.anchored) {
      if (p.regex.test(normalized)) result = !p.negate;
    } else {
      if (p.regex.test(normalized)) result = !p.negate;
      const basename = normalized.split('/').pop();
      if (basename !== normalized && p.regex.test(basename)) result = !p.negate;
    }
  }
  return result;
}

export async function scanDir(dir, ignorePatterns = []) {
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const rel = relative(dir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(entry.name)) continue;
        if (isIgnored(rel, true, ignorePatterns)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) continue;
        if (!SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) continue;
        if (isIgnored(rel, false, ignorePatterns)) continue;
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

export async function readFile(filePath) {
  return fsReadFile(filePath, 'utf-8');
}

export async function loadIgnoreFile(rootDir) {
  try {
    const content = await fsReadFile(join(rootDir, '.genieshignore'), 'utf-8');
    if (!content) return [];
    return parseIgnoreFile(content);
  } catch {
    return [];
  }
}
