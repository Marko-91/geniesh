import { basename, extname, relative } from 'path';
import { search } from './search.js';
import { grepFiles } from './grep.js';
import { extractSymbols } from './symbol-utils.js';

// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_BUDGET     = 10000; // max chars of code context per turn
const MAX_CHAT_TURNS     = 8;     // sliding window: keep last N user/assistant pairs
const RAG_TOP_K          = 8;     // cosine candidates to consider
const GREP_CONTEXT_LINES = 15;    // lines around each grep match
const RAG_TOP_FILES      = 12;    // max files from RAG to prioritize for grep

// Priority-1 filenames (loaded first, regardless of score)
const PRIORITY_NAMES = new Set([
  'readme.md', 'changelog.md', 'contributing.md', 'license',
  'instructions.md', // .github/instructions.md — project conventions
]);

// ─── Symbol extraction ──────────────────────────────────────────────────────────
// Imported from symbol-utils.js:
//   extractSymbols()          — broad extraction for user questions

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

  // Separate RAG and BFS results
  const ragResults = trace.filter(e => e.method === 'rag');
  const bfsByRound = {};

  trace.filter(e => e.method.startsWith('bfs-')).forEach(e => {
    const round = parseInt(e.method.slice(4));
    if (!bfsByRound[round]) bfsByRound[round] = [];
    bfsByRound[round].push(e);
  });

  // Show RAG results first
  for (const entry of ragResults) {
    const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
    const lineNum = `\x1b[36m${entry.startLine}–${entry.endLine}\x1b[0m`;
    lines.push(`  \x1b[90m${relPath}:${lineNum}  RAG (score: ${(entry.score || 0).toFixed(2)})\x1b[0m`);
  }

  // Show BFS results organized by round
  for (const round of Object.keys(bfsByRound).sort((a, b) => a - b)) {
    const roundNum = parseInt(round);
    const bfsResults = bfsByRound[roundNum].sort((a, b) => a.file.localeCompare(b.file));

    // Find and show the BFS query log for this round
    const bfsLog = depthLogs.find(l => l.includes(`[bfs ${roundNum}] symbols:`));
    if (bfsLog) {
      lines.push(`  \x1b[90m${bfsLog}\x1b[0m`);
    }

    for (const entry of bfsResults) {
      const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
      const lineNum = `\x1b[33m${entry.startLine}–${entry.endLine}\x1b[0m`;
      const hitCount = `\x1b[35m${entry.hitCount}\x1b[0m`;
      lines.push(`    \x1b[90m${relPath}:${lineNum}  bfs-${roundNum} (${hitCount} hit${entry.hitCount > 1 ? 's' : ''})${entry.symbol ? ` [${entry.symbol}]` : ''}\x1b[0m`);
    }

    const addedLog = depthLogs.find(l => l.includes(`[bfs ${roundNum}] added `));
    if (addedLog) {
      lines.push(`  \x1b[90m${addedLog}\x1b[0m`);
    }

    // Show discovered symbols log for next round
    if (roundNum + 1 <= Math.max(...Object.keys(bfsByRound).map(Number))) {
      const discoveryLog = depthLogs.find(l => l.includes(`[bfs ${roundNum}→${roundNum + 1}]`));
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
 *   1. BFS traversal: relation-guided grep (budget-limited, no depth cap)
 *   2. MD-prioritised RAG chunks to fill remaining budget
 *
 * @param {string}   question    Current user message
 * @param {object[]} index       Full RAG index
 * @param {string[]} allFiles    All scannable files (for grep)
 * @returns {Promise<{ contextString: string, log: string[], trace: object[] }>}
 */
export async function buildChatContext(question, index, allFiles, relations) {
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

  // ── Tier 1: relation-guided BFS (budget-limited) ──────────────────────────
  let seedSymbols = extractSymbols(question);

  const ragScored = await search(question, index, RAG_TOP_K);
  const ragFiles = [...new Set(ragScored.map(c => c.file))].slice(0, RAG_TOP_FILES);

  // If question has no code symbols, seed BFS from symbols in top RAG chunks
  if (seedSymbols.length === 0 && relations) {
    const ragSymbols = new Set();
    for (const c of ragScored.slice(0, 3)) {
      const fileSyms = relations.byFile[c.file];
      if (fileSyms) fileSyms.forEach(s => ragSymbols.add(s));
    }
    seedSymbols = [...ragSymbols].slice(0, 6);
  }

  let frontier = seedSymbols;
  const seenSymbols = new Set();
  const seenFiles = new Set();
  let bfsRound = 0;

  while (used < budget && frontier.length > 0) {
    const toGrep = frontier.filter(s => !seenSymbols.has(s));
    if (toGrep.length === 0) break;

    log.push(`  [bfs ${bfsRound}] symbols: ${toGrep.slice(0, 8).join(', ')}${toGrep.length > 8 ? ` (+${toGrep.length - 8})` : ''}`);

    const hitFiles = []; // files that matched this round — for relation lookup
    let hitsThisRound = 0;

    for (const sym of toGrep) {
      if (used >= budget) break;
      seenSymbols.add(sym);

      let results;
      try {
        results = await grepFiles(sym, ragFiles, GREP_CONTEXT_LINES, bfsRound);
        if (results.length === 0) {
          results = await grepFiles(sym, allFiles, GREP_CONTEXT_LINES, bfsRound);
        }
      } catch {
        continue;
      }

      for (const { file, windows } of results) {
        if (!seenFiles.has(file)) {
          seenFiles.add(file);
          hitFiles.push(file);
        }
        for (const win of windows) {
          const metadata = {
            method: `bfs-${bfsRound}`,
            symbol: sym,
            hitCount: win.metadata?.hitCount || 1,
          };
          if (tryAdd(file, win.startLine, win.endLine, win.text, `${file} [${sym}]`, metadata)) {
            hitsThisRound++;
          }
          if (used >= budget) break;
        }
        if (used >= budget) break;
      }
    }

    log.push(`  [bfs ${bfsRound}] added ${hitsThisRound} window(s), budget used: ${used}/${budget}`);

    // Discover next frontier via relation map (NO re-grepping for discovery)
    if (used < budget && relations && hitFiles.length > 0) {
      const newSymbols = [];
      const seenRelFiles = new Set();
      for (const file of hitFiles) {
        const fileSymbols = relations.byFile[file];
        if (!fileSymbols) continue;
        for (const sym of fileSymbols) {
          if (!seenSymbols.has(sym) && !newSymbols.includes(sym)) {
            newSymbols.push(sym);
          }
        }
        // BFS across related files: discover new files through symbol overlap
        for (const sym of fileSymbols) {
          const symFiles = relations.bySymbol[sym];
          if (!symFiles) continue;
          for (const relatedFile of symFiles) {
            if (seenFiles.has(relatedFile) || seenRelFiles.has(relatedFile)) continue;
            seenRelFiles.add(relatedFile);
            const relatedSyms = relations.byFile[relatedFile];
            if (!relatedSyms) continue;
            for (const rsym of relatedSyms) {
              if (!seenSymbols.has(rsym) && !newSymbols.includes(rsym)) {
                newSymbols.push(rsym);
              }
            }
          }
        }
      }
      const MAX_FRONTIER = 20;
      const truncated = newSymbols.slice(0, MAX_FRONTIER);
      if (newSymbols.length > 0) {
        log.push(`  [bfs ${bfsRound}→${bfsRound + 1}] discovered: ${truncated.slice(0, 8).join(', ')}${newSymbols.length > 8 ? ` (+${newSymbols.length - 8})` : ''}`);
      }
      frontier = truncated;
    } else if (used < budget && !relations && hitFiles.length > 0) {
      // Fallback: grep-text symbol extraction (no relations available)
      // Not implemented in this path — just stop
      frontier = [];
    } else {
      frontier = [];
    }

    bfsRound++;
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
