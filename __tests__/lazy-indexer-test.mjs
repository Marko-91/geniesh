import { jest } from '@jest/globals';

jest.mock('fs/promises', () => ({
  readdir: jest.fn(async (path, options) => {
    if (path === '/test') {
      return [
        { name: 'Router.php', isDirectory: () => false },
        { name: 'Kernel.php', isDirectory: () => false },
      ];
    }
    return [];
  }),
}));

jest.mock('../packages/kernel/src/parsers/index.js', () => ({
  parseFile: jest.fn(async (content, filePath) => {
    const symbols = [];
    const references = [];
    const imports = [];

    if (content.includes('class Router')) {
      symbols.push({ name: 'Router', kind: 'class', lineRange: [1, 20], exported: true });
      symbols.push({ name: 'dispatch', kind: 'function', lineRange: [10, 18], exported: true });
      references.push({ name: 'Response', kind: 'reference', lineRange: [12, 12] });
    }
    if (content.includes('class Kernel')) {
      symbols.push({ name: 'Kernel', kind: 'class', lineRange: [1, 15], exported: true });
      references.push({ name: 'Router', kind: 'call', lineRange: [5, 5] });
    }
    if (content.includes('$this')) {
      symbols.push({ name: 'handle', kind: 'function', lineRange: [3, 10], exported: false });
    }
    if (content.includes('use App')) {
      imports.push({ module: 'App\\Routing\\Router', type: 'import' });
    }

    return { symbols, references, imports };
  }),
}));

jest.mock('../packages/kernel/src/fs-utils.js', () => ({
  readFile: jest.fn(async (path) => {
    if (path.endsWith('Router.php')) {
      return '<?php\nclass Router {\n  public function dispatch($req) {\n    return new Response();\n  }\n}\n';
    }
    if (path.endsWith('Kernel.php')) {
      return '<?php\nuse App\\Routing\\Router;\nclass Kernel {\n  public function handle() {\n    Router::dispatch($request);\n  }\n}\n';
    }
    return '';
  }),
}));

jest.mock('../packages/kernel/src/graph-engine.js', () => {
  const mockNodes = new Map();
  const mockAdj = new Map();
  const mockRevAdj = new Map();

  const CodeGraph = jest.fn().mockImplementation(() => {
    const graph = {
      nodes: mockNodes,
      adj: mockAdj,
      revAdj: mockRevAdj,
      addNode: jest.fn((id, data) => { mockNodes.set(id, data); }),
      addEdge: jest.fn((from, to, relation, at) => {
        if (!mockAdj.has(from)) mockAdj.set(from, []);
        mockAdj.get(from).push({ to, relation, at: at || null });
        if (!mockRevAdj.has(to)) mockRevAdj.set(to, []);
        mockRevAdj.get(to).push({ from, relation, at: at || null });
      }),
    };
    return graph;
  });

  return { CodeGraph };
});

jest.mock('../packages/kernel/src/community.js', () => ({
  detectCommunities: jest.fn(() => {}),
}));

jest.mock('../src/languages/index.js', () => {
  const phpMod = {
    id: 'php',
    extensions: ['.php'],
    keyFiles: ['composer.json'],
    detect: jest.fn(() => 1),
    patterns: jest.fn((terms) => terms.flatMap(t => [
      { regex: new RegExp('class\\s+' + t + '\\b'), priority: 100, role: 'definition' },
      { regex: new RegExp('use\\s+.*\\\\' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'), priority: 90, role: 'import' },
      { regex: new RegExp('\\b' + t + '\\b'), priority: 1, role: 'mention' },
    ])),
    extractSymbols: jest.fn((q) => q.match(/[A-Z][a-zA-Z0-9]+/g) || []),
    parseFile: jest.fn(),
    findKeyFiles: jest.fn(() => []),
  };
  return {
    getLanguages: jest.fn(() => [phpMod]),
    getLanguage: jest.fn((id) => id === 'php' ? phpMod : null),
    getLanguageForExt: jest.fn(() => phpMod),
    registerLanguage: jest.fn(),
    loadDefaultLanguages: jest.fn(),
  };
});

jest.mock('../src/bm25.js', () => ({
  computeBM25: jest.fn((terms, files) => {
    return files.map(f => ({
      file: f.path,
      bm25Score: f.content.toLowerCase().includes(terms[0]?.toLowerCase()) ? 0.7 : 0.1,
      topTerms: terms.map(t => ({ term: t, count: 1 })),
    })).sort((a, b) => b.bm25Score - a.bm25Score);
  }),
  tokenize: jest.fn((c) => {
    const tokens = c.split(/[^a-zA-Z0-9_$]/).map(t => t.toLowerCase()).filter(t => t.length >= 3);
    return { tokens, length: tokens.length, termCounts: new Map() };
  }),
}));

jest.mock('../src/llm-ranker.js', () => ({
  llmRank: jest.fn(async (question, candidates) => {
    return candidates
      .map(c => ({ file: c.file, score: c.grepScore > 500 ? 10 : 5, reason: 'mock' }))
      .sort((a, b) => b.score - a.score);
  }),
}));

describe('lazy indexer', () => {
  let lazyBuildContext;
  let clearLazyCache;

  beforeAll(async () => {
    const mod = await import('../src/lazy-indexer.js');
    lazyBuildContext = mod.lazyBuildContext;
    clearLazyCache = mod.clearLazyCache;
  });

  afterEach(() => {
    jest.clearAllMocks();
    clearLazyCache();
  });

  const mockProfile = {
    languages: [{ id: 'php', percentage: 100 }],
    keyFiles: [
      { path: '/test/Router.php', name: 'Router.php', type: 'php' },
      { path: '/test/Kernel.php', name: 'Kernel.php', type: 'php' },
    ],
    fileCount: 2,
    structure: { topDirs: [{ name: 'test', fileCount: 2 }] },
  };

  it('returns context and trace for a symbol query', async () => {
    const result = await lazyBuildContext(
      'How does Router::dispatch work?',
      '/test',
      mockProfile,
      { budget: 50000 }
    );

    expect(result).toBeDefined();
    expect(typeof result.contextString).toBe('string');
    expect(Array.isArray(result.trace)).toBe(true);
    expect(result.contextString.length).toBeGreaterThan(0);
  });

  it('includes profile-sourced sections in trace', async () => {
    const result = await lazyBuildContext(
      'How does Router work?',
      '/test',
      mockProfile,
      { budget: 50000 }
    );

    const profileTraces = result.trace.filter(t => t.method === 'profile');
    expect(profileTraces.length).toBeGreaterThan(0);
  });

  it('includes grep-sourced sections in trace', async () => {
    const result = await lazyBuildContext(
      'How does Router work?',
      '/test',
      mockProfile,
      { budget: 50000 }
    );

    const grepTraces = result.trace.filter(t => t.method === 'grep');
    expect(grepTraces.length).toBeGreaterThan(0);
  });

  it('handles vague queries with no symbols gracefully', async () => {
    const result = await lazyBuildContext(
      'What is this project?',
      '/test',
      {
        languages: [{ id: 'php', percentage: 100 }],
        keyFiles: [{ path: '/README.md', name: 'README.md', type: 'generic' }],
        fileCount: 10,
        structure: { topDirs: [] },
      },
      { budget: 50000 }
    );

    expect(result).toBeDefined();
    expect(typeof result.contextString).toBe('string');
  });

  it('respects budget limit', async () => {
    // Force parseFile to return content that would blow past budget
    const { parseFile } = await import('../packages/kernel/src/parsers/index.js');
    parseFile.mockImplementation(async (content) => {
      return { symbols: [{ name: 'Huge', kind: 'class', lineRange: [1, 500], exported: true }], references: [], imports: [] };
    });

    const result = await lazyBuildContext(
      'How does Huge work?',
      '/test',
      {
        languages: [{ id: 'php', percentage: 100 }],
        keyFiles: [],
        fileCount: 1,
        structure: { topDirs: [] },
      },
      { budget: 1000 }
    );

    expect(result.contextString.length).toBeLessThanOrEqual(2000);
  });

  it('produces deterministic output for same input', async () => {
    const result1 = await lazyBuildContext(
      'How does Router::dispatch work?',
      '/test',
      mockProfile,
      { budget: 50000 }
    );

    const result2 = await lazyBuildContext(
      'How does Router::dispatch work?',
      '/test',
      mockProfile,
      { budget: 50000 }
    );

    expect(result1.contextString).toEqual(result2.contextString);
  });

  it('handles empty profile gracefully', async () => {
    const result = await lazyBuildContext(
      'How does Router work?',
      '/test',
      { languages: [], keyFiles: [], fileCount: 0, structure: { topDirs: [] } },
      { budget: 50000 }
    );

    expect(result).toBeDefined();
    expect(typeof result.contextString).toBe('string');
  });
});
