import { StreamingMarkdownParser } from './md-parser.js';
import ora from 'ora';

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
let _model = process.env.MODEL || 'qwen3-coder';

/** Override the model at runtime (used by CLI --model flag). */
export function setModel(name) { _model = name; }
export function getModel()     { return _model; }

/**
 * Streams a single-turn response from Llama 3 to stdout.
 * Uses /api/generate with streaming enabled.
 *
 * @param {string} prompt
 * @returns {Promise<void>}
 */
export async function runQuery(prompt) {
  const spinner = ora({ text: `Thinking (${_model})…`, spinner: 'dots' }).start();
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: _model, prompt, stream: true }),
    });
  } catch (err) {
    spinner.fail('Ollama unreachable');
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`,
    );
  }

  if (!res.ok) {
    spinner.fail(`Model error ${res.status}`);
    const body = await res.text();
    throw new Error(`Ollama generate error ${res.status}: ${body}`);
  }

  spinner.stop();
  await streamResponse(res, (obj) => obj.response ?? '');
}

/**
 * Sends a multi-turn chat request, streams the reply to stdout,
 * and returns the full assistant response text.
 *
 * @param {{ role: string, content: string }[]} messages
 * @returns {Promise<string>}  Full assistant response text
 */
export async function runChat(messages) {
  const spinner = ora({ text: `Thinking (${_model})…`, spinner: 'dots' }).start();
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: _model, messages, stream: true }),
    });
  } catch (err) {
    spinner.fail('Ollama unreachable');
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`,
    );
  }

  if (!res.ok) {
    spinner.fail(`Model error ${res.status}`);
    const body = await res.text();
    throw new Error(`Ollama chat error ${res.status}: ${body}`);
  }

  spinner.stop();
  const fullResponse = await streamResponse(res, (obj) => obj.message?.content ?? '');
  return fullResponse;
}

/**
 * Reads a newline-delimited JSON stream from an Ollama response,
 * writes each token to stdout, and returns the full accumulated text.
 *
 * @param {Response} res
 * @param {(obj: object) => string} tokenExtractor
 * @returns {Promise<string>}
 */
async function streamResponse(res, tokenExtractor) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const mdParser = new StreamingMarkdownParser();
  const write = (out) => process.stdout.write(out);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // retain incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const token = tokenExtractor(obj);
        if (token) {
          full += token;
          mdParser.feed(token, write);
        }
      } catch {
        // skip malformed line
      }
    }
  }

  mdParser.flush(write);
  process.stdout.write('\n');
  return full;
}
//   // Handle bold text
//   text = text.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[0m');
  
//   // Handle headers first (they need to be processed before inline code)
//   text = text.replace(/^# (.*)/gm, '\x1b[1m\x1b[37m$1\x1b[0m');
//   text = text.replace(/^## (.*)/gm, '\x1b[1m\x1b[36m$1\x1b[0m');
//   text = text.replace(/^### (.*)/gm, '\x1b[1m\x1b[35m$1\x1b[0m');
//   text = text.replace(/^#### (.*)/gm, '\x1b[1m\x1b[34m$1\x1b[0m');
//   text = text.replace(/^##### (.*)/gm, '\x1b[1m\x1b[33m$1\x1b[0m');
//   text = text.replace(/^###### (.*)/gm, '\x1b[1m\x1b[32m$1\x1b[0m');

//   // Handle inline code
//   text = text.replace(/`(.*?)`/g, '\x1b[32m$1\x1b[0m');

//   // Handle code blocks
//   text = text.replace(/`(\w+)?\n([\s\S]*?)`/g, (match, lang, code) => {
//     const langStr = lang ? ` [${lang}]` : '';
//     const formattedCode = code
//       .replace(/\x1b\[[0-9;]*m/g, '')
//       .replace(/^(.*)$/gm, '  $1');
//     return `\x1b[44m\x1b[37m${langStr}\x1b[0m\n${formattedCode}\x1b[0m`;
//   });

//   return text;
// }