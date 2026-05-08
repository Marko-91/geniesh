import { jest } from '@jest/globals';
import { embed, embedBatch } from '../src/embedder.js';

// Mock fetch
global.fetch = jest.fn();

describe('embedder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('embedBatch', () => {
    it('should embed multiple texts in one call', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
      });

      const result = await embedBatch(['text a', 'text b']);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['text a', 'text b'] }),
      });
    });
  });

  describe('embed', () => {
    it('should return embedding for valid response', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embeddings: [mockEmbedding] }),
      });

      const result = await embed('test text');
      expect(result).toEqual(mockEmbedding);
      expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['test text'] }),
      });
    });

    it('should truncate text if over limit', async () => {
      const longText = 'a'.repeat(7000);
      const truncated = longText.slice(0, 6000);
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[0.1]] }),
      });

      await embed(longText);
      expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: [truncated] }),
      });
    });

    it('should throw error on fetch failure', async () => {
      fetch.mockRejectedValue(new Error('Network error'));
      await expect(embed('test')).rejects.toThrow('Cannot connect to Ollama at http://localhost:11434. Is Ollama running?\n  Network error');
    });

    it('should throw error on non-ok response', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });
      await expect(embed('test')).rejects.toThrow('Ollama embed error 500: Server error');
    });

    it('should throw error on empty embeddings', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embeddings: [] }),
      });
      await expect(embed('test')).rejects.toThrow('Ollama returned empty embedding response');
    });
  });
});