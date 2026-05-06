#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { readFile } from './fs-utils.js';
import { extractFunction } from './extractor.js';
import { buildIndex, loadIndex, indexExists } from './indexer.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt } from './prompt.js';
import { runQuery, runChat } from './runner.js';

const program = new Command();

program
  .name('ai')
  .description('Local AI developer assistant — Llama 3 + RAG (powered by Ollama)')
  .version('1.0.0')
  .enablePositionalOptions();

// ─── ai index --dir <path> ───────────────────────────────────────────────────

program
  .command('index')
  .description('Build a RAG index for a directory and save to .ai-index.json')
  .requiredOption('--dir <path>', 'Directory to scan and index')
  .action(async (opts) => {
    try {
      await buildIndex(opts.dir);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  });

// ─── ai chat ─────────────────────────────────────────────────────────────────

program
  .command('chat')
  .description('Start an interactive chat session (RAG-augmented if index exists)')
  .action(async () => {
    const hasIndex = await indexExists();
    let index = null;

    if (hasIndex) {
      console.log('Index found — RAG-augmented chat enabled.\n');
      index = await loadIndex();
    } else {
      console.log('No index found. Run `ai index --dir <path>` for RAG support.\n');
    }

    // System message establishes the persona for the whole session.
    const messages = [
      { role: 'system', content: 'You are a senior software engineer. Be concise and practical.' },
    ];

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log('Type your message. Type "exit" or press Ctrl+C to quit.\n');

    // Graceful shutdown on Ctrl+C
    process.on('SIGINT', () => {
      console.log('\nBye!');
      rl.close();
      process.exit(0);
    });

    while (true) {
      let userInput;
      try {
        userInput = await ask('You: ');
      } catch {
        break;
      }

      const trimmed = userInput.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        rl.close();
        console.log('Bye!');
        break;
      }

      // Augment with RAG context when index is available.
      let content = trimmed;
      if (index) {
        try {
          const chunks = await search(trimmed, index, 4);
          if (chunks.length > 0) {
            const ctx = chunks
              .map((c) => `// ${c.file} (lines ${c.startLine}–${c.endLine})\n${c.chunk}`)
              .join('\n\n---\n\n')
              .slice(0, 6000);
            content = `Relevant code from the codebase:\n\n${ctx}\n\nQuestion: ${trimmed}`;
          }
        } catch {
          // RAG failure is non-fatal — fall back to plain message
        }
      }

      messages.push({ role: 'user', content });
      process.stdout.write('\nAssistant: ');

      try {
        const reply = await runChat(messages);
        messages.push({ role: 'assistant', content: reply });
      } catch (err) {
        console.error(`\nError: ${err.message}`);
        messages.pop(); // remove unanswered user message to keep history clean
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

program.parseAsync(process.argv);
