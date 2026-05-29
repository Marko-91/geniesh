import { extname, relative } from 'path';
import { readFile } from '../packages/kernel/src/fs-utils.js';
import { parseFile } from '../packages/kernel/src/parsers/index.js';
import { CodeGraph } from '../packages/kernel/src/graph-engine.js';
import { detectCommunities } from '../packages/kernel/src/community.js';
import { getLanguages, getLanguageForExt } from './languages/index.js';
import { computeBM25 } from './bm25.js';
import { llmRank } from './llm-ranker.js';

const MAX_GREP_RESULTS = 15;
const MAX_BM25_RESULTS = 15;
const MAX_LLM_CANDIDATES = 30;
const TOP_PARSE_FILES = 10;
const DEFAULT_BUDGET = 128000;
const MAX_LINES_PER_FILE = 300;

let _parsedCache = new Map();
let _fileContentCache = new Map();
let _scanCache = null;

export function clearLazyCache() {
  _parsedCache = new Map();
  _fileContentCache = new Map();
  _scanCache = null;
}

async function walkDir(dir, exts) {
  const cacheKey = `${dir}:${exts.join(',')}`;
  if (_scanCache && _scanCache.key === cacheKey) return _scanCache.files;
  const { readdir } = await import('fs/promises');
  const { join: joinPath, extname: getExt } = await import('path');
  const IGNORED = new Set(['node_modules','dist','.git','.next','build','out','coverage',
    '__pycache__','venv','.venv','vendor','.cache','target','.gradle',
    '.idea','.vscode','tmp','temp','bazel-bin','bazel-out','bazel-genfiles',
    'bazel-testlogs','express','flask','gin','ripgrep','zod','monolog','graphify-out']);

  const extSet = new Set(exts);
  const files = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORED.has(entry.name)) continue;
      const fp = joinPath(current, entry.name);
      if (entry.isDirectory()) await walk(fp);
      else if (extSet.has(getExt(entry.name).toLowerCase())) files.push(fp);
    }
  }
  await walk(dir);
  _scanCache = { key: cacheKey, files };
  return files;
}

async function readFileCached(filePath) {
  if (_fileContentCache.has(filePath)) return _fileContentCache.get(filePath);
  const content = await readFile(filePath);
  if (content.length < 500000) _fileContentCache.set(filePath, content);
  return content;
}

function extractQuerySymbols(question, languages) {
  const symbols = [];
  for (const lang of languages) {
    const mod = getLanguages().find(m => m.id === lang.id);
    if (mod && mod.extractSymbols) {
      symbols.push(...mod.extractSymbols(question));
    }
  }
  return [...new Set(symbols)];
}

async function smartGrep(dir, terms, languages) {
  const results = [];
  for (const lang of languages) {
    const mod = getLanguages().find(m => m.id === lang.id);
    if (!mod || !mod.patterns || mod.extensions.length === 0) continue;

    const patterns = mod.patterns(terms);
    if (patterns.length === 0) continue;

    const files = await walkDir(dir, mod.extensions);
    for (const filePath of files) {
      let content;
      try { content = await readFileCached(filePath); }
      catch { continue; }
      const lines = content.split('\n');
      const fileMatches = [];

      for (const pattern of patterns) {
        for (let i = 0; i < Math.min(lines.length, MAX_LINES_PER_FILE); i++) {
          const m = lines[i].match(pattern.regex);
          if (m) {
            fileMatches.push({
              line: i + 1,
              priority: pattern.priority,
              role: pattern.role,
              matchLine: lines[i].trim().substring(0, 200),
            });
          }
        }
      }

      if (fileMatches.length > 0) {
        const bestPriority = Math.max(...fileMatches.map(m => m.priority));
        const roles = [...new Set(fileMatches.map(m => m.role))];
        const grepScore = fileMatches.reduce((sum, m) => {
          const roleMult = roleMultiplier(m.role);
          return sum + m.priority * roleMult;
        }, 0);
        results.push({ file: filePath, grepScore, bestPriority, roles, matches: fileMatches });
      }
    }
  }
  return results.sort((a, b) => b.grepScore - a.grepScore);
}

function roleMultiplier(role) {
  switch (role) {
    case 'definition': case 'interface': case 'function-def': case 'type': return 10;
    case 'import': case 'variable': case 'extends': case 'implements': return 4;
    case 'static-call': case 'instantiation': case 'method-call': return 3;
    case 'type-hint': case 'type-ref': case 'type-check': case 'member-access': return 2;
    case 'docblock': case 'jsdoc': return 1.5;
    default: return 1;
  }
}

async function readMatchedFiles(candidates) {
  const contents = [];
  for (const c of candidates) {
    try {
      const content = await readFileCached(c.file);
      contents.push({ path: c.file, content });
    } catch {
      /* skip unreadable */
    }
  }
  return contents;
}

function unionCandidates(grepCandidates, bm25Results, maxGrep, maxBm25) {
  const grepTop = grepCandidates.slice(0, maxGrep).map(c => c.file);
  const bm25Top = bm25Results.slice(0, maxBm25).map(c => c.file);
  const union = new Set([...grepTop, ...bm25Top]);

  const merged = [];
  for (const file of union) {
    const grep = grepCandidates.find(c => c.file === file);
    const bm25 = bm25Results.find(c => c.file === file);
    merged.push({
      file,
      grepScore: grep ? grep.grepScore : 0,
      bestPriority: grep ? grep.bestPriority : 0,
      roles: grep ? grep.roles : [],
      matches: grep ? grep.matches : [],
      matchLine: grep && grep.matches.length > 0 ? grep.matches[0].matchLine : '',
      bm25Score: bm25 ? bm25.bm25Score : 0,
      topTerms: bm25 ? bm25.topTerms : [],
      isFromGrep: !!grep,
      isFromBm25: !!bm25,
    });
  }
  return merged;
}

async function buildMiniGraph(rankedFiles, dir) {
  const graph = new CodeGraph();

  for (const { file } of rankedFiles) {
    let content;
    try { content = await readFileCached(file); }
    catch { continue; }

    const fileNodeId = `file://${file}`;
    graph.addNode(fileNodeId, { id: fileNodeId, type: 'file', file });

    let result;
    try { result = await parseFile(content, file); }
    catch { continue; }

    if (!result || !result.symbols) continue;

    for (const sym of result.symbols) {
      const symId = `sym://${file}:${sym.name}`;
      graph.addNode(symId, {
        id: symId, type: 'symbol', file,
        name: sym.name, kind: sym.kind,
        lineRange: sym.lineRange, exported: sym.exported,
      });
      graph.addEdge(fileNodeId, symId, 'contains', sym.lineRange);

      for (const ref of (result.references || [])) {
        if (ref.name === sym.name) continue;
        const refSymId = `sym://${file}:${ref.name}`;
        if (!graph.nodes.has(refSymId)) {
          graph.addNode(refSymId, {
            id: refSymId, type: 'symbol', file,
            name: ref.name, kind: 'reference',
            lineRange: ref.lineRange,
          });
        }
        graph.addEdge(symId, refSymId, 'calls', ref.lineRange);
      }
    }

    for (const imp of (result.imports || [])) {
      graph.addEdge(fileNodeId, `module://${imp.module}`, 'imports');
    }

    graph.addEdge(fileNodeId, fileNodeId, 'defines');
  }

  detectCommunities(graph);
  return graph;
}

function bfsFromGraph(graph, queryTerms, maxDepth = 2, maxNodes = 20) {
  const seedNodes = [];
  for (const [id, node] of graph.nodes) {
    if (node.type !== 'symbol') continue;
    const name = node.name || '';
    if (queryTerms.some(t => name.toLowerCase() === t.toLowerCase())) {
      seedNodes.push(id);
    }
    if (seedNodes.length >= 10) break;
  }
  if (seedNodes.length === 0) return [];

  const visited = new Set();
  const results = [];
  let queue = seedNodes.map(id => ({ id, depth: 0 }));

  while (queue.length > 0 && results.length < maxNodes) {
    const { id, depth } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const node = graph.nodes.get(id);
    if (node && node.type === 'symbol') {
      results.push({ symbol: node.name, file: node.file, lineRange: node.lineRange, depth });
    }

    if (depth >= maxDepth) continue;
    const neighbors = graph.adj.get(id) || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.to)) {
        queue.push({ id: edge.to, depth: depth + 1 });
      }
    }
    const revNeighbors = graph.revAdj.get(id) || [];
    for (const edge of revNeighbors) {
      if (!visited.has(edge.from)) {
        queue.push({ id: edge.from, depth: depth + 1 });
      }
    }
  }

  return results;
}

function formatContextSections(sections, budget = DEFAULT_BUDGET) {
  let total = 0;
  const lines = [];
  const used = new Set();

  for (const sec of sections) {
    if (!sec.text || sec.text.length === 0) continue;
    const key = `${sec.file}:${sec.startLine || 0}-${sec.endLine || 0}`;
    if (used.has(key)) continue;
    used.add(key);

    if (total + sec.text.length > budget) break;
    total += sec.text.length;

    lines.push('');
    lines.push(`# ${sec.label || relative(process.cwd(), sec.file).replace(/\\/g, '/')}`);
    if (sec.startLine && sec.endLine) {
      lines.push(`# Lines ${sec.startLine}-${sec.endLine}`);
    }
    lines.push('');
    lines.push(sec.text);
  }

  return lines.join('\n');
}

async function loadFileLines(file, startLine, endLine) {
  const content = await readFileCached(file);
  const allLines = content.split('\n');
  const s = Math.max(0, (startLine || 1) - 1);
  const e = Math.min(allLines.length, endLine || allLines.length);
  return allLines.slice(s, e).join('\n');
}

export async function lazyBuildContext(question, dir, profile, options = {}) {
  const budget = options.budget || DEFAULT_BUDGET;
  const languages = profile.languages;
  const sections = [];
  const trace = [];

  // 1. Extract symbols from question
  const terms = extractQuerySymbols(question, languages);
  const hasSymbols = terms.length > 0;

  if (!hasSymbols) {
    return handleVagueQuery(question, dir, profile, options);
  }

  // 2. Smart grep
  const grepCandidates = await smartGrep(dir, terms, languages);

  if (grepCandidates.length === 0) {
    return handleVagueQuery(question, dir, profile, options);
  }

  // 3. Read matched file contents for BM25
  const fileContents = await readMatchedFiles(grepCandidates.slice(0, 30));

  // 4. BM25
  const bm25Results = computeBM25(terms, fileContents);

  // 5. Union
  const combined = unionCandidates(grepCandidates, bm25Results, MAX_GREP_RESULTS, MAX_BM25_RESULTS);

  // 6. LLM re-rank
  let ranked = combined;
  if (combined.length > 5) {
    const llmCandidates = combined.slice(0, MAX_LLM_CANDIDATES);
    const llmResults = await llmRank(question, llmCandidates);
    if (llmResults && llmResults.length > 0) {
      process.stderr.write(`[re-ranker] top 5:\n${llmResults.slice(0, 5).map(r => `  ${r.file.split('/').pop()}: ${r.score} — ${r.reason}`).join('\n')}\n`);
      ranked = combined.map(c => {
        const llm = llmResults.find(r => r.file === c.file);
        return { ...c, llmScore: llm ? llm.score : 0, llmReason: llm ? llm.reason : '' };
      }).sort((a, b) => (b.llmScore || 0) - (a.llmScore || 0));
    }
  }

  // 7. Add key file contents (high priority)
  for (const kf of profile.keyFiles) {
    if (!kf.path) continue;
    try {
      const content = await readFileCached(kf.path);
      if (content.trim().length > 0) {
        const lines = content.split('\n');
        const maxLines = Math.min(lines.length, 100);
        sections.push({
          file: kf.path, startLine: 1, endLine: maxLines,
          text: lines.slice(0, maxLines).join('\n'),
          label: `Key file: ${kf.name}`,
        });
        trace.push({ file: kf.path, startLine: 1, endLine: maxLines, method: 'profile', symbol: kf.type });
      }
    } catch { /* skip */ }
  }

  // 8. Parse top N and build mini-graph
  const topFiles = ranked.slice(0, TOP_PARSE_FILES);
  const graph = await buildMiniGraph(topFiles.map(c => ({ file: c.file })), dir);

  // 9. Add definition files (highest priority matches)
  for (const c of topFiles) {
    if (c.bestPriority < 80) continue;
    const content = await readFileCached(c.file).catch(() => null);
    if (!content) continue;
    const lines = content.split('\n');

    for (const match of (c.matches || []).slice(0, 3)) {
      const startLine = Math.max(0, match.line - 3);
      const endLine = Math.min(lines.length, match.line + 30);
      const text = lines.slice(startLine, endLine).join('\n');
      sections.push({
        file: c.file, startLine: startLine + 1, endLine,
        text,
        label: `${c.roles[0] || 'match'} — ${relative(process.cwd(), c.file)}`,
      });
      trace.push({ file: c.file, startLine: startLine + 1, endLine, method: 'grep', symbol: terms[0] });
    }
  }

  // 10. BFS on mini-graph
  if (graph && graph.nodes.size > 0) {
    const bfsResults = bfsFromGraph(graph, terms, 2, 15);
    for (const br of bfsResults) {
      if (br.depth === 0) continue;
      if (!br.lineRange) continue;
      const text = await loadFileLines(br.file, br.lineRange[0], br.lineRange[1]).catch(() => '');
      if (text.trim().length > 0) {
        sections.push({
          file: br.file, startLine: br.lineRange[0], endLine: br.lineRange[1],
          text,
          label: `BFS: ${br.symbol} (depth ${br.depth}) — ${relative(process.cwd(), br.file)}`,
        });
        trace.push({ file: br.file, startLine: br.lineRange[0], endLine: br.lineRange[1], method: 'bfs', symbol: br.symbol });
      }
    }
  }

  // 11. Add BM25-only files (high BM25, low grep) that weren't added above
  const addedFiles = new Set(sections.map(s => s.file));
  for (const c of topFiles) {
    if (addedFiles.has(c.file)) continue;
    if (c.bm25Score < 0.1) continue;
    const content = await readFileCached(c.file).catch(() => null);
    if (!content) continue;
    const lines = content.split('\n');
    const maxLen = Math.min(lines.length, 80);
    const text = lines.slice(0, maxLen).join('\n');
    sections.push({
      file: c.file, startLine: 1, endLine: maxLen,
      text,
      label: `BM25 hit — ${relative(process.cwd(), c.file)}`,
    });
    trace.push({ file: c.file, startLine: 1, endLine: maxLen, method: 'rag', symbol: terms.join(', ') });
  }

  // 12. Format context
  const contextString = formatContextSections(sections, budget);
  return { contextString, trace };
}

async function handleVagueQuery(question, dir, profile, options) {
  const budget = options.budget || DEFAULT_BUDGET;
  const sections = [];
  const trace = [];

  // Add key files
  for (const kf of profile.keyFiles) {
    if (!kf.path) continue;
    try {
      const content = await readFileCached(kf.path);
      if (content.trim().length > 0) {
        const lines = content.split('\n');
        const maxLines = Math.min(lines.length, 100);
        sections.push({
          file: kf.path, startLine: 1, endLine: maxLines,
          text: lines.slice(0, maxLines).join('\n'),
          label: `Key file: ${kf.name}`,
        });
        trace.push({ file: kf.path, startLine: 1, endLine: maxLines, method: 'profile', symbol: 'keyfile' });
      }
    } catch { /* skip */ }
  }

  // Try BM25 on all scanned files (top 2 languages only)
  const topLang = profile.languages.slice(0, 2);
  const terms = extractQuerySymbols(question, profile.languages);
  if (terms.length > 0) {
    for (const lang of topLang) {
      const mod = getLanguages().find(m => m.id === lang.id);
      if (!mod || mod.extensions.length === 0) continue;
      const files = await walkDir(dir, mod.extensions);
      const contents = [];
      for (const f of files.slice(0, 100)) {
        try {
          const content = await readFileCached(f);
          contents.push({ path: f, content });
        } catch { /* skip */ }
      }
      const bm25Results = computeBM25(terms, contents);
      for (const r of bm25Results.slice(0, 5)) {
        const content = await readFileCached(r.file).catch(() => null);
        if (!content) continue;
        const lines = content.split('\n');
        const maxLen = Math.min(lines.length, 60);
        sections.push({
          file: r.file, startLine: 1, endLine: maxLen,
          text: lines.slice(0, maxLen).join('\n'),
          label: `BM25 top: ${relative(process.cwd(), r.file)} (score: ${r.bm25Score.toFixed(4)})`,
        });
        trace.push({ file: r.file, startLine: 1, endLine: maxLen, method: 'rag', symbol: terms.join(', ') });
      }
      break;
    }
  }

  const contextString = formatContextSections(sections, budget);
  return { contextString, trace };
}
