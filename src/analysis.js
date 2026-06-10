import { join } from 'path';
import { search } from './search.js';
import { readFile } from './fs-utils.js';
import { runGenx } from './genx.js';

const NOISE = new Set([
  'the', 'this', 'that', 'with', 'from', 'into', 'onto', 'over', 'under',
  'what', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'does', 'show', 'find', 'look', 'give', 'make', 'call', 'calls',
  'function', 'method', 'class', 'variable', 'symbol', 'code', 'file',
  'how', 'why', 'who', 'can', 'will', 'should', 'would', 'could', 'have',
  'and', 'for', 'not', 'but', 'all', 'any', 'one', 'its', 'add', 'use',
]);

function extractSymbolsFromChunks(results) {
  const symbols = [];
  const seen = new Set();
  const declPat = /(?:function|class|const|let|var)\s+([A-Za-z_]\w+)/g;
  for (const r of results) {
    let m;
    while ((m = declPat.exec(r.chunk)) !== null) {
      const name = m[1];
      if (!seen.has(name)) { seen.add(name); symbols.push(name); }
    }
    const idPat = /\b([A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]+)\b/g;
    while ((m = idPat.exec(r.chunk)) !== null) {
      const name = m[1];
      if (name.length >= 3 && !NOISE.has(name.toLowerCase()) && !seen.has(name)) {
        seen.add(name); symbols.push(name);
      }
    }
  }
  return symbols.slice(0, 8);
}

function extractSymbols(text) {
  const tokens = text.split(/[\s,;|/\\]+/);
  const symbols = [];
  const seen = new Set();
  for (let tok of tokens) {
    tok = tok.replace(/["'`()\[\]{}.:!?]/g, '').trim();
    if (tok.length < 2) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok)) continue;
    if (NOISE.has(tok.toLowerCase())) continue;
    if (!seen.has(tok)) { seen.add(tok); symbols.push(tok); }
  }
  return symbols.slice(0, 8);
}

export async function analyzeCode(question, dir, ragIndex) {
  let symbols = extractSymbols(question);

  // Use RAG only as a symbol hint source, NOT for file loading.
  // RAG's semantic search is unreliable for code; mapx understands code structure far better.
  if (ragIndex && Array.isArray(ragIndex) && ragIndex.length) {
    try {
      const results = await search(question, ragIndex, 8);
      const ragSymbols = extractSymbolsFromChunks(results);
      const seen = new Set(symbols);
      for (const s of ragSymbols) {
        if (!seen.has(s)) { seen.add(s); symbols.push(s); }
      }
    } catch {}
  }

  // genx/mapx is the primary file discoverer — it uses code structure (call graphs, symbols)
  // Only use code-like symbols (PascalCase or camelCase) for genx.
  // Lowercase English words like "dispatch" or "requests" match too many files.
  const codeSymbols = symbols.filter(s => /[A-Z]/.test(s));
  const querySymbols = codeSymbols.length ? codeSymbols : symbols.slice(0, 2);

  let genxContent = '';
  let genxFiles = [];
  if (querySymbols.length) {
    try {
      const result = await runGenx(querySymbols.slice(0, 4).join(', '), dir);
      genxContent = result.content;
      genxFiles = (result.hitFiles || []).filter(f => !/^tests\/|\/tests\/|\/vendor\/|\/node_modules\//.test(f));
    } catch {}
  }

  const hitFiles = genxFiles.slice(0, 5);

  let fileContent = '';
  for (const file of hitFiles) {
    const absPath = file.startsWith('/') ? file : join(dir, file);
    try {
      const content = await readFile(absPath);
      fileContent += `## File: ${file}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
    } catch {}
  }

  return { genxContent, fileContent, hitFiles };
}
