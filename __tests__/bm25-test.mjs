import { jest } from '@jest/globals';

describe('BM25', () => {
  let bm25;

  beforeAll(async () => {
    bm25 = await import('../src/bm25.js');
  });

  describe('tokenize', () => {
    it('splits code into lowercase tokens', () => {
      const { tokens, termCounts, length } = bm25.tokenize('Router::dispatch($request)');
      expect(tokens).toContain('router');
      expect(tokens).toContain('dispatch');
      expect(tokens).toContain('request');
      expect(length).toBe(3);
    });

    it('filters out English noise words', () => {
      const { tokens, length } = bm25.tokenize('this is the handler for that');
      expect(tokens).not.toContain('this');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('for');
      expect(tokens).toContain('handler');
    });

    it('filters short tokens (<3 chars)', () => {
      const { tokens } = bm25.tokenize('a bc def ghij');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('bc');
      expect(tokens).toContain('def');
      expect(tokens).toContain('ghij');
    });

    it('handles empty content', () => {
      const result = bm25.tokenize('');
      expect(result.length).toBe(0);
      expect(result.tokens).toEqual([]);
    });

    it('counts term frequency correctly', () => {
      const { termCounts, length } = bm25.tokenize('router router dispatch router');
      expect(termCounts.get('router')).toBe(3);
      expect(termCounts.get('dispatch')).toBe(1);
      expect(length).toBe(4);
    });
  });

  describe('computeBM25', () => {
    it('returns empty for empty file list', () => {
      const result = bm25.computeBM25(['router'], []);
      expect(result).toEqual([]);
    });

    it('scores relevant files higher', () => {
      const files = [
        { path: '/router.php', content: 'class Router { function dispatch() { return new Response(); } }' },
        { path: '/kernel.php', content: 'class Kernel { function handle() { return response; } }' },
      ];
      const result = bm25.computeBM25(['router', 'dispatch'], files);
      expect(result[0].file).toBe('/router.php');
      expect(result[0].bm25Score).toBeGreaterThan(0);
      expect(result[1].bm25Score).toBeGreaterThanOrEqual(0);
    });

    it('returns zero scores when no terms match', () => {
      const files = [
        { path: '/a.php', content: 'class Foo {}' },
        { path: '/b.php', content: 'class Bar {}' },
      ];
      const result = bm25.computeBM25(['router', 'dispatch'], files);
      expect(result.every(r => r.bm25Score === 0)).toBe(true);
    });

    it('file with more matches scores higher', () => {
      const files = [
        { path: '/low.php', content: 'class Dispatcher {}' },
        { path: '/high.php', content: 'class Router { function dispatch() { Router::dispatch(); } }' },
      ];
      const result = bm25.computeBM25(['router', 'dispatch'], files);
      const highFile = result.find(r => r.file === '/high.php');
      const lowFile = result.find(r => r.file === '/low.php');
      expect(highFile.bm25Score).toBeGreaterThan(lowFile.bm25Score);
    });

    it('includes topTerms in result', () => {
      const files = [
        { path: '/router.php', content: 'Router router route routing route' },
      ];
      const result = bm25.computeBM25(['router'], files);
      expect(result[0].topTerms.length).toBeGreaterThan(0);
      expect(result[0].topTerms[0].term).toBe('router');
      expect(result[0].topTerms[0].count).toBeGreaterThan(0);
    });

    it('handles single-file case without crashing', () => {
      const files = [
        { path: '/a.php', content: 'class Router { function dispatch() {} }' },
      ];
      const result = bm25.computeBM25(['router', 'dispatch'], files);
      expect(result.length).toBe(1);
      expect(result[0].bm25Score).toBeGreaterThan(0);
    });

    it('handles files with empty content', () => {
      const files = [
        { path: '/empty.php', content: '' },
        { path: '/router.php', content: 'class Router {}' },
      ];
      const result = bm25.computeBM25(['router'], files);
      expect(result.length).toBe(2);
      expect(result.find(r => r.file === '/router.php').bm25Score).toBeGreaterThan(0);
      expect(result.find(r => r.file === '/empty.php').bm25Score).toBe(0);
    });
  });
});
