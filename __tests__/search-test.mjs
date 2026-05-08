import { jest } from '@jest/globals';
import { cosine, search } from '../src/search.js';
import { embed } from '../src/embedder.js';

// Mock embedder
jest.mock('../src/embedder.js', () => ({
  embed: jest.fn(),
}));

describe('search', () => {
  describe('cosine', () => {
    it('should calculate cosine similarity', () => {
      expect(cosine([1, 0], [1, 0])).toBe(1);
      expect(cosine([1, 0], [0, 1])).toBe(0);
      expect(cosine([1, 0], [-1, 0])).toBe(-1);
    });

    it('should handle zero vectors', () => {
      expect(cosine([0, 0], [1, 1])).toBe(0);
    });
  });

  describe('search', () => {
    it('should return top K similar entries', async () => {
      embed.mockResolvedValue([1, 0]);
      const index = [
        { file: 'a.js', chunk: 'chunk1', startLine: 1, endLine: 10, embedding: [1, 0] }, // score 1
        { file: 'b.js', chunk: 'chunk2', startLine: 1, endLine: 10, embedding: [0, 1] }, // score 0
        { file: 'c.js', chunk: 'chunk3', startLine: 1, endLine: 10, embedding: [0.5, 0.5] }, // score 0.5
      ];

      const result = await search('query', index, 2);
      expect(result).toEqual([
        { file: 'a.js', chunk: 'chunk1', startLine: 1, endLine: 10, score: 1 },
        { file: 'c.js', chunk: 'chunk3', startLine: 1, endLine: 10, score: 0.7071067811865475 },
      ]);
    });

    it('should handle empty index', async () => {
      embed.mockResolvedValue([1, 0]);
      const result = await search('query', [], 5);
      expect(result).toEqual([]);
    });

    it('should limit to top K', async () => {
      embed.mockResolvedValue([1, 0]);
      const index = Array(10).fill().map((_, i) => ({
        file: `f${i}.js`,
        chunk: `chunk${i}`,
        startLine: 1,
        endLine: 10,
        embedding: [1 - i * 0.1, i * 0.1],
      }));

      const result = await search('query', index, 3);
      expect(result.length).toBe(3);
      expect(result[0].score).toBeGreaterThan(result[1].score);
    });
  });
});