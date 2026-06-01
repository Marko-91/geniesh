
import ora from 'ora';
import { spinners } from './spinners-ora.js';

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
let _model = process.env.MODEL || 'qwen3-coder';

/** Override the model at runtime (used by CLI --model flag). */
export function setModel(name) { _model = name; }
export function getModel()     { return _model; }

const FALLBACK_CONTEXT_LENGTHS = {
  qwen3: 131072, 'qwen3-coder': 131072,
  'llama3.1': 131072, 'llama3.2': 131072, 'llama3.3': 131072,
  'deepseek-coder-v2': 131072, 'deepseek-r1': 131072,
  'deepseek-coder': 16384,
  'codellama': 16384, 'codellama:13b': 16384,
  'codegemma': 8192, 'gemma2': 8192,
};

/**
 * Fetch model info from Ollama, extracting context_length from model_info.
 * Falls back to a hardcoded map, then to 32_000.
 */
export async function getModelInfo(model) {
  const m = model || _model;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m }),
    });
    if (res.ok) {
      const data = await res.json();
      const mi = data.model_info || {};
      // Try common keys for context length
      for (const key of Object.keys(mi)) {
        if (key.endsWith('.context_length')) {
          const val = mi[key];
          // GGUF metadata values can be strings or numbers
          const n = typeof val === 'number' ? val : Number(val);
          if (Number.isFinite(n) && n > 0) return { contextLength: n };
        }
      }
    }
  } catch { /* fall through */ }

  // Hardcoded fallback
  for (const prefix of Object.keys(FALLBACK_CONTEXT_LENGTHS)) {
    if (m.startsWith(prefix)) {
      return { contextLength: FALLBACK_CONTEXT_LENGTHS[prefix] };
    }
  }
  return { contextLength: 32_000 };
}

/**
 * Count tokens for a text string against the given model.
 * Uses Ollama's /api/tokenize endpoint; falls back to chars/4.
 */
export async function countTokens(text, model) {
  const m = model || _model;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, prompt: text }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.tokens)) return data.tokens.length;
    }
  } catch { /* fall through */ }
  return Math.floor(text.length / 4);
}

/**
 * Runs a single-turn prompt against the given model and returns the response text.
 * Does NOT write to stdout — used for chaining model outputs (e.g., review command).
 *
 * @param {string} prompt
 * @param {string} [model]  Model name; defaults to _model
 * @returns {Promise<string>}
 */
export async function runGenerate(prompt, model) {
  const m = model || _model;
  const spinner = ora({ text: `Thinking (${m})…`, spinner: 'dots' }).start();
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, prompt, stream: false, think: false }),
    });
  } catch (err) {
    spinner.fail('Ollama unreachable');
    throw new Error(`Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`);
  }
  if (!res.ok) {
    spinner.fail(`Model error ${res.status}`);
    const body = await res.text();
    throw new Error(`Ollama generate error ${res.status}: ${body}`);
  }
  spinner.succeed(`Done (${m})`);
  const data = await res.json();
  return data.response || '';
}

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
      body: JSON.stringify({ model: _model, prompt, stream: true, think: false }),
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
      body: JSON.stringify({ model: _model, messages, stream: true, think: false }),
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
  const randomSpinner = spinners[Math.floor(Math.random() * spinners.length)];
  const spinner = ora({
    text: 'Generating…',
    spinner: randomSpinner,
    color: 'blue',
  }).start();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let started = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const token = tokenExtractor(obj);
          if (token) {
            let delta;
            if (full && token.startsWith(full)) {
              delta = token.slice(full.length);
              full = token;
            } else {
              delta = token;
              full += token;
            }
            if (delta) {
              if (!started) { spinner.stop(); started = true; }
              process.stdout.write(delta);
            }
          }
        } catch {
          // skip malformed line
        }
      }
    }
  } finally {
    if (!started) spinner.stop();
  }

  process.stdout.write('\n');
  return full;
}