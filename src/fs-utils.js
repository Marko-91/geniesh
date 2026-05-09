import { readFile as fsReadFile } from 'fs/promises';
import { readdir } from 'fs/promises';
import { join, extname, basename } from 'path';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out',
  'coverage', '__pycache__', 'venv', '.venv', 'vendor', '.cache'
]);

const ALLOWED_DOT_DIRS = new Set(['.github']);

const SUPPORTED_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
  '.rb', '.md', '.sh', '.sql', '.yaml', '.yml', '.json', '.php',
  '.lisp', '.lsp', '.cl',
]);

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
  '.zip', '.tar', '.gz', '.7z', '.pdf', '.docx', '.xlsx',
  '.mp4', '.mp3', '.avi', '.mov',
]);

const IGNORED_FILES = new Set([
  '.ai-index.json', 'package-lock.json', 'yarn.lock',
]);

export async function scanDir(dir) {
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
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && (!entry.name.startsWith('.') || ALLOWED_DOT_DIRS.has(entry.name))) {
          await walk(fullPath);
        }
      } else if (
        entry.isFile() &&
        !IGNORED_FILES.has(entry.name) &&
        !entry.name.endsWith('.min.js') && !entry.name.endsWith('.min.css') &&
        SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())
      ) {
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

const FILE_REF_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.yml', '.yaml', '.json', '.md', '.sh',
  '.lisp', '.lsp', '.cl',
]);

/**
 * Detects file references in a user query by matching words against
 * known project files. Handles full paths, partial paths, and basenames.
 * @param {string}   query     User message
 * @param {string[]} allFiles  All scannable files in the project
 * @returns {string[]}  Up to 3 matched file paths
 */
export function extractFileRefs(query, allFiles) {
  const words = query.split(/\s+/);
  const matches = new Set();

  for (const word of words) {
    const clean = word.replace(/[.,;:!?)\]]+$/, '');
    if (clean.length < 3) continue;
    if (FILE_REF_EXTS.size > 0) {
      const hasExt = FILE_REF_EXTS.has(extname(clean).toLowerCase());
      if (!hasExt && !clean.includes('/') && !clean.includes('\\')) continue;
    }

    const normalized = clean.replace(/\\/g, '/').replace(/^\.\//, '');

    for (const fp of allFiles) {
      const fpNorm = fp.replace(/\\/g, '/');

      // Exact basename match
      if (basename(fpNorm) === normalized || basename(fpNorm).toLowerCase() === normalized.toLowerCase()) {
        matches.add(fp);
        continue;
      }

      // Partial path match (e.g. "lib/application.js" matches ".../express/lib/application.js")
      if (normalized.includes('/') && fpNorm.includes(normalized)) {
        matches.add(fp);
      }
    }

    if (matches.size >= 3) break;
  }

  return [...matches];
}
