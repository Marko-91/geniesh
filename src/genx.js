import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const MAPX_BIN = process.env.MAPX_BIN || 'mapx';
const SNIPPET_RADIUS = 20;
const MAX_HIT_FILES = 5;

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
    if (err.killed) throw new Error('mapx timed out after 120s');
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

function formatCallChain(callGraph, querySymbols, tagNames = []) {
  if (!callGraph) return '';
  const byCaller = {};
  const byCallee = {};
  for (const edge of callGraph) {
    const caller = edge.caller || '';
    const callee = edge.callee || '';
    if (caller && callee) {
      (byCaller[caller] ||= []).push(callee);
      (byCallee[callee] ||= []).push(caller);
    }
  }
  const allNames = [...new Set([...querySymbols, ...tagNames])];
  const matched = allNames.filter(s => byCaller[s] || byCallee[s]);
  const lines = [];
  for (const sym of matched) {
    const calls = byCaller[sym];
    const calledBy = byCallee[sym];
    if (calledBy) {
      lines.push(`${calledBy.slice(0, 8).join(', ')} → ${sym}`);
      if (calledBy.length > 8) lines[lines.length - 1] += ` … (+${calledBy.length - 8} more)`;
    }
    if (calls) {
      lines.push(`${sym} → ${calls.slice(0, 8).join(', ')}`);
      if (calls.length > 8) lines[lines.length - 1] += ` … (+${calls.length - 8} more)`;
    }
  }
  return lines.join('\n');
}

function buildContextSection(tags, callGraph, query, root) {
  const symbols = extractSymbols(query);
  const tagNames = [...new Set(tags.map(t => t.name).filter(Boolean))];
  const callChain = formatCallChain(callGraph, symbols, tagNames);

  const lines = [`## Context: ${query}`];
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
    const names = [...new Set(fileTags.map(t => t.name))].sort().join(', ');

    const ext = relFname.includes('.') ? relFname.split('.').pop().toLowerCase() : '';
    const lang = EXT_LANG[ext] || '';

    lines.push(`### ${relFname}`);
    lines.push(`> ${roles.join(', ')} | symbols: ${names}`);

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

export async function runGenx(query, root) {
  process.stderr.write(`\x1b[90m[genx] mapx…\x1b[0m\n`);
  let data;
  try {
    data = runMapx(root, query, true);
  } catch (err) {
    throw new Error(`genx failed: ${err.message}`);
  }
  const tags = data.tags || [];
  const callGraph = data.callGraph || null;

  if (!tags.length) {
    process.stderr.write(`\x1b[90m[genx] no results\x1b[0m\n`);
    return { content: '', hitFiles: [] };
  }

  const contextSection = buildContextSection(tags, callGraph, query, root);

  const seenFiles = new Set();
  const hitFileList = [];
  for (const tag of tags) {
    if (tag.rel_fname && !seenFiles.has(tag.rel_fname)) {
      seenFiles.add(tag.rel_fname);
      hitFileList.push(tag.rel_fname);
      if (hitFileList.length >= MAX_HIT_FILES) break;
    }
  }

  return { content: contextSection, hitFiles: hitFileList };
}
