export { grepFiles, grepDir } from '../packages/kernel/src/grep.js';

const MAX_WINDOWS = 15;
const MAX_CONTEXT_CHARS = 8000;

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
