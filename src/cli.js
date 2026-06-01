#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { Transform } from 'stream';
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
import { runQuery, runChat, runGenerate, setModel, getModel, getModelInfo, countTokens } from './runner.js';
import { setEmbedder } from './embedder.js';
import { grepDir, formatGrepResults, buildGrepContext } from './grep.js';
import { extractUrls, fetchWebContent } from './web-fetch.js';
import { webSearch, formatSearchResults } from './web-search.js';
import { parseFileEdits, formatDiff, formatSearchReplaceDiff, applySearchReplace } from './diff-apply.js';
const { structuredPatch } = require('diff');
import { parseShellCommands, runShellCommand } from './terminal-agent.js';
import { execSync } from 'child_process';
import ora from 'ora';
import { runGenx, compressConversation } from './genx.js';

const msgMeta = new WeakMap(); // message → { rawParts?, question? }

function serializeMessages(messages) {
  return messages.map(m => {
    const role = m.role === 'system' ? '<|system|>' : m.role === 'user' ? '<|user|>' : '<|assistant|>';
    return `${role}\n${m.content}\n`;
  }).join('\n');
}

async function compactMessagesIfNeeded(messages, { contextLimit, compressModel, modelName }) {
  if (messages.length <= 1) return;
  const total = await countTokens(serializeMessages(messages), modelName);
  const ratio = total / contextLimit;
  if (ratio < 0.60) return;

  // Strip stale genx/file/web bloat from old user messages (no LLM call)
  // Keep system + last 2 turns intact
  const preserveCount = Math.min(5, messages.length - 1);
  const compactEnd = messages.length - preserveCount;
  if (compactEnd >= 2) {
    for (let i = 1; i < compactEnd; i++) {
      const meta = msgMeta.get(messages[i]);
      if (!meta || !meta.rawParts) continue;
      const stripped = meta.rawParts
        .filter(p => p.startsWith('Question:') || p.startsWith('Output each'))
        .join('\n\n');
      if (stripped) messages[i].content = stripped;
    }
  }

  // Check again after stripping
  const afterStrip = await countTokens(serializeMessages(messages), modelName);
  const afterRatio = afterStrip / contextLimit;
  if (afterRatio < 0.60) return;

  // Determine compaction level
  const aggressive = afterRatio >= 0.85;
  const preserveTurns = aggressive ? 1 : 2;
  const keepCount = Math.min(1 + preserveTurns * 2, messages.length - 1);
  const compactIdx = messages.length - keepCount;
  if (compactIdx < 2) return;

  const toCompact = messages.slice(1, compactIdx);
  const preserved = [messages[0], ...messages.slice(compactIdx)];

  process.stderr.write(`\x1b[33m[geniesh] context at ${Math.round(afterRatio * 100)}% — compacting ${toCompact.length} message(s) with ${compressModel || modelName}…\x1b[0m\n`);

  let summary;
  try {
    summary = await compressConversation(toCompact, compressModel || modelName);
  } catch (err) {
    process.stderr.write(`\x1b[31m[geniesh] compaction failed: ${err.message}\x1b[0m\n`);
    return;
  }

  messages.length = 0;
  messages.push(preserved[0]); // system
  if (summary) {
    const compactMsg = { role: 'user', content: `[Compacted conversation history]\n\n${summary}` };
    msgMeta.set(compactMsg, { rawParts: null });
    messages.push(compactMsg);
  }
  for (let i = 1; i < preserved.length; i++) {
    messages.push(preserved[i]);
  }
  process.stderr.write(`\x1b[32m[geniesh] messages compacted (was ${toCompact.length}, now 1 summary)\x1b[0m\n`);
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
  const historyPath = process.env.GENX_HISTORY || join(process.env.HOME || '~', '.genx_history.md');
  try { await appendFile(historyPath, entry, 'utf-8'); } catch { /* non-fatal */ }
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

async function handleEdits(reply, ask, root) {
  const { scanDir } = await import('./fs-utils.js');
  let allFiles = [];
  try { allFiles = await scanDir(root || process.cwd()); } catch { /* non-fatal */ }

  const allEdits = parseFileEdits(reply, allFiles);
  const srEdits = allEdits.filter(e => e.type === 'sr');
  const fullEdits = allEdits.filter(e => e.type === 'full');
  const applied = [];
  let lastEditError = null;

  // 1) Try SEARCH/REPLACE edits first
  for (const edit of srEdits) {
    let diff, apply, originalContent;
    originalContent = await readFile(edit.file).catch(() => '');
    diff = formatSearchReplaceDiff(edit.file, edit.search, edit.replace, originalContent);
    apply = () => applySearchReplace(edit.file, edit.search, edit.replace);
    if (!diff) continue;
    process.stdout.write(`\n${diff}\n`);
    const ans = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
    if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
      try {
        await apply();
        applied.push({ file: edit.file, search: edit.search, replace: edit.replace });
        if (/\.(js|mjs|cjs)$/i.test(edit.file)) {
          try {
            execSync(`node --check "${edit.file}"`, { stdio: 'pipe', timeout: 10000 });
            process.stdout.write(`\x1b[32m✓ ${edit.file} updated (syntax OK)\x1b[0m\n`);
          } catch (synErr) {
            applied.pop();
            if (originalContent) await writeFile(edit.file, originalContent, 'utf-8');
            process.stdout.write(`\x1b[31m✗ ${edit.file} syntax check FAILED — reverted\x1b[0m\n`);
            process.stdout.write(synErr.stderr.toString().split('\n').slice(0, 5).join('\n') + '\n');
            lastEditError = new Error(`Syntax check failed for ${edit.file}`);
          }
        } else {
          process.stdout.write(`\x1b[32m✓ ${edit.file} updated\x1b[0m\n`);
        }
      } catch (err) {
        lastEditError = err;
        if (!err.message.includes('not found')) {
          process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
        }
      }
    } else {
      process.stdout.write(`\x1b[33mSkipped ${edit.file}\x1b[0m\n`);
    }
  }

  // 2) Full-file fallback — diff the rewrite against current file and show surgical changes
  if (applied.length === 0 && fullEdits.length > 0) {
    fullEditsLoop:
    for (const edit of fullEdits) {
      const oldContent = await readFile(edit.file).catch(() => '');
      if (!oldContent) continue;
      const diff = formatDiff(oldContent, edit.content, edit.file);
      if (!diff) continue;
      process.stdout.write(`\n\x1b[33m⚠ LLM output a full-file rewrite — surgical diff:\x1b[0m\n`);
      process.stdout.write(`\n${diff}\n`);
      const ans = await ask(`Apply this change? [\x1b[1mY\x1b[0m/n] `);
      if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
        try {
          await writeFile(edit.file, edit.content, 'utf-8');
          applied.push({ file: edit.file, search: oldContent, replace: edit.content });
          process.stdout.write(`\x1b[32m✓ ${edit.file} updated\x1b[0m\n`);
        } catch (err) {
          process.stdout.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
        }
      } else {
        process.stdout.write(`\x1b[33mSkipped ${edit.file}\x1b[0m\n`);
      }
    }
  }

  // 3) Function-level fallback when SEARCH text not found
  if (lastEditError && lastEditError.message.includes('not found')) {
    const srEdit = srEdits.find(e => e.type === 'sr');
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
            process.stdout.write(`\n\x1b[33m⚠ Exact text not found — replacing function \x1b[1m${funcName}\x1b[0m instead\x1b[0m\n`);
            const diff = formatDiff(old, fullNew, srEdit.file);
            if (diff) process.stdout.write(`\n${diff}\n`);
            const ans2 = await ask(`Apply replacement for \x1b[1m${funcName}\x1b[0m in ${srEdit.file}? [\x1b[1mY\x1b[0m/n] `);
            if (!ans2 || ans2.toLowerCase() === 'y' || ans2 === '') {
              try {
                await writeFile(srEdit.file, fullNew);
                applied.push({ file: srEdit.file, search: srEdit.search, replace: fullNew });
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

  return applied;
}

async function printEditSummary(applied, model) {
  if (!applied.length || !model) return;
  const parts = [];
  for (const a of applied) {
    const patch = structuredPatch(a.file, a.file, a.search, a.replace);
    if (!patch.hunks.length) continue;
    const hunksText = patch.hunks.map(h =>
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`
    ).join('\n');
    parts.push(`File: ${a.file}\n${hunksText}`);
  }
  const prompt = `Summarize this code edit in 1 line: what changed, which functions/methods, +N/-N lines. Be specific about files and function names. Keep under 100 chars.

${parts.join('\n---\n')}`;
  try {
    const summary = await runGenerate(prompt, model);
    process.stdout.write(`\n\x1b[1;36m📝 Summary\x1b[0m  ${summary.trim()}\n`);
  } catch {
    // Silently skip — summary is non-critical
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

    const modelInfo = await getModelInfo(modelName).catch(() => ({ contextLength: 32768 }));
    const contextLimit = modelInfo.contextLength;
    let budgetTokens = 0;

    if (process.stdin.isTTY) {
      process.stdout.write('\x1b[?2004h');
    }

    class BracketedPasteTransform extends Transform {
      constructor(stdin) {
        super();
        this._stdin = stdin;
        this._buf = '';
        this._in = false;
        this.isTTY = true;
      }
      setRawMode(mode) {
        if (this._stdin.setRawMode) this._stdin.setRawMode(mode);
      }
      _transform(chunk, _, cb) {
        this._buf += chunk.toString();
        this._drain();
        cb();
      }
      _flush(cb) {
        if (this._buf) this.push(this._buf);
        cb();
      }
      _drain() {
        while (this._buf.length) {
          if (this._in) {
            const end = this._buf.indexOf('\x1b[201~');
            if (end === -1) {
              this.push(this._buf.replace(/\n/g, '\v'));
              this._buf = '';
            } else {
              const block = this._buf.slice(0, end).replace(/\n/g, '\v');
              this.push(block);
              this._buf = this._buf.slice(end + 6);
              this._in = false;
            }
          } else {
            const start = this._buf.indexOf('\x1b[200~');
            if (start === -1) {
              this.push(this._buf);
              this._buf = '';
            } else {
              if (start > 0) this.push(this._buf.slice(0, start));
              this._buf = this._buf.slice(start + 6);
              this._in = true;
            }
          }
        }
      }
    }

    const inputSrc = process.stdin.isTTY
      ? process.stdin.pipe(new BracketedPasteTransform(process.stdin))
      : process.stdin;

    const rl = createInterface({ input: inputSrc, output: process.stdout });

    let inputResolve = null;
    const inputBuffer = [];

    rl.on('line', (line) => {
      // \v was substituted for \n inside a paste by the transform above
      const actual = line.replace(/\v/g, '\n');
      if (inputResolve) {
        const r = inputResolve;
        inputResolve = null;
        r(actual);
      } else {
        inputBuffer.push(actual);
      }
    });

    function ask(question) {
      return new Promise((resolve) => {
        process.stdout.write(question);
        if (inputBuffer.length > 0) {
          resolve(inputBuffer.shift());
        } else {
          inputResolve = resolve;
        }
      });
    }

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('🧞  geniesh  —  type \x1b[33mexit\x1b[0m or Ctrl+C to quit');
    console.log(`📂  Root      : ${dir}`);
    console.log(`🧩  Model     : ${modelName}`);
    if (compressModel) console.log(`🧹  Compress  : ${compressModel}`);
    console.log(`📊  Budget    : 0 / ${contextLimit.toLocaleString()} tok`);
    if (ragIndex) console.log(`📚  RAG index : ${ragIndex.length} chunks (symbol discovery active)`);
    else if (ragIndexPromise) console.log(`📚  RAG index : loading…`);
    else console.log(`📚  RAG index : not built  (run: geniesh index --dir ${dir})`);
    console.log('────────────────────────────────────────────────────────────\n');
    console.log('\x1b[90m💡 Tips\x1b[0m');
    console.log('\x1b[90m Commands:\x1b[0m');
    console.log('\x1b[90m   /search "query"              Search DuckDuckGo + fetch top pages\x1b[0m');
    console.log('\x1b[90m   /file "path1, path2"         Load full file(s) into context\x1b[0m');
    console.log('\x1b[90m   /ctx|/context "symbol1, symbol2"  Run genx with exactly these symbols\x1b[0m');
    console.log('\x1b[90m   /edit                       Enable SEARCH/REPLACE edit approval\x1b[0m');
    console.log('\x1b[90m   /budget                     Show token budget breakdown\x1b[0m');
    console.log('\x1b[90m   /compact                    Manually compact conversation history\x1b[0m');
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

    process.on('SIGINT', () => {
      if (process.stdin.isTTY) process.stdout.write('\x1b[?2004l');
      console.log('\nBye!'); rl.close(); process.exit(0);
    });

    // Load genx history from previous sessions — no genx call, just file read
    let historyContent = '';
    const historyPath = join(dir, '.genx_history.md');
    try { historyContent = await fsReadFile(historyPath, 'utf-8'); } catch { /* no history yet */ }

    while (true) {
      let userInput;
      try { userInput = await ask('\x1b[32mYou\x1b[0m: '); } catch { break; }
      const trimmed = userInput.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        if (process.stdin.isTTY) process.stdout.write('\x1b[?2004l');
        rl.close(); console.log('Bye!'); break;
      }

      // /budget — show token breakdown
      if (/^\/budget\b/.test(trimmed)) {
        const total = await countTokens(serializeMessages(messages), modelName);
        const pct = Math.round((total / contextLimit) * 100);
        let color = '\x1b[32m'; // green
        if (pct >= 85) color = '\x1b[31m'; else if (pct >= 60) color = '\x1b[33m';
        process.stderr.write(
          `\x1b[90m── token budget ──\n` +
          `  messages  : ${messages.length}\n` +
          `  used      : ${total.toLocaleString()} tok (${messages.length > 1 ? Math.round(total / messages.length).toLocaleString() : 0} avg)\n` +
          `  limit     : ${contextLimit.toLocaleString()} tok\n` +
          `  budget    : ${color}${pct}%\x1b[0m\x1b[90m\n` +
          `──────────────────\x1b[0m\n`
        );
        continue;
      }

      // /compact — manually trigger compaction
      if (/^\/compact\b/.test(trimmed)) {
        process.stderr.write(`\x1b[33m[geniesh] manual compaction triggered…\x1b[0m\n`);
        await compactMessagesIfNeeded(messages, { contextLimit, compressModel, modelName });
        continue;
      }

      // Parse all slash commands from anywhere in the message.
      // All commands require quoted delimiters to avoid accidental token capture:
      //   /search "query"   /file "path1, path2"   /context "word1, word2"
      const searchMatch  = trimmed.match(/\/search\s+"([^"]+)"/);
      const fileMatch    = trimmed.match(/\/file\s+"([^"]+)"/);
      const ctxMatch     = trimmed.match(/\/(?:ctx|context)\s+"([^"]+)"/);
      const hasEditCmd   = /(?:^|\s)\/edit\b/.test(trimmed);
      const hasSlashCmd  = !!(searchMatch || fileMatch || ctxMatch);

      // Strip slash commands from the prose question sent to the LLM
      let questionText = trimmed
        .replace(/\/search\s+"[^"]+"/g, '')
        .replace(/\/file\s+"[^"]+"/g, '')
        .replace(/\/(?:ctx|context)\s+"[^"]+"/g, '')
        .replace(/\/edit\b/gi, '')
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

      // genx context — only on explicit /context or /ctx
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
      if (hasEditCmd) {
        parts.push('Output each edit as: FILE_PATH\nSEARCH\n<old code>\nREPLACE\n<new code>. Do NOT use <<<<<<<, =======, >>>>>>>, or ``` markers.');
      }

      // Compact if approaching context limit
      await compactMessagesIfNeeded(messages, { contextLimit, compressModel, modelName });

      const userMsg = { role: 'user', content: parts.join('\n\n') };
      msgMeta.set(userMsg, { rawParts: parts, question });
      messages.push(userMsg);

      // LLM call
      process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
      try {
        let reply = await runChat(messages);
        messages.push({ role: 'assistant', content: reply });

        // Update budget display
        budgetTokens = await countTokens(serializeMessages(messages), modelName);
        const bpct = Math.round((budgetTokens / contextLimit) * 100);
        let bcolor = '\x1b[32m';
        if (bpct >= 85) bcolor = '\x1b[31m'; else if (bpct >= 60) bcolor = '\x1b[33m';
        process.stderr.write(`\x1b[90m[tok: ${budgetTokens.toLocaleString()} / ${contextLimit.toLocaleString()} ${bcolor}${bpct}%\x1b[0m\x1b[90m]\x1b[0m\n`);

        // Signal handling (REQUERY / REQUERY_INTERNET / bash)
        reply = await handleSignals(reply, messages, dir, ask, { compressModel });

        // Edit detection — only on explicit /edit command
        if (hasEditCmd) {
          const applied = await handleEdits(reply, ask, dir);
          if (applied.length > 0) {
            const summaryModel = compressModel || getModel();
            await printEditSummary(applied, summaryModel);
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
