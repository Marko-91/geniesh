import { basename, extname, relative } from 'path';
import { search } from './search.js';
import { grepFiles } from './grep.js';
import { extractSymbols } from './symbol-utils.js';
import { readFile } from './fs-utils.js';

// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_BUDGET     = 10000; // max chars of code context per turn
const MAX_PER_FILE       = Math.floor(CONTEXT_BUDGET * 0.5); // prevent any single file from starving the rest
const ROUND_0_CAP        = Math.floor(CONTEXT_BUDGET * 0.7); // reserve 30% for rounds ≥1
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

// ─── English word noise filter ────────────────────────────────────────────────────
// PascalCase words that are common English → almost never real code symbols
const ENGLISH_PASCAL_NOISE = new Set([
  'the','you','this','that','these','those','are','was','but','can','from',
  'how','show','what','why','when','where','which','who','whom','whose',
  'into','about','also','very','just','over','under','here','there','then',
  'else','still','already','more','most','other','each','every','both','few',
  'much','many','some','once','ever','again','upon','down','off','near',
  'red','see','old','out','its','has','had','may','will','would','could',
  'should','shall','than','thus','hence','thence','then','till','until',
  'while','after','before','above','below','across','along','among',
  'around','behind','beneath','beside','between','beyond','during',
  'except','inside','outside','since','through','toward','towards',
  'within','without','having','doing','being','going','coming','making',
  'taking','giving','using','finding','keeping','letting','looking',
  'asking','telling','working','calling','thinking','knowing','seeming',
  'become','became','begin','began','beginning','hold','held','hold',
  'keep','kept','lay','laid','lie','lay','lying','rise','rose','rising',
  'set','setting','sit','sat','sitting','stand','stood','standing',
  'leave','left','mean','meant','meeting','running','bringing',
  'buying','catching','choosing','coming','doing','drawing','drinking',
  'driving','eating','falling','feeling','fighting','finding','flying',
  'forgetting','forgiving','freezing','getting','giving','going','growing',
  'hiding','holding','hurting','keeping','knowing','leading','leaving',
  'lending','letting','lying','losing','making','meaning','meeting',
  'paying','putting','reading','riding','ringing','rising','running',
  'saying','seeing','selling','sending','shaking','shining','shooting',
  'showing','shutting','singing','sinking','sitting','sleeping','speaking',
  'spending','standing','stealing','sticking','striking','swearing',
  'sweeping','swimming','swinging','taking','teaching','tearing','telling',
  'thinking','throwing','understanding','waking','wearing','weeping',
  'winning','writing','wrote','written',
]);

// ─── Query-aware scoring ────────────────────────────────────────────────────────
const QUERY_STOP_WORDS = new Set([
  'the','this','that','these','those','and','for','are','was','but','not','with',
  'from','how','what','why','when','where','which','who','is','it','to','in','of',
  'a','an','at','by','on','or','as','be','do','has','had','its','can','may','will',
  'would','could','should','shall','add','look','show','want','need','use','get',
  'set','run','put','try','new','now','all','any','out','old','let','too','top',
  'key','end','log','map','see','say','ask','tell','find','make','take','know',
  'think','give','work','call','come','go','have','done','said','got','much',
  'many','some','every','each','both','few','more','most','other','into','upon',
  'over','under','between','through','during','before','after','above','below',
  'up','down','off','near','here','there','then','else','also','very','just',
  'about','always','never','often','once','ever','again','still','already',
  'please','please','help','could','would','should','must','might','shall',
]);

function extractQueryTerms(question) {
  const raw = question.split(/[\s,.;:!?(){}[\]"'/=+*&|^~`@#$%]+/);
  return [...new Set(raw)]
    .map(w => w.replace(/^['"]+|['"]+$/g, ''))
    .filter(w => w.length >= 3 && !QUERY_STOP_WORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
}

function queryRelevanceScore(symbol, queryTerms) {
  if (queryTerms.length === 0) return 0;
  const symLower = symbol.toLowerCase();
  // Exact match with a query term → highest
  for (const qt of queryTerms) {
    if (qt === symLower) return 1000;
  }
  // Symbol starts with a query term (e.g. query "Stats" → symbol "StatsOnly")
  for (const qt of queryTerms) {
    if (qt.length >= 3 && symLower.startsWith(qt)) return 800;
  }
  // Symbol contains a query term as substring
  for (const qt of queryTerms) {
    if (qt.length >= 3 && symLower.includes(qt)) return 600;
  }
  // Query term contains symbol (e.g. symbol "Mode" → query "SearchMode")
  for (const qt of queryTerms) {
    if (symLower.length >= 3 && qt.includes(symLower)) return 400;
  }
  // CamelCase decomposition match
  const parts = symbol.split(/(?=[A-Z])/).map(p => p.toLowerCase()).filter(p => p.length >= 2);
  for (const qt of queryTerms) {
    for (const part of parts) {
      if (qt === part) return 300;
    }
  }
  // Exact match after stripping common prefixes (is_, has_, to_, set_)
  const stripped = symLower.replace(/^(is|has|to|set|get|with|from|as)_/, '');
  for (const qt of queryTerms) {
    if (qt === stripped) return 200;
  }
  return 0;
}

// ─── Index sorting ──────────────────────────────────────────────────────────────
const HIGH_PRIORITY_DIRS = /[/\\](src|lib|app|core|include|packages)[/\\]/;
const LOW_PRIORITY_DIRS  = /^|[/\\](test|spec|__tests__|__mocks__|fixtures|examples)[/\\]/;

function fileTier(filePath) {
  const name = basename(filePath).toLowerCase();
  if (PRIORITY_NAMES.has(name)) return 0;           // tier 1: named docs
  if (extname(name) === '.md') return 1;             // tier 2: other markdown
  return 2;                                          // tier 3: code files
}

// Score for sorting grep results: source dirs first, test dirs last
function dirScore(filePath) {
  if (HIGH_PRIORITY_DIRS.test(filePath)) return -1;
  if (LOW_PRIORITY_DIRS.test(filePath)) return 1;
  return 0;
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

  // Separate RAG, file-ref, and BFS results
  const ragResults = trace.filter(e => e.method === 'rag');
  const fileRefResults = trace.filter(e => e.method === 'file-ref');
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

  // Show file-ref results
  for (const entry of fileRefResults) {
    const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
    const lineNum = `\x1b[36m${entry.startLine}–${entry.endLine}\x1b[0m`;
    const totalLines = entry.endLine - entry.startLine + 1;
    const isTruncated = entry._truncated;
    lines.push(`  \x1b[90m${relPath}:${lineNum}  file-ref (${totalLines} lines${isTruncated ? ', truncated' : ''})\x1b[0m`);
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

  // Show any non-BFS, non-RAG logs that haven't been rendered
  for (const entry of depthLogs) {
    if (entry.startsWith('  [file-ref]')) {
      lines.push(`  \x1b[90m${entry}\x1b[0m`);
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
 * @param {object}   [relations] Relation graph (byFile/bySymbol)
 * @param {string[]} [fileRefs]  Explicit file paths referenced in the query
 * @returns {Promise<{ contextString: string, log: string[], trace: object[] }>}
 */
export async function buildChatContext(question, index, allFiles, relations, fileRefs = []) {
  const budget   = CONTEXT_BUDGET;
  let   used     = 0;
  const sections = [];
  const seen     = new Set();  // deduplicate by "file:startLine"
  const perFile  = new Map();  // char usage per file — prevents one file starving others
  const log      = [];         // human-readable depth log lines
  const trace    = [];         // retrieval method tracing

  function tryAdd(file, startLine, endLine, text, label, traceMetadata) {
    const key = `${file}:${startLine}`;
    if (seen.has(key)) return false;
    const fileUsed = perFile.get(file) || 0;
    if (fileUsed >= MAX_PER_FILE) return false;
    const block = `// ${label || file} (lines ${startLine}–${endLine})\n${text}\n`;
    if (used + block.length > budget) return false;
    if (fileUsed + block.length > MAX_PER_FILE) return false;
    sections.push(block);
    seen.add(key);
    perFile.set(file, fileUsed + block.length);
    used += block.length;
    if (traceMetadata) {
      trace.push({ file, startLine, endLine, ...traceMetadata });
    }
    return true;
  }

  // ── Tier 0: explicit file references (like --file in chat) ─────────────
  for (const fp of fileRefs) {
    if (used >= budget) break;
    try {
      const content = await readFile(fp);
      const lineCount = content.split('\n').length;
      // Leave 200 chars margin for tryAdd wrapper (label + line nums)
      const maxLen = Math.max(Math.min(budget - used - 200, MAX_PER_FILE), 0);
      const isTruncated = content.length > maxLen;
      const fileText = isTruncated
        ? content.slice(0, maxLen) + '\n... (truncated)'
        : content;
      if (tryAdd(fp, 1, lineCount, fileText, `file-ref: ${fp}`, { method: 'file-ref', _truncated: isTruncated })) {
        log.push(`  [file-ref] loaded ${fp} (${lineCount} lines)`);
      }
    } catch {
      log.push(`  [file-ref] failed to load ${fp}`);
    }
  }

  // ── Tier 1: relation-guided BFS (budget-limited) ──────────────────────────
  let seedSymbols = extractSymbols(question);

  // Filter out symbols that are common English words masquerading as PascalCase
  seedSymbols = seedSymbols.filter(s => !ENGLISH_PASCAL_NOISE.has(s.toLowerCase()));

  // Filter out symbols that don't exist in the relation graph (natural language noise)
  if (relations && seedSymbols.length > 0) {
    const knownSymbols = new Set(Object.keys(relations.bySymbol));
    seedSymbols = seedSymbols.filter(s => knownSymbols.has(s));
  }

  // Try RAG if index is available, otherwise fall back to grep-bootstrap
  let ragScored = [];
  let ragFiles = [];
  let useGrepBootstrap = false;

  if (index && index.length > 0) {
    try {
      ragScored = await search(question, index, RAG_TOP_K);
      ragFiles = [...new Set(ragScored.map(c => c.file))].slice(0, RAG_TOP_FILES);
    } catch {
      useGrepBootstrap = true;
    }
  } else {
    useGrepBootstrap = true;
  }

  // If question has no code symbols, seed BFS from symbols in top RAG chunks
  // or via grep-bootstrap (no embedding index needed)
  if (seedSymbols.length === 0 && relations) {
    if (ragScored.length > 0) {
      const ragSymbols = new Set();
      for (const c of ragScored.slice(0, 3)) {
        const fileSyms = relations.byFile[c.file];
        if (fileSyms) fileSyms.forEach(s => ragSymbols.add(s.name || s));
      }
      seedSymbols = [...ragSymbols].slice(0, 6);
    } else if (useGrepBootstrap) {
      // Grep meaningful query words across all files to find seed symbols
      const queryWords = question.split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !/^[A-Z][a-z]{2,}$/.test(w) && !/[A-Z]{2,}/.test(w)) // skip PascalCase/ALL_CAPS (already in symbols)
        .slice(0, 4);
      if (queryWords.length > 0) {
        const grepSeedSymbols = new Set();
        for (const word of queryWords) {
          try {
            const results = await grepFiles(word, allFiles, 5);
            for (const r of results) {
              const fileSyms = relations.byFile[r.file];
              if (fileSyms) fileSyms.forEach(s => grepSeedSymbols.add(s.name || s));
            }
          } catch { continue; }
        }
        seedSymbols = [...grepSeedSymbols].slice(0, 6);
      }
    }
  }

  let frontier = seedSymbols;
  const seenSymbols = new Set();
  const seenFiles = new Set();
  let bfsRound = 0;

  while (used < budget && frontier.length > 0) {
    const roundCap = bfsRound === 0 ? Math.min(ROUND_0_CAP, budget) : budget;
    if (used >= roundCap) break;
    const toGrep = frontier.filter(s => !seenSymbols.has(s));
    if (toGrep.length === 0) break;

    log.push(`  [bfs ${bfsRound}] symbols: ${toGrep.slice(0, 8).join(', ')}${toGrep.length > 8 ? ` (+${toGrep.length - 8})` : ''}`);

    const hitFiles = []; // files that matched this round — for relation lookup
    let hitsThisRound = 0;

    // Phase 1: collect all (sym, file, windows) groups across all symbols
    const groups = []; // { sym, file, windows, taken }

    for (const sym of toGrep) {
      if (used >= roundCap) break;
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

      // Dotted symbol (e.g. Layer.match) rarely exists literally in source
      // (it's usually Layer.prototype.match). Prefer segment greps so the
      // actual implementation file (lib/router/layer.js) fills budget first.
      if (sym.includes('.')) {
        const segResults = [];
        for (const segment of sym.split('.')) {
          if (segment.length < 2) continue;
          try {
            let r = await grepFiles(segment, ragFiles, GREP_CONTEXT_LINES, bfsRound);
            if (r.length === 0) {
              r = await grepFiles(segment, allFiles, GREP_CONTEXT_LINES, bfsRound);
            }
            segResults.push(...r);
          } catch {
            continue;
          }
        }
        results = [...segResults, ...results];
      }

      for (const { file, windows } of results) {
        groups.push({ sym, file, windows, taken: 0 });
      }
    }

    // Sort groups by directory priority (source dirs first, test dirs last)
    groups.sort((a, b) => dirScore(a.file) - dirScore(b.file));

    // Phase 2: round-robin across groups — one window per group per cycle
    let anyAdded = true;
    while (used < roundCap && anyAdded) {
      anyAdded = false;
      for (const group of groups) {
        if (used >= roundCap) break;
        if (group.taken >= group.windows.length) continue;

        const win = group.windows[group.taken++];

        if (!seenFiles.has(group.file)) {
          seenFiles.add(group.file);
          hitFiles.push(group.file);
        }

        const metadata = {
          method: `bfs-${bfsRound}`,
          symbol: group.sym,
          hitCount: win.metadata?.hitCount || 1,
        };
        if (tryAdd(group.file, win.startLine, win.endLine, win.text, `${group.file} [${group.sym}]`, metadata)) {
          anyAdded = true;
          hitsThisRound++;
        }
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
        for (const entry of fileSymbols) {
          const sym = entry.name || entry;
          if (!seenSymbols.has(sym) && !newSymbols.includes(sym)) {
            newSymbols.push(sym);
          }
        }
        // BFS across related files: discover new files through symbol overlap
        for (const entry of fileSymbols) {
          const sym = entry.name || entry;
          const symFiles = relations.bySymbol[sym];
          if (!symFiles) continue;
          for (const ref of symFiles) {
            const relatedFile = ref.file || ref;
            if (seenFiles.has(relatedFile) || seenRelFiles.has(relatedFile)) continue;
            seenRelFiles.add(relatedFile);
            const relatedSyms = relations.byFile[relatedFile];
            if (!relatedSyms) continue;
            for (const rentry of relatedSyms) {
              const rsym = rentry.name || rentry;
              if (!seenSymbols.has(rsym) && !newSymbols.includes(rsym)) {
                newSymbols.push(rsym);
              }
            }
          }
        }

        // Follow import edges: files imported by this file
        const imported = relations.byImports?.[file];
        if (imported) {
          for (const impFile of imported) {
            if (seenFiles.has(impFile) || seenRelFiles.has(impFile)) continue;
            seenRelFiles.add(impFile);
            const impSyms = relations.byFile[impFile];
            if (!impSyms) continue;
            for (const entry of impSyms) {
              const sym = entry.name || entry;
              if (!seenSymbols.has(sym) && !newSymbols.includes(sym)) {
                newSymbols.push(sym);
              }
            }
          }
        }

        // Follow reverse import edges: files that import this file
        const importers = relations.byImporters?.[file];
        if (importers) {
          for (const impFile of importers) {
            if (seenFiles.has(impFile) || seenRelFiles.has(impFile)) continue;
            seenRelFiles.add(impFile);
            const impSyms = relations.byFile[impFile];
            if (!impSyms) continue;
            for (const entry of impSyms) {
              const sym = entry.name || entry;
              if (!seenSymbols.has(sym) && !newSymbols.includes(sym)) {
                newSymbols.push(sym);
              }
            }
          }
        }
      }

      // Query-aware scoring: symbols matching query terms get highest priority
      // Then exported, then by kind (class > function > variable > reference)
      const kindOrder = { class: 0, function: 1, variable: 2, reference: 3 };
      const queryTerms = extractQueryTerms(question);
      const symbolPriority = (name) => {
        const metas = relations.bySymbol[name];
        if (!metas || metas.length === 0) return 99999;
        const m = metas[0];
        const qScore = queryRelevanceScore(name, queryTerms);
        // query score dominates (weight 1e6), then exported (1e5), then kind (1e3)
        return -qScore * 1000000 + (m.exported ? 0 : 100000) + (kindOrder[m.kind] ?? 99) * 1000;
      };

      newSymbols.sort((a, b) => symbolPriority(a) - symbolPriority(b));

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
