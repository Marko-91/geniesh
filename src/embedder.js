const OLLAMA_URL = 'http://localhost:11434';

/**
 * Generates an embedding vector for the given text using nomic-embed-text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
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
  return data.embeddings[0];
}
