import { chunkFile } from '../src/chunker.js';

describe('chunker', () => {
  describe('chunkFile', () => {
    it('should return empty array for empty content', () => {
      const result = chunkFile('test.js', '');
      expect(result).toEqual([]);
    });

    it('should return empty array for content with only whitespace', () => {
      const result = chunkFile('test.js', '   \n\t\n  ');
      expect(result).toEqual([]);
    });

    it('should create one chunk for small content', () => {
      const content = 'line1\nline2\nline3';
      const result = chunkFile('test.js', content);
      expect(result).toEqual([
        {
          file: 'test.js',
          chunk: 'line1\nline2\nline3',
          startLine: 1,
          endLine: 3,
        },
      ]);
    });

    it('should create multiple chunks with overlap', () => {
      const lines = [];
      for (let i = 1; i <= 120; i++) {
        lines.push(`line${i}`);
      }
      const content = lines.join('\n');
      const result = chunkFile('test.js', content);

      expect(result.length).toBe(2);
      expect(result[0]).toEqual({
        file: 'test.js',
        chunk: lines.slice(0, 100).join('\n'),
        startLine: 1,
        endLine: 100,
      });
      expect(result[1]).toEqual({
        file: 'test.js',
        chunk: lines.slice(50, 120).join('\n'),
        startLine: 51,
        endLine: 120,
      });
    });

    it('should handle exact chunk size', () => {
      const lines = [];
      for (let i = 1; i <= 100; i++) {
        lines.push(`line${i}`);
      }
      const content = lines.join('\n');
      const result = chunkFile('test.js', content);

      expect(result.length).toBe(1);
      expect(result[0]).toEqual({
        file: 'test.js',
        chunk: content,
        startLine: 1,
        endLine: 100,
      });
    });
  });
});