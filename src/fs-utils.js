import { readFile as fsReadFile } from 'fs/promises';
import { readdir } from 'fs/promises';
import { join, extname } from 'path';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out',
  'coverage', '__pycache__', 'venv', '.venv', 'vendor', '.cache', '__tests__', 'test', 'tests'
]);

const SUPPORTED_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
  '.rb', '.md', '.sh', '.sql', '.yaml', '.yml', '.json', '.php'
]);

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
  '.zip', '.tar', '.gz', '.7z', '.pdf', '.docx', '.xlsx',
  '.mp4', '.mp3', '.avi', '.mov', 'package-lock.json', 'yarn.lock',
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
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath);
        }
      } else if (
        entry.isFile() &&
        entry.name !== '.ai-index.json' && entry.name !== 'package-lock.json' &&
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
