import { loadIndex } from './indexer.js';
import { loadRelations, relationsExist } from './relations.js';
import { scanDir } from './fs-utils.js';
import { runGenerate } from './runner.js';
import { writeFile } from 'fs/promises';

const HIGH_PRIORITY_DIRS = /[/\\](src|lib|app|core|include|packages)[/\\]/;
const TEST_DIRS = /[/\\](test|spec|__tests__|__mocks__|fixtures|examples|docs)[/\\]/;

function summarize(relations, allFiles) {
  const sourceFiles = allFiles.filter(f =>
    HIGH_PRIORITY_DIRS.test(f) && !TEST_DIRS.test(f)
  );

  const lines = [];

  for (const file of sourceFiles) {
    const syms = relations.byFile[file];
    if (!syms || syms.length === 0) continue;

    const exported = syms.filter(s => s.exported);
    const classes = syms.filter(s => s.kind === 'class');
    const functions = exported.filter(s => s.kind === 'function');
    const main = [...classes, ...functions, ...exported.filter(s => s.kind !== 'class' && s.kind !== 'function')];

    lines.push(`## ${file}`);
    lines.push('');

    const imports = relations.byImports[file];
    const localImports = imports
      ? imports.filter(i => sourceFiles.includes(i))
      : [];
    if (localImports.length > 0) {
      lines.push(`  imports: ${localImports.map(i => `\`${i}\``).join(', ')}`);
    }

    const importers = relations.byImporters[file];
    const localImporters = importers
      ? importers.filter(i => sourceFiles.includes(i))
      : [];
    if (localImporters.length > 0) {
      lines.push(`  imported_by: ${localImporters.map(i => `\`${i}\``).join(', ')}`);
    }

    for (const sym of main.slice(0, 20)) {
      const refs = relations.bySymbol[sym.name];
      const refFiles = refs ? [...new Set(refs.map(r => r.file))].filter(f => sourceFiles.includes(f) && f !== file) : [];
      lines.push(`  - ${sym.kind === 'function' ? 'fn' : sym.kind === 'class' ? 'class' : 'var'} \`${sym.name}\`` + (refFiles.length > 0 ? ` (also referenced in: ${refFiles.join(', ')})` : ''));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function extractJSON(text) {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = jsonMatch ? jsonMatch[1] : text;
  const start = str.indexOf('[');
  const end = str.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in LLM response');
  return JSON.parse(str.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You are a benchmark generator for a code retrieval system called geniesh.

Your job: analyze the codebase summary below and generate a benchmark JSON file with 12-15 questions that test how well the system retrieves relevant code context.

Each benchmark question must have:
- "name": short descriptive name
- "question": what a developer would ask (natural language)
- "expected_files": which source files MUST be retrieved to answer the question (2-4 files)
- "expected_symbols": which function/class/variable names MUST appear in the retrieved context (2-5 symbols)

RULES:
1. Questions must require CROSS-FILE knowledge — at least 2 expected_files per question
2. expected_symbols must be real symbol names from the summary (case-sensitive)
3. Include questions about:
   - Core API flow (e.g., "How does X work?")
   - Error handling paths
   - Configuration/settings
   - Data flow between modules
   - Multi-hop dependencies (file A -> file B -> file C)
4. expected_files paths must match EXACTLY as shown in the ## headers
5. Return ONLY a JSON array, no extra text
6. Each question must be answerable from the code, not general knowledge

Example question:
{ "name": "Middleware pipeline", "question": "How does the middleware pipeline process a request? Walk through what happens when app.use is called.", "expected_files": ["express\\\\lib\\\\application.js"], "expected_symbols": ["use", "handle", "flatten"] }`;

export async function generateBenchmark(benchmarkFile, dir, model) {
  const allFiles = await scanDir(dir);
  const hasRelations = await relationsExist();
  if (!hasRelations) {
    throw new Error(`No relations found. Run geniesh index --dir ${dir} first`);
  }
  const relations = await loadRelations();

  const summary = summarize(relations, allFiles);

  const prompt = `${SYSTEM_PROMPT}\n\nCODEBASE SUMMARY:\n${summary}\n\nGenerate the benchmark JSON array now. Return ONLY the JSON array.`;

  const response = await runGenerate(prompt, model);

  let benchmarks;
  try {
    benchmarks = extractJSON(response);
  } catch (err) {
    throw new Error(`Failed to parse LLM response as JSON: ${err.message}\n\nRaw response:\n${response}`);
  }

  if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
    throw new Error('LLM returned empty or invalid benchmark array');
  }

  for (const bm of benchmarks) {
    if (!bm.name || !bm.question || !bm.expected_files || !bm.expected_symbols) {
      throw new Error(`Invalid benchmark entry: ${JSON.stringify(bm)}`);
    }
    if (bm.expected_files.length < 2) {
      throw new Error(`Benchmark "${bm.name}" has fewer than 2 expected_files`);
    }
    if (bm.expected_symbols.length < 2) {
      throw new Error(`Benchmark "${bm.name}" has fewer than 2 expected_symbols`);
    }
  }

  const output = { benchmarks };
  await writeFile(benchmarkFile, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n  Generated ${benchmarks.length} benchmarks → ${benchmarkFile}\n`);

  for (const bm of benchmarks) {
    console.log(`  ${bm.name}`);
    console.log(`    Files:   ${bm.expected_files.join(', ')}`);
    console.log(`    Symbols: ${bm.expected_symbols.join(', ')}`);
    console.log('');
  }

  return benchmarks;
}
