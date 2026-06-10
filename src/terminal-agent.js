import { execSync } from 'child_process';
import { writeFile } from 'fs/promises';

const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_CHARS = 30000;
const CMD_TIMEOUT = 60000;

export function parseShellCommands(text) {
  // Match: ```bash or ```shell blocks
  const cmdRe = /```(bash|shell|sh)\n([\s\S]*?)```/g;
  const commands = [];
  let match;
  while ((match = cmdRe.exec(text)) !== null) {
    const cmd = match[2].trim();
    if (cmd) commands.push(cmd);
  }
  return commands;
}

export function runShellCommand(command, cwd) {
  const start = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = execSync(command, {
      timeout: CMD_TIMEOUT,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      cwd: cwd || process.cwd(),
    });
    stdout = (result || '').trim();
  } catch (err) {
    exitCode = err.status || 1;
    stdout = (err.stdout || '').trim();
    stderr = (err.stderr || '').trim();
    if (err.message && !stderr) stderr = err.message;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Truncate output
  let output = stdout;
  if (stderr) output += '\n' + stderr;
  const lines = output.split('\n');
  if (lines.length > MAX_OUTPUT_LINES) {
    output = lines.slice(0, MAX_OUTPUT_LINES).join('\n') + `\n... (${lines.length - MAX_OUTPUT_LINES} more lines)`;
  }
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${output.length - MAX_OUTPUT_CHARS} more chars)`;
  }

  return {
    command,
    exitCode,
    stdout,
    stderr,
    output,
    elapsed: `${elapsed}s`,
  };
}

export function formatCommandResult(result) {
  const lines = [`$ ${result.command}`];
  if (result.output) lines.push(result.output);
  lines.push(`  → exit ${result.exitCode} (${result.elapsed})`);
  return lines.join('\n');
}
