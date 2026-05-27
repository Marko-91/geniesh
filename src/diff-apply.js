import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

export function parseFileEdits(text, allFiles) {
  // Match: ```lang:filepath or ```:filepath or just ```filepath
  const blockRe = /```(\w[\w+-]*)?\s*:?\s*([^\n`]+?)\n([\s\S]*?)```/g;
  const edits = [];
  const seen = new Set();
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const rawPath = match[2].trim();
    const content = match[3];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const normalized = normalizePath(rawPath);
    const matched = allFiles.find(f => normalizePath(f).endsWith(normalized) || normalizePath(f) === normalized);
    if (matched) {
      edits.push({ file: matched, content });
    }
  }
  return edits;
}

export function formatDiff(oldContent, newContent, filePath) {
  if (oldContent === newContent) return null;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const changes = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) {
      const lineNum = i + 1;
      const ctxBefore = Math.max(0, i - 2);
      const ctxAfter = Math.min(max, i + 3);
      let block = '';
      for (let j = ctxBefore; j < ctxAfter; j++) {
        if (j < 0 || j >= max) continue;
        const marker = j === i ? '>' : ' ';
        const oldL = j < oldLines.length ? oldLines[j] : '';
        const newL = j < newLines.length ? newLines[j] : '';
        if (j === i) {
          block += `\x1b[31m- ${oldL}\x1b[0m\n`;
          block += `\x1b[32m+ ${newL}\x1b[0m\n`;
        } else {
          block += `  ${oldL}\n`;
        }
      }
      changes.push({ line: lineNum, block: block.trimEnd() });
    }
  }
  if (changes.length === 0) return null;
  const summary = changes.map(c => `  L${c.line}`).join(', ');
  return `\x1b[1m${filePath}\x1b[0m — ${changes.length} change(s) at ${summary}\n${changes[0].block}` + (changes.length > 1 ? '\n  ...' : '');
}

export async function applyEdit(filePath, content) {
  const old = await readFile(filePath, 'utf-8').catch(() => '');
  await writeFile(filePath, content, 'utf-8');
  return old;
}

export async function getCurrentContent(filePath) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}
