import { jest } from '@jest/globals';
import { grepFiles, formatGrepResults, buildGrepContext, escapeRegex, countBraces, findScopeHeader, findScopeEnd, getScopeWindow } from '../src/grep.js';
import { readFile } from '../src/fs-utils.js';

// Mock fs-utils
jest.mock('../src/fs-utils.js', () => ({
  readFile: jest.fn(),
}));

describe('grep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('grepFiles', () => {
    it('should return empty array for no matches', async () => {
      readFile.mockResolvedValue('no match here');
      const result = await grepFiles('test', ['file.js'], 2);
      expect(result).toEqual([]);
    });

    it('should find matches and create windows', async () => {
      const content = `function test() {
  console.log('test');
  return test;
}`;
      readFile.mockResolvedValue(content);
      const result = await grepFiles('test', ['file.js'], 2);
      expect(result.length).toBe(1);
      expect(result[0].file).toBe('file.js');
      expect(result[0].windows.length).toBe(1);
      expect(result[0].windows[0].startLine).toBe(1);
      expect(result[0].windows[0].endLine).toBe(4);
      expect(result[0].windows[0].metadata.symbol).toBe('test');
    });

    it('should skip pure reference lines', async () => {
      const content = `test`;
      readFile.mockResolvedValue(content);
      const result = await grepFiles('test', ['file.js'], 2);
      expect(result).toEqual([]);
    });
  });

  describe('formatGrepResults', () => {
    it('should format results', () => {
      const results = [
        {
          file: 'test.js',
          windows: [
            {
              startLine: 1,
              endLine: 3,
              matchLines: [2],
              text: 'line1\nline2\nline3',
            },
          ],
        },
      ];
      const output = formatGrepResults(results, 'test');
      expect(output).toContain('Found 1 occurrence');
      expect(output).toContain('test.js');
      expect(output).toContain('→');
    });

    it('should handle no results', () => {
      const output = formatGrepResults([], 'test');
      expect(output).toBe('No matches found for "test".');
    });
  });

  describe('buildGrepContext', () => {
    it('should build context string', () => {
      const results = [
        {
          file: 'test.js',
          windows: [
            {
              startLine: 1,
              endLine: 2,
              matchLines: [1],
              text: 'function test() {',
            },
          ],
        },
      ];
      const context = buildGrepContext(results);
      expect(context).toContain('// File: test.js');
      expect(context).toContain('function test() {');
    });

    it('should cap at max windows', () => {
      const results = Array(20).fill({
        file: 'test.js',
        windows: [
          {
            startLine: 1,
            endLine: 2,
            matchLines: [1],
            text: 'line',
          },
        ],
      });
      const context = buildGrepContext(results);
      const blocks = context.split('\n\n');
      expect(blocks.length).toBeLessThanOrEqual(16); // MAX_WINDOWS + some
    });
  });
});