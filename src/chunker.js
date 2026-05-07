const CHUNK_SIZE = 150; // lines per chunk
const OVERLAP = 50;    // lines of overlap between chunks

/** 
 * Splits a file's content into overlapping line-based chunks.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ file: string, chunk: string, startLine: number, endLine: number }[]}
 */
export function chunkFile(filePath, content) {
  const lines = content.split('\n');
  const chunks = [];

  if (lines.length === 0) return chunks;

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    const chunk = lines.slice(start, end).join('\n');

    if (chunk.trim().length > 0) {
      chunks.push({
        file: filePath,
        chunk,
        startLine: start + 1,
        endLine: end,
      });
    }

    if (end === lines.length) break;
    start = end - OVERLAP;
  }

  return chunks;
}
