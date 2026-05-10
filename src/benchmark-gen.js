import { loadIndex } from './indexer.js';
import { loadRelations, relationsExist } from './relations.js';
import { scanDir } from './fs-utils.js';
import { runGenerate } from './runner.js';
import { writeFile } from 'fs/promises';

const SKIP_DIRS = /[/\\](test|tests|spec|__tests__|__mocks__|fixtures|examples|docs|bench)[/\\]/;
const SKIP_EXTS  = /\.(md|yaml|yml|json|lock|toml|ini|cfg|txt|css|scss|html|svg|png|ico|xml)$/i;
const TEST_FILE_RE = /[/\\].+_test\.(go|py|rs|js)$/;
const TEST_FILE_RE2 = /[/\\]test_.+\.(go|py|rs)$/;
const CONFTEST_RE = /\bconftest\.py$/;

function isSourceFile(f) {
  if (SKIP_DIRS.test(f)) return false;
  if (SKIP_EXTS.test(f)) return false;
  if (TEST_FILE_RE.test(f)) return false;
  if (TEST_FILE_RE2.test(f)) return false;
  if (CONFTEST_RE.test(f)) return false;
  return true;
}

const MAJOR_DIRS = [/[/\\](src|lib|app|packages)[/\\]/];
const MINOR_DIRS = [/[/\\](crates|cmd|pkg|internal|include|core)[/\\]/];
const ROOT_EXT_PRIORITY = new Set(['.go', '.rs', '.py', '.rb']);

function findSourceFiles(allFiles) {
  const major = allFiles.filter(f => MAJOR_DIRS.some(r => r.test(f)) && isSourceFile(f));
  if (major.length >= 3) return major;

  const rootLevel = allFiles.filter(f => {
    const ext = f.match(/\.(\w+)$/)?.[1];
    if (!ext || !ROOT_EXT_PRIORITY.has('.' + ext)) return false;
    const norm = f.replace(/\\/g, '/');
    const parts = norm.split('/');
    if (parts.length !== 2) return false;
    return isSourceFile(f);
  });
  if (rootLevel.length >= 3) return rootLevel;

  const minor = allFiles.filter(f => MINOR_DIRS.some(r => r.test(f)) && isSourceFile(f));
  if (minor.length >= 3) return minor;

  const fallback = allFiles.filter(f => {
    const ext = f.match(/\.(\w+)$/)?.[1];
    return ext && ROOT_EXT_PRIORITY.has('.' + ext) && isSourceFile(f);
  });
  return fallback;
}

const DOT_RE = /\./;

function isDottedChain(sym) {
  return DOT_RE.test(sym);
}

const STDLIB_METHODS = new Set([
  'Promise.resolve', 'Promise.reject', 'Object.assign', 'Object.defineProperty',
  'Object.keys', 'Object.values', 'Object.entries', 'Object.getPrototypeOf',
  'Array.isArray', 'Array.from', 'Number.isFinite', 'Number.isNaN',
  'toString', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString',
  'as_ref', 'to_vec', 'clone', 'is_empty', 'as_bytes', 'into_path',
  'starts_with', 'is_match', 'is_some', 'is_none', 'unwrap', 'as_str',
  'to_string', 'as_byte', 'to_owned', 'into_iter',
]);
const STD_ARG_NAMES = new Set([
  'val', 'buf', 'dst', 'src', 'tmp', 'idx', 'len', 'pos', 'ptr', 'fn', 'ch',
  'input', 'output', 'result', 'options', 'config', 'data', 'value',
  'params', 'args', 'opts', 'err', 'res', 'req', 'self', 'this',
]);

function isValidSymbol(sym, allSymbolKeys) {
  if (isDottedChain(sym)) return false;
  if (allSymbolKeys && allSymbolKeys.has(sym)) return true;
  if (STDLIB_METHODS.has(sym)) return false;
  if (STD_ARG_NAMES.has(sym)) return false;
  if (/^[a-z]{1,3}$/.test(sym)) return false;
  return true;
}

function cleanSymbols(symbols, allSymbolKeys) {
  return symbols.filter(s => {
    const valid = isValidSymbol(s, allSymbolKeys);
    if (!valid) console.warn(`    Filtering out invalid symbol: "${s}"`);
    return valid;
  });
}

const MAX_FILES_IN_SUMMARY = 12;

function summarize(relations, allFiles) {
  const sourceFiles = findSourceFiles(allFiles)
    .map(f => ({ file: f, count: (relations.byFile[f] || []).length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FILES_IN_SUMMARY)
    .map(e => e.file);

  const lines = [];

  for (const file of sourceFiles) {
    const syms = relations.byFile[file];
    if (!syms || syms.length === 0) continue;

    const classes = syms.filter(s => s.kind === 'class');
    const functions = syms.filter(s => s.kind === 'function');
    const variables = syms.filter(s => s.kind === 'reference' || s.kind === 'variable');
    const main = [
      ...classes.map(s => ({ ...s, label: 'class' })),
      ...functions.map(s => ({ ...s, label: 'fn' })),
      ...variables.filter(s => s.exported).map(s => ({ ...s, label: 'var' })),
    ];

    const unique = new Map();
    for (const s of main) {
      if (!unique.has(s.name)) unique.set(s.name, s);
    }

    lines.push(`  ${file}`);
    for (const sym of [...unique.values()].slice(0, 15)) {
      lines.push(`    ${sym.label} ${sym.name}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function summarizeSymbolKeys(relations, allFiles, maxKeys = 200) {
  const dirPrefix = allFiles.length > 0
    ? allFiles[0].split(/[/\\]/)[0]
    : null;
  if (!dirPrefix) return '';
  const repoFileSet = new Set(
    Object.keys(relations.byFile).filter(f => f.startsWith(dirPrefix))
  );
  const defKinds = new Set(['class', 'function', 'variable']);
  const defKeys = [];
  const refKeys = [];
  for (const [k, entries] of Object.entries(relations.bySymbol)) {
    const inRepo = entries.some(e => e.file && repoFileSet.has(e.file));
    if (!inRepo) continue;
    const isDef = entries.some(e => e.file && repoFileSet.has(e.file) && defKinds.has(e.kind));
    (isDef ? defKeys : refKeys).push(k);
  }
  defKeys.sort();
  refKeys.sort();
  const combined = [...defKeys, ...refKeys.slice(0, Math.max(0, maxKeys - defKeys.length))];
  return combined.slice(0, maxKeys).join('\n');
}

function extractJSON(text) {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = jsonMatch ? jsonMatch[1] : text;
  const start = str.indexOf('[');
  const end = str.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in LLM response');
  return JSON.parse(str.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You are a senior developer exploring a new codebase. Generate a benchmark to test how well a code retrieval system can find relevant context for your questions.

CRITICAL RULE — ABSOLUTELY FORBIDDEN:
You MUST NEVER use dotted/chained symbols like "Error.Errors", "self.config.clone", "Promise.resolve", "result.then", "Object.assign", "inst.clone", "builder.build", "ctx.seen.set", "util.slugify", "input.normalize", "payload.issues.push", "checks.map", "regexes.map", "vals.every", "results.push", "matches.push", "errs.push", "range.clone", "parent.clone".
Every expected_symbols entry MUST be a SINGLE identifier — no dots, no property chains.

The code retrieval system can ONLY find symbols that match these regex patterns:
1. PascalCase: [A-Z][a-z]+(?:[A-Z][a-z0-9]+)+   e.g. "ZodError", "MethodView", "FlaskClient"
2. camelCase: [a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*   e.g. "compileETag", "parseAsync", "normalizeParams"
3. snake_case: [a-z][a-z0-9]+_[a-z][a-z0-9_]+    e.g. "add_url_rule", "from_pyfile", "set_charset"
4. UPPER_SNAKE: [A-Z]{2,}(?:_[A-Z0-9]+)+         e.g. "MAX_RETRY", "DEFAULT_PORT"
5. Single PascalCase word: [A-Z][a-z]{2,}         e.g. "View", "Route", "New", "Get", "Post"

ALSO FORBIDDEN:
- Standard library methods: toString, hasOwnProperty, isPrototypeOf
- Single-letter or 2-3 char lowercase: val, buf, dst, src, tmp, idx, len, pos, ptr, fn, ch
- Common parameter names: input, output, result, options, config, data, value, params, args, opts

GOOD expected_symbols examples: ["createApplication", "compileETag", "handle", "use", "render", "View", "add_url_rule", "safeParse", "parseAsync", "ZodError"]
BAD expected_symbols examples: ["Error.Errors", "self.config.clone", "Promise.resolve", "result.then", "Object.assign", "as_ref", "clone", "to_vec", "toString", "input.value", "opts.name"]

TASK:
Generate 12-15 questions a REAL developer would ask when learning this codebase.

Each entry:
- "name": short label
- "question": natural developer question
- "expected_files": 2-4 file paths matching EXACTLY the paths in the tree
- "expected_symbols": 2-5 symbol names — ALL must be single identifiers (NO DOTS) from the ALL SYMBOLS list or tree below

RULES:
- expected_files paths must match EXACTLY the paths shown in the tree
- EVERY expected_symbol MUST appear in the ALL SYMBOLS list below
- NEVER include dotted chains like "self.config.clone" or "Error.Errors"
- Cover different parts of the codebase
- Return ONLY a JSON array — no commentary

Example entry:
{"name":"Request pipeline","question":"How does a request flow through middleware to a route handler?","expected_files":["lib/express.js","lib/application.js"],"expected_symbols":["createApplication","handle","use"]}

ALL SYMBOLS IN CODEBASE (use ONLY these as expected_symbols):`;

// appended: symbols list + "Generate the benchmark JSON array now"

export async function generateBenchmark(benchmarkFile, dir, model) {
  const allFiles = await scanDir(dir);
  const hasRelations = await relationsExist();
  if (!hasRelations) {
    throw new Error(`No relations found. Run geniesh index --dir ${dir} first`);
  }
  const relations = await loadRelations();

  const summary = summarize(relations, allFiles);
  const symbolKeys = summarizeSymbolKeys(relations, allFiles);
  const allSymbolKeys = new Set(symbolKeys.split('\n').filter(Boolean));

  const prompt = `${SYSTEM_PROMPT}\n${symbolKeys}\n\nCODEBASE SUMMARY (file tree with symbols):\n${summary}\n\nGenerate the benchmark JSON array now. Return ONLY the JSON array. Mark sure ALL expected_symbols are from the ALL SYMBOLS list above.`;

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

  let cleaned = 0;
  const valid = benchmarks.filter(bm => {
    if (!bm.name || !bm.question || !bm.expected_files || !bm.expected_symbols) {
      console.warn(`  Skipping invalid entry (missing fields): ${bm.name || 'unnamed'}`);
      return false;
    }
    if (bm.expected_files.length < 1) {
      console.warn(`  Skipping "${bm.name}" — no expected_files`);
      return false;
    }
    if (bm.expected_symbols.length < 1) {
      console.warn(`  Skipping "${bm.name}" — no expected_symbols`);
      return false;
    }
    const before = bm.expected_symbols.length;
    bm.expected_symbols = cleanSymbols(bm.expected_symbols, allSymbolKeys);
    cleaned += before - bm.expected_symbols.length;
    if (bm.expected_symbols.length < 1) {
      console.warn(`  Skipping "${bm.name}" — all symbols filtered out`);
      return false;
    }
    return true;
  });
  if (cleaned > 0) console.warn(`  Filtered out ${cleaned} invalid symbol(s) across all entries`);
  if (valid.length < 5) {
    throw new Error(`Only ${valid.length} valid benchmarks — need at least 5`);
  }
  benchmarks = valid;

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
