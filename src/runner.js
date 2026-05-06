const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'llama3';

/**
 * Streams a single-turn response from Llama 3 to stdout.
 * Uses /api/generate with streaming enabled.
 *
 * @param {string} prompt
 * @returns {Promise<void>}
 */
export async function runQuery(prompt) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: true }),
    });
  } catch (err) {
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama generate error ${res.status}: ${body}`);
  }

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
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, stream: true }),
    });
  } catch (err) {
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama chat error ${res.status}: ${body}`);
  }

  return streamResponse(res, (obj) => obj.message?.content ?? '');
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
          process.stdout.write(token);
          full += token;
        }
      } catch {
        // skip malformed line
      }
    }
  }

  process.stdout.write('\n');
  return full;
}
