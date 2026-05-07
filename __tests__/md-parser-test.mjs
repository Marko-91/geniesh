import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { formatMarkdown, processToken, flush } from '../src/md-parser.js';

// ─── formatMarkdown ───────────────────────────────────────────────────────────

describe('formatMarkdown', () => {
  test('formats **bold** text', () => {
    expect(formatMarkdown('This is **bold** text')).toBe('This is \x1b[1mbold\x1b[0m text');
  });

  test('leaves plain text unchanged', () => {
    expect(formatMarkdown('no formatting here')).toBe('no formatting here');
  });

  test('formats h1 header', () => {
    expect(formatMarkdown('# Title')).toBe('\x1b[1m\x1b[37mTitle\x1b[0m');
  });

  test('formats h2 header', () => {
    expect(formatMarkdown('## Subtitle')).toBe('\x1b[1m\x1b[36mSubtitle\x1b[0m');
  });

  test('formats h3 header', () => {
    expect(formatMarkdown('### Section')).toBe('\x1b[1m\x1b[35mSection\x1b[0m');
  });

  test('formats inline `code`', () => {
    expect(formatMarkdown('Use `npm install`')).toBe('Use \x1b[32mnpm install\x1b[0m');
  });

  test('formats a fenced code block with language tag', () => {
    const input = '```js\nconsole.log("hi");\n```';
    const result = formatMarkdown(input);
    expect(result).toContain('[js]');
    expect(result).toContain('console.log');
    expect(result).toContain('\x1b[44m');
  });

  test('formats a fenced code block without language tag', () => {
    const input = '```\nconst x = 1;\n```';
    const result = formatMarkdown(input);
    expect(result).toContain('const x = 1');
    expect(result).toContain('\x1b[0m');
  });

  test('formats bold and inline code in the same string', () => {
    const result = formatMarkdown('Run **npm** and use `node`');
    expect(result).toContain('\x1b[1m');
    expect(result).toContain('\x1b[32m');
  });
});

// ─── processToken / flush ─────────────────────────────────────────────────────

describe('processToken', () => {
  let writeCalls;
  let cb;

  beforeEach(() => {
    writeCalls = [];
    cb = (s) => writeCalls.push(s);
    // drain any leftover state from a previous test
    flush(cb);
    writeCalls = [];
  });

  afterEach(() => {
    flush(cb);
  });

  test('passes plain text straight through to callback', () => {
    processToken('hello world', cb);
    flush(cb);
    expect(writeCalls.join('')).toBe('hello world');
  });

  test('applies bold formatting when ** delimiters are complete', () => {
    processToken('Say **bold** now', cb);
    flush(cb);
    const output = writeCalls.join('');
    expect(output).toContain('\x1b[1m');
    expect(output).toContain('bold');
    expect(output).toContain('\x1b[0m');
  });

  test('buffers text while bold tag is still open — no ANSI emitted yet', () => {
    processToken('Start **incomplete', cb);
    // closing ** not seen yet — bold ANSI must not have been emitted
    const before = writeCalls.join('');
    expect(before).not.toContain('\x1b[1m');
  });

  test('flush outputs whatever remains in the buffer', () => {
    processToken('leftover text', cb);
    flush(cb);
    expect(writeCalls.join('')).toContain('leftover text');
  });

  test('flush on empty buffer does not crash', () => {
    expect(() => flush(cb)).not.toThrow();
  });
});
