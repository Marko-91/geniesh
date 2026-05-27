import { jest } from '@jest/globals';
import { scanDir, readFile, parseIgnoreFile, loadIgnoreFile } from '../src/fs-utils.js';
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

  describe('parseIgnoreFile', () => {
    it('should parse simple patterns', () => {
      const patterns = parseIgnoreFile('dist\n.env\ntmp/');
      expect(patterns.length).toBe(3);
      expect(patterns[0].pattern).toBe('dist');
      expect(patterns[0].negate).toBe(false);
      expect(patterns[1].pattern).toBe('.env');
      expect(patterns[2].pattern).toBe('tmp');
      expect(patterns[2].dirOnly).toBe(true);
    });

    it('should handle negated patterns', () => {
      const patterns = parseIgnoreFile('*\n!keep.js');
      expect(patterns.length).toBe(2);
      expect(patterns[0].negate).toBe(false);
      expect(patterns[1].negate).toBe(true);
      expect(patterns[1].pattern).toBe('keep.js');
    });

    it('should skip comments and empty lines', () => {
      const patterns = parseIgnoreFile('# comment\n\nbuild\n');
      expect(patterns.length).toBe(1);
      expect(patterns[0].pattern).toBe('build');
    });

    it('should handle anchored patterns', () => {
      const patterns = parseIgnoreFile('/only-root');
      expect(patterns.length).toBe(1);
      expect(patterns[0].anchored).toBe(true);
      expect(patterns[0].pattern).toBe('only-root');
    });
  });

  describe('scanDir with ignorePatterns', () => {
    it('should skip files matching ignore patterns', async () => {
      readdir.mockImplementation((path) => {
        if (path === '/test') return Promise.resolve([
          { name: 'app.js', isDirectory: () => false, isFile: () => true },
          { name: 'test.js', isDirectory: () => false, isFile: () => true },
        ]);
        return Promise.resolve([]);
      });

      const patterns = parseIgnoreFile('test.js');
      const result = await scanDir('/test', patterns);
      expect(result).toEqual(['\\test\\app.js']);
    });

    it('should skip dirs matching ignore patterns', async () => {
      readdir.mockImplementation((path) => {
        if (path === '/test') return Promise.resolve([
          { name: 'build', isDirectory: () => true, isFile: () => false },
          { name: 'app.js', isDirectory: () => false, isFile: () => true },
        ]);
        if (path === join('/test', 'build')) return Promise.resolve([
          { name: 'artifacts.js', isDirectory: () => false, isFile: () => true },
        ]);
        return Promise.resolve([]);
      });

      const patterns = parseIgnoreFile('build/');
      const result = await scanDir('/test', patterns);
      expect(result).toEqual(['\\test\\app.js']);
    });
  });

  describe('loadIgnoreFile', () => {
    it('should return empty array when file not found', async () => {
      fsReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await loadIgnoreFile('/test');
      expect(result).toEqual([]);
    });

    it('should return empty array when content is empty', async () => {
      fsReadFile.mockResolvedValue('');
      const result = await loadIgnoreFile('/test');
      expect(result).toEqual([]);
    });
  });
});