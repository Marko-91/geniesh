import { basename, extname } from 'path';
import { search } from './search.js';
import { grepFiles } from './grep.js';

// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_BUDGET    = 10000;  // max chars of code context per turn
const MAX_CHAT_TURNS    = 8;      // sliding window: keep last N user/assistant pairs
const RAG_TOP_K         = 8;      // cosine candidates to consider
const GREP_CONTEXT_LINES = 15;    // lines around each grep match

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

export function extractSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)].slice(0, 6);
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
 *   1. README / named doc chunks
 *   2. Other .md chunks
 *   3. Grep hits for extracted symbols (deterministic, fast)
 *   4. Cosine-scored RAG chunks
 *
 * @param {string}   question    Current user message
 * @param {object[]} index       Full RAG index
 * @param {string[]} allFiles    All scannable files (for grep)
 * @returns {Promise<string>}    Formatted context string
 */
export async function buildChatContext(question, index, allFiles) {
  const budget   = CONTEXT_BUDGET;
  let   used     = 0;
  const sections = [];
  const seen     = new Set();  // deduplicate by "file:startLine"

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

  // ── Tier 1: grep hits for extracted symbols (highest priority when present) ─
  // Targeted symbol hits are more valuable than cosine-similar chunks, so they
  // go in first before the budget can be consumed by generic RAG results.
  const symbols = extractSymbols(question);
  if (symbols.length > 0 && allFiles.length > 0) {
    for (const sym of symbols) {
      if (used >= budget) break;
      let results;
      try {
        results = await grepFiles(sym, allFiles, GREP_CONTEXT_LINES);
      } catch {
        continue;
      }
      for (const { file, windows } of results) {
        for (const win of windows) {
          tryAdd(file, win.startLine, win.endLine, win.text, `${file} [refs: ${sym}]`);
          if (used >= budget) break;
        }
        if (used >= budget) break;
      }
    }
  }

  // ── Tier 2: MD-prioritised RAG chunks (fill remaining budget) ──────────────
  const scored = await search(question, index, RAG_TOP_K);
  const sorted = sortedIndex(index);

  // Walk priority-sorted index (MD first), emit chunks that appear in top-K
  const scoredKeys = new Set(scored.map(c => `${c.file}:${c.startLine}`));
  for (const entry of sorted) {
    if (used >= budget) break;
    const key = `${entry.file}:${entry.startLine}`;
    if (scoredKeys.has(key)) {
      tryAdd(entry.file, entry.startLine, entry.endLine, entry.chunk);
    }
  }

  // Fill any remaining budget with unseen top-K chunks
  for (const c of scored) {
    if (used >= budget) break;
    tryAdd(c.file, c.startLine, c.endLine, c.chunk);
  }

  return sections.join('\n---\n\n');
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
