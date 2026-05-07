import { scanDir, readFile } from './fs-utils.js';

const MAX_WINDOWS = 15;
const MAX_CONTEXT_CHARS = 8000;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches an array of files for a pattern, extracts surrounding context
 * windows, and merges overlapping windows.
 *
 * @param {string}   pattern
 * @param {string[]} files
 * @param {number}   contextLines
 * @returns {Promise<{ file: string, windows: object[] }[]>}
 */
export async function grepFiles(pattern, files, contextLines = 20) {
  const re = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'gi');
  const results = [];

  for (const filePath of files) {
    let content;
    try { content = await readFile(filePath); } catch { continue; }

    const lines = content.split('\n');
    const matchIndices = [];

    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      // Skip pure-reference lines (imports, use/require/include in any language).
      // Language-agnostic heuristic: a short line with no call/assignment/definition
      // operators is just a reference, not a site worth showing to the model.
      const trimmed = lines[i].trim();
      const isPureReference = trimmed.length < 80 && !/[({=:]/.test(trimmed);
      if (!isPureReference) matchIndices.push(i);
    }
    if (matchIndices.length === 0) continue;

    // Merge overlapping context windows
    const windows = [];
    let wStart   = Math.max(0, matchIndices[0] - contextLines);
    let wEnd     = Math.min(lines.length - 1, matchIndices[0] + contextLines);
    let wMatches = [matchIndices[0]];

    for (let i = 1; i < matchIndices.length; i++) {
      const nStart = Math.max(0, matchIndices[i] - contextLines);
      const nEnd   = Math.min(lines.length - 1, matchIndices[i] + contextLines);
      if (nStart <= wEnd + 1) {
        wEnd = Math.max(wEnd, nEnd);
        wMatches.push(matchIndices[i]);
      } else {
        windows.push({
          startLine: wStart + 1,
          endLine:   wEnd + 1,
          matchLines: wMatches.map((m) => m + 1),
          text: lines.slice(wStart, wEnd + 1).join('\n'),
        });
        wStart = nStart; wEnd = nEnd; wMatches = [matchIndices[i]];
      }
    }
    windows.push({
      startLine: wStart + 1,
      endLine:   wEnd + 1,
      matchLines: wMatches.map((m) => m + 1),
      text: lines.slice(wStart, wEnd + 1).join('\n'),
    });

    results.push({ file: filePath, windows });
  }

  return results;
}

/**
 * Scans a directory then greps all files.
 */
export async function grepDir(pattern, dir, contextLines = 20) {
  const files = await scanDir(dir);
  return grepFiles(pattern, files, contextLines);
}

/**
 * Pretty-prints grep results to the terminal with ANSI colours.
 * Matching lines are highlighted with a → arrow.
 */
export function formatGrepResults(results, pattern) {
  if (results.length === 0) return `No matches found for "${pattern}".`;

  const totalOccurrences = results.reduce(
    (sum, r) => sum + r.windows.reduce((s, w) => s + w.matchLines.length, 0),
    0,
  );

  const out = [];
  out.push(
    `\x1b[1mFound ${totalOccurrences} occurrence(s) of "${pattern}" in ${results.length} file(s)\x1b[0m\n`,
  );

  for (const { file, windows } of results) {
    for (const win of windows) {
      out.push(`\x1b[36m${file}\x1b[0m  lines ${win.startLine}–${win.endLine}`);
      const fileLines = win.text.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        const lineNum = win.startLine + i;
        const isMatch = win.matchLines.includes(lineNum);
        const marker  = isMatch ? '\x1b[33m→\x1b[0m' : ' ';
        out.push(`  ${marker} ${String(lineNum).padStart(4)} │ ${fileLines[i]}`);
      }
      out.push('');
    }
  }

  return out.join('\n');
}

/**
 * Serialises grep results into a capped context string for the LLM.
 */
export function buildGrepContext(results) {
  let context = '';
  let count   = 0;

  for (const { file, windows } of results) {
    if (count >= MAX_WINDOWS) break;
    for (const win of windows) {
      if (count >= MAX_WINDOWS) break;
      const block = `// File: ${file} (lines ${win.startLine}–${win.endLine})\n${win.text}\n\n`;
      if (context.length + block.length > MAX_CONTEXT_CHARS) break;
      context += block;
      count++;
    }
  }

  return context;
}
