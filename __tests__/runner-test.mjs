import { jest } from '@jest/globals';
import { setModel, getModel, runQuery, runChat } from '../src/runner.js';
import { formatMarkdown } from '../src/md-parser.js';
import { spinners } from '../src/spinners-ora.js';

// Mock dependencies
jest.mock('../src/md-parser.js', () => ({
  formatMarkdown: jest.fn((text) => text),
}));
jest.mock('../src/spinners-ora.js', () => ({
  spinners: ['dots'],
}));
jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn(),
    fail: jest.fn(),
  })),
}));

// Mock fetch and Response
global.fetch = jest.fn();
const mockReader = {
  read: jest.fn(),
};
const mockResponse = {
  ok: true,
  body: { getReader: () => mockReader },
  text: jest.fn(),
};

describe('runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setModel('test-model'); // reset
  });

  describe('setModel and getModel', () => {
    it('should set and get model', () => {
      setModel('new-model');
      expect(getModel()).toBe('new-model');
    });
  });

  describe('runQuery', () => {
    it('should handle successful response', async () => {
      fetch.mockResolvedValue(mockResponse);
      mockReader.read
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"response": "hello"}\n') })
        .mockResolvedValueOnce({ done: true });

      const consoleSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
      await runQuery('test prompt');
      expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/generate', expect.any(Object));
      expect(consoleSpy).toHaveBeenCalledWith('h');
      consoleSpy.mockRestore();
    });

    it('should throw on fetch error', async () => {
      fetch.mockRejectedValue(new Error('network'));
      await expect(runQuery('test')).rejects.toThrow('Cannot connect to Ollama');
    });

    it('should throw on bad response', async () => {
      fetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') });
      await expect(runQuery('test')).rejects.toThrow('Ollama generate error 500');
    });
  });

  describe('runChat', () => {
    it('should return full response', async () => {
      fetch.mockResolvedValue(mockResponse);
      mockReader.read
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"message": {"content": "hi"}}\n') })
        .mockResolvedValueOnce({ done: true });

      const consoleSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
      const result = await runChat([{ role: 'user', content: 'test' }]);
      expect(result).toBe('hi');
      consoleSpy.mockRestore();
    });
  });
});