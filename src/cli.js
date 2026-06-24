#!/usr/bin/env node

import { createInterface } from 'readline';
import { Command } from 'commander';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

import { startChat } from './chat.js';
import { setModel, checkOllamaHealth, runQuery, runGenerate } from './runner.js';
import { setEmbedder } from './embedder.js';
import { buildIndex, buildIndexFromFileList, loadIndex, indexExists } from './indexer.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt, buildDiffReviewPrompt, buildCommitPrompt, buildPrPrompt } from './prompt.js';
import { readFile } from './fs-utils.js';
import { extractFunction } from './extractor.js';
import { getBranchDiff, getStagedDiff, getRecentCommits } from './git-utils.js';

function ask(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(query, answer => { rl.close(); resolve(answer.trim()); });
  });
}

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
    try {
      const model = opts.model || program.opts().model || 'qwen3-coder';
      setModel(model);
      const { head: branch, mergeBase, log, stat, diff } = getBranchDiff(base, head);
      if (!diff.trim()) { console.log('✓ No differences found — branches are identical.'); return; }
      const prompt = buildDiffReviewPrompt(log, stat, diff);
      console.log(`\n\x1b[36m📊 ${branch}\x1b[0m → \x1b[33m${base}\x1b[0m  (merge-base: ${mergeBase.slice(0, 7)})\n`);
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
  .command('commit')
  .description('Generate a conventional commit message from staged changes')
  .option('--dry-run', 'Print the message without committing')
  .option('-a, --all', 'Stage all tracked changes first')
  .option('--model <name>', 'Ollama model')
  .action(async (opts) => {
    try {
      const model = opts.model || program.opts().model || 'qwen3-coder';
      setModel(model);

      let { diff, stat } = getStagedDiff();
      if (!diff.trim()) {
        if (opts.all) {
          execSync('git add -A', { encoding: 'utf-8' });
          const r = getStagedDiff();
          diff = r.diff;
          stat = r.stat;
        }
        if (!diff.trim()) { console.error('No staged changes. Use `git add` or --all.'); process.exit(1); }
      }

      const recentLog = getRecentCommits(5);
      const prompt = buildCommitPrompt(diff, recentLog);
      const reply = await runGenerate(prompt, model);
      if (!reply.trim()) { console.error('Model returned empty message.'); process.exit(1); }

      const lines = reply.trim().split('\n');
      const subject = lines[0].trim();
      const body = lines.slice(1).map(l => l.trimRight()).join('\n').trim();

      console.log(`\n\x1b[36m┌─ Proposed commit ──────────────────────────\x1b[0m`);
      console.log(`\x1b[36m│\x1b[0m ${subject}`);
      if (body) {
        for (const line of body.split('\n')) {
          console.log(`\x1b[36m│\x1b[0m ${line}`);
        }
      }
      console.log(`\x1b[36m└──────────────────────────────────────────────\x1b[0m\n`);

      if (opts.dryRun) return;

      const ans = await ask('Create this commit? [Y/n/e dit] ');
      if (!ans || ans.toLowerCase() === 'y' || ans === '') {
        const tf = `/tmp/geniesh-commit-${Date.now()}.txt`;
        await writeFile(tf, reply.trim(), 'utf-8');
        execSync(`git commit -F "${tf}"`, { encoding: 'utf-8', stdio: 'inherit' });
        await unlink(tf);
      } else if (ans.toLowerCase() === 'e') {
        const tf = `/tmp/geniesh-commit-${Date.now()}.txt`;
        await writeFile(tf, reply.trim(), 'utf-8');
        const editor = process.env.EDITOR || 'nano';
        execSync(`${editor} "${tf}"`, { encoding: 'utf-8', stdio: 'inherit' });
        execSync(`git commit -F "${tf}"`, { encoding: 'utf-8', stdio: 'inherit' });
        await unlink(tf);
      }
    } catch (err) {
      if (err.message?.includes('fatal:')) {
        console.error(`Git error: ${err.message.split('\n')[0]}`);
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
  .command('pr')
  .description('Generate a PR description from branch diff')
  .argument('<base>', 'Base branch (main, trunk, master, etc.)')
  .argument('[head]', 'Feature branch (default: current HEAD)')
  .option('--open', 'Create the PR via gh CLI')
  .option('--model <name>', 'Ollama model')
  .action(async (base, head, opts) => {
    try {
      const model = opts.model || program.opts().model || 'qwen3-coder';
      setModel(model);
      const { head: branch, mergeBase, log, stat, diff } = getBranchDiff(base, head);
      if (!diff.trim()) { console.log('✓ No differences found — branches are identical.'); return; }

      if (opts.open) {
        const prompt = buildPrPrompt(log, stat, diff);
        const reply = await runGenerate(prompt, model);
        if (!reply.trim()) { console.error('Model returned empty response.'); process.exit(1); }
        const titleMatch = reply.match(/^Title:\s*(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : branch;
        const body = reply.replace(/^Title:\s*.+(\n|$)/, '').trim();
        try {
          execSync('gh --version', { encoding: 'utf-8', stdio: 'pipe' });
        } catch {
          console.error('\nGitHub CLI not found. Install: https://cli.github.com/');
          process.exit(1);
        }
        const tf = `/tmp/geniesh-pr-${Date.now()}.md`;
        await writeFile(tf, body, 'utf-8');
        const result = execSync(
          `gh pr create --title "${title.replace(/"/g, '\\"')}" --body-file "${tf}" --base "${base}"`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );
        await unlink(tf);
        console.log(`\x1b[32m✓ ${result.trim()}\x1b[0m`);
      } else {
        const prompt = buildPrPrompt(log, stat, diff);
        console.log(`\n\x1b[36m📋 PR: ${branch}\x1b[0m → \x1b[33m${base}\x1b[0m  (merge-base: ${mergeBase.slice(0, 7)})\n`);
        await runQuery(prompt);
      }
    } catch (err) {
      if (err.message?.includes('fatal:')) {
        console.error(`Git error: ${err.message.split('\n')[0]}`);
      } else { console.error(`\nError: ${err.message}`); }
      process.exit(1);
    }
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
      console.log('  \x1b[1mCLI commands:\x1b[0m');
      console.log('  \x1b[90m  chat\x1b[0m               Interactive coding session');
      console.log('  \x1b[90m  diff <base> [head]\x1b[0m  PR-style code review between branches');
      console.log('  \x1b[90m  commit\x1b[0m             Generate commit message from staged changes');
      console.log('  \x1b[90m  pr <base> [head]\x1b[0m    Generate PR description');
      console.log('  \x1b[90m  index\x1b[0m              Build RAG index for a directory');
      console.log('  \x1b[90m  "query" --file\x1b[0m      One-shot analysis of a file\n');
      console.log('  \x1b[1mIn-chat commands\x1b[0m \x1b[90m(/file, /ctx, /edit, /search, /analyse, /plan, /budget, /compact)\x1b[0m');
      console.log('  \x1b[90m  /file "path"\x1b[0m         Load file(s) into context');
      console.log('  \x1b[90m  /ctx "symbols"\x1b[0m       Pull call-graph context via genx');
      console.log('  \x1b[90m  /edit\x1b[0m               Enable SEARCH/REPLACE edit mode with diff review');
      console.log('  \x1b[90m  /search "query"\x1b[0m      Web search and fetch top pages');
      console.log('  \x1b[90m  /analyse\x1b[0m             Deep codebase analysis with RAG + genx');
      console.log('  \x1b[90m  /plan\x1b[0m                Plan-only mode (no code output)');
      console.log('  \x1b[90m  /budget\x1b[0m              Show token budget breakdown');
      console.log('  \x1b[90m  /compact\x1b[0m             Trim conversation history\n');
      console.log('  \x1b[90m  geniesh <command> --help   for details\x1b[0m\n');
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
