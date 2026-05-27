import { readFile, writeFile } from 'fs/promises';

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function findFile(rawPath, allFiles) {
  const norm = normalizePath(rawPath).replace(/['"]/g, '');
  // Direct match
  let m = allFiles.find(f => normalizePath(f) === norm);
  if (m) return m;
  // Ends-with match
  m = allFiles.find(f => normalizePath(f).endsWith(norm) || normalizePath(f).endsWith('/' + norm));
  if (m) return m;
  // Basename match
  const base = norm.split('/').pop();
  m = allFiles.find(f => f.split(/[/\\]/).pop().toLowerCase() === base);
  return m;
}

// Parse search/replace blocks in Aider format:
// path/to/file
// ```search/replace  or  SEARCH / REPLACE markers
export function parseSearchReplace(text, allFiles) {
  // Format:
  // file/path.js
  // SEARCH
  // old text
  // REPLACE
  // new text
  const blocks = [];
  const blockRe = /^([^\n]+)\nSEARCH\n([\s\S]*?)REPLACE\n([\s\S]*?)(?=\n\n\S|\nSEARCH|$)/gm;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const search = match[2].trimEnd();
    const replace = match[3].trimEnd();
    if (!rawPath || !search) continue;
    const file = findFile(rawPath, allFiles);
    if (file) {
      blocks.push({ type: 'search-replace', file, search, replace });
    }
  }
  return blocks;
}

// Parse full-file edits: ```lang:filepath content ``` or
// file mentioned before code block
export function parseFullFileEdits(text, allFiles) {
  const edits = [];
  const seen = new Set();

  // Pattern 1: ```lang:filepath or ```:filepath
  const re1 = /```(\w[\w+-]*)?\s*:\s*([^\n`]+?)\n([\s\S]*?)```/g;
  let match;
  while ((match = re1.exec(text)) !== null) {
    const rawPath = match[2].trim();
    const content = match[3];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = findFile(rawPath, allFiles);
    if (file) edits.push({ file, content });
  }

  // Pattern 2: code block with file path mentioned in preceding text
  // e.g. "edit `lib/app.js`:\n```js\ncontent\n```"
  const re2 = /(?:in|for|edit|update|change|modify)\s+[`'\"]?([^\s`'\"]+(?:\.[a-z]+)+)[`'\"]?[^]*?\n```(?:\w+)?\n([\s\S]*?)```/gi;
  while ((match = re2.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = findFile(rawPath, allFiles);
    if (file) edits.push({ file, content });
  }

  return edits;
}

export function parseFileEdits(text, allFiles) {
  const edits = [];

  // Search/replace blocks take priority
  const sr = parseSearchReplace(text, allFiles);
  edits.push(...sr.map(e => ({ ...e, type: 'sr' })));

  // Full-file edits
  const ff = parseFullFileEdits(text, allFiles);
  edits.push(...ff.map(e => ({ ...e, type: 'full' })));

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
        if (j >= max) continue;
        if (j === i) {
          block += `\x1b[31m- ${oldLines[j]}\x1b[0m\n`;
          block += `\x1b[32m+ ${newLines[j]}\x1b[0m\n`;
        } else {
          block += `  ${oldLines[j]}\n`;
        }
      }
      changes.push({ line: lineNum, block, ctxBefore, ctxAfter });
    }
  }
  if (changes.length === 0) return null;
  const summary = changes.map(c => `L${c.line}`).join(', ');
  return `\x1b[1m${filePath}\x1b[0m — ${changes.length} change(s) at ${summary}\n${changes[0].block}` + (changes.length > 1 ? '\n  ...' : '');
}

export function formatSearchReplaceDiff(file, search, replace) {
  return `\x1b[1m${file}\x1b[0m — search/replace\n` +
    `\x1b[31m- ${search.split('\n')[0]}${search.includes('\n') ? ' …' : ''}\x1b[0m\n` +
    `\x1b[32m+ ${replace.split('\n')[0]}${replace.includes('\n') ? ' …' : ''}\x1b[0m`;
}

export async function applySearchReplace(file, search, replace) {
  const content = await readFile(file, 'utf-8');
  if (!content.includes(search)) {
    throw new Error(`Search text not found in ${file}`);
  }
  const newContent = content.replace(search, replace);
  await writeFile(file, newContent, 'utf-8');
  return content;
}

export async function applyFullFileEdit(file, content) {
  const old = await readFile(file, 'utf-8').catch(() => '');
  await writeFile(file, content, 'utf-8');
  return old;
}
