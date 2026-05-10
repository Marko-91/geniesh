#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { basename } from 'path';
import { createRequire } from 'module';
import { readFile } from './fs-utils.js';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import { extractFunction } from './extractor.js';
import { buildIndex, loadIndex, indexExists, buildIndexFromFileList } from './indexer.js';
import { loadRelations, relationsExist } from './relations.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt } from './prompt.js';
import { runQuery, runChat, runGenerate, setModel } from './runner.js';
import { setEmbedder } from './embedder.js';
import { runEval, formatEvalResults } from './eval.js';
import { generateBenchmark } from './benchmark-gen.js';
import { runSelfImprove } from './autoimprove/auto-improve.js';
import { grepDir, formatGrepResults, buildGrepContext } from './grep.js';
import { buildChatContext, applySlideWindow } from './context-builder.js';
import { extractSymbols } from './symbol-utils.js';
import { scanDir, extractFileRefs } from './fs-utils.js';
import { execSync } from 'child_process';
import ora from 'ora';

const program = new Command();
const icons = ['⏳', '🤔', '🧠', '🔮'];
await checkOllamaHealth();

program
  .name('geniesh')
  .description('Local AI developer assistant — BFS relation-graph + RAG (powered by Ollama)')
  .version(version)
  .enablePositionalOptions()
  .option('--model <name>', 'Ollama model to use', 'qwen3-coder')
  .option('--embedder <name>', 'Ollama embedding model to use', 'nomic-embed-text')
  .hook('preAction', (thisCommand) => {
    const { model, embedder } = thisCommand.opts();
    if (model) setModel(model);
    if (embedder) setEmbedder(embedder);
  });

// ─── ai index --dir <path> ───────────────────────────────────────────────────

program
  .command('index')
  .description('Build a RAG index for a directory or single file')
  .option('--dir <path>', 'Directory to scan and index')
  .option('--file <path>', 'Single file to index')
  .action(async (opts) => {
    try {
      if (opts.file) {
        // Index single file
        await buildIndexFromFileList(opts.file);
      } else if (opts.dir) {
        // Index directory
        await buildIndex(opts.dir);
      } else {
        throw new Error('Either --dir or --file must be specified');
      }
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai chat ─────────────────────────────────────────────────────────────────

program
  .command('chat')
  .description('Start an intelligent chat session with auto-indexing and priority RAG')
  .option('--dir <path>', 'Directory to use for indexing/search (default: cwd)')
  .option('--files <paths...>', 'Explicit files to use as context (skips auto-index)')
  .option('--dirs <paths...>', 'Explicit directories to scan as context (skips auto-index)')
  .action(async (opts) => {
    const dir = opts.dir || process.cwd();

    // ─ 1. Build or load index ─────────────────────────────────────────────────
    let index;
    let allFiles;
    const hasExplicit = (opts.files && opts.files.length > 0) || (opts.dirs && opts.dirs.length > 0);

    if (hasExplicit) {
      // Explicit mode: build an in-memory index from the given files/dirs only
      let explicitFiles = [...(opts.files || [])];
      for (const d of (opts.dirs || [])) {
        const scanned = await scanDir(d);
        explicitFiles = explicitFiles.concat(scanned);
      }
      // deduplicate
      explicitFiles = [...new Set(explicitFiles)];
      console.log(`\n📎  Explicit context: ${explicitFiles.length} file(s)\n`);
      index = await buildIndexFromFileList(explicitFiles);
      allFiles = explicitFiles;
    } else if (await indexExists()) {
      const loadSpinner = ora('Loading index…').start();
      index = await loadIndex();
      loadSpinner.succeed(`Index loaded — ${index.length} chunks from ${new Set(index.map(e => e.file)).size} files`);
      allFiles = await scanDir(dir);
    } else {
      console.log(`\n⚠️  No index found. Building index for ${dir}…\n`);
      index = await buildIndex(dir);
      allFiles = await scanDir(dir);
    }

    let relations = null;
    if (!hasExplicit && await relationsExist()) {
      try { relations = await loadRelations(); } catch {}
    }

    // ─ 3. System prompt ───────────────────────────────────────────────────────
    const messages = [
      {
        role: 'system',
        content:
          'You are a senior software engineer.\n\n' +
          'Rules:\n' +
          '- Every claim about code MUST cite the exact file and line number\n' +
          '  from the provided context above. If the file or line is not in the\n' +
          '  context, do not cite it.\n' +
          '- If you cannot cite it, it is not in the code — state that clearly.\n' +
          '- You may use general knowledge for analysis and suggestions, but preface\n' +
          '  general advice with "In general:" or "A common pattern is:" so the user\n' +
          '  knows it is not from the code.\n' +
          '- Never invent file names, function names, or line numbers.\n' +
          '- Prefer simple, minimal changes. Do not propose additional abstraction\n' +
          '  layers unless the existing code demonstrably fails at its task.',
      },
    ];

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('🧠  AI Chat  —  type \x1b[33mexit\x1b[0m or Ctrl+C to quit');
    if (hasExplicit) {
      console.log(`📎  Context   : ${allFiles.length} explicit file(s)`);
    } else {
      console.log(`📂  Directory : ${dir}`);
    }
    console.log(`🧩  Model     : ${program.opts().model || 'qwen3-coder'}`);
    console.log(`🔤  Embedder  : ${program.opts().embedder || 'nomic-embed-text'}`);
    console.log(`📚  Index     : ${index.length} chunks`);
    console.log('────────────────────────────────────────────────────────────\n');

    console.log('\x1b[90m💡 Tips\x1b[0m');
    console.log('\x1b[90m   • Mention a file path to load it as full context:  "look at lib/application.js"\x1b[0m');
    console.log('\x1b[90m   • Ask about specific symbols:                      "how does Router.handle work?"\x1b[0m');
    console.log('\x1b[90m   • Use concrete function/method names for best BFS\x1b[0m');
    console.log('\x1b[90m   • Type \x1b[33mexit\x1b[90m or Ctrl+C to quit\x1b[0m\n');

    process.on('SIGINT', () => {
      console.log('\nBye!');
      rl.close();
      process.exit(0);
    });

    while (true) {
      let userInput;
      try {
        userInput = await ask('\x1b[32mYou\x1b[0m: ');
      } catch {
        break;
      }

      const trimmed = userInput.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        rl.close();
        console.log('Bye!');
        break;
      }

      // ─ Build context ─────────────────────────────────────────────────────────
      const symbols = extractSymbols(trimmed);
      const fileRefs = extractFileRefs(trimmed, allFiles);
      const ctxSpinner = ora({
        text: symbols.length
          ? `Building context (BFS + RAG: ${symbols.join(', ')})…`
          : fileRefs.length
            ? `Building context (files: ${fileRefs.map(f => basename(f)).join(', ')})…`
            : 'Building context (RAG)…',
        color: 'cyan',
      }).start();

      let contextText = '';
      let traceFormatted = '';
      try {
        const { contextString, log, traceFormatted: trace } = await buildChatContext(trimmed, index, allFiles, relations, fileRefs, search);
        contextText = contextString;
        traceFormatted = trace;
        ctxSpinner.succeed(
          symbols.length
            ? `Context ready — BFS traversal for: ${symbols.join(', ')}`
            : fileRefs.length
              ? `Context ready — file-ref: ${fileRefs.map(f => basename(f)).join(', ')}`
              : 'Context ready — RAG',
        );
        if (traceFormatted) {
          console.log(traceFormatted);
        }
      } catch (err) {
        ctxSpinner.warn(`Context build failed (${err.message}), falling back to plain message`);
      }

      const content = contextText
        ? `<codebase_context>\n${contextText}\n</codebase_context>\n\nQuestion: ${trimmed}`
        : trimmed;

      // Apply sliding window before pushing new turn
      applySlideWindow(messages);
      messages.push({ role: 'user', content });

      // ─ LLM call ───────────────────────────────────────────────────────────────
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      try {
        const reply = await runChat(messages);
        messages.push({ role: 'assistant', content: reply });
      } catch (err) {
        console.error(`\nError: ${err.message}`);
        messages.pop();
      }
      console.log();
    }
  });

// ─── geniesh "<query>" --file / --fn / --dir ─────────────────────────────────

program
  .argument('[query]', 'What to ask the AI about your code')
  .option('--file <path>', 'Analyze a specific file')
  .option('--fn <name>',   'Extract and analyze a specific function (requires --file)')
  .option('--dir <path>',  'Use RAG over an indexed directory')
  .action(async (query, opts) => {
    if (!query && !opts.file && !opts.dir) {
      console.log('');
      console.log(`  \x1b[1;36m🧞  geniesh\x1b[0m  \x1b[90mv${version}\x1b[0m`);
      console.log('  \x1b[90mYour code genie is out of the bottle.\x1b[0m');
      console.log('');
      console.log('  \x1b[90m  geniesh chat\x1b[0m       \x1b[90mExplore any codebase hands-free\x1b[0m');
      console.log('  \x1b[90m  geniesh "fix this"\x1b[0m  \x1b[90m--file src/app.js  One-shot analysis\x1b[0m');
      console.log('  \x1b[90m  geniesh --help\x1b[0m     \x1b[90mSee all commands\x1b[0m');
      console.log('');
      return;
    }
    try {
      let prompt;

      if (opts.file) {
        const content = await readFile(opts.file);

        if (opts.fn) {
          const fnCode = extractFunction(content, opts.fn);
          if (!fnCode) {
            console.error(`Function "${opts.fn}" not found in ${opts.file}`);
            process.exit(1);
          }
          prompt = buildDirectPrompt(query, fnCode, `${opts.file} → ${opts.fn}()`);
        } else {
          prompt = buildDirectPrompt(query, content, opts.file);
        }
      } else if (opts.dir) {
        if (!(await indexExists())) {
          console.error(`No index found. Run first:\n  geniesh index --dir ${opts.dir}`);
          process.exit(1);
        }

        const index = await loadIndex();
        const chunks = await search(query, index, 5);

        if (chunks.length === 0) {
          console.error('No relevant chunks found in the index.');
          process.exit(1);
        }

        prompt = buildPrompt(query, chunks);
      } else {
        console.error('Provide --file <path> or --dir <path>');
        program.help();
        process.exit(1);
      }

      await runQuery(prompt);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai refs <name> --dir <path> ────────────────────────────────────────────

program
  .command('refs')
  .description('Find all usages of a symbol across a directory (no index needed)')
  .argument('<name>', 'Function, variable, or symbol name to search for')
  .requiredOption('--dir <path>', 'Directory to search')
  .option('--ask <question>', 'Ask the LLM a question about the found usages')
  .option('--explain', 'Ask the LLM to explain the symbol and its usage patterns')
  .option('--context <lines>', 'Lines of context around each match', (v) => parseInt(v, 10), 20)
  .action(async (name, opts) => {
    try {
      process.stdout.write(`Searching for "${name}" in ${opts.dir}...\n`);
      const results = await grepDir(name, opts.dir, opts.context);

      console.log(formatGrepResults(results, name));

      const question = opts.ask
        || (opts.explain
          ? `Explain what "${name}" does, how it is used across the codebase, and what the calling patterns suggest about its responsibilities and design.`
          : null);

      if (question) {
        if (results.length === 0) {
          console.error('No matches to analyse.');
          process.exit(1);
        }
        const context = buildGrepContext(results);
        const prompt = `You are a senior software engineer.

Context (all usages of "${name}" found in the codebase):
${context}

Task:
${question}

Return:
- bugs
- improvements
- security issues
- explanation (if relevant)

Be concise and practical.`;
        await runQuery(prompt);
      }
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai review <query> --file / --dir ───────────────────────────────────────

program
  .command('review')
  .description('Analyze code with one model, then critique with another')
  .argument('<query>', 'Question about the code')
  .option('--file <path>', 'File to analyze')
  .option('--dir <path>', 'Directory to search (requires index)')
  .option('--reviewer <model>', 'Reviewer model to critique the analysis', 'llama3.1')
  .action(async (query, opts) => {
    try {
      const primaryModel = program.opts().model || 'qwen3-coder';
      const reviewerModel = opts.reviewer;
      let context = '';

      if (opts.file) {
        const content = await readFile(opts.file);
        context = `<codebase_context>\n${content}\n</codebase_context>`;
      } else if (opts.dir) {
        if (!(await indexExists())) {
          console.error(`No index found. Run first:\n  geniesh index --dir ${opts.dir}`);
          process.exit(1);
        }
        const index = await loadIndex();
        const chunks = await search(query, index, 5);
        if (chunks.length === 0) {
          console.error('No relevant chunks found in the index.');
          process.exit(1);
        }
        context = buildPrompt(query, chunks);
      } else {
        console.error('Provide --file <path> or --dir <path>');
        process.exit(1);
      }

      console.log(`\n\x1b[1mStage 1: Analysis (\x1b[36m${primaryModel}\x1b[0m)\x1b[0m\n`);

      const analysis = await runGenerate(
        `You are a senior software engineer.\n\n${context}\n\nQuestion: ${query}\n\nAnalyze the code and provide a thorough answer. Be specific with file names and line numbers.`,
        primaryModel,
      );

      console.log(`\n\x1b[1mStage 2: Review (\x1b[33m${reviewerModel}\x1b[0m)\x1b[0m\n`);

      setModel(reviewerModel);
      await runQuery(
        `You are a senior software engineer acting as a code reviewer.\n\n` +
        `Below is an analysis produced by another AI model (${primaryModel}) in response to the question "${query}".\n\n` +
        `<analysis>\n${analysis}\n</analysis>\n\n` +
        `Your job is to review this analysis for:\n` +
        `- Accuracy: Are the claims correct? Are file names and line numbers real?\n` +
        `- Completeness: Did the analysis miss anything important?\n` +
        `- Bug hunting: Can you find bugs the analysis missed?\n` +
        `- Improvements: Are there better approaches?\n\n` +
        `Be critical and specific. Praise what's good, correct what's wrong, add what's missing.`,
      );
      setModel(primaryModel);

      console.log();
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai eval --benchmark <file> --dir <path> ────────────────────────────────

program
  .command('eval')
  .description('Evaluate retrieval quality against a benchmark suite')
  .requiredOption('--benchmark <file>', 'Benchmark JSON file')
  .requiredOption('--dir <path>', 'Directory of the codebase to evaluate against')
  .option('--verbose', 'Print per-benchmark details')
  .action(async (opts) => {
    try {
      const results = await runEval(opts.benchmark, opts.dir, !!opts.verbose);
      console.log(formatEvalResults(results));
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai benchmark generate --dir <path> --output <file> ────────────────────

const benchmark = program.command('benchmark').description('Generate and manage benchmark suites');

benchmark
  .command('generate')
  .description('Auto-generate a benchmark suite by analyzing the codebase with an LLM')
  .requiredOption('--dir <path>', 'Directory of the codebase to analyze')
  .option('--output <file>', 'Output benchmark JSON file', 'geniesh-benchmark.json')
  .option('--model <name>', 'Ollama model to use for generation')
  .action(async (opts) => {
    try {
      const model = opts.model || program.opts().model;
      await generateBenchmark(opts.output, opts.dir, model);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai self-improve [iterations] ────────────────────────────────────────

program
  .command('self-improve')
  .description('Run the self-improvement loop: eval → analyze → fix → retest → repeat')
  .argument('[iterations]', 'Maximum iterations (default 5)', parseInt)
  .action(async (iterations) => {
    try {
      await runSelfImprove(iterations);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);

async function checkOllamaHealth() {
  const url = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('✅ Ollama server running!');
  } catch {
    console.error('❌ Ollama server is not running. Start Ollama with `ollama serve`.');
    process.exit(1);
  }
}
