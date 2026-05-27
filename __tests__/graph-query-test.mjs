import { jest } from '@jest/globals';

jest.mock('../packages/kernel/src/parsers/index.js', () => ({
  parseFile: jest.fn(async () => ({ symbols: [], references: [], imports: [] })),
  ensureTSParsers: jest.fn(async () => {}),
  SOURCE_EXTS: new Set(['.js', '.ts']),
}));

jest.mock('../packages/kernel/src/fs-utils.js', () => ({
  readFile: jest.fn(async () => ''),
}));

jest.mock('../packages/kernel/src/community.js', () => ({
  detectCommunities: jest.fn(() => 0),
}));

jest.mock('../packages/kernel/src/chunker.js', () => ({
  chunkFile: jest.fn(() => []),
}));

import { CodeGraph } from '../packages/kernel/src/graph-engine.js';

describe('graph-query', () => {
  let graph;

  beforeEach(() => {
    graph = new CodeGraph();
    graph.addFileNode('/root/a.js');
    graph.addFileNode('/root/b.js');
    graph.addFileNode('/root/c.js');
    graph.addSymbolNode('foo', '/root/a.js', 'function', [1, 5], true);
    graph.addSymbolNode('bar', '/root/a.js', 'function', [7, 10], true);
    graph.addSymbolNode('helper', '/root/b.js', 'function', [1, 3], true);
    graph.addSymbolNode('helper', '/root/c.js', 'function', [10, 20], true);

    graph.addEdge('sym:///root/a.js:foo', 'sym:///root/a.js:bar', 'calls', [2]);
    graph.addEdge('sym:///root/a.js:bar', 'sym:///root/b.js:helper', 'calls', [8]);
    graph.addEdge('file:///root/a.js', 'file:///root/b.js', 'imports');
    graph.addEdge('file:///root/a.js', 'sym:///root/a.js:foo', 'contains', [1, 5]);
    graph.addEdge('file:///root/b.js', 'sym:///root/b.js:helper', 'contains', [1, 3]);
    graph.addEdge('file:///root/c.js', 'sym:///root/c.js:helper', 'contains', [10, 20]);
    graph.communityCount = 2;
  });

  describe('queryCallers', () => {
    it('should find callers', async () => {
      const { queryCallers } = await import('../packages/kernel/src/graph-query.js');
      const results = queryCallers(graph, 'bar');
      expect(results.length).toBe(1);
      expect(results[0].callerNode.name).toBe('foo');
    });

    it('should return empty for uncalled symbols', async () => {
      const { queryCallers } = await import('../packages/kernel/src/graph-query.js');
      const results = queryCallers(graph, 'baz');
      expect(results.length).toBe(0);
    });
  });

  describe('queryCallees', () => {
    it('should find callees', async () => {
      const { queryCallees } = await import('../packages/kernel/src/graph-query.js');
      const results = queryCallees(graph, 'foo');
      expect(results.length).toBe(1);
      expect(results[0].targetNode.name).toBe('bar');
    });
  });

  describe('queryFileNeighbors', () => {
    it('should return imports, importers, and symbols', async () => {
      const { queryFileNeighbors } = await import('../packages/kernel/src/graph-query.js');
      const result = queryFileNeighbors(graph, '/root/a.js');
      expect(result.imports.length).toBe(1);
      expect(result.imports[0].file).toBe('/root/b.js');
      expect(result.symbols.length).toBe(2);
    });
  });

  describe('rankSymbols', () => {
    it('should rank symbols by query relevance', async () => {
      const { rankSymbols } = await import('../packages/kernel/src/graph-query.js');
      const symbols = graph.getFileSymbols('/root/a.js');
      const ranked = rankSymbols(graph, symbols, ['foo'], new Set());
      expect(ranked.length).toBe(2);
      expect(ranked[0].node.name).toBe('foo');
    });
  });

  describe('scoreSymbol', () => {
    it('should give high score for exact match', async () => {
      const { scoreSymbol } = await import('../packages/kernel/src/graph-query.js');
      const score = scoreSymbol(graph, 'foo', ['foo']);
      expect(score).toBeGreaterThan(0);
    });

    it('should give zero for no match', async () => {
      const { scoreSymbol } = await import('../packages/kernel/src/graph-query.js');
      const score = scoreSymbol(graph, 'foo', ['nonexistent']);
      expect(score).toBe(0);
    });
  });

  describe('formSymbolGroups', () => {
    it('should form groups from frontier symbols', async () => {
      const { formSymbolGroups } = await import('../packages/kernel/src/graph-query.js');
      const frontier = [{ name: 'foo' }];
      const groups = formSymbolGroups(graph, frontier, ['/root/a.js']);
      expect(groups.length).toBeGreaterThan(0);
      expect(groups[0].sym).toBe('foo');
    });
  });
});
