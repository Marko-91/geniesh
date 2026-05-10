import { readFile } from './fs-utils.js';

const MAX_SCOPE_SEARCH_LINES = 20;
const MAX_SCOPE_EXPANSION = 3;

const fileCache = new Map();

export function clearGrepCache() {
  fileCache.clear();
}

async function readWithCache(filePath) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  const content = await readFile(filePath);
  fileCache.set(filePath, content);
  return content;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countBraces(line) {
  let open = 0;
  let close = 0;
  for (const ch of line) {
    if (ch === '{') open++;
    if (ch === '}') close++;
  }
  return { open, close };
}

function findScopeHeader(lines, lineIndex) {
  const headerRE = /\b(?:function|class|if|for|while|switch|try|catch|finally|async|export|const|let|var|=>)\b/;
  const searchStart = Math.max(0, lineIndex - MAX_SCOPE_SEARCH_LINES);

  for (let i = lineIndex; i >= searchStart; i--) {
    const text = lines[i].trim();
    if (!text) continue;
    if (text.endsWith('{') || headerRE.test(text)) return i;
  }
  return null;
}

function findScopeEnd(lines, startIndex) {
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < lines.length; i++) {
    const { open, close } = countBraces(lines[i]);
    if (open > 0) { depth += open; started = true; }
    depth -= close;
    if (started && depth <= 0) return i;
  }
  return null;
}

function getScopeWindow(lines, matchIndex, contextLines) {
  const headerIndex = findScopeHeader(lines, matchIndex);
  if (headerIndex === null) return null;

  let braceLine = headerIndex;
  for (let i = headerIndex; i < Math.min(lines.length, headerIndex + 5); i++) {
    if (lines[i].includes('{')) { braceLine = i; break; }
  }

  const endIndex = findScopeEnd(lines, braceLine);
  if (endIndex === null) return null;
  if (endIndex - headerIndex > contextLines * MAX_SCOPE_EXPANSION) return null;

  return { start: headerIndex, end: endIndex };
}

export async function grepFiles(pattern, files, contextLines = 20, depth = 0) {
  const re = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'gi');
  const results = [];

  for (const filePath of files) {
    let content;
    try { content = await readWithCache(filePath); } catch { continue; }

    const lines = content.split('\n');
    const matchIndices = [];

    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      const trimmed = lines[i].trim();
      const isPureReference = trimmed.length < 80 && !/[({=:]/.test(trimmed);
      if (!isPureReference) matchIndices.push(i);
    }
    if (matchIndices.length === 0) continue;

    const windows = [];
    const firstScope = getScopeWindow(lines, matchIndices[0], contextLines);
    let wStart = firstScope ? firstScope.start : Math.max(0, matchIndices[0] - contextLines);
    let wEnd   = firstScope ? firstScope.end : Math.min(lines.length - 1, matchIndices[0] + contextLines);
    let wMatches = [matchIndices[0]];

    for (let i = 1; i < matchIndices.length; i++) {
      const scope = getScopeWindow(lines, matchIndices[i], contextLines);
      const nStart = scope ? scope.start : Math.max(0, matchIndices[i] - contextLines);
      const nEnd   = scope ? scope.end : Math.min(lines.length - 1, matchIndices[i] + contextLines);
      if (nStart <= wEnd + 1) {
        wEnd = Math.max(wEnd, nEnd);
        wMatches.push(matchIndices[i]);
      } else {
        windows.push({
          startLine: wStart + 1,
          endLine:   wEnd + 1,
          matchLines: wMatches.map(m => m + 1),
          text: lines.slice(wStart, wEnd + 1).join('\n'),
          metadata: { symbol: pattern, hitCount: wMatches.length, depth },
        });
        wStart = nStart; wEnd = nEnd; wMatches = [matchIndices[i]];
      }
    }
    windows.push({
      startLine: wStart + 1,
      endLine:   wEnd + 1,
      matchLines: wMatches.map(m => m + 1),
      text: lines.slice(wStart, wEnd + 1).join('\n'),
      metadata: { symbol: pattern, hitCount: wMatches.length, depth },
    });

    results.push({ file: filePath, windows });
  }

  return results;
}

import { scanDir } from './fs-utils.js';

export async function grepDir(pattern, dir, contextLines = 20) {
  const files = await scanDir(dir);
  return grepFiles(pattern, files, contextLines);
}
