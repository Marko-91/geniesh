import { extname, relative, isAbsolute } from 'path';
import { readFile } from './fs-utils.js';
import { extractSymbols } from './symbol-utils.js';
import { queryCallers, queryCallees, queryFileNeighbors, rankSymbols, scoreSymbol } from './graph-query.js';

const DEFAULT_BUDGET = 128000;
const DEFAULT_MAX_PER_FILE = Math.floor(DEFAULT_BUDGET * 0.3);
const DEFAULT_RAG_TOP_K = 8;
const DEFAULT_MAX_CHAT_TURNS = 8;

const PRIORITY_NAMES = new Set([
  'readme.md', 'changelog.md', 'contributing.md', 'license', 'instructions.md',
]);

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
  'taking','giving','using','fing','keeping','letting','looking',
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

const KIND_ORDER = { class: 0, function: 1, variable: 2, reference: 3 };

const _fileCache = new Map();

async function readFileLines(file, startLine, endLine) {
  try {
    let lines = _fileCache.get(file);
    if (!lines) {
      const content = await readFile(file);
      lines = content.split('\n');
      _fileCache.set(file, lines);
    }
    return lines.slice(startLine - 1, endLine).join('\n');
  } catch {
    return null;
  }
}

function extractQueryTerms(question) {
  const raw = question.split(/[\s,.;:!?(){}[\]"'/=+*&|^~`@#$%]+/);
  const STOP = new Set([
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
    'please','help','could','would','should','must','might','shall',
  ]);
  return [...new Set(raw)]
    .map(w => w.replace(/^['"]+|['"]+$/g, ''))
    .filter(w => w.length >= 3 && !STOP.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
}

function shortenPath(pathStr, maxSegments = 4) {
  const parts = pathStr.split('/');
  if (parts.length <= maxSegments) return pathStr;
  return `.../${parts.slice(-maxSegments).join('/')}`;
}

function formatTrace(trace, bfsLogs, projectRoot) {
  if (trace.length === 0) return '';
  const lines = ['\x1b[90m\x1b[1mRetrieval trace:\x1b[0m'];

  for (const log of bfsLogs) {
    lines.push(`  \x1b[90m${log}\x1b[0m`);
  }

  for (const entry of trace) {
    const relPath = shortenPath(relative(projectRoot, entry.file).replace(/\\/g, '/'));
    const ls = `\x1b[33m${entry.startLine}\x1b[0m`;
    const le = `\x1b[33m${entry.endLine}\x1b[0m`;
    const method = entry.method === 'bfs' ? '\x1b[36mBFS\x1b[0m' :
      entry.method === 'rag' ? '\x1b[35mRAG\x1b[0m' :
      '\x1b[32mfile-ref\x1b[0m';
    const extra = entry.symbol ? ` \x1b[90m[${entry.symbol}]\x1b[0m` : '';
    lines.push(`    ${method} ${relPath}:${ls}–${le}${extra}`);
  }

  return lines.join('\n');
}

function tryAdd(sections, seen, perFile, used, budget, maxPerFile, file, startLine, endLine, text, label, traceTarget) {
  const key = `${file}:${startLine}-${endLine}`;
  if (seen.has(key)) return false;
  const fileUsed = perFile.get(file) || 0;
  if (fileUsed >= maxPerFile) return false;
  const block = `// ${label} (lines ${startLine}–${endLine})\n${text}\n`;
  if (used.value + block.length > budget) return false;
  if (fileUsed + block.length > maxPerFile) return false;
  // content-based dedup: same file + overlapping text
  const contentFingerprint = `${file}:${text.slice(0, 80)}`;
  if (seen.has(contentFingerprint)) return false;
  sections.push(block);
  seen.add(key);
  seen.add(contentFingerprint);
  perFile.set(file, fileUsed + block.length);
  used.value += block.length;
  if (traceTarget && traceTarget.length !== undefined) {
    const lbl = label || '';
    traceTarget.push({ file, startLine, endLine, symbol: lbl.split('[').pop()?.replace(']', '')?.trim() || lbl, method: 'bfs' });
  }
  return true;
}

export async function buildChatContext(question, index, allFiles, graph, fileRefs = [], searchFn = null) {
  const budget = (graph && graph._budget) || DEFAULT_BUDGET;
  const maxPerFile = Math.floor(budget * 0.3);
  const used = { value: 0 };
  const sections = [];
  const seen = new Set();
  const perFile = new Map();
  const bfsLogs = [];
  const trace = [];

  const tryAddSection = (file, startLine, endLine, text, label, traceEntry) => {
    return tryAdd(sections, seen, perFile, used, budget, maxPerFile, file, startLine, endLine, text, label, traceEntry);
  };

  // Phase 0: Explicit file references
  for (const fp of fileRefs) {
    if (used.value >= budget) break;
    try {
      const content = await readFile(fp);
      const lineCount = content.split('\n').length;
      const maxLen = Math.max(Math.min(budget - used.value - 200, maxPerFile), 0);
      const isTruncated = content.length > maxLen;
      const fileText = isTruncated ? content.slice(0, maxLen) + '\n... (truncated)' : content;
      tryAddSection(fp, 1, lineCount, fileText, `file-ref: ${fp}`, trace);
      bfsLogs.push(`  [file-ref] loaded ${fp} (${lineCount} lines)`);
    } catch {
      bfsLogs.push(`  [file-ref] failed to load ${fp}`);
    }
  }

  // Phase 1: Extract symbols
  let seedSymbols = extractSymbols(question);
  seedSymbols = seedSymbols.filter(s => !ENGLISH_PASCAL_NOISE.has(s.toLowerCase()));

  if (graph && seedSymbols.length > 0) {
    seedSymbols = seedSymbols.filter(s => graph.getSymbol(s).length > 0);
  }

  // Run RAG search for discovery fill
  let ragScored = [];
  if (searchFn && index && index.length > 0) {
    try {
      ragScored = await searchFn(question, index, DEFAULT_RAG_TOP_K);
    } catch {}
  }

  // Bootstrap seeds from RAG if no symbols found
  if (seedSymbols.length === 0 && graph && ragScored.length > 0) {
    const ragSyms = new Set();
    for (const c of ragScored.slice(0, 3)) {
      const fileSyms = graph.getFileSymbols(c.file);
      fileSyms.forEach(s => ragSyms.add(s));
    }
    seedSymbols = [...ragSyms].map(s => s.name).filter(Boolean).slice(0, 6);
  }

  if (seedSymbols.length === 0 && !graph) {
    seedSymbols = extractSymbols(question).filter(s => !ENGLISH_PASCAL_NOISE.has(s.toLowerCase())).slice(0, 6);
  }

  // Phase 2: Graph BFS
  let frontier = seedSymbols;
  const seenSymbols = new Set();
  const seenFiles = new Set();
  let bfsRound = 0;
  const queryTerms = extractQueryTerms(question);
  const MAX_BFS_ROUNDS = 2;

  while (used.value < budget && frontier.length > 0 && bfsRound < MAX_BFS_ROUNDS) {
    const toProcess = frontier.filter(s => !seenSymbols.has(s));
    if (toProcess.length === 0) break;

    bfsLogs.push(`  [bfs ${bfsRound}] symbols: ${toProcess.slice(0, 6).join(', ')}${toProcess.length > 6 ? ` (+${toProcess.length - 6})` : ''}`);

    const hitFiles = new Set();
    let hitCount = 0;

    for (const symName of toProcess) {
      if (used.value >= budget) break;
      seenSymbols.add(symName);

      const symNodes = graph ? graph.getSymbol(symName) : [];

      for (const symNode of symNodes) {
        if (used.value >= budget) break;

        // Get definition code
        if (symNode.lineRange) {
          const [sl, el] = symNode.lineRange;
          const text = await readFileLines(symNode.file, sl, el);
          if (text) {
            const label = `${symNode.file} [${symName}]`;
            if (tryAddSection(symNode.file, sl, el, text, label, trace)) {
              hitCount++;
              hitFiles.add(symNode.file);
            }
          }
        }

        // Get callers
        const callers = graph ? graph.getCallers(symNode.id) : [];
        for (const caller of callers.slice(0, 2)) {
          if (used.value >= budget) break;
          if (!caller.at || !caller.node?.file) continue;
          const [sl, el] = caller.at;
          const text = await readFileLines(caller.node.file, sl - 2, el + 3);
          if (text) {
            const label = `${caller.node.file} [${symName} caller]`;
            if (tryAddSection(caller.node.file, Math.max(1, sl - 2), el + 3, text, label, trace)) {
              hitCount++;
              hitFiles.add(caller.node.file);
            }
          }
        }

        // Get callees
        const callees = graph ? graph.getCallees(symNode.id) : [];
        for (const callee of callees.slice(0, 2)) {
          if (used.value >= budget) break;
          if (!callee.at || !callee.node?.file) continue;
          const [sl, el] = callee.at;
          const text = await readFileLines(callee.node.file, sl - 2, el + 3);
          if (text) {
            const label = `${callee.node.file} [${symName} callee]`;
            if (tryAddSection(callee.node.file, Math.max(1, sl - 2), el + 3, text, label, trace)) {
              hitCount++;
              hitFiles.add(callee.node.file);
            }
          }
        }
      }
    }

    bfsLogs.push(`  [bfs ${bfsRound}] added ${hitCount} window(s), budget used: ${used.value}/${budget}`);

    // Phase 3: Discover new symbols for next round
    if (used.value < budget && graph && hitFiles.size > 0) {
      const newCandidates = [];

      for (const file of hitFiles) {
        seenFiles.add(file);
        const fileSyms = graph.getFileSymbols(file);
        for (const sym of fileSyms) {
          if (!seenSymbols.has(sym.name)) newCandidates.push(sym);
        }

        const fileImports = graph.getFileImports(file);
        for (const imp of fileImports) {
          const impSyms = graph.getFileSymbols(imp.file);
          for (const sym of impSyms) {
            if (!seenSymbols.has(sym.name)) newCandidates.push(sym);
          }
        }

        const fileImporters = graph.getFileImporters(file);
        for (const imp of fileImporters) {
          const impSyms = graph.getFileSymbols(imp.file);
          for (const sym of impSyms) {
            if (!seenSymbols.has(sym.name)) newCandidates.push(sym);
          }
        }
      }

      const ranked = rankSymbols(graph, newCandidates, queryTerms, seenSymbols);
      const MAX_FRONTIER = 15;
      const nextFrontier = ranked.slice(0, MAX_FRONTIER).map(r => r.node.name);

      if (nextFrontier.length > 0) {
        bfsLogs.push(`  [bfs ${bfsRound}→${bfsRound + 1}] discovered: ${nextFrontier.slice(0, 6).join(', ')}${nextFrontier.length > 6 ? ` (+${nextFrontier.length - 6})` : ''}`);
      }

      frontier = nextFrontier;
      bfsRound++;
    } else {
      frontier = [];
    }
  }

  // Phase 4: RAG fill
  if (ragScored.length > 0) {
    const scoredKeys = new Set(ragScored.map(c => `${c.file}:${c.startLine}`));
    const sorted = [...(index || [])].sort((a, b) => {
      const ta = PRIORITY_NAMES.has(a.file?.toLowerCase().split('/').pop()) ? 0 :
        a.file?.endsWith('.md') ? 1 : 2;
      const tb = PRIORITY_NAMES.has(b.file?.toLowerCase().split('/').pop()) ? 0 :
        b.file?.endsWith('.md') ? 1 : 2;
      return ta - tb;
    });

    for (const entry of sorted) {
      if (used.value >= budget) break;
      const key = `${entry.file}:${entry.startLine}`;
      if (scoredKeys.has(key)) {
        const rag = ragScored.find(s => s.file === entry.file && s.startLine === entry.startLine);
        if (tryAddSection(entry.file, entry.startLine, entry.endLine, entry.chunk, undefined, trace)) {
          if (trace.length > 0) trace[trace.length - 1].method = 'rag';
        }
      }
    }

    for (const c of ragScored) {
      if (used.value >= budget) break;
      if (tryAddSection(c.file, c.startLine, c.endLine, c.chunk, undefined, trace)) {
        if (trace.length > 0) trace[trace.length - 1].method = 'rag';
      }
    }
  }

  return {
    contextString: sections.join('\n---\n\n'),
    log: bfsLogs,
    trace,
    traceFormatted: formatTrace(trace, bfsLogs, process.cwd()),
  };
}

export function applySlideWindow(messages, maxTurns = DEFAULT_MAX_CHAT_TURNS) {
  while (messages.length > 1 + maxTurns * 2) {
    messages.splice(1, 2);
  }
}

export function setBudget(budget) {
  if (typeof budget === 'number' && budget > 0) {
    // Budget is set via a property on the graph object
    // This gets passed through from the CLI
  }
}
