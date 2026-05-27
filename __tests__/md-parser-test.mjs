import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { formatMarkdown, processToken, flush } from '../src/md-parser.js';

describe('formatMarkdown', () => {
  test('returns text as-is (no formatting)', () => {
    expect(formatMarkdown('**bold** text')).toBe('**bold** text');
  });

  test('leaves plain text unchanged', () => {
    expect(formatMarkdown('no formatting here')).toBe('no formatting here');
  });
});

describe('processToken', () => {
  let writeCalls;
  let cb;

  beforeEach(() => {
    writeCalls = [];
    cb = (s) => writeCalls.push(s);
    flush(cb);
    writeCalls = [];
  });

  afterEach(() => {
    flush(cb);
  });

  function written() {
    return writeCalls.join('');
  }

  test('passes text straight through to callback', () => {
    processToken('hello world', cb);
    flush(cb);
    expect(written()).toBe('hello world');
  });

  test('passes text with markdown characters as-is', () => {
    processToken('Say **bold** now', cb);
    flush(cb);
    expect(written()).toBe('Say **bold** now');
  });

  test('flush does not crash on empty buffer', () => {
    expect(() => flush(cb)).not.toThrow();
  });
});
