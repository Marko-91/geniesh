#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { resolve } from 'path';
import { join } from 'path';
import { createRequire } from 'module';
import { readFile } from './fs-utils.js';
import { writeFile, appendFile, readFile as fsReadFile } from 'fs/promises';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import { extractFunction } from './extractor.js';
import { buildIndex, loadIndex, indexExists, buildIndexFromFileList } from './indexer.js';
import { search } from './search.js';
import { buildPrompt, buildDirectPrompt, SYSTEM_RULES } from './prompt.js';
import { runQuery, runChat, runGenerate, setModel } from './runner.js';
import { setEmbedder } from './embedder.js';
import { grepDir, formatGrepResults, buildGrepContext } from './grep.js';
import { extractUrls, fetchWebContent } from './web-fetch.js';
import { webSearch, formatSearchResults } from './web-search.js';
function applySlideWindow(messages, maxTurns = 8) {
  while (messages.length > 1 + maxTurns * 2) messages.splice(1, 2);
}
import { parseFileEdits, formatDiff, formatSearchReplaceDiff, applySearchReplace, applyFullFileEdit } from './diff-apply.js';
import { parseShellCommands, runShellCommand } from './terminal-agent.js';
import { execSync, spawnSync } from 'child_process';
import ora from 'ora';

// ---------------------------------------------------------------------------
// genx integration
// ---------------------------------------------------------------------------

const GENX_BIN = process.env.GENX_BIN || 'python3';
const GENX_SCRIPT = process.env.GENX_SCRIPT
  || join(process.env.HOME || '~', 'projects', 'mapx', 'genx', 'main.py');
const GENX_HISTORY = process.env.GENX_HISTORY
  || join(process.env.HOME || '~', '.genx_history.md');

/**
 * Run genx and return the full context markdown string (stdout).
 */
function runGenx(query, task, root, { compressModel } = {}) {
  const historyPath = join(root, '.genx_history.md');
  const args = [GENX_SCRIPT, query, '--root', root, '--history', historyPath];
  if (task) args.push('--task', task);
  if (compressModel) args.push('--compress-model', compressModel);

  const result = spawnSync(GENX_BIN, args, {
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (result.error) throw new Error(`genx failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`genx exited ${result.status}`);
  return result.stdout || '';
}

/**
 * Append a web-search entry to the shared genx history file.
 */
async function appendWebHistory(query, results, fetchedContent) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const snippetBlock = results
    .map(r => `### ${r.url}\n> ${r.snippet || r.title || '(no snippet)'}`)
    .join('\n\n');
  const contentBlock = fetchedContent
    ? '\n\n**Fetched content** (truncated to 2000 chars):\n\n' +
      fetchedContent.slice(0, 2000) + (fetchedContent.length > 2000 ? '\n... (truncated)' : '')
    : '';
  const entry = `\n---\n## [WEB: ${ts}] duckduckgo: "${query}"\n\n` +
    `**Fetched**: ${ts}\n` +
    `**Results**: ${results.map(r => r.url).join(', ')}\n\n` +
    snippetBlock + contentBlock + '\n';
  try { await appendFile(GENX_HISTORY, entry, 'utf-8'); } catch { /* non-fatal */ }
}

/**
 * Handle REQUERY / REQUERY_INTERNET / bash signals in the latest LLM reply.
 * Mutates messages[], calls runChat(), returns final reply.
 */
async function handleSignals(reply, messages, root, ask, { maxIter = 3, compressModel = '' } = {}) {
  let current = reply;
  for (let i = 0; i < maxIter; i++) {
    // REQUERY
    const rq = current.match(/^REQUERY\s+(.+)$/m);
    if (rq) {
      const symbols = rq[1].trim();
      process.stderr.write(`\x1b[33m[geniesh] ↺ REQUERY: ${symbols} — fetching context…\x1b[0m\n`);
      let extra = '';
      try { extra = await runGenx(symbols, '', root, { compressModel }); }
      catch (err) { process.stderr.write(`\x1b[31m[geniesh] REQUERY failed: ${err.message}\x1b[0m\n`); break; }
      messages.push({ role: 'user', content: `[Context update for: ${symbols}]\n\n${extra}\n\nContinue your response using this additional context.` });
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      current = await runChat(messages);
      messages.push({ role: 'assistant', content: current });
      continue;
    }

    // REQUERY_INTERNET
    const ri = current.match(/^REQUERY_INTERNET\s+(.+)$/m);
    if (ri) {
      const q = ri[1].trim();
      process.stderr.write(`\x1b[33m[geniesh] ↺ REQUERY_INTERNET: "${q}" — searching…\x1b[0m\n`);
      let webBlock = '';
      try {
        const results = await webSearch(q, 3);
        let fetched = '';
        if (results.length > 0) {
          const pages = await Promise.allSettled(results.slice(0, 2).map(r => fetchWebContent(r.url)));
          fetched = pages.filter(p => p.status === 'fulfilled').map(p => p.value).join('\n\n---\n\n');
          await appendWebHistory(q, results, fetched);
        }
        webBlock = `[Web page content]\nSearch: "${q}"\n\n` +
          formatSearchResults(results) +
          (fetched ? `\n\n--- Fetched pages ---\n${fetched}` : '');
      } catch (err) { webBlock = `[Web search failed: ${err.message}]`; }
      messages.push({ role: 'user', content: webBlock + '\n\nContinue your response using this web content.' });
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      current = await runChat(messages);
      messages.push({ role: 'assistant', content: current });
      continue;
    }

    // bash blocks
    const commands = parseShellCommands(current);
    let anyRan = false;
    for (const cmd of commands) {
      process.stdout.write(`\n\x1b[90m$ ${cmd}\x1b[0m\n`);
      const ans = await ask(`Run this command? [\x1b[1mY\x1b[0m/n] `);
      if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
        const res = runShellCommand(cmd);
        process.stdout.write(`\x1b[90m${res.output.slice(0, 2000)}${res.output.length > 2000 ? '\n... (truncated)' : ''}\x1b[0m\n`);
        process.stdout.write(`\x1b[90m  → exit ${res.exitCode} (${res.elapsed})\x1b[0m\n`);
        messages.push({ role: 'user', content: `Command executed:\n\`\`\`\n$ ${cmd}\n${res.output}\n\`\`\`\nExit code: ${res.exitCode}\n\nContinue with the next step.` });
        process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
        current = await runChat(messages);
        messages.push({ role: 'assistant', content: current });
        anyRan = true;
      } else {
        process.stdout.write(`\x1b[33mSkipped\x1b[0m\n`);
      }
    }
    if (anyRan) continue;
    break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Edit detection (unchanged logic from prior cli.js)
// ---------------------------------------------------------------------------

async function handleEdits(reply, ask) {
  const { scanDir } = await import('./fs-utils.js');
  let allFiles = [];
  try { allFiles = await scanDir(process.cwd()); } catch { /* non-fatal */ }

  const edits = parseFileEdits(reply, allFiles);
  let lastEditError = null;

  for (const edit of edits) {
    let diff, apply, originalContent;
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
    const ans = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
    if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
      try {
        await apply();
        if (/\.(js|mjs|cjs)$/i.test(edit.file)) {
          try {
            execSync(`node --check "${edit.file}"`, { stdio: 'pipe', timeout: 10000 });
            process.stdout.write(`\x1b[32m✓ ${edit.file} updated (syntax OK)\x1b[0m\n`);
          } catch (synErr) {
            if (originalContent) await writeFile(edit.file, originalContent, 'utf-8');
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

  // Function-level fallback when SEARCH text not found
  if (lastEditError && lastEditError.message.includes('not found')) {
    const srEdit = edits.find(e => e.type === 'sr');
    if (srEdit) {
      const old = await readFile(srEdit.file).catch(() => '');
      if (old) {
        const fm = (srEdit.search + srEdit.replace).match(/function\s+(\w+)\s*\(/);
        if (fm) {
          const funcName = fm[1];
          const lines = old.split('\n');
          const re = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)`);
          let si = lines.findIndex(l => re.test(l));
          if (si >= 0) {
            let depth = 0, ei = si, started = false;
            for (let i = si; i < lines.length && i < si + 300; i++) {
              for (const ch of lines[i]) {
                if (ch === '{') { depth++; started = true; }
                if (ch === '}') depth--;
              }
              if (started && depth <= 0 && i > si) { ei = i; break; }
            }
            const head = lines.slice(0, si).join('\n');
            const tail = lines.slice(ei + 1).join('\n');
            const fullNew = (head ? head + '\n' : '') + srEdit.replace + (tail ? '\n' + tail : '');
            process.stdout.write(`\n\x1b[33mSEARCH text not found — retrying by function \x1b[1m${funcName}\x1b[0m:\x1b[0m\n`);
            const ans2 = await ask(`Replace function \x1b[1m${funcName}\x1b[0m in ${srEdit.file}? [\x1b[1mY\x1b[0m/n] `);
            if (!ans2 || ans2.toLowerCase() === 'y' || ans2 === '') {
              try {
                await writeFile(srEdit.file, fullNew);
                process.stdout.write(`\x1b[32m✓ ${srEdit.file} updated\x1b[0m\n`);
              } catch (err2) {
                process.stdout.write(`\x1b[31m✗ Failed: ${err2.message}\x1b[0m\n`);
              }
            } else { process.stdout.write(`\x1b[33mSkipped\x1b[0m\n`); }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commander setup
// ---------------------------------------------------------------------------

const program = new Command();
await checkOllamaHealth();

program
  .name('geniesh')
  .description('Local AI developer assistant — genx context pipeline + Ollama')
  .version(version)
  .enablePositionalOptions()
  .option('--model <name>', 'Ollama model to use', 'qwen3-coder')
  .option('--embedder <name>', 'Ollama embedding model to use', 'nomic-embed-text')
  .hook('preAction', (thisCommand) => {
    const { model, embedder } = thisCommand.opts();
    if (model) setModel(model);
    if (embedder) setEmbedder(embedder);
  });

// ─── index ───────────────────────────────────────────────────────────────────

program
  .command('index')
  .description('Build a RAG index for a directory or single file (used by --full-index)')
  .option('--dir <path>', 'Directory to scan and index')
  .option('--file <path>', 'Single file to index')
  .action(async (opts) => {
    try {
      if (opts.file) { await buildIndexFromFileList(opts.file); }
      else if (opts.dir) { await buildIndex(opts.dir); }
      else { throw new Error('Either --dir or --file must be specified'); }
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
  });

// ─── chat ─────────────────────────────────────────────────────────────────────

program
  .command('chat')
  .description('Interactive coding chat powered by genx context pipeline')
  .option('--dir <path>', 'Project root passed to genx (default: cwd)')
  .option('--full-index', 'Pre-build RAG index for vague-query symbol discovery')
  .option('--compress-model <name>', 'Ollama model for genx history compression (e.g. llama3:latest)')
  .action(async (opts) => {
    const dir = resolve(opts.dir || process.cwd());
    const compressModel = opts.compressModel || '';

    // RAG index for vague-query symbol discovery.
    // --full-index: load/build synchronously before first prompt.
    // default: silently load an existing index if present — no build, no output.
    //          Run `geniesh index --dir .` to build/refresh the index.
    let ragIndex = null;
    let ragIndexPromise = null;
    if (opts.fullIndex) {
      const s = ora(await indexExists() ? 'Loading RAG index…' : `Building RAG index for ${dir}…`).start();
      ragIndex = await indexExists() ? await loadIndex() : await buildIndex(dir);
      s.succeed(`RAG index: ${ragIndex.length} chunks`);
    } else if (await indexExists()) {
      // Load silently in background — no spinner, no blocking output
      ragIndexPromise = loadIndex().catch(() => null);
    }

    // OS info
    const os = await import('os');
    let lampInfo = `${os.platform()} (${os.arch()})`;
    try {
      if (os.platform() === 'darwin') {
        const sw = await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf-8').catch(() => '');
        const ver = sw.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || os.release();
        lampInfo = `macOS ${ver} (${os.arch()})`;
      } else if (os.platform() === 'linux') {
        const rel = await readFile('/etc/os-release', 'utf-8').catch(() => '');
        const name = (rel.match(/^PRETTY_NAME="(.+)"$/m) || rel.match(/^PRETTY_NAME=(.+)$/m))?.[1] || 'Linux';
        lampInfo = `${name} (${os.arch()})`;
      }
    } catch {}

    const modelName = program.opts().model || 'qwen3-coder';
    const messages = [{
      role: 'system',
      content:
        `You are running on: ${lampInfo}\nModel: ${modelName}\n\n` +
        SYSTEM_RULES +
        '\n\nTips: NEVER say you "cannot" make changes. Output edit blocks — they will be applied automatically.\n' +
        'After running a command you will see its output and can continue.\nBe concise and practical.',
    }];

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('🧞  geniesh  —  type \x1b[33mexit\x1b[0m or Ctrl+C to quit');
    console.log(`📂  Root      : ${dir}`);
    console.log(`🧩  Model     : ${modelName}`);
    if (ragIndex) console.log(`📚  RAG index : ${ragIndex.length} chunks (symbol discovery active)`);
    else if (ragIndexPromise) console.log(`📚  RAG index : loading…`);
    else console.log(`📚  RAG index : not built  (run: geniesh index --dir ${dir})`);
    console.log('────────────────────────────────────────────────────────────\n');
    console.log('\x1b[90m💡 Tips\x1b[0m');
    console.log('\x1b[90m Commands:\x1b[0m');
    console.log('\x1b[90m   /search "query"              Search DuckDuckGo + fetch top pages\x1b[0m');
    console.log('\x1b[90m   /file "path1, path2"         Load full file(s) into context\x1b[0m');
    console.log('\x1b[90m   /ctx|/context "symbol1, symbol2"  Run genx with exactly these symbols\x1b[0m');
    console.log('\x1b[90m   https://...                 Paste a URL — page is fetched automatically\x1b[0m');
    console.log('\x1b[90m   exit  or  Ctrl+C            Quit\x1b[0m');
    console.log('');
    console.log('\x1b[90m Asking questions:\x1b[0m');
    console.log('\x1b[90m   • Symbol names work best:   "how does fullReIndex work?"\x1b[0m');
    console.log('\x1b[90m   • Prose queries also work:  "explain the reindexing flow"\x1b[0m');
    console.log('\x1b[90m   • Ask to edit code:         "add error handling to saveIndex in indexer.js"\x1b[0m');
    console.log('\x1b[90m   • Ask to run commands:      "run the tests and show me failures"\x1b[0m');
    console.log('');
    console.log('\x1b[90m How the LLM gets more context:\x1b[0m');
    console.log('\x1b[90m   • REQUERY <symbols>         LLM asks for deeper code context automatically\x1b[0m');
    console.log('\x1b[90m   • REQUERY_INTERNET <query>  LLM searches the web for external docs\x1b[0m');
    console.log('\x1b[90m   • ```bash blocks            LLM runs commands — you approve each one\x1b[0m');
    console.log('\x1b[90m   • Edits shown as diffs — you approve before they are applied\x1b[0m\n');

    process.on('SIGINT', () => { console.log('\nBye!'); rl.close(); process.exit(0); });

    // Load genx history from previous sessions — no genx call, just file read
    let historyContent = '';
    const historyPath = join(dir, '.genx_history.md');
    try { historyContent = await fsReadFile(historyPath, 'utf-8'); } catch { /* no history yet */ }

    while (true) {
      let userInput;
      try { userInput = await ask('\x1b[32mYou\x1b[0m: '); } catch { break; }
      const trimmed = userInput.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') { rl.close(); console.log('Bye!'); break; }

      // Parse all slash commands from anywhere in the message.
      // All commands require quoted delimiters to avoid accidental token capture:
      //   /search "query"   /file "path1, path2"   /context "word1, word2"
      const searchMatch  = trimmed.match(/\/search\s+"([^"]+)"/);
      const fileMatch    = trimmed.match(/\/file\s+"([^"]+)"/);
      const ctxMatch     = trimmed.match(/\/(?:ctx|context)\s+"([^"]+)"/);
      const hasSlashCmd  = !!(searchMatch || fileMatch || ctxMatch);

      // Strip slash commands from the prose question sent to the LLM
      let questionText = trimmed
        .replace(/\/search\s+"[^"]+"/g, '')
        .replace(/\/file\s+"[^"]+"/g, '')
        .replace(/\/(?:ctx|context)\s+"[^"]+"/g, '')
        .replace(/\s+/g, ' ').trim();

      // /search command
      let manualWebContent = '';
      if (searchMatch) {
        const sq = searchMatch[1].trim();
        const ss = ora({ text: `Searching "${sq}"…`, color: 'yellow' }).start();
        try {
          const results = await webSearch(sq, 5);
          if (results.length === 0) { ss.fail('No search results'); }
          else {
            ss.succeed(`Found ${results.length} results`);
            const fs2 = ora({ text: 'Fetching pages…', color: 'yellow' }).start();
            const pages = await Promise.allSettled(results.slice(0, 2).map(r => fetchWebContent(r.url)));
            const parts = pages.filter(p => p.status === 'fulfilled').map(p => p.value);
            fs2[parts.length ? 'succeed' : 'info'](`Fetched ${parts.length} page(s)`);
            const fetched = parts.join('\n\n---\n\n');
            await appendWebHistory(sq, results, fetched);
            manualWebContent = formatSearchResults(results) + (fetched ? `\n\n--- Fetched pages ---\n${fetched}` : '');
          }
        } catch (err) { ss.fail(`Search failed: ${err.message}`); }
      }
      // URL fetch (skip when /search already ran)
      let urlWebContent = '';
      if (!searchMatch) {
        const urls = extractUrls(trimmed);
        if (urls.length > 0) {
          const ws = ora({ text: `Fetching ${urls.length} URL(s)…`, color: 'yellow' }).start();
          const pages = await Promise.allSettled(urls.map(u => fetchWebContent(u)));
          const parts = pages.filter(p => p.status === 'fulfilled').map(p => p.value);
          ws.succeed(`Fetched ${(parts.reduce((s, p) => s + p.length, 0) / 1000).toFixed(1)}k`);
          urlWebContent = parts.join('\n\n---\n\n');
        }
      }
      const webContent = manualWebContent || urlWebContent;

      // /file command — paths from pre-parsed fileMatch above.
      // Format: /file "path1, path2, ..."
      let fileContent = '';
      if (fileMatch) {
        const paths = fileMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        const parts = [];
        for (const p of paths) {
          const absPath = p.startsWith('/') ? p : join(dir, p);
          const content = await readFile(absPath).catch(() => null);
          if (content) {
            parts.push(`// file-ref: ${p}\n${content}`);
            process.stderr.write(`\x1b[90m[geniesh] loaded ${p} (${Math.round(content.length / 4).toLocaleString()} tok)\x1b[0m\n`);
          } else {
            process.stderr.write(`\x1b[31m[geniesh] could not read ${p}\x1b[0m\n`);
          }
        }
        fileContent = parts.join('\n\n');
      }

      // Materialise background RAG index if it finished
      if (!ragIndex && ragIndexPromise) {
        // Race with setImmediate — adopt only if already resolved
        const settled = await Promise.race([
          ragIndexPromise,
          new Promise(r => setImmediate(() => r(null))),
        ]);
        if (settled) {
          ragIndex = settled;
          ragIndexPromise = null;
          process.stderr.write(`\x1b[90m[geniesh] RAG index ready: ${ragIndex.length} chunks\x1b[0m\n`);
        }
      }

      // genx context — only on explicit /context or /ctx command
      let contextMd = '';
      if (ctxMatch) {
        const genxQuery = ctxMatch[1].trim();
        const cs = ora({ text: `[geniesh] running genx: ${genxQuery.slice(0, 60)}…`, color: 'cyan' }).start();
        try {
          contextMd = await runGenx(genxQuery, '', dir, { compressModel });
          cs.succeed(`[geniesh] context: ${Math.round(contextMd.length / 4).toLocaleString()} tok`);
        } catch (err) {
          cs.warn(`[geniesh] genx failed (${err.message}) — proceeding without code context`);
        }
      }

      // Build user message — questionText already has slash commands stripped
      let question = questionText || trimmed;
      for (const url of extractUrls(trimmed)) question = question.replace(url, 'the fetched page');
      question = question.replace(/\s+/g, ' ').trim();
      const parts = [];
      if (contextMd) parts.push(contextMd);
      if (fileContent) parts.push(fileContent);
      if (webContent) parts.push(`[Web page content]\n${webContent}`);
      parts.push(`Question: ${question}`);

      applySlideWindow(messages);
      messages.push({ role: 'user', content: parts.join('\n\n') });

      // LLM call
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      try {
        let reply = await runChat(messages);
        messages.push({ role: 'assistant', content: reply });

        // Signal handling (REQUERY / REQUERY_INTERNET / bash)
        reply = await handleSignals(reply, messages, dir, ask, { compressModel });

        // Edit detection
        await handleEdits(reply, ask);
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
      console.log('  \x1b[90m  geniesh chat\x1b[0m       \x1b[90mInteractive chat (genx context pipeline)\x1b[0m');
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
          if (!fnCode) { console.error(`Function "${opts.fn}" not found in ${opts.file}`); process.exit(1); }
          prompt = buildDirectPrompt(query, fnCode, `${opts.file} → ${opts.fn}()`);
        } else {
          prompt = buildDirectPrompt(query, content, opts.file);
        }
      } else if (opts.dir) {
        if (!(await indexExists())) { console.error(`No index found. Run first:\n  geniesh index --dir ${opts.dir}`); process.exit(1); }
        const idx = await loadIndex();
        const chunks = await search(query, idx, 5);
        if (chunks.length === 0) { console.error('No relevant chunks found.'); process.exit(1); }
        prompt = buildPrompt(query, chunks);
      } else {
        console.error('Provide --file <path> or --dir <path>'); program.help(); process.exit(1);
      }
      await runQuery(prompt);
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
  });

// ─── refs ─────────────────────────────────────────────────────────────────────

program
  .command('refs')
  .description('Find all usages of a symbol across a directory')
  .argument('<name>', 'Symbol name to search for')
  .requiredOption('--dir <path>', 'Directory to search')
  .option('--ask <question>', 'Ask the LLM about the usages')
  .option('--explain', 'Explain the symbol and its usage patterns')
  .option('--context <lines>', 'Lines of context around each match', (v) => parseInt(v, 10), 20)
  .action(async (name, opts) => {
    try {
      process.stdout.write(`Searching for "${name}" in ${opts.dir}...\n`);
      const results = await grepDir(name, opts.dir, opts.context);
      console.log(formatGrepResults(results, name));
      const question = opts.ask || (opts.explain ? `Explain what "${name}" does and its usage patterns.` : null);
      if (question) {
        if (results.length === 0) { console.error('No matches.'); process.exit(1); }
        await runQuery(`You are a senior software engineer.\n\nContext:\n${buildGrepContext(results)}\n\nTask:\n${question}\n\nBe concise.`);
      }
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
  });

// ─── review ───────────────────────────────────────────────────────────────────

program
  .command('review')
  .description('Analyze code with one model, then critique with another')
  .argument('<query>', 'Question about the code')
  .option('--file <path>', 'File to analyze')
  .option('--dir <path>', 'Directory to search (requires index)')
  .option('--reviewer <model>', 'Reviewer model', 'llama3.1')
  .action(async (query, opts) => {
    try {
      const primary = program.opts().model || 'qwen3-coder';
      let ctx = '';
      if (opts.file) {
        ctx = `<codebase_context>\n${await readFile(opts.file)}\n</codebase_context>`;
      } else if (opts.dir) {
        if (!(await indexExists())) { console.error('No index found.'); process.exit(1); }
        const chunks = await search(query, await loadIndex(), 5);
        if (!chunks.length) { console.error('No chunks found.'); process.exit(1); }
        ctx = buildPrompt(query, chunks);
      } else { console.error('Provide --file or --dir'); process.exit(1); }
      console.log(`\n\x1b[1mStage 1: Analysis (\x1b[36m${primary}\x1b[0m)\x1b[0m\n`);
      const analysis = await runGenerate(`You are a senior software engineer.\n\n${ctx}\n\nQuestion: ${query}\n\nAnalyze thoroughly.`, primary);
      console.log(`\n\x1b[1mStage 2: Review (\x1b[33m${opts.reviewer}\x1b[0m)\x1b[0m\n`);
      setModel(opts.reviewer);
      await runQuery(`You are a senior software engineer acting as a code reviewer.\n\nAnalysis by ${primary} for: "${query}"\n\n<analysis>\n${analysis}\n</analysis>\n\nReview for accuracy, completeness, bugs, improvements. Be critical.`);
      setModel(primary);
      console.log();
    } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
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
