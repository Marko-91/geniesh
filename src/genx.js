import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { readFile, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { runGenerate } from './runner.js';

const MAPX_BIN = process.env.MAPX_BIN || 'mapx';
const SNIPPET_RADIUS = 20;
const TOKEN_ESTIMATE_CHARS = 4;
const COMPRESS_THRESHOLD = 0.80;

const NOISE = new Set([
  'the', 'this', 'that', 'with', 'from', 'into', 'onto', 'over', 'under',
  'what', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'does', 'show', 'find', 'look', 'give', 'make', 'call', 'calls',
  'function', 'method', 'class', 'variable', 'symbol', 'code', 'file',
  'how', 'why', 'who', 'can', 'will', 'should', 'would', 'could', 'have',
  'and', 'for', 'not', 'but', 'all', 'any', 'one', 'its', 'add', 'use',
]);

const EXT_LANG = {
  php: 'php', phtml: 'php',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  rs: 'rust', py: 'python',
  go: 'go', rb: 'ruby', java: 'java',
};

function runMapx(root, query, callGraph = false) {
  const args = ['--root', root, '--query', query, '--format', 'json'];
  if (callGraph) args.push('--call-graph');
  let result;
  try {
    result = execFileSync(MAPX_BIN, args, {
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('mapx binary not found. Set MAPX_BIN env var or install mapx.');
    }
    if (err.killed) {
      throw new Error('mapx timed out after 120s');
    }
    const stderr = (err.stderr || '').slice(0, 400);
    throw new Error(`mapx exited ${err.status}: ${stderr}`);
  }
  if (!result.trim()) return { tags: [], callGraph: null };
  try {
    const data = JSON.parse(result);
    if (Array.isArray(data)) return { tags: data, callGraph: null };
    return data;
  } catch (e) {
    throw new Error(`could not parse mapx output: ${e.message}\n${result.slice(0, 200)}`);
  }
}

function readSnippet(fname, line, radius = SNIPPET_RADIUS) {
  try {
    const allLines = readFileSync(fname, 'utf-8').split('\n');
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(allLines.length, line - 1 + radius + 1);
    const snippetLines = allLines.slice(start, end);
    const targetIdx = (line - 1) - start;
    if (targetIdx >= 0 && targetIdx < snippetLines.length) {
      snippetLines[targetIdx] = '▶ ' + snippetLines[targetIdx];
    }
    return snippetLines.join('\n').trimEnd();
  } catch {
    return `  <could not read ${fname}>`;
  }
}

function formatCallChain(callGraph, querySymbols) {
  if (!callGraph) return '';
  const byCaller = {};
  for (const edge of callGraph) {
    const caller = edge.caller || '';
    const callee = edge.callee || '';
    if (caller && callee) {
      (byCaller[caller] ||= []).push(callee);
    }
  }
  const lines = [];
  for (const sym of querySymbols) {
    const matched = Object.keys(byCaller).filter(k => k.toLowerCase() === sym.toLowerCase());
    for (const caller of matched) {
      const callees = byCaller[caller];
      let line = `${caller} → ${callees.slice(0, 8).join(', ')}`;
      if (callees.length > 8) line += ` … (+${callees.length - 8} more)`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function extractSymbols(query) {
  const tokens = query.split(/[\s,;|/\\]+/);
  const symbols = [];
  const seen = new Set();
  for (let tok of tokens) {
    tok = tok.replace(/["'`()\[\]{}.:!?]/g, '').trim();
    if (tok.length < 2) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok)) continue;
    if (NOISE.has(tok.toLowerCase())) continue;
    if (!seen.has(tok)) {
      seen.add(tok);
      symbols.push(tok);
    }
  }
  return symbols.slice(0, 8);
}

function parseHistoryDedupKeys(history) {
  const keys = new Set();
  let currentFile = '';
  for (const line of history.split('\n')) {
    if (line.startsWith('### ')) {
      currentFile = line.slice(4).trim();
    } else if (line.startsWith('> ') && currentFile) {
      const m = line.match(/> (.+) \| score: (\d+) \| symbols: (.+)/);
      if (m) {
        const score = parseInt(m[2], 10);
        for (const role of m[1].split(', ')) {
          for (const symbol of m[3].split(', ')) {
            keys.add(`${currentFile}||${symbol.trim()}||${role.trim()}||${score}`);
          }
        }
      }
    }
  }
  return keys;
}

function estimateTokens(text) {
  return Math.floor(text.length / TOKEN_ESTIMATE_CHARS);
}

async function loadHistory(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function saveHistory(path, text) {
  await writeFile(path, text, 'utf-8');
}

async function appendHistory(path, section) {
  await appendFile(path, section, 'utf-8');
}

async function compressHistory(history, model) {
  const prompt =
    'You are compressing a code context history log.\n' +
    'Rules:\n' +
    '- Keep ALL file paths, line numbers, symbol names, function names, and call chains exactly as-is.\n' +
    '- Compress or remove verbose prose and repeated explanations.\n' +
    '- Preserve the markdown structure (## headers, ### subheaders, code blocks).\n' +
    '- Do NOT invent new information.\n\n' +
    'History to compress:\n\n' +
    history;
  return await runGenerate(prompt, model);
}

function filterHistoryBySymbols(history, symbols) {
  if (!symbols.length || !history) return history;
  const sections = history.split(/\n(?=---\n## )/);
  const pattern = new RegExp(
    symbols.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i',
  );
  const matching = sections.filter(s => pattern.test(s));
  return matching.length ? matching.join('') : history;
}

function buildContextSection(tags, callGraph, query, task, root) {
  const symbols = extractSymbols(query);
  const callChain = formatCallChain(callGraph, symbols);

  const lines = [`## Context: ${query}`];
  if (task) lines.push(`**Task**: ${task}`);
  if (callChain) {
    lines.push('**Call chain**:');
    for (const cl of callChain.split('\n')) lines.push(`  ${cl}`);
  }
  lines.push('');

  const seen = new Set();
  const byFile = {};
  for (const tag of [...tags].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = `${tag.rel_fname}||${tag.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byFile[tag.rel_fname] ||= []).push(tag);
  }

  for (const [relFname, fileTags] of Object.entries(byFile)) {
    const hitLines = [...new Set(fileTags.map(t => t.line))].sort((a, b) => a - b);
    const roles = [...new Set(fileTags.map(t => t.kind))].sort();
    const score = Math.max(...fileTags.map(t => t.score || 0));
    const names = [...new Set(fileTags.map(t => t.name))].sort().join(', ');

    const ext = relFname.includes('.') ? relFname.split('.').pop().toLowerCase() : '';
    const lang = EXT_LANG[ext] || '';

    lines.push(`### ${relFname}`);
    lines.push(`> ${roles.join(', ')} | score: ${Math.round(score)} | symbols: ${names}`);

    const fname = fileTags[0].fname || join(root, relFname);
    let allLines;
    try {
      allLines = readFileSync(fname, 'utf-8').split('\n');
    } catch {
      lines.push('```\n<could not read file>\n```\n');
      continue;
    }

    const intervals = hitLines.map(hl => [
      Math.max(0, hl - 1 - SNIPPET_RADIUS),
      Math.min(allLines.length, hl - 1 + SNIPPET_RADIUS + 1),
    ]);

    const merged = [];
    for (const [s, e] of intervals.sort((a, b) => a[0] - b[0])) {
      if (merged.length && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }

    const snippets = merged.map(([s, e]) => {
      const chunk = allLines.slice(s, e);
      for (const hl of hitLines) {
        const idx = (hl - 1) - s;
        if (idx >= 0 && idx < chunk.length && !chunk[idx].startsWith('▶ ')) {
          chunk[idx] = '▶ ' + chunk[idx];
        }
      }
      return chunk.join('\n').trimEnd();
    });

    lines.push(`\`\`\`${lang}`);
    lines.push(snippets.join('\n\n… (gap) …\n\n'));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export async function runGenx(query, task, root, { compressModel, model, window } = {}) {
  const historyPath = join(root, '.genx_history.md');
  const compress_model = compressModel || model || '';
  const window_tokens = window || 32_000;

  // 1. Run mapx
  process.stderr.write(`\x1b[90m[genx] running mapx…\x1b[0m\n`);
  let data;
  try {
    data = runMapx(root, query, true);
  } catch (err) {
    throw new Error(`genx failed: ${err.message}`);
  }
  const tags = data.tags || [];
  const callGraph = data.callGraph || null;

  if (!tags.length) {
    process.stderr.write(`\x1b[90m[genx] no results from mapx\x1b[0m\n`);
    return '';
  }

  // 2. Assemble context section
  const contextSection = buildContextSection(tags, callGraph, query, task || '', root);

  // 3. Build history entry
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const symbols = extractSymbols(query);
  const symbolStr = symbols.join(', ');
  const hitFiles = [...new Set(tags.slice(0, 10).map(t => t.rel_fname))].sort().join(', ');

  let historyEntry = `\n---\n## [${timestamp}] ${symbolStr}\n**Task**: ${task || ''}\n**Root**: ${root}\n**Files hit**: ${hitFiles}\n\n${contextSection}\n`;

  // 4. Load history, check token budget
  let history = await loadHistory(historyPath);
  const historyTokens = estimateTokens(history);

  if (historyTokens > 0 && compress_model) {
    const usageRatio = historyTokens / window_tokens;
    if (usageRatio >= COMPRESS_THRESHOLD) {
      process.stderr.write(`\x1b[90m[genx] history at ${Math.round(usageRatio * 100)}% of window (${historyTokens.toLocaleString()} tokens) — compressing…\x1b[0m\n`);
      try {
        const compressed = await compressHistory(history, compress_model);
        if (compressed) {
          history = compressed;
          await saveHistory(historyPath, history);
          process.stderr.write(`\x1b[90m[genx] history compressed and rewritten\x1b[0m\n`);
        }
      } catch (err) {
        process.stderr.write(`\x1b[90m[genx] compression failed: ${err.message}\x1b[0m\n`);
      }
    }
  }

  // 5. Dedup tags against history
  if (history) {
    const existingKeys = parseHistoryDedupKeys(history);
    const newTags = tags.filter(t => {
      const key = `${t.rel_fname}||${t.name}||${t.kind || ''}||${Math.round(t.score || 0)}`;
      return !existingKeys.has(key);
    });

    if (newTags.length && newTags.length < tags.length) {
      const newContext = buildContextSection(newTags, callGraph, query, task || '', root);
      const newHitFiles = [...new Set(newTags.slice(0, 10).map(t => t.rel_fname))].sort().join(', ');
      historyEntry = `\n---\n## [${timestamp}] ${symbolStr}\n**Task**: ${task || ''}\n**Root**: ${root}\n**Files hit**: ${newHitFiles}\n\n${newContext}\n`;
      await appendHistory(historyPath, historyEntry);
      process.stderr.write(`\x1b[90m[genx] appended ${newTags.length} new tag(s) to ${historyPath} (${tags.length} total)\x1b[0m\n`);
    } else if (newTags.length) {
      await appendHistory(historyPath, historyEntry);
      process.stderr.write(`\x1b[90m[genx] appended to ${historyPath}\x1b[0m\n`);
    } else {
      process.stderr.write(`\x1b[90m[genx] all ${tags.length} tags already in history — skipped append\x1b[0m\n`);
    }
  } else {
    await appendHistory(historyPath, historyEntry);
    process.stderr.write(`\x1b[90m[genx] appended to ${historyPath}\x1b[0m\n`);
  }

  // 6. Build output for LLM
  const priorSymbolsFound = history ? filterHistoryBySymbols(history, symbols).trim().length > 0 : false;
  let body;
  if (priorSymbolsFound) {
    const relevantHistory = filterHistoryBySymbols(history, symbols);
    body = relevantHistory.trim() + '\n\n' + historyEntry.trim();
  } else {
    body = (history.trim() + '\n\n' + historyEntry.trim()).trim();
  }

  const taskLine = task || '(no task specified)';
  const symbolDisplay = symbols.length ? symbols.join(', ') : query;
  const preamble = [
    'You are a senior software engineer. Read the document below carefully before responding.',
    '',
    '## How to read this document',
    '',
    '**History sections** (entries with ISO timestamps in headings): prior coding sessions on this',
    'codebase. They show what was explored, what decisions were made, and what files were touched.',
    'Use them as background — do not treat them as the current task.',
    '',
    `**Current context section** (the last entry, timestamp ${timestamp}): fresh code snippets`,
    `fetched by mapx for the symbol(s): \`${symbolDisplay}\`.`,
    'Lines marked with `▶` are the exact matched lines. All other lines are surrounding context.',
    '',
    '## Your task',
    '',
    taskLine,
    '',
    '## Rules',
    '',
    '- Every claim about code MUST cite the exact file and line number shown in the context.',
    '- If a file or line is not in the context, say so clearly — do not invent paths or numbers.',
    '- Prefer minimal, targeted changes. Do not refactor unrelated code.',
    '- If you produce edits, use SEARCH/REPLACE blocks:',
    '      path/to/file.ext',
    '      SEARCH',
    '      <exact existing lines>',
    '      REPLACE',
    '      <new lines>',
    '- If you need to run a shell command, wrap it in a ```bash fence and it will be executed.',
    '- If the context is insufficient, output on its own line:',
    '      REQUERY <symbol_or_symbols>',
    '  and the pipeline will fetch more context for those symbols.',
    '',
    '---',
    '',
  ].join('\n');

  return preamble + body;
}

export async function printHistory(historyPath, { symbols } = {}) {
  let history = await loadHistory(historyPath);
  if (!history) {
    console.log(`[genx] no history at ${historyPath}`);
    return;
  }
  if (symbols) {
    const syms = extractSymbols(symbols);
    history = filterHistoryBySymbols(history, syms);
  }
  console.log(history);
}
