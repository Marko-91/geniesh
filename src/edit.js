import { readFile, writeFile } from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { structuredPatch } = require('diff');

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function findFile(rawPath, allFiles) {
  const norm = normalizePath(rawPath).replace(/['"]/g, '');
  let m = allFiles.find(f => normalizePath(f) === norm);
  if (m) return m;
  m = allFiles.find(f => normalizePath(f).endsWith(norm) || normalizePath(f).endsWith('/' + norm));
  if (m) return m;
  const base = norm.split('/').pop();
  m = allFiles.find(f => f.split(/[/\\]/).pop().toLowerCase() === base);
  return m;
}

function trimFences(s) {
  return s.replace(/^```[\w+-]*\n?/gm, '').replace(/```\s*$/g, '').trimEnd();
}

function trimTrailing(s) {
  return s.replace(/\n{2,}\s*(?:```[\w+-]*|CONTEXT|ASSISTANT).*$/s, '').trimEnd();
}

export function parseEdits(text, allFiles) {
  const edits = [];
  // Skip preamble: find the first SEARCH block
  let body;
  if (/^[^\n]+\n\s*SEARCH\s*\n/.test(text)) {
    body = text;
  } else {
    const idx = text.search(/\n[^\n]+\n\s*SEARCH\s*\n/);
    if (idx < 0) return edits;
    body = text.slice(idx + 1);
  }

  const sr = /(?:^|\n+)([^\n]+)\n\s*SEARCH\s*\n([\s\S]*?)\n\s*REPLACE\s*\n([\s\S]*?)(?=\n{3,}|\n(?:[^\n]+\n\s*SEARCH\s*\n|\s*SEARCH\s*\n)|$)/g;
  let m;
  while ((m = sr.exec(body)) !== null) {
    const file = findFile(m[1].trim(), allFiles);
    if (!file) continue;
    const search = trimFences(m[2]);
    const replace = trimTrailing(trimFences(m[3]));
    edits.push({ type: 'sr', file, search, replace });
  }
  // Fenced code blocks with file path: path/to/file.ext\n```\ncontent\n```
  if (!edits.length) {
    const fc = /^([^\n`]+\.\w+)\s*\n```(?:\w+)?\n([\s\S]*?)```/gm;
    while ((m = fc.exec(body)) !== null) {
      const file = findFile(m[1].trim(), allFiles);
      if (!file) continue;
      edits.push({ type: 'full', file, content: m[2].trimEnd() });
    }
  }
  return edits;
}

export function formatDiff(file, search, replace, fileContent) {
  if (!fileContent?.includes(search)) return null;
  const patch = structuredPatch(file, file, search, replace);
  if (!patch.hunks.length) return null;

  const lines = fileContent.split('\n');
  const firstSearchLine = search.split('\n')[0].trim();
  const offset = lines.findIndex(l => l.includes(firstSearchLine));
  if (offset < 0) return null;

  const out = [`\x1b[1m${file}\x1b[0m`];
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const absStart = offset + hunk.oldStart;
    const absEnd = offset + hunk.oldStart + hunk.oldLines - 1;
    out.push(`  L${absStart}–L${absEnd}`);
    for (const line of hunk.lines) {
      const ch = line[0];
      const text = line.slice(1);
      if (ch === ' ') {
        out.push(`   ${String(offset + oldLine).padStart(4)}│ ${text}`);
        oldLine++; newLine++;
      } else if (ch === '-') {
        out.push(` \x1b[31m-${String(offset + oldLine).padStart(4)}│ ${text}\x1b[0m`);
        oldLine++;
      } else if (ch === '+') {
        out.push(` \x1b[32m+${String(offset + newLine).padStart(4)}│ ${text}\x1b[0m`);
        newLine++;
      }
    }
  }
  return out.join('\n');
}

export function formatFileDiff(file, oldContent, newContent) {
  if (oldContent === newContent) return null;
  const patch = structuredPatch(file, file, oldContent, newContent);
  if (!patch.hunks.length) return null;

  const out = [`\x1b[1m${file}\x1b[0m (full file)`];
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    out.push(`  L${hunk.oldStart}–L${hunk.oldStart + hunk.oldLines - 1}`);
    for (const line of hunk.lines) {
      const ch = line[0];
      const text = line.slice(1);
      if (ch === ' ') {
        out.push(`   ${String(oldLine).padStart(4)}│ ${text}`);
        oldLine++; newLine++;
      } else if (ch === '-') {
        out.push(` \x1b[31m-${String(oldLine).padStart(4)}│ ${text}\x1b[0m`);
        oldLine++;
      } else if (ch === '+') {
        out.push(` \x1b[32m+${String(newLine).padStart(4)}│ ${text}\x1b[0m`);
        newLine++;
      }
    }
  }
  return out.join('\n');
}

export async function applyEdit(file, search, replace) {
  const content = await readFile(file, 'utf-8');
  if (!content.includes(search)) {
    throw new Error(`SEARCH text not found in ${file}`);
  }
  const newContent = content.replace(search, () => replace);
  await writeFile(file, newContent, 'utf-8');
  return content;
}
