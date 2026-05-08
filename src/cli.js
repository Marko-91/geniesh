#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { readFile } from './fs-utils.js';
import { extractFunction } from './extractor.js';
import { buildIndex, loadIndex, indexExists, buildIndexFromFileList } from './indexer.js';
import { loadRelations, relationsExist } from './relations.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt } from './prompt.js';
import { runQuery, runChat, setModel } from './runner.js';
import { grepDir, formatGrepResults, buildGrepContext } from './grep.js';
import { buildChatContext, applySlideWindow } from './context-builder.js';
import { extractSymbols } from './symbol-utils.js';
import { scanDir } from './fs-utils.js';
import { execSync } from 'child_process';
import ora from 'ora';

const program = new Command();
const icons = ['⏳', '🤔', '🧠', '🔮'];
await checkOllamaHealth();

program
  .name('ai')
  .description('Local AI developer assistant — Llama 3 + RAG (powered by Ollama)')
  .version('1.0.0')
  .enablePositionalOptions()
  .option('--model <name>', 'Ollama model to use', 'qwen3-coder')
  .hook('preAction', (thisCommand) => {
    const model = thisCommand.opts().model;
    if (model) setModel(model);
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
          'You are a senior software engineer with full access to the codebase context provided. ' +
          'Answer questions concisely and practically. Always reference exact file names and line numbers when relevant. ' +
          'If the answer is not in the provided context, say so clearly instead of guessing.',
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
    console.log(`📚  Index     : ${index.length} chunks`);
    console.log('────────────────────────────────────────────────────────────\n');

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
      const ctxSpinner = ora({
        text: symbols.length
          ? `Building context (BFS + RAG: ${symbols.join(', ')})…`
          : 'Building context (RAG)…',
        color: 'cyan',
      }).start();

      let contextText = '';
      let traceFormatted = '';
      try {
        const { contextString, log, traceFormatted: trace } = await buildChatContext(trimmed, index, allFiles, relations);
        contextText = contextString;
        traceFormatted = trace;
        ctxSpinner.succeed(
          symbols.length
            ? `Context ready — BFS traversal for: ${symbols.join(', ')}`
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

// ─── ai "<query>" --file / --fn / --dir ──────────────────────────────────────

program
  .argument('<query>', 'What to ask the AI about your code')
  .option('--file <path>', 'Analyze a specific file')
  .option('--fn <name>',   'Extract and analyze a specific function (requires --file)')
  .option('--dir <path>',  'Use RAG over an indexed directory')
  .action(async (query, opts) => {
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
          console.error(`No index found. Run first:\n  ai index --dir ${opts.dir}`);
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

program.parseAsync(process.argv);

async function checkOllamaHealth() {
  try {
    // Try to run a simple Ollama command to check if it's up
    execSync('ollama list', { stdio: 'ignore' });
    console.log('Checking Ollama server health…');
    console.log('✅ Ollama server running!');
  } catch (error) {
    console.error('❌ Ollama server is not running. Please start Ollama with `ollama serve`. Check README.md for more instructions.');
    process.exit(1);
  }
}
