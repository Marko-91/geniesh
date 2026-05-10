import { loadIndex, indexExists } from './indexer.js';
import { loadRelations, relationsExist } from './relations.js';
import { search } from './search.js';
import { buildChatContext } from './context-builder.js';
import { scanDir } from './fs-utils.js';
import { readFile } from './fs-utils.js';

function scoreFileRecall(trace, expectedFiles) {
  if (!expectedFiles || expectedFiles.length === 0) return null;
  const retrievedFiles = new Set(trace.map(e => e.file.replace(/\\/g, '/')));
  const hits = expectedFiles.filter(f => {
    const norm = f.replace(/\\/g, '/');
    return [...retrievedFiles].some(r => r === norm || r.endsWith('/' + norm));
  });
  return { score: hits.length / expectedFiles.length, hits, misses: expectedFiles.filter(f => !hits.includes(f)), retrieved: retrievedFiles.size };
}

function scoreSymbolPrecision(trace, contextString, expectedSymbols) {
  if (!expectedSymbols || expectedSymbols.length === 0) return null;
  const traceSymbols = new Set();
  for (const entry of trace) {
    if (entry.symbol) traceSymbols.add(entry.symbol);
  }
  const hits = expectedSymbols.filter(s => {
    if (traceSymbols.has(s)) return true;
    if (contextString && contextString.includes(s)) return true;
    return false;
  });
  return { score: hits.length / expectedSymbols.length, hits, misses: expectedSymbols.filter(s => !hits.includes(s)) };
}

function scoreContextEfficiency(used, budget, trace, expectedFiles) {
  const pct = budget > 0 ? used / budget : 0;
  const expectedSet = new Set(expectedFiles ? expectedFiles.map(f => f.replace(/\\/g, '/')) : []);
  let relevantChars = 0;
  for (const entry of trace) {
    const norm = entry.file.replace(/\\/g, '/');
    if ([...expectedSet].some(e => norm === e || norm.endsWith('/' + e))) {
      relevantChars += (entry.endLine || 0) - (entry.startLine || 0);
    }
  }
  return { budgetUsed: pct, totalEntries: trace.length };
}

function scoreBfsRounds(trace) {
  const rounds = new Set();
  for (const entry of trace) {
    if (entry.method && entry.method.startsWith('bfs-')) {
      rounds.add(entry.method);
    }
  }
  return { rounds: rounds.size };
}

export async function runEval(benchmarkFile, dir, verbose) {
  const raw = await readFile(benchmarkFile);
  const benchmark = JSON.parse(raw);
  const suite = benchmark.benchmarks || [benchmark];

  if (!(await indexExists())) {
    console.error(`No index found for ${dir}. Run: geniesh index --dir ${dir}`);
    process.exit(1);
  }

  const index = await loadIndex();
  const allFiles = await scanDir(dir);
  const hasRelations = await relationsExist();
  const relations = hasRelations ? await loadRelations() : null;

  const results = [];

  for (const bm of suite) {
    if (verbose) console.log(`\n  Evaluating: ${bm.name}`);

    const { contextString, log, trace } = await buildChatContext(
      bm.question,
      index,
      allFiles,
      relations,
      bm.file_refs || [],
      search,
    );

    const fileRecall = scoreFileRecall(trace, bm.expected_files);
    const symbolPrecision = scoreSymbolPrecision(trace, contextString, bm.expected_symbols);
    const contextEfficiency = scoreContextEfficiency(
      trace.reduce((sum, e) => sum + ((e.endLine || 0) - (e.startLine || 0)), 0),
      10000,
      trace,
      bm.expected_files,
    );
    const bfsRounds = scoreBfsRounds(trace);

    if (verbose) {
      console.log(`    File recall:    ${fileRecall ? (fileRecall.score * 100).toFixed(0) + '%' : 'N/A'} (${fileRecall?.hits.length || 0}/${bm.expected_files?.length || '?'})`);
      console.log(`    Symbol recall:  ${symbolPrecision ? (symbolPrecision.score * 100).toFixed(0) + '%' : 'N/A'} (${symbolPrecision?.hits.length || 0}/${bm.expected_symbols?.length || '?'})`);
      console.log(`    Budget used:    ${(contextEfficiency.budgetUsed * 100).toFixed(0)}%`);
      console.log(`    BFS rounds:     ${bfsRounds.rounds}`);
      if (fileRecall?.misses.length > 0) console.log(`    Missed files:   ${fileRecall.misses.join(', ')}`);
      if (symbolPrecision?.misses.length > 0) console.log(`    Missed symbols: ${symbolPrecision.misses.join(', ')}`);
    }

    results.push({
      name: bm.name,
      question: bm.question,
      fileRecall: fileRecall ? { score: fileRecall.score, hits: fileRecall.hits.length, total: bm.expected_files.length } : null,
      symbolPrecision: symbolPrecision ? { score: symbolPrecision.score, hits: symbolPrecision.hits.length, total: bm.expected_symbols.length } : null,
      contextEfficiency: { budgetUsed: contextEfficiency.budgetUsed, entries: contextEfficiency.totalEntries },
      bfsRounds: bfsRounds.rounds,
    });
  }

  return results;
}

function ansiBar(value, maxWidth, filled, empty) {
  const w = Math.max(1, maxWidth - 2);
  const n = Math.round(value * w);
  return filled.repeat(n) + empty.repeat(w - n);
}

export function formatEvalResults(results) {
  const lines = [];
  lines.push('');
  lines.push('  Geniesh Benchmark Results');
  lines.push('  ' + '='.repeat(70));
  lines.push('');

  let sumFR = 0, sumSR = 0, frCount = 0, srCount = 0;

  for (const r of results) {
    const fr = r.fileRecall;
    const sr = r.symbolPrecision;
    const score = r.contextEfficiency;
    const br = r.bfsRounds;

    if (fr) { sumFR += fr.score; frCount++; }
    if (sr) { sumSR += sr.score; srCount++; }

    lines.push('');
    lines.push('  ' + r.name);
    lines.push('  ' + '-'.repeat(r.name.length));
    lines.push('    File recall:        ' + (fr ? `${(fr.score * 100).toFixed(0).padStart(3)}% ${fr.hits}/${fr.total}` : 'N/A') + '  ' + (fr ? ansiBar(fr.score, 20, '\u2588', '\u2591') : ''));
    lines.push('    Symbol recall:      ' + (sr ? `${(sr.score * 100).toFixed(0).padStart(3)}% ${sr.hits}/${sr.total}` : 'N/A') + '  ' + (sr ? ansiBar(sr.score, 20, '\u2588', '\u2591') : ''));
    lines.push('    Budget used:        ' + `${(score.budgetUsed * 100).toFixed(0).padStart(3)}%` + '  ' + ansiBar(1 - score.budgetUsed, 20, '\u2588', '\u2591'));
    lines.push('    BFS rounds:         ' + `${br}`);
  }

  lines.push('');
  lines.push('  ' + '-'.repeat(70));
  if (frCount > 0) {
    const avgFR = (sumFR / frCount * 100).toFixed(1);
    lines.push('  Average file recall:    ' + `${avgFR}%`.padStart(5) + '  ' + ansiBar(sumFR / frCount, 20, '\u2588', '\u2591'));
  }
  if (srCount > 0) {
    const avgSR = (sumSR / srCount * 100).toFixed(1);
    lines.push('  Average symbol recall:  ' + `${avgSR}%`.padStart(5) + '  ' + ansiBar(sumSR / srCount, 20, '\u2588', '\u2591'));
  }
  lines.push('');

  return lines.join('\n');
}
