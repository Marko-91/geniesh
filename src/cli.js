#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

import { startChat } from './chat.js';
import { setModel, checkOllamaHealth } from './runner.js';
import { setEmbedder } from './embedder.js';
import { buildIndex, buildIndexFromFileList, loadIndex, indexExists } from './indexer.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt, buildDiffReviewPrompt } from './prompt.js';
import { readFile } from './fs-utils.js';
import { extractFunction } from './extractor.js';
import { runQuery } from './runner.js';

const program = new Command();
await checkOllamaHealth();

program
  .name('geniesh')
  .description('AI developer assistant — Ollama + file context')
  .version(version)
  .enablePositionalOptions()
  .option('--model <name>', 'Ollama model', 'qwen3-coder')
  .option('--embedder <name>', 'Embedding model', 'nomic-embed-text')
  .hook('preAction', (cmd) => {
    const opts = cmd.opts();
    if (opts.model) setModel(opts.model);
    if (opts.embedder) setEmbedder(opts.embedder);
  });

program
  .command('chat')
  .description('Interactive coding chat with auto file context')
  .option('--model <name>', 'Ollama model (default: qwen3-coder)')
  .option('--dir <path>', 'Project root (default: cwd)')
  .option('--full-index', 'Pre-build RAG index for vague-query discovery')
  .action(async (opts) => {
    const model = opts.model || program.opts().model || 'qwen3-coder';
    const dir = resolve(opts.dir || process.cwd());
    await startChat(model, dir, opts);
  });

program
  .command('diff')
  .description('PR-style review of changes between two branches')
  .argument('<base>', 'Base branch (main, trunk, master, etc.)')
  .argument('[head]', 'Feature branch (default: current HEAD)')
  .option('--model <name>', 'Ollama model')
  .action(async (base, head, opts) => {
    const MB = 1024 * 1024;
    try {
      const model = opts.model || program.opts().model || 'qwen3-coder';
      setModel(model);
      if (!head) {
        head = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', maxBuffer: 1 * MB }).trim();
      }
      const mergeBase = execSync(`git merge-base "${base}" "${head}"`, { encoding: 'utf-8', maxBuffer: 1 * MB }).trim();
      const log = execSync(`git log --oneline "${mergeBase}..${head}"`, { encoding: 'utf-8', maxBuffer: 5 * MB });
      const stat = execSync(`git diff --stat "${mergeBase}..${head}"`, { encoding: 'utf-8', maxBuffer: 5 * MB });
      const diff = execSync(`git diff "${mergeBase}..${head}"`, { encoding: 'utf-8', maxBuffer: 50 * MB });
      if (!diff.trim()) { console.log('✓ No differences found — branches are identical.'); return; }
      const prompt = buildDiffReviewPrompt(log, stat, diff);
      console.log(`\n\x1b[36m📊 ${head}\x1b[0m → \x1b[33m${base}\x1b[0m  (merge-base: ${mergeBase.slice(0, 7)})\n`);
      await runQuery(prompt);
    } catch (err) {
      if (err.message.includes('fatal:')) {
        console.error(`Git error: ${err.message.split('\n')[0]}`);
      } else if (err.code === 'ENOBUFS') {
        console.error('Diff too large — output exceeded buffer. Try a smaller scope or use --model with larger context.');
      } else { console.error(`\nError: ${err.message}`); }
      process.exit(1);
    }
  });

program
  .command('index')
  .description('Build RAG index for a directory')
  .option('--dir <path>', 'Directory to scan and index')
  .option('--file <path>', 'Single file to index')
  .action(async (opts) => {
    try {
      if (opts.file) await buildIndexFromFileList(opts.file);
      else if (opts.dir) await buildIndex(opts.dir);
      else throw new Error('Specify --dir or --file');
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
  });

program
  .argument('[query]', 'What to ask about your code')
  .option('--file <path>', 'Analyze a specific file')
  .option('--fn <name>', 'Extract a function (requires --file)')
  .option('--dir <path>', 'Use RAG over an indexed directory')
  .action(async (query, opts) => {
    if (!query && !opts.file && !opts.dir) {
      console.log(`\n  \x1b[1;36m🧞  geniesh\x1b[0m  \x1b[90mv${version}\x1b[0m`);
      console.log('  \x1b[90mYour code genie is out of the bottle.\x1b[0m\n');
      console.log('  \x1b[90m  geniesh chat\x1b[0m          Interactive chat');
      console.log('  \x1b[90m  geniesh "fix this"\x1b[0m    \x1b[90m--file src/app.js  One-shot\x1b[0m');
      console.log('  \x1b[90m  geniesh --help\x1b[0m        See all commands\x1b[0m\n');
      return;
    }
    try {
      let prompt;
      if (opts.file) {
        const content = await readFile(opts.file);
        if (opts.fn) {
          const fnCode = extractFunction(content, opts.fn);
          if (!fnCode) { console.error(`Function "${opts.fn}" not found`); process.exit(1); }
          prompt = buildDirectPrompt(query, fnCode, `${opts.file} → ${opts.fn}()`);
        } else {
          prompt = buildDirectPrompt(query, content, opts.file);
        }
      } else if (opts.dir) {
        if (!(await indexExists())) { console.error(`No index. Run: geniesh index --dir ${opts.dir}`); process.exit(1); }
        const idx = await loadIndex();
        const chunks = await search(query, idx, 5);
        if (!chunks.length) { console.error('No relevant chunks found.'); process.exit(1); }
        prompt = buildPrompt(query, chunks);
      } else { console.error('Specify --file or --dir'); process.exit(1); }
      await runQuery(prompt);
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
  });

program.parseAsync(process.argv);
