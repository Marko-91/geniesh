import { createInterface } from 'readline';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import ora from 'ora';
import { runChat, countTokens, getModelInfo } from './runner.js';
import { SYSTEM_RULES, ANALYSIS_PROMPT, PLAN_INSTRUCTION } from './prompt.js';
import { analyzeCode } from './analysis.js';
import { runGenx } from './genx.js';
import { parseEdits, applyEdit, formatDiff } from './edit.js';
import { webSearch, formatSearchResults } from './web-search.js';
import { fetchWebContent, extractUrls } from './web-fetch.js';
import { readFile, scanDir } from './fs-utils.js';
import { parseShellCommands, runShellCommand } from './terminal-agent.js';

const MAX_TURNS = 10;

export async function startChat(modelName, dir, opts) {
  const messages = [{ role: 'system', content: SYSTEM_RULES }];

  const modelInfo = await getModelInfo(modelName);
  const contextLimit = modelInfo.contextLength;

  let ragIndex = null;
  if (opts.fullIndex) {
    const { loadIndex, indexExists } = await import('./indexer.js');
    const s = ora('Loading RAG index…').start();
    ragIndex = await loadIndex();
    s.succeed(`RAG index: ${ragIndex.length} chunks`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let inputResolve = null;
  const inputBuffer = [];
  rl.on('line', line => {
    if (inputResolve) { const r = inputResolve; inputResolve = null; r(line); }
    else inputBuffer.push(line);
  });

  function ask(q) {
    return new Promise(resolve => {
      process.stdout.write(q);
      if (inputBuffer.length) resolve(inputBuffer.shift());
      else inputResolve = resolve;
    });
  }

  console.log(`🧞 geniesh  •  ${modelName}  •  ${dir}`);

  while (true) {
    let input;
    try { input = await ask('\x1b[32mYou\x1b[0m: '); } catch { break; }
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') break;

    const searchMatch  = trimmed.match(/\/search\s+"([^"]+)"/);
    const ctxMatch     = trimmed.match(/\/ctx\s+"([^"]+)"/);
    const fileMatch    = trimmed.match(/\/file\s+"([^"]+)"/) || trimmed.match(/\/file\s+(\S+)/);
    const hasEditCmd   = /(?:^|\s)\/edit\b/.test(trimmed);
    const hasAnalyseCmd = /(?:^|\s)\/analyse\b/.test(trimmed);
    const hasPlanCmd    = /(?:^|\s)\/plan\b/.test(trimmed);

    if (/^\/budget$/.test(trimmed)) {
      const total = await countTokens(messages.map(m => m.content).join('\n'), modelName);
      const pct = Math.round(total / contextLimit * 100);
      console.log(`messages: ${messages.length}  |  ${total.toLocaleString()} / ${contextLimit.toLocaleString()} tok  (${pct}%)`);
      continue;
    }

    if (/^\/compact$/.test(trimmed)) {
      const before = messages.length;
      trimMessages(messages, 6);
      console.log(`messages: ${before} → ${messages.length}`);
      continue;
    }

    let question = trimmed
      .replace(/\/search\s+"[^"]+"/g, '')
      .replace(/\/ctx\s+"[^"]+"/g, '')
      .replace(/\/file\s+"[^"]+"/g, '')
      .replace(/\/file\s+\S+/g, '')
      .replace(/\/edit\b/gi, '')
      .replace(/\/analyse\b/gi, '')
      .replace(/\/plan\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    if (!question) question = 'continue';

    let webContent = '';
    if (searchMatch) {
      const sq = searchMatch[1].trim();
      const ss = ora(`Searching "${sq}"…`).start();
      try {
        const results = await webSearch(sq, 5);
        if (results.length) {
          const pages = await Promise.allSettled(results.slice(0, 2).map(r => fetchWebContent(r.url)));
          const fetched = pages.filter(p => p.status === 'fulfilled').map(p => p.value).join('\n\n---\n\n');
          webContent = formatSearchResults(results) + (fetched ? `\n\n${fetched}` : '');
          ss.succeed();
        } else ss.fail('no results');
      } catch (err) { ss.fail(err.message); }
    }

    if (!searchMatch) {
      const urls = extractUrls(trimmed);
      if (urls.length) {
        const pages = await Promise.allSettled(urls.map(u => fetchWebContent(u)));
        const fetched = pages.filter(p => p.status === 'fulfilled').map(p => p.value);
        if (fetched.length) webContent = fetched.join('\n\n---\n\n');
      }
    }

    let contextMd = '';
    if (ctxMatch) {
      const symbols = ctxMatch[1].trim();
      const cs = ora(`ctx: ${symbols.slice(0, 60)}…`).start();
      try {
        const result = await runGenx(symbols, dir);
        contextMd = result.content;
        cs.succeed();
      } catch (err) { cs.fail(err.message); }
    }

    let fileContent = '';
    if (fileMatch) {
      const rawPath = fileMatch[1] || fileMatch[2];
      const paths = rawPath.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of paths) {
        const absPath = p.startsWith('/') ? p : join(dir, p);
        const content = await readFile(absPath).catch(() => null);
        if (content) {
          fileContent += `## File: ${p}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }
      }
    }

    let analyseContextMd = '';
    let analyseFileContent = '';
    if (hasAnalyseCmd && dir) {
      const as = ora('🔍 Analysing codebase…').start();
      try {
        const result = await analyzeCode(question, dir, ragIndex);
        analyseContextMd = result.genxContent;
        analyseFileContent = result.fileContent;
        if (result.hitFiles.length) as.succeed(`found ${result.hitFiles.length} files`);
        else as.fail('no relevant files found');
      } catch (err) { as.fail(err.message); }
    }

    if (analyseContextMd) contextMd += (contextMd ? '\n\n' : '') + analyseContextMd;
    if (analyseFileContent) fileContent += analyseFileContent;

    const refs = [];
    if (contextMd) refs.push(`--- context ---\n${contextMd}\n--- end context ---`);
    if (fileContent) refs.push(`--- files ---\n${fileContent}\n--- end files ---`);
    if (webContent) refs.push(`--- web ---\n${webContent}\n--- end web ---`);

    const userParts = [question];
    if (refs.length) userParts.push(refs.join('\n\n'));
    if (hasEditCmd) {
      userParts.push(
        'Now produce SEARCH/REPLACE edits for the files above. ' +
        'Copy SEARCH text character-for-character. ' +
        'Do NOT output REQUERY.'
      );
    }
    if (hasPlanCmd) userParts.push(PLAN_INSTRUCTION);
    if (hasAnalyseCmd) userParts.push(ANALYSIS_PROMPT);

    messages.push({ role: 'user', content: userParts.join('\n\n') });

    process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
    try {
      let reply = await runChat(messages);

      // Strip REQUERY lines from response — we feed context directly, LLM shouldn't need to re-query
      reply = reply.replace(/^REQUERY\s+.*$/gm, '').trim();

      messages.push({ role: 'assistant', content: reply });

      const total = await countTokens(messages.map(m => m.content).join('\n'), modelName);
      const pct = Math.round(total / contextLimit * 100);
      const color = pct >= 85 ? '\x1b[31m' : pct >= 60 ? '\x1b[33m' : '\x1b[32m';
      process.stderr.write(`\x1b[90m[tok: ${total.toLocaleString()} / ${contextLimit.toLocaleString()} ${color}${pct}%\x1b[0m\x1b[90m]\x1b[0m\n`);

      reply = await handleSignals(reply, messages, dir, ask, modelName, hasPlanCmd);

      if (hasEditCmd && reply.trim()) {
        let allFiles = [];
        try { allFiles = await scanDir(dir); } catch {}
        const edits = parseEdits(reply, allFiles);
        for (const edit of edits) {
          if (edit.type === 'sr') {
            const content = await readFile(edit.file).catch(() => '');
            if (!content?.includes(edit.search)) {
              console.log(`\x1b[33m⚠ SEARCH text not found in ${edit.file}\x1b[0m`);
              continue;
            }
            const diff = formatDiff(edit.file, edit.search, edit.replace, content);
            if (!diff) continue;
            console.log(`\n${diff}`);
            const ans = await ask('Apply? [Y/n] ');
            if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
              try {
                await applyEdit(edit.file, edit.search, edit.replace);
                if (/\.(js|mjs|cjs)$/.test(edit.file)) {
                  try {
                    execSync(`node --check "${edit.file}"`, { stdio: 'pipe', timeout: 10000 });
                    console.log(`\x1b[32m✓ ${edit.file} updated (syntax OK)\x1b[0m`);
                  } catch (e) {
                    console.log(`\x1b[31m✗ ${edit.file} syntax error — reverted\x1b[0m`);
                    await writeFile(edit.file, content, 'utf-8');
                  }
                } else {
                  console.log(`\x1b[32m✓ ${edit.file} updated\x1b[0m`);
                }
              } catch (err) { console.log(`\x1b[31m✗ ${err.message}\x1b[0m`); }
            }
          } else if (edit.type === 'full') {
            const oldContent = await readFile(edit.file).catch(() => '');
            if (!oldContent) continue;
            const { formatFileDiff } = await import('./edit.js');
            const diff = formatFileDiff(edit.file, oldContent, edit.content);
            if (!diff) continue;
            console.log(`\n\x1b[33m⚠ Full file rewrite — surgical diff:\x1b[0m`);
            console.log(diff);
            const ans = await ask('Apply? [Y/n] ');
            if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
              try {
                await writeFile(edit.file, edit.content, 'utf-8');
                console.log(`\x1b[32m✓ ${edit.file} updated\x1b[0m`);
              } catch (err) { console.log(`\x1b[31m✗ ${err.message}\x1b[0m`); }
            }
          }
        }
      }

      trimMessages(messages, MAX_TURNS);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
      messages.pop();
    }
    console.log();
  }

  rl.close();
  console.log('Bye!');
}

async function handleSignals(reply, messages, dir, ask, modelName, planMode) {
  let current = reply;
  for (let i = 0; i < 3; i++) {
    if (planMode) break;
    const rq = current.match(/^REQUERY\s+(.+)$/m);
    if (rq) {
      const symbols = rq[1].trim();
      process.stderr.write(`\x1b[33m↺ REQUERY: ${symbols}\x1b[0m\n`);
      try {
        const result = await runGenx(symbols, dir);
        messages.push({ role: 'user', content: `[Context for: ${symbols}]\n\n${result.content}\n\nContinue.` });
        process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
        current = await runChat(messages);
        messages.push({ role: 'assistant', content: current });
        continue;
      } catch { break; }
    }

    const cmds = parseShellCommands(current);
    let anyRan = false;
    for (const cmd of cmds) {
      process.stdout.write(`\n\x1b[90m$ ${cmd}\x1b[0m\n`);
      const ans = await ask('Run? [Y/n] ');
      if (!ans || ans.toLowerCase().startsWith('y') || ans === '') {
        const res = runShellCommand(cmd);
        process.stdout.write(`\x1b[90m${res.output.slice(0, 2000)}\n→ exit ${res.exitCode} (${res.elapsed})\x1b[0m\n`);
        messages.push({ role: 'user', content: `$ ${cmd}\n${res.output}\nExit: ${res.exitCode}\nContinue.` });
        process.stdout.write('\n\x1b[36mAssistant\x1b[0m:\n');
        current = await runChat(messages);
        messages.push({ role: 'assistant', content: current });
        anyRan = true;
      }
    }
    if (anyRan) continue;
    break;
  }
  return current;
}

function trimMessages(messages, maxTurns) {
  const max = 1 + maxTurns * 2;
  if (messages.length <= max) return;
  const keep = [messages[0], ...messages.slice(-(maxTurns * 2))];
  messages.length = 0;
  messages.push(...keep);
}
