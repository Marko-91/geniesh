const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// nomic-embed-text context limit ~8192 tokens; ~4 chars/token → 6000 char safe limit
const EMBED_CHAR_LIMIT = 6000;
let _embedder = process.env.EMBEDDER || 'nomic-embed-text';

export function setEmbedder(name) { _embedder = name; }
export function getEmbedder()     { return _embedder; }

/**
 * Generates an embedding vector for the given text using nomic-embed-text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

/**
 * Generates embeddings for multiple texts in a single Ollama call.
 * Dramatically faster than calling embed() N times (one inference run).
 * @param {string[]} texts
 * @param {number}   [charLimit]  Override char limit per text
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts) {
  const input = texts.map(t =>
    t.length > EMBED_CHAR_LIMIT ? t.slice(0, EMBED_CHAR_LIMIT) : t,
  );

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: _embedder, input }),
    });
  } catch (err) {
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_URL}. Is Ollama running?\n  ${err.message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed error ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (!data?.embeddings?.length) {
    throw new Error('Ollama returned empty embedding response');
  }
  return data.embeddings;
}
