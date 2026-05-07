import { describe, test, expect } from '@jest/globals';
import { extractFunction } from '../src/extractor.js';
import { chunkFile } from '../src/chunker.js';
import { cosine } from '../src/search.js';
import { buildPrompt, buildDirectPrompt } from '../src/prompt.js';

// ─── extractFunction ─────────────────────────────────────────────────────────

describe('extractFunction', () => {
  test('extracts a function declaration', () => {
    const src = `function greet(name) {\n  return 'hello ' + name;\n}`;
    const result = extractFunction(src, 'greet');
    expect(result).toContain('function greet');
    expect(result).toContain("return 'hello '");
  });

  test('extracts a const arrow function', () => {
    const src = `const add = (a, b) => {\n  return a + b;\n};`;
    const result = extractFunction(src, 'add');
    expect(result).toContain('const add');
    expect(result).toContain('return a + b');
  });

  test('extracts an async function', () => {
    const src = `async function fetchData(url) {\n  const res = await fetch(url);\n  return res.json();\n}`;
    const result = extractFunction(src, 'fetchData');
    expect(result).toContain('async function fetchData');
    expect(result).toContain('await fetch');
  });

  test('extracts an exported function', () => {
    const src = `export function handler(req) {\n  return req.body;\n}`;
    const result = extractFunction(src, 'handler');
    expect(result).toContain('export function handler');
    expect(result).toContain('return req.body');
  });

  test('handles nested braces without closing early', () => {
    const src = `function outer() {\n  if (true) {\n    return { key: 'val' };\n  }\n}`;
    const result = extractFunction(src, 'outer');
    expect(result).toContain("key: 'val'");
    // braces must be balanced in the extracted slice
    const opens = (result.match(/{/g) || []).length;
    const closes = (result.match(/}/g) || []).length;
    expect(opens).toBe(closes);
  });

  test('returns null when function does not exist', () => {
    const src = `function other() { return 1; }`;
    expect(extractFunction(src, 'missing')).toBeNull();
  });

  test('returns null for empty source', () => {
    expect(extractFunction('', 'anything')).toBeNull();
  });
});

// ─── chunkFile ───────────────────────────────────────────────────────────────

describe('chunkFile', () => {
  test('small file produces a single chunk with correct metadata', () => {
    const content = Array(10).fill('const x = 1;').join('\n');
    const chunks = chunkFile('src/a.js', content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file).toBe('src/a.js');
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(10);
  });

  test('large file produces multiple chunks', () => {
    const content = Array(400).fill('const x = 1;').join('\n');
    const chunks = chunkFile('big.js', content);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('consecutive chunks overlap (startLine of chunk N+1 < endLine of chunk N)', () => {
    const content = Array(400).fill('const x = 1;').join('\n');
    const chunks = chunkFile('f.js', content);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThan(chunks[i - 1].endLine);
    }
  });

  test('empty file returns no chunks', () => {
    expect(chunkFile('e.js', '')).toHaveLength(0);
  });

  test('whitespace-only file returns no chunks', () => {
    expect(chunkFile('w.js', '   \n   \n')).toHaveLength(0);
  });

  test('each chunk contains the original source lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line_${i + 1}`);
    const [chunk] = chunkFile('t.js', lines.join('\n'));
    expect(chunk.chunk).toContain('line_1');
    expect(chunk.chunk).toContain('line_20');
  });
});

// ─── cosine ──────────────────────────────────────────────────────────────────

describe('cosine', () => {
  test('identical vectors score 1', () => {
    const v = [1, 2, 3, 4];
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  test('orthogonal vectors score 0', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  test('opposite vectors score -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test('zero vector returns 0 without throwing', () => {
    expect(() => cosine([0, 0], [1, 2])).not.toThrow();
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });

  test('score is symmetric', () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.1, 0.9, 0.4];
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a));
  });
});

// ─── buildPrompt ─────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const chunks = [
    { file: 'src/auth.ts', chunk: 'function login() {}', startLine: 1, endLine: 1 },
    { file: 'src/auth.ts', chunk: 'function logout() {}', startLine: 5, endLine: 5 },
  ];

  test('contains the user query', () => {
    expect(buildPrompt('find bugs', chunks)).toContain('find bugs');
  });

  test('contains the file path', () => {
    expect(buildPrompt('explain', chunks)).toContain('src/auth.ts');
  });

  test('contains the chunk source code', () => {
    const p = buildPrompt('explain', chunks);
    expect(p).toContain('function login()');
    expect(p).toContain('function logout()');
  });

  test('does not exceed a reasonable size for large chunks', () => {
    const big = { file: 'big.js', chunk: 'x'.repeat(9000), startLine: 1, endLine: 100 };
    const p = buildPrompt('q', [big]);
    expect(p.length).toBeLessThan(15000);
  });
});

// ─── buildDirectPrompt ───────────────────────────────────────────────────────

describe('buildDirectPrompt', () => {
  test('contains the query and code', () => {
    const p = buildDirectPrompt('find bugs', 'const x = null;', 'src/a.js');
    expect(p).toContain('find bugs');
    expect(p).toContain('const x = null;');
  });

  test('contains the label when provided', () => {
    const p = buildDirectPrompt('explain', 'return 1;', 'src/a.js → myFn()');
    expect(p).toContain('src/a.js → myFn()');
  });

  test('omits label comment when label is empty', () => {
    const p = buildDirectPrompt('q', 'code', '');
    expect(p).not.toContain('//');
  });

  test('truncates code exceeding the character limit', () => {
    const huge = 'y'.repeat(17000);
    const p = buildDirectPrompt('q', huge, '');
    expect(p).toContain('(truncated)');
  });

  test('does not truncate code within the limit', () => {
    const small = 'z'.repeat(100);
    const p = buildDirectPrompt('q', small, '');
    expect(p).not.toContain('(truncated)');
  });
});