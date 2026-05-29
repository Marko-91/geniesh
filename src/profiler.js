import { readdir, stat } from 'fs/promises';
import { extname, join, basename, relative } from 'path';
import { getLanguages } from './languages/index.js';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out', 'coverage',
  '__pycache__', 'venv', '.venv', 'vendor', '.cache', 'target', '.gradle',
  '.idea', '.vscode', '.DS_Store', 'tmp', 'temp', 'bazel-bin', 'bazel-out',
  'bazel-genfiles', 'bazel-testlogs',
  'express', 'flask', 'gin', 'ripgrep', 'zod', 'monolog', 'graphify-out',
]);

const GENERIC_KEY_FILES = new Set([
  'readme.md', 'readme', 'contributing.md', 'changelog.md', 'license',
  'makefile', 'dockerfile', 'docker-compose.yml', '.gitignore', '.env.example',
  '.editorconfig',
]);

async function quickScan(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        files.push({ path: fullPath, ext, name: entry.name });
      }
    }
  }
  await walk(dir);
  return files;
}

function analyzeStructure(files) {
  const top = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.length > 1) {
      const root = parts[parts.length - 2];
      top.set(root, (top.get(root) || 0) + 1);
    }
  }
  const entries = [...top.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, fileCount: count }));
  return { topDirs: entries };
}

export async function profileProject(dir) {
  const files = await quickScan(dir);

  const langs = getLanguages();
  const langScores = langs.map(mod => ({
    id: mod.id,
    percentage: Math.round(mod.detect(files) * 100),
  })).filter(l => l.percentage > 0)
    .sort((a, b) => b.percentage - a.percentage);

  const keyFiles = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (GENERIC_KEY_FILES.has(lower)) {
      keyFiles.push({ path: f.path, name: f.name, type: 'generic' });
    }
    for (const mod of langs) {
      if (mod.keyFiles && mod.keyFiles.includes(f.name)) {
        if (!keyFiles.find(k => k.path === f.path)) {
          keyFiles.push({ path: f.path, name: f.name, type: mod.id });
        }
      }
    }
  }

  const structure = analyzeStructure(files);

  return {
    languages: langScores,
    keyFiles,
    fileCount: files.length,
    structure,
  };
}
