import { jest } from '@jest/globals';
import { scanDir, readFile } from '../src/fs-utils.js';
import { readdir, readFile as fsReadFile } from 'fs/promises';
import { join } from 'path';

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readdir: jest.fn(),
  readFile: jest.fn(),
}));

describe('fs-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('scanDir', () => {
    it('should return an empty array for empty directory', async () => {
      readdir.mockResolvedValue([]);
      const result = await scanDir('/test');
      expect(result).toEqual([]);
      expect(readdir).toHaveBeenCalledWith('/test', { withFileTypes: true });
    });

    it('should collect supported files and ignore unsupported ones', async () => {
      const mockEntries = [
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
        { name: 'file.png', isDirectory: () => false, isFile: () => true },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: 'subdir', isDirectory: () => true, isFile: () => false },
      ];
      readdir.mockImplementation((path) => {
        if (path === '/test') return Promise.resolve(mockEntries);
        if (path === join('/test', 'subdir')) return Promise.resolve([
          { name: 'nested.js', isDirectory: () => false, isFile: () => true },
        ]);
        return Promise.resolve([]);
      });

      const result = await scanDir('/test');
      expect(result).toEqual(['\\test\\file.js', '\\test\\subdir\\nested.js']);
    });

    it('should ignore directories in IGNORED_DIRS', async () => {
      const mockEntries = [
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
      ];
      readdir.mockResolvedValue(mockEntries);
      const result = await scanDir('/test');
      expect(result).toEqual(['\\test\\file.js']);
    });

    it('should ignore files with unsupported extensions', async () => {
      const mockEntries = [
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
        { name: 'file.png', isDirectory: () => false, isFile: () => true },
        { name: 'file.min.js', isDirectory: () => false, isFile: () => true },
      ];
      readdir.mockResolvedValue(mockEntries);
      const result = await scanDir('/test');
      expect(result).toEqual(['\\test\\file.js']);
    });
  });

  describe('readFile', () => {
    it('should read file content as UTF-8', async () => {
      fsReadFile.mockResolvedValue('test content');
      const result = await readFile('/test/file.js');
      expect(result).toBe('test content');
      expect(fsReadFile).toHaveBeenCalledWith('/test/file.js', 'utf-8');
    });

    it('should throw if file read fails', async () => {
      fsReadFile.mockRejectedValue(new Error('File not found'));
      await expect(readFile('/test/file.js')).rejects.toThrow('File not found');
    });
  });
});