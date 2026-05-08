import { jest } from '@jest/globals';
import { buildIndex, loadIndex, saveIndex, indexExists, buildIndexFromFileList } from '../src/indexer.js';
import { readFile as fsReadFile, writeFile, unlink, access } from 'fs/promises';
import { scanDir, readFile as readSourceFile } from '../src/fs-utils.js';
import { chunkFile } from '../src/chunker.js';
import { embed, embedBatch } from '../src/embedder.js';

// Mock dependencies
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
  access: jest.fn(),
}));
jest.mock('../src/fs-utils.js', () => ({
  scanDir: jest.fn(),
  readFile: jest.fn(),
}));
jest.mock('../src/chunker.js', () => ({
  chunkFile: jest.fn(),
}));
jest.mock('../src/embedder.js', () => ({
  embed: jest.fn(),
  embedBatch: jest.fn(),
}));
jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('indexer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildIndex', () => {
    it('should build index from directory', async () => {
      scanDir.mockResolvedValue(['file1.js']);
      readSourceFile.mockResolvedValue('content');
      chunkFile.mockReturnValue([
        { file: 'file1.js', chunk: 'chunk1', startLine: 1, endLine: 10 },
        { file: 'file1.js', chunk: 'chunk2', startLine: 11, endLine: 20 },
      ]);
      embedBatch.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);
      unlink.mockResolvedValue();

      const result = await buildIndex('/test');
      expect(result).toEqual([
        { file: 'file1.js', chunk: 'chunk1', startLine: 1, endLine: 10, embedding: [0.1, 0.2] },
        { file: 'file1.js', chunk: 'chunk2', startLine: 11, endLine: 20, embedding: [0.3, 0.4] },
      ]);
      expect(scanDir).toHaveBeenCalledWith('/test');
      expect(embedBatch).toHaveBeenCalledTimes(1);
      expect(embedBatch).toHaveBeenCalledWith(['chunk1', 'chunk2']);
    });

    it('should handle empty directory', async () => {
      scanDir.mockResolvedValue([]);
      const result = await buildIndex('/test');
      expect(result).toEqual([]);
    });

    it('should skip files that fail to read or embed', async () => {
      scanDir.mockResolvedValue(['file1.js']);
      readSourceFile.mockRejectedValue(new Error('read error'));
      unlink.mockResolvedValue();

      const result = await buildIndex('/test');
      expect(result).toEqual([]);
    });
  });

  describe('loadIndex', () => {
    it('should load index from file', async () => {
      const indexData = [{ file: 'test.js', chunk: 'chunk', embedding: [0.1] }];
      fsReadFile.mockResolvedValue(JSON.stringify(indexData));

      const result = await loadIndex();
      expect(result).toEqual(indexData);
      expect(fsReadFile).toHaveBeenCalledWith('.ai-index.json', 'utf-8');
    });

    it('should throw error if file not found', async () => {
      fsReadFile.mockRejectedValue(new Error('not found'));
      await expect(loadIndex()).rejects.toThrow('Index file ".ai-index.json" not found');
    });
  });

  describe('saveIndex', () => {
    it('should save index to file', async () => {
      const index = [{ file: 'test.js' }];
      await saveIndex(index);
      expect(writeFile).toHaveBeenCalledWith('.ai-index.json', JSON.stringify(index), 'utf-8');
    });
  });

  describe('indexExists', () => {
    it('should return true if index exists', async () => {
      access.mockResolvedValue();
      const result = await indexExists();
      expect(result).toBe(true);
    });

    it('should return false if index does not exist', async () => {
      access.mockRejectedValue(new Error('not found'));
      const result = await indexExists();
      expect(result).toBe(false);
    });
  });

  describe('buildIndexFromFileList', () => {
    it('should build index from file list', async () => {
      const files = ['file1.js'];
      readSourceFile.mockResolvedValue('content');
      chunkFile.mockReturnValue([{ file: 'file1.js', chunk: 'chunk', startLine: 1, endLine: 10 }]);
      embedBatch.mockResolvedValue([[0.1]]);

      const result = await buildIndexFromFileList(files);
      expect(result).toEqual([{ file: 'file1.js', chunk: 'chunk', startLine: 1, endLine: 10, embedding: [0.1] }]);
    });

    it('should return empty array for empty list', async () => {
      const result = await buildIndexFromFileList([]);
      expect(result).toEqual([]);
    });
  });
});