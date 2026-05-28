#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { basename, join } from 'path';
import { createRequire } from 'module';
import { readFile } from './fs-utils.js';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import { extractFunction } from './extractor.js';
import { buildIndex, loadIndex, indexExists, buildIndexFromFileList } from './indexer.js';
import { tryLoadGraph, graphExists, loadGraph } from './relations.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt } from './prompt.js';
import { runQuery, runChat, runGenerate, setModel } from './runner.js';
import { setEmbedder } from './embedder.js';
import { runEval, formatEvalResults } from './eval.js';
import { generateBenchmark } from './benchmark-gen.js';
import { runSelfImprove } from './autoimprove/auto-improve.js';
import { grepDir, formatGrepResults, buildGrepContext } from './grep.js';
import { extractUrls, fetchWebContent } from './web-fetch.js';
import { webSearch, formatSearchResults } from './web-search.js';
import { buildChatContext, applySlideWindow } from './context-builder.js';
import { extractSymbols } from './symbol-utils.js';
import { scanDir, extractFileRefs } from './fs-utils.js';
import { parseFileEdits, formatDiff, formatSearchReplaceDiff, applySearchReplace, applyFullFileEdit } from './diff-apply.js';
import { parseShellCommands, runShellCommand, formatCommandResult } from './terminal-agent.js';
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
  .description('Start an intelligent chat session with auto-indexing and AST graph traversal')
  .option('--dir <path>', 'Directory to use for indexing/search (default: cwd)')
  .option('--files <paths...>', 'Explicit files to use as context (skips auto-index)')
  .option('--dirs <paths...>', 'Explicit directories to scan as context (skips auto-index)')
  .option('--budget <chars>', 'Context budget in characters (default: 128000)', parseInt)
  .action(async (opts) => {
    const dir = opts.dir || process.cwd();

    let index;
    let graph;
    let allFiles;
    const hasExplicit = (opts.files && opts.files.length > 0) || (opts.dirs && opts.dirs.length > 0);

    if (hasExplicit) {
      let explicitFiles = [...(opts.files || [])];
      for (const d of (opts.dirs || [])) {
        const scanned = await scanDir(d);
        explicitFiles = explicitFiles.concat(scanned);
      }
      explicitFiles = [...new Set(explicitFiles)];
      console.log(`\n📎  Explicit context: ${explicitFiles.length} file(s)\n`);
      index = await buildIndexFromFileList(explicitFiles);
      allFiles = explicitFiles;
    } else if (await indexExists() && await graphExists()) {
      const loadSpinner = ora('Loading index + graph…').start();
      index = await loadIndex();
      graph = await loadGraph();
      loadSpinner.succeed(`Index: ${index.length} chunks · Graph: ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
      allFiles = await scanDir(dir);
    } else {
      console.log(`\n⚠️  No index found. Building index + graph for ${dir}…\n`);
      index = await buildIndex(dir);
      graph = await loadGraph();
      allFiles = await scanDir(dir);
    }

    // ─ 3. System prompt ───────────────────────────────────────────────────────
    const messages = [
      {
        role: 'system',
        content:
          'You are a senior software engineer with full read/write access to the\n' +
          'codebase. When asked to make changes, you CAN and SHOULD propose edits\n' +
          'in the formats below — they will be parsed and applied automatically.\n\n' +
          'Rules:\n' +
          '- Every claim about code MUST cite the exact file and line number\n' +
          '  from the codebase_context above. If the file or line is not in the\n' +
          '  context, do not cite it.\n' +
          '- If you cannot cite it, it is not in the code — state that clearly.\n' +
          '- You may use general knowledge for analysis and suggestions, but preface\n' +
          '  general advice with "In general:" or "A common pattern is:" so the user\n' +
          '  knows it is not from the code.\n' +
          '- Never invent file names, function names, or line numbers.\n' +
          '- Prefer simple, minimal changes. Do not propose additional abstraction\n' +
          '  layers unless the existing code demonstrably fails at its task.\n' +
          '- If the user message contains a [Web page content] section,\n' +
          '  the content was fetched from a URL they asked about. Use it to answer\n' +
          '  their question — it is as authoritative as the codebase context.\n' +
          '- In the codebase context above, sections labeled "file-ref:" contain\n' +
          '  the ENTIRE file content (not just a window). Use the full content\n' +
          '  from these sections when you need to propose SEARCH/REPLACE edits.\n' +
          '- To make changes, you MUST output edits using one of these formats.\n' +
          '  They WILL be detected and offered to the user for approval.\n' +
          '  1) Search/replace (for targeted changes — preferred):\n' +
          '     File path on its own line, then SEARCH, then the EXACT text to\n' +
          '     find, then REPLACE, then the new text. Example:\n' +
          '       lib/application.js\n' +
          '       SEARCH\n' +
          '       // MIT Licensed\n' +
          '       REPLACE\n' +
          '       // Express.js application module\n' +
          '       // MIT Licensed\n' +
          '     The SEARCH text must match the file exactly — copy it character\n' +
          '     for character from the codebase context above.\n' +
          '  2) Full-file (for rewrites):\n' +
          '     A fenced code block with language, colon, and path:\n' +
          '       ```js:lib/application.js\n' +
          '       // Express.js application module\n' +
          '       /*!\n' +
          '        * Express - application\n' +
          '        * Copyright(c) 2010 TJ Holowaychuk\n' +
          '        * MIT Licensed\n' +
          '        */\n' +
          '       ```\n' +
          '- You can execute shell commands by outputting a fenced code block\n' +
          '  with the bash language tag. They will also be detected and offered\n' +
          '  to the user. Example:\n' +
          '    ```bash\n' +
          '    npm install express\n' +
          '    ```\n' +
          '  After running a command, you will see its output and can continue\n' +
          '  with the next step.',
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
    if (graph) console.log(`🔗  Graph     : ${graph.nodes.size} nodes · ${graph.edges.length} edges · ${graph.communityCount} communities`);
    console.log('────────────────────────────────────────────────────────────\n');

    console.log('\x1b[90m💡 Tips\x1b[0m');
    console.log('\x1b[90m   • Mention a file path to load it as full context:  "look at lib/application.js"\x1b[0m');
    console.log('\x1b[90m   • Ask about specific symbols:                      "how does Router.handle work?"\x1b[0m');
    console.log('\x1b[90m   • Use concrete function/method names for AST graph\x1b[0m');
    if (graph) console.log('\x1b[90m   • Budget is ~32k tok default (--budget <chars> to override)\x1b[0m');
    console.log('\x1b[90m   • Paste a URL to fetch its content as context\x1b[0m');
    console.log('\x1b[90m   • /search <query> to search the web via DuckDuckGo\x1b[0m');
    console.log('\x1b[90m   • Ask for code changes — LLM proposes edits, you confirm\x1b[0m');
    console.log('\x1b[90m   • Ask to run commands — LLM writes them, you approve\x1b[0m');
    console.log('\x1b[90m   • Type \x1b[33mexit\x1b[90m or Ctrl+C to quit\x1b[0m\n');

    process.on('SIGINT', () => {
      console.log('\nBye!');
      rl.close();
      process.exit(0);
    });

    // Track last fetched web content so it persists across turns
    let lastWebContent = '';

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

      // ─ /search command ──────────────────────────────────────────────────────────
      let searchResultsText = '';
      let searchFollowUp = '';
      const searchMatch = trimmed.match(/^\/search\s+(.+)/s);
      if (searchMatch) {
        const rest = searchMatch[1].trim();
        // Support: /search "query" optional follow-up question
        const quoted = rest.match(/^"([^"]+)"\s*(.*)/s);
        const query = quoted ? quoted[1] : rest;
        searchFollowUp = quoted ? quoted[2].trim() : '';
        const searchSpinner = ora({ text: `Searching "${query}"…`, color: 'yellow' }).start();
        try {
          const results = await webSearch(query, 5);
          if (results.length === 0) {
            searchSpinner.fail('No search results');
          } else {
            searchSpinner.succeed(`Found ${results.length} results for "${query}"`);
            searchResultsText = formatSearchResults(results);
            // Fetch the top 2 result pages
            const topUrls = results.slice(0, 2).map(r => r.url);
            const fetchSpinner = ora({ text: `Fetching ${topUrls.length} result page(s)…`, color: 'yellow' }).start();
            const fetchResults = await Promise.allSettled(topUrls.map(url => fetchWebContent(url)));
            const fetchParts = [];
            for (let i = 0; i < topUrls.length; i++) {
              const r = fetchResults[i];
              if (r.status === 'fulfilled') {
                fetchParts.push(r.value);
              }
            }
            if (fetchParts.length > 0) {
              fetchSpinner.succeed(`Fetched ${fetchParts.length} page(s)`);
              searchResultsText += '\n\n--- Fetched pages ---\n' + fetchParts.join('\n\n---\n\n');
            } else {
              fetchSpinner.info('No pages fetched');
            }
            lastWebContent = searchResultsText;
          }
        } catch (err) {
          searchSpinner.fail(`Search failed: ${err.message}`);
        }
      }

      // ─ Web fetch ──────────────────────────────────────────────────────────────
      let webContent = '';
      const urls = extractUrls(trimmed);
      if (urls.length > 0) {
        const wfSpinner = ora({ text: `Fetching ${urls.length} URL(s)…`, color: 'yellow' }).start();
        const results = await Promise.allSettled(urls.map(url => fetchWebContent(url)));
        const parts = [];
        for (let i = 0; i < urls.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            parts.push(r.value);
            wfSpinner.text = `Fetched ${(r.value.length / 1000).toFixed(1)}k from ${urls[i]}`;
          } else {
            wfSpinner.text = `Failed: ${urls[i]} (${r.reason.message})`;
          }
        }
        const totalKb = (parts.reduce((s, p) => s + p.length, 0) / 1000).toFixed(1);
        wfSpinner.succeed(`Fetched ${totalKb}k from ${urls.length} URL(s)`);
        if (parts.length > 0) {
          webContent = parts.join('\n\n---\n\n');
          lastWebContent = webContent;
        }
      } else if (searchResultsText) {
        webContent = searchResultsText;
      } else if (lastWebContent) {
        webContent = lastWebContent;
        const kb = (lastWebContent.length / 1000).toFixed(1);
        process.stderr.write(`\x1b[90m(using ${kb}k from previous fetch)\x1b[0m\n`);
      }

      // ─ Build context ─────────────────────────────────────────────────────────
      const symbols = extractSymbols(trimmed);
      let fileRefs = extractFileRefs(trimmed, allFiles);

      // Auto-detect edit intent: scan the question for "edit <filepath>" patterns
      // and try to read the file directly from disk
      const editActionPattern = /(?:edit|change|modify|add|update|fix|remove|delete|append|prepend|insert)\s.*?([^\s,;]+\.\w+)/i;
      const editMatch = trimmed.match(editActionPattern);
      if (editMatch) {
        const candidate = editMatch[1].replace(/[.,;:!?)]$/, '');
        process.stderr.write(`\x1b[90m[edit-detect] candidate="${candidate}" fileRefs=${JSON.stringify(fileRefs)}\x1b[0m\n`);
        // Try matching against allFiles first (like extractFileRefs)
        const found = allFiles.find(f => {
          const fn = f.replace(/\\/g, '/').toLowerCase();
          const cn = candidate.toLowerCase();
          return fn.endsWith('/' + cn) || fn === cn || fn.includes('/' + cn);
        });
        if (found) {
          process.stderr.write(`\x1b[90m[edit-detect] matched in allFiles: ${found}\x1b[0m\n`);
          if (!fileRefs.includes(found)) fileRefs.push(found);
        } else if (candidate.includes('/') || candidate.includes('\\')) {
          // File not in allFiles — try reading from project dir
          const absPath = join(dir, candidate);
          process.stderr.write(`\x1b[90m[edit-detect] not in allFiles, trying: ${absPath}\x1b[0m\n`);
          fileRefs.push(absPath);
        }
      }
      const ctxSpinner = ora({
        text: symbols.length
          ? `Building context (BFS + RAG: ${symbols.join(', ')})…`
          : fileRefs.length
            ? `Building context (files: ${fileRefs.map(f => basename(f)).join(', ')})…`
            : 'Building context (RAG)…',
        color: 'cyan',
      }).start();

      let contextText = '';
      try {
        if (opts.budget && graph) graph._budget = opts.budget;
        const { contextString, trace } = await buildChatContext(trimmed, index, allFiles, graph, fileRefs, search);
        contextText = contextString;
        const bfsCount = trace.filter(t => t.method === 'bfs').length;
        const ragCount = trace.filter(t => t.method === 'rag').length;
        const refCount = trace.filter(t => t.method === 'file-ref').length;
        const tokenEst = Math.round(contextString.length / 4);
        const budget = graph?._budget || 128000;
        const pct = Math.round(contextString.length / budget * 100);
        ctxSpinner.succeed(`Context: ${trace.length} windows` +
          (bfsCount ? ` (${bfsCount} BFS` : '') +
          (ragCount ? ` + ${ragCount} RAG` : '') +
          (refCount ? ` + ${refCount} ref` : '') +
          ((bfsCount || ragCount || refCount) ? ')' : '') +
          ` — ${tokenEst.toLocaleString()} tok` +
          (graph ? ` (${pct}%)` : ''));

      } catch (err) {
        ctxSpinner.warn(`Context build failed (${err.message}), falling back to plain message`);
      }

      // Strip command prefix and fetched URLs from question
      let questionText = searchFollowUp || trimmed;
      if (webContent) {
        if (!searchFollowUp) {
          const searchCmd = questionText.match(/^\/search\s+(.+)/s);
          if (searchCmd) {
            questionText = searchCmd[1].trim();
          }
        }
        for (const url of extractUrls(trimmed)) {
          questionText = questionText.replace(url, 'the fetched page');
        }
        questionText = questionText.replace(/\s+/g, ' ').trim();
      }

      const content = webContent || contextText
        ? `${contextText ? `[Codebase context]\n${contextText}\n\n` : ''}${webContent ? `[Web page content]\n${webContent}\n\n` : ''}Read the [Web page content] above and answer using both the web page content and the codebase context.\n\nQuestion: ${questionText}`
        : trimmed;

      applySlideWindow(messages);
      messages.push({ role: 'user', content });

      // ─ LLM call ───────────────────────────────────────────────────────────────
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      try {
        const reply = await runChat(messages);
        messages.push({ role: 'assistant', content: reply });

        // ─ Post-response: detect edits and commands ──────────────────────────────
        let currentReply = reply;
        let agentLoop = true;
        while (agentLoop) {
          agentLoop = false;

          // Check for file edits
          const edits = parseFileEdits(currentReply, allFiles);
          for (const edit of edits) {
            let diff;
            let apply;
            if (edit.type === 'sr') {
              diff = formatSearchReplaceDiff(edit.file, edit.search, edit.replace);
              apply = () => applySearchReplace(edit.file, edit.search, edit.replace);
            } else {
              const oldContent = await readFile(edit.file).catch(() => '');
              diff = formatDiff(oldContent, edit.content, edit.file);
              apply = () => applyFullFileEdit(edit.file, edit.content);
            }
            if (!diff) continue;
            process.stdout.write(`\n${diff}\n`);
            const answer = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
            if (!answer || answer.toLowerCase() === 'y' || answer === '') {
              try {
                await apply();
                process.stdout.write(`\x1b[32m✓ ${edit.file} updated\x1b[0m\n`);
              } catch (err) {
                process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
              }
            } else {
              process.stdout.write(`\x1b[33mSkipped ${edit.file}\x1b[0m\n`);
            }
          }

          // Check for shell commands
          const commands = parseShellCommands(currentReply);
          for (const cmd of commands) {
            process.stdout.write(`\n\x1b[90m$ ${cmd}\x1b[0m\n`);
            const answer = await ask(`Run this command? [\x1b[1mY\x1b[0m/n] `);
            if (!answer || answer.toLowerCase() === 'y' || answer === '') {
              const result = runShellCommand(cmd);
              process.stdout.write(`\x1b[90m${result.output.slice(0, 2000)}${result.output.length > 2000 ? '\n... (truncated)' : ''}\x1b[0m\n`);
              process.stdout.write(`\x1b[90m  → exit ${result.exitCode} (${result.elapsed})\x1b[0m\n`);
              // Feed output back to LLM
              const feedback = `Command executed:\n\`\`\`\n$ ${cmd}\n${result.output}\n\`\`\`\nExit code: ${result.exitCode}\n\nContinue with the next step.`;
              messages.push({ role: 'user', content: feedback });
              process.stdout.write(`\n\x1b[36mAssistant\x1b[0m:\n`);
              currentReply = await runChat(messages);
              messages.push({ role: 'assistant', content: currentReply });
              process.stdout.write('\n');
              agentLoop = true; // Check again for more commands
            } else {
              process.stdout.write(`\x1b[33mSkipped\x1b[0m\n`);
            }
          }
        }
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
