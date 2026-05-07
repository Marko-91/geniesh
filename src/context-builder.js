import { basename, extname } from 'path';
import { search } from './search.js';
import { grepFiles } from './grep.js';

// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_BUDGET     = 10000; // max chars of code context per turn
const MAX_CHAT_TURNS     = 8;     // sliding window: keep last N user/assistant pairs
const RAG_TOP_K          = 8;     // cosine candidates to consider
const GREP_CONTEXT_LINES = 15;    // lines around each grep match
const GREP_MAX_DEPTH     = 2;     // transitive grep: depth 0 = question symbols, depth 1 = symbols found in results
const GREP_MAX_PER_DEPTH = 6;     // max new symbols to expand at each depth level

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
 * @returns {Promise<{ contextString: string, log: string[] }>}
 */
export async function buildChatContext(question, index, allFiles) {
  const budget   = CONTEXT_BUDGET;
  let   used     = 0;
  const sections = [];
  const seen     = new Set();  // deduplicate by "file:startLine"
  const log      = [];         // human-readable depth log lines

  function tryAdd(file, startLine, endLine, text, label) {
    const key = `${file}:${startLine}`;
    if (seen.has(key)) return false;
    const block = `// ${label || file} (lines ${startLine}–${endLine})\n${text}\n`;
    if (used + block.length > budget) return false;
    sections.push(block);
    seen.add(key);
    used += block.length;
    return true;
  }

  // ── Tier 1: transitive grep ─────────────────────────────────────────────────
  const depth0 = extractSymbols(question);

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

        let results;
        try {
          results = await grepFiles(sym, allFiles, GREP_CONTEXT_LINES);
        } catch {
          continue;
        }

        for (const { file, windows } of results) {
          for (const win of windows) {
            if (tryAdd(file, win.startLine, win.endLine, win.text, `${file} [d${depth}: ${sym}]`)) {
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
  const scored = await search(question, index, RAG_TOP_K);
  const sorted = sortedIndex(index);

  const scoredKeys = new Set(scored.map(c => `${c.file}:${c.startLine}`));
  for (const entry of sorted) {
    if (used >= budget) break;
    const key = `${entry.file}:${entry.startLine}`;
    if (scoredKeys.has(key)) {
      tryAdd(entry.file, entry.startLine, entry.endLine, entry.chunk);
    }
  }
  for (const c of scored) {
    if (used >= budget) break;
    tryAdd(c.file, c.startLine, c.endLine, c.chunk);
  }

  return { contextString: sections.join('\n---\n\n'), log };
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
