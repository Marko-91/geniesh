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
  '.cs', '.fs', '.fsx', '.vb',
]);

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
  '.zip', '.tar', '.gz', '.7z', '.pdf', '.docx', '.xlsx',
  '.mp4', '.mp3', '.avi', '.mov',
]);

const IGNORED_FILES = new Set([
  'geniesh-index.json', 'geniesh-relations.json',
  '.ai-index.json', '.ai-relations.json',
  'package-lock.json', 'yarn.lock',
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
