import { basename, extname, relative } from 'path';
import { search } from './search.js';
import { grepFiles } from './grep.js';

// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_BUDGET     = 10000; // max chars of code context per turn
const MAX_CHAT_TURNS     = 8;     // sliding window: keep last N user/assistant pairs
const RAG_TOP_K          = 8;     // cosine candidates to consider
const GREP_CONTEXT_LINES = 15;    // lines around each grep match
const GREP_MAX_DEPTH     = 2;     // transitive grep: depth 0 = question symbols, depth 1 = symbols found in results
const GREP_MAX_PER_DEPTH = 6;     // max new symbols to expand at each depth level
const RAG_TOP_FILES      = 12;    // max files from RAG to prioritize for grep

// Priority-1 filenames (loaded first, regardless of score)
const PRIORITY_NAMES = new Set([
  'readme.md', 'contributing.md', 'architecture.md', 'overview.md',
  'guide.md', 'docs.md', 'api.md', 'changelog.md',
]);

// ─── Symbol extraction ──────────────────────────────────────────────────────────
// Only matches structurally identifiable code symbols — plain English words are
// excluded by requiring interior uppercase, underscores, or dots.
//
//   camelCase:   streamResponse, buildIndex, runChat
//   PascalCase:  StreamingMarkdownParser, MyClass  (must have ≥2 humps)
//   snake_case:  build_index, run_query
//   dotted:      config.path, req.body.id
//
const SYMBOL_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +          // camelCase
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +           // PascalCase (≥2 humps)
  '|[a-z][a-z0-9]+_[a-z][a-z0-9_]+' +           // snake_case
  '|[a-z][a-z0-9]+(?:\\.[a-z][a-z0-9]+)+' +     // dotted.path
  '|[A-Z]{2,}(?:_[A-Z0-9]+)+' +                 // ALL_CAPS_CONSTANT
  ')\\b',
  'g',
);

// Depth-1 discovery: only camelCase and PascalCase are promoted from grep results.
// snake_case is data (DB columns, config keys). dotted paths may be domains/URLs.
// ALL_CAPS are usually constants defined in the same file — not worth following transitively.
const DISCOVERY_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +          // camelCase only
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +           // PascalCase only
  ')\\b',
  'g',
);

// Domain / URL / file-extension filter for dotted.path symbols at any depth
const DOMAIN_RE = /\.(com|net|org|io|co|php|js|ts|html|css|json|md|txt|edu|gov|app|dev)(\.|$)/i;

export function extractSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)]
    .filter(s => !DOMAIN_RE.test(s))
    .slice(0, 6);
}

// Narrower extraction used only when discovering depth-1 symbols from grep results
function extractDiscoverySymbols(text) {
  const raw = [...text.matchAll(DISCOVERY_RE)].map(m => m[1]);
  return [...new Set(raw)].slice(0, GREP_MAX_PER_DEPTH);
}

// ─── Index sorting ──────────────────────────────────────────────────────────────
function fileTier(filePath) {
  const name = basename(filePath).toLowerCase();
  if (PRIORITY_NAMES.has(name)) return 0;           // tier 1: named docs
  if (extname(name) === '.md') return 1;             // tier 2: other markdown
  return 2;                                          // tier 3: code files
}

function sortedIndex(index) {
  return [...index].sort((a, b) => {
    const ta = fileTier(a.file);
    const tb = fileTier(b.file);
    return ta !== tb ? ta - tb : 0;
  });
}

/**
 * Formats retrieval trace metadata into a human-readable summary with depth organization.
 *
 * @param {object[]} trace          Array of { file, startLine, endLine, method, score, symbol, hitCount, depth }
 * @param {string[]} [depthLogs]    Debug logs from grep depths (optional)
 * @param {string}   [projectRoot]  Project root for relative paths (defaults to cwd)
 * @returns {string}  Formatted trace output
 */
function formatRetrievalTrace(trace, depthLogs = [], projectRoot = process.cwd()) {
  if (trace.length === 0) return '';

  const lines = ['📌 \x1b[90mRetrieval trace:\x1b[0m'];

  // Separate RAG and grep results
  const ragResults = trace.filter(e => e.method === 'rag');
  const grepByDepth = {};
  
  trace.filter(e => e.method.startsWith('grep-d')).forEach(e => {
    const depth = parseInt(e.method.slice(-1));
    if (!grepByDepth[depth]) grepByDepth[depth] = [];
    grepByDepth[depth].push(e);
  });

  // Show RAG results first
  for (const entry of ragResults) {
    const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
    const lineNum = `\x1b[36m${entry.startLine}–${entry.endLine}\x1b[0m`;
    lines.push(`  \x1b[90m${relPath}:${lineNum}  RAG (score: ${(entry.score || 0).toFixed(2)})\x1b[0m`);
  }

  // Show grep results organized by depth
  for (const depth of Object.keys(grepByDepth).sort((a, b) => a - b)) {
    const depthNum = parseInt(depth);
    const grepResults = grepByDepth[depthNum].sort((a, b) => a.file.localeCompare(b.file));

    // Find and show the grep query log for this depth
    const grepLog = depthLogs.find(l => l.includes(`[depth ${depthNum}] grepping:`));
    if (grepLog) {
      lines.push(`  \x1b[90m${grepLog}\x1b[0m`);
    }

    // Show each grep result with colored line numbers
    for (const entry of grepResults) {
      const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
      const lineNum = `\x1b[33m${entry.startLine}–${entry.endLine}\x1b[0m`;
      const hitCount = `\x1b[35m${entry.hitCount}\x1b[0m`;
      lines.push(`    \x1b[90m${relPath}:${lineNum}  grep-d${depthNum} (${hitCount} hit${entry.hitCount > 1 ? 's' : ''})${entry.symbol ? ` [${entry.symbol}]` : ''}\x1b[0m`);
    }

    const addedLog = depthLogs.find(l => l.includes(`[depth ${depthNum}] added `));
    if (addedLog) {
      lines.push(`  \x1b[90m${addedLog}\x1b[0m`);
    }

    // Show discovered symbols log for next depth
    if (depthNum + 1 <= Math.max(...Object.keys(grepByDepth).map(Number))) {
      const discoveryLog = depthLogs.find(l => l.includes(`[depth ${depthNum}→${depthNum + 1}]`));
      if (discoveryLog) {
        lines.push(`  \x1b[90m${discoveryLog}\x1b[0m`);
      }
    }
  }

  return lines.join('\n');
}

function shortenPath(pathStr, maxSegments = 4) {
  const parts = pathStr.split('/');
  if (parts.length <= maxSegments) return pathStr;
  return `.../${parts.slice(-maxSegments).join('/')}`;
}

// ─── Context builder ─────────────────────────────────────────────────────────────
/**
 * Builds a code context string for the current chat turn.
 *
 * Priority order (greedy, stops when budget exhausted):
 *   1. Transitive grep: depth-0 symbols from question → depth-1 symbols
 *      discovered inside grep results (up to GREP_MAX_DEPTH levels)
 *   2. MD-prioritised RAG chunks to fill remaining budget
 *
 * @param {string}   question    Current user message
 * @param {object[]} index       Full RAG index
 * @param {string[]} allFiles    All scannable files (for grep)
 * @returns {Promise<{ contextString: string, log: string[], trace: object[] }>}
 */
export async function buildChatContext(question, index, allFiles) {
  const budget   = CONTEXT_BUDGET;
  let   used     = 0;
  const sections = [];
  const seen     = new Set();  // deduplicate by "file:startLine"
  const log      = [];         // human-readable depth log lines
  const trace    = [];         // retrieval method tracing

  function tryAdd(file, startLine, endLine, text, label, traceMetadata) {
    const key = `${file}:${startLine}`;
    if (seen.has(key)) return false;
    const block = `// ${label || file} (lines ${startLine}–${endLine})\n${text}\n`;
    if (used + block.length > budget) return false;
    sections.push(block);
    seen.add(key);
    used += block.length;
    if (traceMetadata) {
      trace.push({ file, startLine, endLine, ...traceMetadata });
    }
    return true;
  }

  // ── Tier 1: transitive grep ─────────────────────────────────────────────────
  const depth0 = extractSymbols(question);

  // Get top RAG files to prioritize for grep
  const ragScored = await search(question, index, RAG_TOP_K);
  const ragFiles = [...new Set(ragScored.map(c => c.file))].slice(0, RAG_TOP_FILES);

  if (depth0.length > 0 && allFiles.length > 0) {
    const greppedSymbols = new Set(); // track what we've already grepped across all depths

    let frontier = depth0; // symbols to grep at the current depth

    for (let depth = 0; depth < GREP_MAX_DEPTH; depth++) {
      const toGrep = frontier.filter(s => !greppedSymbols.has(s));
      if (toGrep.length === 0) break;

      log.push(`  [depth ${depth}] grepping: ${toGrep.join(', ')}`);

      const discoveredTexts = []; // raw text of all windows found at this depth
      let hitsThisDepth = 0;

      for (const sym of toGrep) {
        if (used >= budget) break;
        greppedSymbols.add(sym);

        // First try grep in top RAG files, then fall back to all files
        let results;
        try {
          results = await grepFiles(sym, ragFiles, GREP_CONTEXT_LINES, depth);
          if (results.length === 0) {
            results = await grepFiles(sym, allFiles, GREP_CONTEXT_LINES, depth);
          }
        } catch {
          continue;
        }

        for (const { file, windows } of results) {
          for (const win of windows) {
            const metadata = {
              method: `grep-d${depth}`,
              symbol: sym,
              hitCount: win.metadata?.hitCount || 1,
              depth,
            };
            if (tryAdd(file, win.startLine, win.endLine, win.text, `${file} [d${depth}: ${sym}]`, metadata)) {
              discoveredTexts.push(win.text);
              hitsThisDepth++;
            }
            if (used >= budget) break;
          }
          if (used >= budget) break;
        }
      }

      log.push(`  [depth ${depth}] added ${hitsThisDepth} window(s), budget used: ${used}/${budget}`);

      if (depth + 1 < GREP_MAX_DEPTH && used < budget) {
        // Depth-1+: only camelCase/PascalCase promoted — snake_case and dotted are data noise
        const combined = discoveredTexts.join('\n');
        const newSymbols = extractDiscoverySymbols(combined)
          .filter(s => !greppedSymbols.has(s));

        if (newSymbols.length > 0) {
          log.push(`  [depth ${depth}→${depth + 1}] discovered: ${newSymbols.join(', ')}`);
        }
        frontier = newSymbols;
      }
    }
  }

  // ── Tier 2: MD-prioritised RAG chunks (fill remaining budget) ──────────────
  const scored = ragScored; // reuse the already computed RAG results
  const sorted = sortedIndex(index);

  const scoredKeys = new Set(scored.map(c => `${c.file}:${c.startLine}`));
  for (const entry of sorted) {
    if (used >= budget) break;
    const key = `${entry.file}:${entry.startLine}`;
    if (scoredKeys.has(key)) {
      const ragMetadata = scored.find(s => s.file === entry.file && s.startLine === entry.startLine);
      tryAdd(entry.file, entry.startLine, entry.endLine, entry.chunk, undefined, {
        method: 'rag',
        score: ragMetadata?.score || 0,
      });
    }
  }
  for (const c of scored) {
    if (used >= budget) break;
    tryAdd(c.file, c.startLine, c.endLine, c.chunk, undefined, {
      method: 'rag',
      score: c.score || 0,
    });
  }

  return {
    contextString: sections.join('\n---\n\n'),
    log,
    trace,
    traceFormatted: formatRetrievalTrace(trace, log, process.cwd()),
  };
}

// ─── Sliding window ─────────────────────────────────────────────────────────────
/**
 * Enforces a sliding window over the messages array.
 * Always keeps messages[0] (system prompt).
 * Evicts the oldest [user, assistant] pair when over the limit.
 *
 * @param {object[]} messages  mutated in place
 */
export function applySlideWindow(messages) {
  // messages[0] = system, then alternating user/assistant pairs
  while (messages.length > 1 + MAX_CHAT_TURNS * 2) {
    messages.splice(1, 2);  // drop oldest user + assistant
  }
}
