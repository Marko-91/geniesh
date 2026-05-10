import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { execSync } from 'child_process';
import { runGenerate } from '../runner.js';
import { runEval, formatEvalResults } from '../eval.js';
import { buildAnalysisPrompt } from './prompts.js';

const MAX_ITERATIONS = 5;
const IMPROVEMENT_THRESHOLD = 0.02;

const BENCHMARK_REPOS = {
  'express': { url: 'https://github.com/expressjs/express.git', dir: 'express' },
  'flask': { url: 'https://github.com/pallets/flask.git', dir: 'flask' },
  'gin': { url: 'https://github.com/gin-gonic/gin.git', dir: 'gin' },
  'ripgrep': { url: 'https://github.com/BurntSushi/ripgrep.git', dir: 'ripgrep' },
  'zod': { url: 'https://github.com/colinhacks/zod.git', dir: 'zod' },
  'monolog': { url: 'https://github.com/Seldaek/monolog.git', dir: 'monolog' },
};

function log(msg, level = 'info') {
  const prefix = level === 'info' ? '  ' : level === 'warn' ? '  ⚠' : '  ✖';
  console.log(`${prefix} ${msg}`);
}

function knownLimitations() {
  return '- isExported() only detects JS/TS export patterns — Python/Go/Rust show as non-exported\n- BFS depends on import/relation graph — disconnected files cannot be discovered\n- path normalization: relations.byFile keys are relative but grepFiles returned absolute\n- SYMBOL_RE may miss language-specific patterns (Go uppercase func, Rust pub fn)\n- Source files filtered by SOURCE_EXTS — may miss unconventional extensions';
}

async function findBenchmarkFiles() {
  let entries;
  try {
    entries = await readdir('.reports');
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    const match = e.match(/^auto-(\w+)-benchmark\.json$/);
    if (match) files.push({ file: `.reports/${e}`, repo: match[1] });
  }
  return files;
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(bm) {
  const repo = BENCHMARK_REPOS[bm.repo];
  if (!repo) return null;
  if (!await pathExists(repo.dir)) {
    log(`Cloning ${bm.repo}...`);
    execSync(`git clone --depth 1 ${repo.url} ${repo.dir}`, { stdio: 'ignore' });
    log(`Indexing ${bm.repo}...`);
    execSync(`node src/cli.js index --dir ${repo.dir}`, { stdio: 'ignore' });
  }
  return repo.dir;
}

async function runAllEvals(benchmarks) {
  const results = [];
  for (const bm of benchmarks) {
    const dir = await ensureRepo(bm);
    if (!dir) { log(`Unknown repo ${bm.repo}, skipping`, 'warn'); continue; }
    log(`Evaluating ${bm.repo}...`);
    try {
      const evalResults = await runEval(bm.file, dir, false);
      results.push({ repo: bm.repo, results: evalResults });
    } catch (err) {
      log(`Eval failed for ${bm.repo}: ${err.message}`, 'warn');
    }
  }
  return results;
}

function aggregateScores(allResults) {
  let totalFR = 0, totalSR = 0, frCount = 0, srCount = 0;
  const details = [];
  for (const { repo, results } of allResults) {
    for (const r of results) {
      if (r.fileRecall) { totalFR += r.fileRecall.score; frCount++; }
      if (r.symbolPrecision) { totalSR += r.symbolPrecision.score; srCount++; }
      details.push({ repo, name: r.name, fileRecall: r.fileRecall?.score ?? null, symbolRecall: r.symbolPrecision?.score ?? null });
    }
  }
  return { avgFileRecall: frCount > 0 ? totalFR / frCount : 0, avgSymbolRecall: srCount > 0 ? totalSR / srCount : 0, details };
}

async function applySuggestions(suggestions) {
  let applied = 0;
  for (const s of suggestions) {
    try {
      const content = await readFile(s.file, 'utf-8');
      if (content.includes(s.code)) { log(`Already applied: ${s.file}`, 'warn'); continue; }
      await writeFile(s.file, s.code, 'utf-8');
      applied++;
      log(`Applied: ${s.file} — ${s.description}`);
    } catch (err) {
      log(`Failed to apply ${s.file}: ${err.message}`, 'warn');
    }
  }
  return applied;
}

function extractSuggestions(text) {
  const candidates = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map(m => m[1]);
  if (candidates.length === 0) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) candidates.push(text.slice(start, end + 1));
  }
  for (const str of candidates) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) return parsed.suggestions;
    } catch {}
  }
  return [];
}

async function runImprovementCycle(scores) {
  log(`Current scores — File recall: ${(scores.avgFileRecall * 100).toFixed(1)}%, Symbol recall: ${(scores.avgSymbolRecall * 100).toFixed(1)}%`);
  log('');

  const prompt = buildAnalysisPrompt(
    scores.details.map(d => ({
      name: `${d.repo}/${d.name}`,
      fileRecall: d.fileRecall !== null ? { score: d.fileRecall } : null,
      symbolPrecision: d.symbolRecall !== null ? { score: d.symbolRecall } : null,
    })),
    knownLimitations()
  );

  log('Analyzing results with LLM...');
  const response = await runGenerate(prompt);
  log(`Raw LLM response (${response.length} chars):`);
  log(response.slice(0, 500));
  const suggestions = extractSuggestions(response);

  if (suggestions.length === 0) { log('No suggestions from LLM', 'warn'); return false; }

  log(`LLM suggested ${suggestions.length} change(s)`);
  const applied = await applySuggestions(suggestions);
  log(`Applied ${applied} change(s)`);
  return applied > 0;
}

export async function runSelfImprove(iterations) {
  const maxIter = iterations || MAX_ITERATIONS;
  log(`Self-improvement loop — max ${maxIter} iterations`);
  log('');

  const benchmarks = await findBenchmarkFiles();
  if (benchmarks.length === 0) { log('No benchmark files found in .reports/', 'warn'); return; }

  log(`Found ${benchmarks.length} benchmark(s): ${benchmarks.map(b => b.repo).join(', ')}`);
  log('');

  let prevScores = null;

  for (let i = 0; i < maxIter; i++) {
    log(`─── Iteration ${i + 1}/${maxIter} ───`);
    log('');

    const allResults = await runAllEvals(benchmarks);
    if (allResults.length === 0) { log('No eval results — aborting', 'warn'); return; }

    const scores = aggregateScores(allResults);
    const formatted = formatEvalResults(allResults.flatMap(r => r.results));
    console.log(formatted);
    log('');

    if (prevScores) {
      const frDelta = scores.avgFileRecall - prevScores.avgFileRecall;
      const srDelta = scores.avgSymbolRecall - prevScores.avgSymbolRecall;
      log(`Delta — File recall: ${(frDelta * 100).toFixed(1)}% | Symbol recall: ${(srDelta * 100).toFixed(1)}%`);
      if (frDelta < IMPROVEMENT_THRESHOLD && srDelta < IMPROVEMENT_THRESHOLD) {
        log('No significant improvement — stopping');
        break;
      }
    }

    prevScores = scores;

    const changed = await runImprovementCycle(scores);
    if (!changed) { log('No changes applied — stopping'); break; }
    log('');
  }

  if (prevScores) {
    log('Self-improvement complete');
    log(`Final scores — File recall: ${(prevScores.avgFileRecall * 100).toFixed(1)}% | Symbol recall: ${(prevScores.avgSymbolRecall * 100).toFixed(1)}%`);
  }
}
