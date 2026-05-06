import { embed } from './embedder.js';

/**
 * Cosine similarity between two vectors.
 * nomic-embed-text returns normalized vectors so the dot product == cosine similarity,
 * but we compute both norms explicitly for safety with other embedding models.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}  Score in [-1, 1]
 */
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embeds a query and returns the top-K most similar index entries.
 *
 * @param {string}   queryText
 * @param {object[]} index      Array of { file, chunk, startLine, endLine, embedding }
 * @param {number}   topK
 * @returns {Promise<object[]>}
 */
export async function search(queryText, index, topK = 5) {
  const queryEmbedding = await embed(queryText);

  const scored = index.map((entry) => ({
    file: entry.file,
    chunk: entry.chunk,
    startLine: entry.startLine,
    endLine: entry.endLine,
    score: cosine(queryEmbedding, entry.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
