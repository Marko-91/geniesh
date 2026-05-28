#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { basename, join } from 'path';
import { createRequire } from 'module';
import { readFile } from './fs-utils.js';
import { writeFile } from 'fs/promises';
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
          'codebase. When asked to make changes, output edit blocks — they will be\n' +
          'parsed and applied automatically. NEVER say you "cannot" make changes.\n' +
          'You MUST output SEARCH/REPLACE or full-file edit blocks as instructed.\n\n' +
          'Example of how you MUST respond to edit requests:\n' +
          '  User: add a comment at the top of lib/application.js that says\n' +
          '    "// Express.js application module"\n' +
          '  You:\n' +
          '    lib/application.js\n' +
          '    SEARCH\n' +
          '    /*!\n' +
          '     * Express - application\n' +
          '     * Copyright(c) 2010 TJ Holowaychuk <tj@vision-media.ca>\n' +
          '     * MIT Licensed\n' +
          '     */\n' +
          '    REPLACE\n' +
          '    // Express.js application module\n' +
          '    /*!\n' +
          '     * Express - application\n' +
          '     * Copyright(c) 2010 TJ Holowaychuk <tj@vision-media.ca>\n' +
          '     * MIT Licensed\n' +
          '     */\n' +
          '  (Then the system applies the edit and asks for confirmation.)\n\n' +
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

      // Auto-detect edit intent: find <file.ext> near an edit verb in the question
      const hasEditVerb = /\b(?:edit|change|modify|add|update|fix|remove|delete|append|prepend|insert)\b/i.test(trimmed);
      let editMatch = null;
      if (hasEditVerb) {
        // Pattern 1: "edit <anything> file.ext"
        let m = trimmed.match(/(?:edit|change|modify|add|update|fix|remove|delete|append|prepend|insert)\s.*?([^\s,;]+\.\w+)/i);
        if (m) { editMatch = m; }
        // Pattern 2: "in file.ext edit" — match file BEFORE the verb
        if (!editMatch) {
          m = trimmed.match(/(?:in|of|for|from)\s+([^\s,;]+\.\w+)\b/i);
          if (m) { editMatch = m; }
        }
        // Pattern 3: fall back to fileRefs if we found a .js/.ts file
        if (!editMatch) {
          const ref = fileRefs.find(f => /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(f));
          if (ref) {
            const cn = ref.replace(/\\/g, '/').split('/').slice(-1)[0].toLowerCase();
            editMatch = { 1: cn };
          }
        }
      }
      if (editMatch) {
        const candidate = (editMatch[1] || editMatch[2] || '').replace(/[.,;:!?)]$/, '');
        // Try matching against allFiles first (like extractFileRefs)
        const found = allFiles.find(f => {
          const fn = f.replace(/\\/g, '/').toLowerCase();
          const cn = candidate.toLowerCase();
          return fn.endsWith('/' + cn) || fn === cn || fn.includes('/' + cn);
        });
        if (found) {
          if (!fileRefs.includes(found)) fileRefs.push(found);
        } else if (candidate.includes('/') || candidate.includes('\\')) {
          // File not in allFiles — try reading from project dir
          fileRefs.push(join(dir, candidate));
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

        // Auto-retry if the LLM refused to edit but was asked to make a change
        let retries = 0;
        // Resolve target file once for both retry logic and code block comparison
        const editFile = editMatch ? editMatch[1].replace(/[.,;:!?)]$/, '') : '';
        const absFile = editMatch ? allFiles.find(f => {
          const fn = f.replace(/\\/g, '/').toLowerCase();
          return fn.endsWith('/' + editFile.toLowerCase()) || fn.includes('/' + editFile.toLowerCase());
        }) : null;
        const fileContent = absFile ? await readFile(absFile).catch(() => '') : '';
        // Extract function name and specific change from the user's question
        const fnRequest = trimmed.match(/(?:function\s+)?(\w+)\s*\([^)]*\)/);
        const fnName = fnRequest ? fnRequest[1] : 'handle';
        const changeRequest = trimmed.replace(/.*?(?:edit|change|modify|add|update|fix)\s.*?(?:function\s+)?\w+\s*\([^)]*\)\s*/i, '').replace(/^to\s+/i, '').trim() || '';

        while (editMatch && retries < 3) {
          const hasEditBlock = currentReply.includes('SEARCH') || /```\w+:[^\s]/.test(currentReply);
          if (hasEditBlock) break;
          const hasCodeBlock = currentReply.includes('```');
          if (hasCodeBlock) {
            // Only skip retry if a code block IS a substantive function edit (not cosmetic)
            const codeBlocks = currentReply.match(/```[\w.]*\n[\s\S]*?```/g);
            const hasSubstantiveEdit = codeBlocks?.some(block => {
              const c = block.replace(/```[\w.]*\n?/, '').replace(/\n```$/, '').trim();
              const m = c.match(/function\s+(\w+)\s*\(/);
              if (!m) return false;
              // Reject placeholder/example code blocks
              const placeholderRe = /\.\.\.|\/\/.*(?:in practice|rest of|your code|example|something like|would follow|or any other|copyright|implementation not shown)/i;
              if (placeholderRe.test(c)) return false;
              // Compare with original — skip retry only if at least 2 lines differ
              if (fileContent && fnName) {
                const lines = fileContent.split('\n');
                const fnIdx = lines.findIndex(l => new RegExp(`function\\s+${fnName}\\s*\\(`).test(l));
                if (fnIdx >= 0) {
                  let depth = 0, endIdx = fnIdx, started = false;
                  for (let i = fnIdx; i < lines.length && i < fnIdx + 300; i++) {
                    for (const ch of lines[i]) {
                      if (ch === '{') { depth++; started = true; }
                      if (ch === '}') depth--;
                    }
                    if (started && depth <= 0 && i > fnIdx) { endIdx = i; break; }
                  }
                  const orig = lines.slice(fnIdx, endIdx + 1).join('\n');
                  const oL = orig.split('\n'), nL = c.split('\n');
                  let diffCount = 0;
                  for (let i = 0; i < Math.max(oL.length, nL.length); i++) {
                    if ((oL[i] || '').trim() !== (nL[i] || '').trim()) diffCount++;
                  }
                  return diffCount >= 2; // only skip if substantive
                }
              }
              return true; // can't compare, assume substantive
            });
            if (hasSubstantiveEdit) break; // let code block fallback handle it
          }
          const refusalPatterns = /\b(cannot|can't|i don't see|i can see fragments|not able to|unable to|not typical|not recommended|instead.*use|not appropriate|would be unusual)\b/i;
          if (!refusalPatterns.test(currentReply) && !hasCodeBlock) break;

          retries++;
          // Find the target function text for the retry prompt
          let funcText = '';
          if (fnName && fileContent) {
            const lines = fileContent.split('\n');
            const fnIdx = lines.findIndex(l => new RegExp(`function\\s+${fnName}\\s*\\(`).test(l));
            if (fnIdx >= 0) {
              let depth = 0, endIdx = fnIdx, started = false;
              for (let i = fnIdx; i < lines.length && i < fnIdx + 300; i++) {
                for (const ch of lines[i]) {
                  if (ch === '{') { depth++; started = true; }
                  if (ch === '}') depth--;
                }
                if (started && depth <= 0 && i > fnIdx) { endIdx = i; break; }
              }
              funcText = lines.slice(fnIdx, endIdx + 1).join('\n');
            }
          }
          const retryMsg = retries >= 3
            ? '\n[SYSTEM OVERRIDE] You are in DIRECT EDIT mode. You MUST output a SEARCH/REPLACE block.\n' +
              'Do NOT explain. Do NOT suggest alternatives. Do NOT refuse.\n' +
              'The user asked: ' + changeRequest + '\n' +
              'File: ' + editFile + '\n' +
              'Function: ' + fnName + '\n\n' +
              (funcText ? 'Existing function:\n```\n' + funcText + '\n```\n\n' : '') +
              'Output ONLY:\n' + editFile + '\nSEARCH\n[exact existing function]\nREPLACE\n[modified function]'
            : '\n[System] You MUST modify the `' + fnName + '` function in `' + editFile + '`.\n' +
              'Do NOT suggest alternative approaches. Do NOT just reformat or add comments.\n' +
              'Make the ACTUAL change requested: ' + changeRequest + '\n' +
              (funcText ? 'The existing ' + fnName + ' function:\n```\n' + funcText + '\n```\n' : '') +
              'Output a SEARCH/REPLACE block with the function text EXACTLY as shown in SEARCH.';
          messages.push({ role: 'user', content: retryMsg });
          process.stdout.write(`\n\x1b[36mAssistant\x1b[0m:\n`);
          currentReply = await runChat(messages);
          messages.push({ role: 'assistant', content: currentReply });
        }

        // After retries: clear editMatch only if retries exhausted (not if we
        // broke out early with a substantive code block that the fallback handles)
        if (editMatch && retries >= 3) {
          const hasSREdit = /SEARCH[\s\S]*?REPLACE/.test(currentReply);
          const hasFullEdit = /```\w+\s*:/.test(currentReply);
          if (!hasSREdit && !hasFullEdit) {
            editMatch = null;
          }
        }

        let agentLoop = true;
        while (agentLoop) {
          agentLoop = false;

          // Check for file edits
          const edits = parseFileEdits(currentReply, allFiles);
          let lastEditError = null;
          for (const edit of edits) {
            let diff;
            let apply;
            let originalContent;
            if (edit.type === 'sr') {
              originalContent = await readFile(edit.file).catch(() => '');
              diff = formatSearchReplaceDiff(edit.file, edit.search, edit.replace);
              apply = () => applySearchReplace(edit.file, edit.search, edit.replace);
            } else {
              originalContent = await readFile(edit.file).catch(() => '');
              diff = formatDiff(originalContent, edit.content, edit.file);
              apply = () => applyFullFileEdit(edit.file, edit.content);
            }
            if (!diff) continue;
            process.stdout.write(`\n${diff}\n`);
            const answer = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
            if (!answer || answer.toLowerCase().startsWith('y') || answer === '') {
              try {
                await apply();
                // Syntax check
                if (/\.(js|mjs|cjs)$/i.test(edit.file)) {
                  try {
                    execSync(`node --check "${edit.file}"`, { stdio: 'pipe', timeout: 10000 });
                    process.stdout.write(`\x1b[32m✓ ${edit.file} updated (syntax OK)\x1b[0m\n`);
                  } catch (synErr) {
                    // Revert on syntax failure
                    if (originalContent) {
                      await writeFile(edit.file, originalContent, 'utf-8');
                    }
                    process.stdout.write(`\x1b[31m✗ ${edit.file} syntax check FAILED — reverted\x1b[0m\n`);
                    process.stdout.write(synErr.stderr.toString().split('\n').slice(0, 5).join('\n') + '\n');
                    lastEditError = new Error(`Syntax check failed for ${edit.file}`);
                  }
                } else {
                  process.stdout.write(`\x1b[32m✓ ${edit.file} updated\x1b[0m\n`);
                }
              } catch (err) {
                process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
                lastEditError = err;
              }
            } else {
              process.stdout.write(`\x1b[33mSkipped ${edit.file}\x1b[0m\n`);
            }
          }

          // If SEARCH text wasn't found, try function-level fallback
          if (lastEditError && lastEditError.message.includes('not found')) {
            const srEdit = edits.find(e => e.type === 'sr');
            if (srEdit) {
              const oldContent = await readFile(srEdit.file).catch(() => '');
              if (oldContent) {
                // Extract function name from the SEARCH or REPLACE text
                const funcMatch = (srEdit.search + srEdit.replace).match(/function\s+(\w+)\s*\(/);
                if (funcMatch) {
                  const funcName = funcMatch[1];
                  const oldLines = oldContent.split('\n');
                  const funcRegex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)`);
                  let startIdx = oldLines.findIndex(l => funcRegex.test(l));
                  if (startIdx >= 0) {
                    let depth = 0, endIdx = startIdx, started = false;
                    for (let i = startIdx; i < oldLines.length && i < startIdx + 300; i++) {
                      for (const ch of oldLines[i]) {
                        if (ch === '{') { depth++; started = true; }
                        if (ch === '}') depth--;
                      }
                      if (started && depth <= 0 && i > startIdx) { endIdx = i; break; }
                    }
                    if (endIdx <= startIdx) endIdx = Math.min(startIdx + srEdit.replace.split('\n').length, oldLines.length);
                    const oldFunc = oldLines.slice(startIdx, endIdx + 1).join('\n');
                    const newHead = oldLines.slice(0, startIdx).join('\n');
                    const newTail = oldLines.slice(endIdx + 1).join('\n');
                    const fullNew = (newHead ? newHead + '\n' : '') + srEdit.replace + (newTail ? '\n' + newTail : '');
                    process.stdout.write(`\n\x1b[33mSEARCH text not found — retrying by function \x1b[1m${funcName}\x1b[0m:\x1b[0m\n`);
                    // Show brief diff
                    const oLines = oldFunc.split('\n');
                    const rLines = srEdit.replace.split('\n');
                    const max = Math.min(oLines.length, rLines.length, 8);
                    for (let i = 0; i < max; i++) {
                      if (oLines[i] !== rLines[i]) {
                        process.stdout.write(`\x1b[31m- ${oLines[i]}\x1b[0m\n`);
                        process.stdout.write(`\x1b[32m+ ${rLines[i]}\x1b[0m\n`);
                      } else {
                        process.stdout.write(`  ${oLines[i]}\n`);
                      }
                    }
                    const answer2 = await ask(`Replace function \x1b[1m${funcName}\x1b[0m in ${srEdit.file}? [\x1b[1mY\x1b[0m/n] `);
                    if (!answer2 || answer2.toLowerCase() === 'y' || answer2 === '') {
                      try {
                        await writeFile(srEdit.file, fullNew);
                        if (/\.(js|mjs|cjs)$/i.test(srEdit.file)) {
                          try {
                            execSync(`node --check "${srEdit.file}"`, { stdio: 'pipe', timeout: 10000 });
                            process.stdout.write(`\x1b[32m✓ ${srEdit.file} updated (syntax OK)\x1b[0m\n`);
                          } catch (synErr) {
                            process.stdout.write(`\x1b[33m⚠  Updated but syntax check FAILED:\x1b[0m\n`);
                            process.stdout.write(synErr.stderr.toString().split('\n').slice(0, 5).join('\n') + '\n');
                          }
                        } else {
                          process.stdout.write(`\x1b[32m✓ ${srEdit.file} updated\x1b[0m\n`);
                        }
                      } catch (err2) {
                        process.stdout.write(`\x1b[31m✗ Failed: ${err2.message}\x1b[0m\n`);
                      }
                    } else {
                      process.stdout.write(`\x1b[33mSkipped\x1b[0m\n`);
                    }
                  }
                }
              }
            }
          }

          // Fallback: if no edit block was found but the LLM showed a code block
          // that looks like a function edit, parse and apply it
          if (edits.length === 0 && editMatch) {
            const targetFile = allFiles.find(f => {
              const fn = f.replace(/\\/g, '/').toLowerCase();
              const cn = editMatch[1].replace(/[.,;:!?)]$/, '').toLowerCase();
              return fn.endsWith('/' + cn) || fn.includes('/' + cn);
            });
            if (targetFile) {
              const codeBlocks = currentReply.match(/```[\w.]*\n[\s\S]*?```/g);
              if (codeBlocks) {
                const oldContent = await readFile(targetFile).catch(() => '');
                if (!oldContent) break;
                for (const block of codeBlocks) {
                  const newContent = block.replace(/```[\w.]*\n?/, '').replace(/\n```$/, '').trim();
                  const oldLines = oldContent.split('\n');

                  // Pattern A: Function edit — code block looks like a function/method def
                  const funcMatch = newContent.match(/(?:(\w+(?:\.\w+)*)\s*(?:\.\s*prototype\s*\.\s*)?=\s*)?function\s+(\w+)\s*\(([^)]*)\)/);
                  if (funcMatch) {
                    const funcName = funcMatch[2];
                    const funcArgs = funcMatch[3];
                    // Search the file for this function definition using regex
                    const funcRegex = new RegExp(
                      `function\\s+${funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)`,
                      'i'
                    );
                    let startIdx = oldLines.findIndex(l => funcRegex.test(l));
                    if (startIdx === -1) {
                      // Try without args — match just the function name
                      const simpleRegex = new RegExp(
                        `[=\\s]function\\s+${funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`,
                        'i'
                      );
                      startIdx = oldLines.findIndex(l => simpleRegex.test(l));
                    }
                    if (startIdx >= 0) {
                      // Strip any lines before the function definition in the code block
                      // (LLMs often add JSDoc/comments above the function)
                      let cleanContent = newContent;
                      const defIdx = cleanContent.search(
                        new RegExp(`(?:\\w+(?:\\.\\w+)*\\s*(?:\\.\\s*prototype\\s*\\.\\s*)?=\\s*)?function\\s+${funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`)
                      );
                      if (defIdx > 0) cleanContent = cleanContent.slice(defIdx).trim();
                      if (!cleanContent) cleanContent = newContent;
                      // Find end of old function by brace matching
                      let depth = 0;
                      let endIdx = startIdx;
                      let started = false;
                      for (let i = startIdx; i < oldLines.length && i < startIdx + 300; i++) {
                        for (const ch of oldLines[i]) {
                          if (ch === '{') { depth++; started = true; }
                          if (ch === '}') depth--;
                        }
                        if (started && depth <= 0 && i > startIdx) { endIdx = i; break; }
                      }
                      if (endIdx <= startIdx) endIdx = Math.min(startIdx + cleanContent.split('\n').length, oldLines.length);
                      const oldFunc = oldLines.slice(startIdx, endIdx + 1).join('\n');
                      const newHead = oldLines.slice(0, startIdx).join('\n');
                      const newTail = oldLines.slice(endIdx + 1).join('\n');
                      const fullNew = (newHead ? newHead + '\n' : '') + cleanContent + (newTail ? '\n' + newTail : '');
                      process.stdout.write(`\n\x1b[33mProposed function edit:\x1b[0m\n`);
                      process.stdout.write(`\x1b[35m--- ${targetFile}:${startIdx + 1}\x1b[0m\n`);
                      process.stdout.write(`\x1b[36m+++ (proposed)\x1b[0m\n`);
                      const difLines = [];
                      const oldLines2 = oldFunc.split('\n');
                      const newLines2 = cleanContent.split('\n');
                      const maxLines = Math.max(oldLines2.length, newLines2.length);
                      for (let i = 0; i < maxLines && i < 12; i++) {
                        if (i < oldLines2.length && i < newLines2.length && oldLines2[i] === newLines2[i]) {
                          difLines.push(` ${oldLines2[i]}`);
                        } else {
                          if (i < oldLines2.length) difLines.push(`\x1b[31m-${oldLines2[i]}\x1b[0m`);
                          if (i < newLines2.length) difLines.push(`\x1b[32m+${newLines2[i]}\x1b[0m`);
                        }
                      }
                      if (oldLines2.length > 12 || newLines2.length > 12) difLines.push('  ...');
                      process.stdout.write(difLines.join('\n') + '\n');
                      const answer = await ask(`Replace function \x1b[1m${funcName}\x1b[0m in ${targetFile}? [\x1b[1mY\x1b[0m/n] `);
                      if (!answer || answer.toLowerCase().startsWith('y') || answer === '') {
                        try {
                          await writeFile(targetFile, fullNew);
                          if (/\.(js|mjs|cjs)$/i.test(targetFile)) {
                            try {
                              execSync(`node --check "${targetFile}"`, { stdio: 'pipe', timeout: 10000 });
                              process.stdout.write(`\x1b[32m✓ ${targetFile} updated (syntax OK)\x1b[0m\n`);
                            } catch (synErr) {
                              process.stdout.write(`\x1b[31m✗ Syntax error in result:\x1b[0m\n`);
                              process.stdout.write(synErr.stderr.toString().split('\n').slice(0, 5).join('\n') + '\n');
                            }
                          } else {
                            process.stdout.write(`\x1b[32m✓ ${targetFile} updated\x1b[0m\n`);
                          }
                        } catch (err) {
                          process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
                        }
                      } else {
                        process.stdout.write(`\x1b[33mSkipped\x1b[0m\n`);
                      }
                    }
                    break;
                  }

                  // Pattern B: Full file edit — code block contains the file's first line
                  const firstLine = oldContent.split('\n')[0]?.trim();
                  if (firstLine && newContent.includes(firstLine) && newContent !== oldContent.trim()) {
                    const diff = formatDiff(oldContent, newContent, targetFile);
                    if (diff) {
                      process.stdout.write(`\n${diff}\n`);
                      const answer = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
                      if (!answer || answer.toLowerCase().startsWith('y') || answer === '') {
                        try {
                          await writeFile(targetFile, newContent);
                          if (/\.(js|mjs|cjs)$/i.test(targetFile)) {
                            try {
                              execSync(`node --check "${targetFile}"`, { stdio: 'pipe', timeout: 10000 });
                              process.stdout.write(`\x1b[32m✓ ${targetFile} updated (syntax OK)\x1b[0m\n`);
                            } catch (synErr) {
                              process.stdout.write(`\x1b[31m✗ Syntax error in result:\x1b[0m\n`);
                              process.stdout.write(synErr.stderr.toString().split('\n').slice(0, 5).join('\n') + '\n');
                            }
                          } else {
                            process.stdout.write(`\x1b[32m✓ ${targetFile} updated\x1b[0m\n`);
                          }
                        } catch (err) {
                          process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
                        }
                      } else {
                        process.stdout.write(`\x1b[33mSkipped ${targetFile}\x1b[0m\n`);
                      }
                      break;
                    }
                  }
                }
              }
            }
          }

          // Check for shell commands
          const commands = parseShellCommands(currentReply);
          for (const cmd of commands) {
            process.stdout.write(`\n\x1b[90m$ ${cmd}\x1b[0m\n`);
            const answer = await ask(`Run this command? [\x1b[1mY\x1b[0m/n] `);
            if (!answer || answer.toLowerCase().startsWith('y') || answer === '') {
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
