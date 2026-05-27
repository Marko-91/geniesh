import { jest } from '@jest/globals';
import { CodeGraph } from '../packages/kernel/src/graph-engine.js';

jest.mock('fs/promises', () => ({
  stat: jest.fn(async () => ({ mtimeMs: 123456, size: 789 })),
}));

jest.mock('../packages/kernel/src/fs-utils.js', () => ({
  readFile: jest.fn(async (fp) => {
    if (fp.endsWith('a.js')) return 'function foo() { return bar(); }\nfunction bar() { return 1; }';
    if (fp.endsWith('b.js')) return 'import { foo } from "./a.js";\nfoo();';
    if (fp.endsWith('c.js')) return 'import { foo as myAlias } from "./a.js";\nmyAlias();';
    return '';
  }),
}));

jest.mock('../packages/kernel/src/parsers/index.js', () => {
  const aResult = {
    symbols: [
      { name: 'foo', kind: 'function', lineRange: [1, 1], exported: true },
      { name: 'bar', kind: 'function', lineRange: [2, 2], exported: true },
    ],
    references: [
      { name: 'bar', kind: 'call', lineRange: [1, 1] },
    ],
    imports: [],
  };
  const bResult = {
    symbols: [
      { name: 'baz', kind: 'function', lineRange: [2, 2], exported: true },
    ],
    references: [],
    imports: [{ module: './a.js', type: 'import' }],
  };
  const cResult = {
    symbols: [],
    references: [{ name: 'myAlias', kind: 'call', lineRange: [2, 2] }],
    imports: [{ module: './a.js', type: 'import' }],
  };
  return {
    parseFile: jest.fn(async (content, filePath) => {
      if (filePath.endsWith('a.js')) return aResult;
      if (filePath.endsWith('b.js')) return bResult;
      if (filePath.endsWith('c.js')) return cResult;
      return { symbols: [], references: [], imports: [] };
    }),
    ensureTSParsers: jest.fn(async () => {}),
    SOURCE_EXTS: new Set(['.js', '.ts', '.py', '.go', '.rs']),
  };
});

jest.mock('../packages/kernel/src/community.js', () => ({
  detectCommunities: jest.fn(() => 3),
}));

jest.mock('../packages/kernel/src/chunker.js', () => ({
  chunkFile: jest.fn(() => []),
}));

describe('CodeGraph', () => {
  let graph;

  beforeEach(() => {
    graph = new CodeGraph();
    graph.addFileNode('/root/a.js');
    graph.addFileNode('/root/b.js');
    graph.addSymbolNode('foo', '/root/a.js', 'function', [1, 5], true);
    graph.addSymbolNode('bar', '/root/a.js', 'function', [7, 10], true);
    graph.addSymbolNode('baz', '/root/b.js', 'function', [3, 8], true);
    graph.addEdge('sym:///root/a.js:foo', 'sym:///root/a.js:bar', 'calls', [1]);
    graph.addEdge('file:///root/a.js', 'sym:///root/a.js:foo', 'contains', [1, 5]);
    graph.addEdge('file:///root/b.js', 'sym:///root/b.js:baz', 'contains', [3, 8]);
  });

  describe('addNode / addEdge', () => {
    it('should add nodes and edges', () => {
      expect(graph.nodes.size).toBe(5);
      expect(graph.edges.length).toBe(3);
    });

    it('should not duplicate nodes', () => {
      graph.addSymbolNode('foo', '/root/a.js', 'function', [1, 5], true);
      expect(graph.nodes.size).toBe(5);
    });
  });

  describe('getNeighbors', () => {
    it('should return direct neighbors at depth 1', () => {
      const fooId = 'sym:///root/a.js:foo';
      const neighbors = graph.getNeighbors(fooId, 1);
      const neighborIds = neighbors.map(n => n.node.id);
      expect(neighborIds).toContain('sym:///root/a.js:bar');
      expect(neighborIds).toContain('file:///root/a.js');
    });
  });

  describe('getCallers / getCallees', () => {
    it('should find callers of a symbol', () => {
      const callers = graph.getCallers('sym:///root/a.js:bar');
      expect(callers.length).toBe(1);
      expect(callers[0].node.name).toBe('foo');
    });

    it('should find callees of a symbol', () => {
      const callees = graph.getCallees('sym:///root/a.js:foo');
      expect(callees.length).toBe(1);
      expect(callees[0].node.name).toBe('bar');
    });
  });

  describe('getSymbol / getFileSymbols', () => {
    it('should find symbols by name', () => {
      const results = graph.getSymbol('foo');
      expect(results.length).toBe(1);
      expect(results[0].file).toBe('/root/a.js');
    });

    it('should find symbols in a file', () => {
      const results = graph.getFileSymbols('/root/a.js');
      expect(results.length).toBe(2);
      expect(results.map(r => r.name).sort()).toEqual(['bar', 'foo']);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('should serialize and deserialize', () => {
      const json = graph.toJSON();
      const restored = CodeGraph.fromJSON(json);
      expect(restored.nodes.size).toBe(5);
      expect(restored.edges.length).toBe(3);
      expect(restored.getSymbol('foo').length).toBe(1);
    });

    it('should handle empty graph', () => {
      const empty = new CodeGraph();
      const json = empty.toJSON();
      const restored = CodeGraph.fromJSON(json);
      expect(restored.nodes.size).toBe(0);
      expect(restored.edges.length).toBe(0);
    });
  });
});

describe('buildGraph', () => {
  it('should import and build graph', async () => {
    const { buildGraph } = await import('../packages/kernel/src/graph-engine.js');
    const files = ['/root/a.js', '/root/b.js'];
    const result = await buildGraph('/root', files);
    expect(result).toBeInstanceOf(CodeGraph);
  });

  it('should resolve aliased import references across files', async () => {
    const { buildGraph } = await import('../packages/kernel/src/graph-engine.js');
    const files = ['/root/a.js', '/root/b.js', '/root/c.js'];
    const result = await buildGraph('/root', files);
    const aliasCalls = result.edges.filter(e =>
      e.from === 'sym:///root/c.js:myAlias' && e.to === 'sym:///root/a.js:foo' && e.relation === 'calls'
    );
    expect(aliasCalls.length).toBe(1);
  });

  it('should add reference edges for same-file references', async () => {
    const { buildGraph } = await import('../packages/kernel/src/graph-engine.js');
    const files = ['/root/a.js', '/root/b.js'];
    const result = await buildGraph('/root', files);
    const barCalls = result.edges.filter(e =>
      e.from === 'sym:///root/a.js:bar' && e.to === 'sym:///root/a.js:bar' && e.relation === 'calls'
    );
    expect(barCalls.length).toBe(1);
  });

  it('should skip unchanged files when prevGraph is provided', async () => {
    const { buildGraph } = await import('../packages/kernel/src/graph-engine.js');
    const files = ['/root/a.js'];
    const graph1 = await buildGraph('/root', files);
    const nodeCount1 = graph1.nodes.size;

    const graph2 = await buildGraph('/root', files, graph1);
    expect(graph2.nodes.size).toBe(nodeCount1);
    expect(graph2.fileHashes.get('/root/a.js')).toBeTruthy();
  });
});

describe('resolveImportPath', () => {
  it('should resolve JS relative imports with extension', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/utils.js', '/root/src/app.ts']);
    expect(resolveImportPath('./utils.js', '/root/src', known)).toBe('/root/src/utils.js');
  });

  it('should resolve JS relative imports without extension', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/utils.js', '/root/src/app.ts']);
    expect(resolveImportPath('./utils', '/root/src', known)).toBe('/root/src/utils.js');
  });

  it('should resolve parent directory imports', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/lib/parse.js', '/root/src/app.ts']);
    expect(resolveImportPath('../lib/parse', '/root/src', known)).toBe('/root/lib/parse.js');
  });

  it('should resolve Python dotted module paths', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/os/path.py', '/root/src/app.py']);
    expect(resolveImportPath('os.path', '/root/src', known)).toBe('/root/src/os/path.py');
  });

  it('should resolve Python __init__.py for package imports', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/mypackage/__init__.py', '/root/src/mypackage/mod.py']);
    expect(resolveImportPath('mypackage', '/root/src', known)).toBe('/root/src/mypackage/__init__.py');
  });

  it('should resolve Python relative package import (from . import X)', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/mypackage/__init__.py']);
    expect(resolveImportPath('.', '/root/src/mypackage', known)).toBe('/root/src/mypackage/__init__.py');
  });

  it('should resolve Go-style imports via last segment fallback', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/util.go', '/root/src/main.go']);
    expect(resolveImportPath('github.com/user/project/util', '/root/src', known)).toBe('/root/src/util.go');
  });

  it('should return null for unresolvable imports', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/app.js']);
    expect(resolveImportPath('./nonexistent', '/root/src', known)).toBeNull();
  });

  it('should return null for stdlib/npm-style bare imports', async () => {
    const { resolveImportPath } = await import('../packages/kernel/src/graph-engine.js');
    const known = new Set(['/root/src/app.js']);
    expect(resolveImportPath('fs', '/root/src', known)).toBeNull();
  });
});
