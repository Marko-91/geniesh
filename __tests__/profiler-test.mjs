import { jest } from '@jest/globals';

jest.mock('fs/promises', () => ({
  readdir: jest.fn(async (path, options) => {
    if (path === '/test') {
      return [
        { name: 'Router.php', isDirectory: () => false },
        { name: 'index.php', isDirectory: () => false },
        { name: 'src', isDirectory: () => true },
        { name: 'composer.json', isDirectory: () => false },
      ];
    }
    if (path === '/test/src') {
      return [{ name: 'Kernel.php', isDirectory: () => false }];
    }
    return [];
  }),
  stat: jest.fn(async () => ({ isDirectory: () => false, size: 1000 })),
}));

jest.mock('../src/languages/index.js', () => {
  const phpMod = {
    id: 'php',
    extensions: ['.php', '.phtml'],
    keyFiles: ['composer.json', 'artisan'],
    detect: jest.fn(),
    patterns: jest.fn(),
    extractSymbols: jest.fn(),
    parseFile: jest.fn(),
    findKeyFiles: jest.fn(),
  };
  const jsMod = {
    id: 'js',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
    keyFiles: ['package.json', 'tsconfig.json'],
    detect: jest.fn(),
    patterns: jest.fn(),
    extractSymbols: jest.fn(),
    parseFile: jest.fn(),
    findKeyFiles: jest.fn(),
  };
  const genericMod = {
    id: 'generic',
    extensions: [],
    keyFiles: ['README.md', 'Makefile', 'Dockerfile'],
    detect: jest.fn(() => 0),
    patterns: jest.fn(),
    extractSymbols: jest.fn(),
    parseFile: jest.fn(),
    findKeyFiles: jest.fn(),
  };
  return {
    getLanguages: jest.fn(() => [genericMod, phpMod, jsMod]),
    getLanguage: jest.fn((id) => ({ php: phpMod, js: jsMod, generic: genericMod }[id])),
    getLanguageForExt: jest.fn(),
    registerLanguage: jest.fn(),
    loadDefaultLanguages: jest.fn(),
    _test: { phpMod, jsMod, genericMod },
  };
});

describe('profiler', () => {
  let profileProject;

  beforeAll(async () => {
    const mod = await import('../src/profiler.js');
    profileProject = mod.profileProject;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('detects languages from file extensions', async () => {
    const { phpMod, jsMod } = (await import('../src/languages/index.js'))._test;
    phpMod.detect.mockReturnValue(0.62);
    jsMod.detect.mockReturnValue(0.31);

    const result = await profileProject('/test');
    expect(result.languages).toEqual([
      { id: 'php', percentage: 62 },
      { id: 'js', percentage: 31 },
    ]);
    expect(result.fileCount).toBeGreaterThan(0);
  });

  it('finds key files by name', async () => {
    const { phpMod, jsMod } = (await import('../src/languages/index.js'))._test;
    phpMod.detect.mockReturnValue(0.5);
    jsMod.detect.mockReturnValue(0.5);

    const result = await profileProject('/test');
    expect(result.keyFiles).toBeDefined();
    expect(Array.isArray(result.keyFiles)).toBe(true);
  });

  it('handles empty project gracefully', async () => {
    const { phpMod, jsMod } = (await import('../src/languages/index.js'))._test;
    phpMod.detect.mockReturnValue(0);
    jsMod.detect.mockReturnValue(0);

    const result = await profileProject('/empty');
    expect(result.languages).toEqual([]);
    expect(result.fileCount).toBeGreaterThanOrEqual(0);
  });

  it('sorts languages by percentage descending', async () => {
    const { phpMod, jsMod } = (await import('../src/languages/index.js'))._test;
    phpMod.detect.mockReturnValue(0.2);
    jsMod.detect.mockReturnValue(0.7);

    const result = await profileProject('/test');
    expect(result.languages[0].id).toBe('js');
    expect(result.languages[1].id).toBe('php');
  });

  it('filters out languages with 0% detection', async () => {
    const { phpMod, jsMod } = (await import('../src/languages/index.js'))._test;
    phpMod.detect.mockReturnValue(1);
    jsMod.detect.mockReturnValue(0);

    const result = await profileProject('/test');
    expect(result.languages.length).toBe(1);
    expect(result.languages[0].id).toBe('php');
  });

  it('returns structure with top-level directories', async () => {
    const result = await profileProject('/test');
    expect(result.structure).toBeDefined();
    expect(Array.isArray(result.structure.topDirs)).toBe(true);
  });
});
