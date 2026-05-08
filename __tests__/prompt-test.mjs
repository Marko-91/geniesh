import { buildPrompt, buildDirectPrompt } from '../src/prompt.js';

describe('prompt', () => {
  describe('buildPrompt', () => {
    it('should build prompt from chunks', () => {
      const chunks = [
        { file: 'a.js', chunk: 'code1', startLine: 1, endLine: 10 },
        { file: 'b.js', chunk: 'code2', startLine: 1, endLine: 5 },
      ];
      const query = 'What does this do?';
      const result = buildPrompt(query, chunks);
      expect(result).toContain('Files:\na.js, b.js');
      expect(result).toContain('// File: a.js (lines 1–10)');
      expect(result).toContain('code1');
      expect(result).toContain('Task:\nWhat does this do?');
    });

    it('should truncate context if over limit', () => {
      const longChunk = 'a'.repeat(9000);
      const chunks = [{ file: 'a.js', chunk: longChunk, startLine: 1, endLine: 10 }];
      const result = buildPrompt('query', chunks);
      expect(result.length).toBeLessThan(10000);
    });
  });

  describe('buildDirectPrompt', () => {
    it('should build direct prompt', () => {
      const code = 'function test() { return 1; }';
      const query = 'Explain this';
      const result = buildDirectPrompt(query, code, 'test.js');
      expect(result).toContain('// test.js');
      expect(result).toContain('function test() { return 1; }');
      expect(result).toContain('Task:\nExplain this');
    });

    it('should truncate code if over limit', () => {
      const longCode = 'a'.repeat(9000);
      const result = buildDirectPrompt('query', longCode);
      expect(result).toContain('... (truncated)');
    });

    it('should handle no label', () => {
      const result = buildDirectPrompt('query', 'code');
      expect(result).not.toContain('//');
    });
  });
});