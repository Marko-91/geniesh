const CHUNK_SIZE = 100;
const OVERLAP = 50;

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
