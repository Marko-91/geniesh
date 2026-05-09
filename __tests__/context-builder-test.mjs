import { jest } from '@jest/globals';
import { buildChatContext, applySlideWindow } from '../src/context-builder.js';
import { search } from '../src/search.js';

// Mock dependencies (kernel paths — context-builder lives in packages/kernel)
jest.mock('../src/search.js', () => ({
  search: jest.fn(),
}));
jest.mock('../packages/kernel/src/grep.js', () => ({
  grepFiles: jest.fn(),
}));

import { grepFiles } from '../packages/kernel/src/grep.js';

describe('context-builder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildChatContext', () => {
    it('should build context with RAG', async () => {
      search.mockResolvedValue([
        { file: 'a.js', score: 0.9, startLine: 1, endLine: 10, chunk: 'code' },
      ]);
      grepFiles.mockResolvedValue([]);

      const result = await buildChatContext('query', [{ file: 'a.js', embedding: [1] }], ['a.js'], null, [], search);
      expect(result.contextString).toContain('code');
    });
  });

  describe('applySlideWindow', () => {
    it('should maintain sliding window', () => {
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: 'u4' },
        { role: 'assistant', content: 'a4' },
        { role: 'user', content: 'u5' },
        { role: 'assistant', content: 'a5' },
        { role: 'user', content: 'u6' },
        { role: 'assistant', content: 'a6' },
        { role: 'user', content: 'u7' },
        { role: 'assistant', content: 'a7' },
        { role: 'user', content: 'u8' },
        { role: 'assistant', content: 'a8' },
        { role: 'user', content: 'u9' },
        { role: 'assistant', content: 'a9' },
      ];
      applySlideWindow(messages);
      expect(messages.length).toBe(17); // system + 8 pairs
    });
  });
});