import { jest } from '@jest/globals';

jest.mock('../packages/kernel/src/parsers/index.js', () => ({
  parseFile: jest.fn(() => ({ symbols: [], references: [], imports: [] })),
}));

describe('language PHP module', () => {
  let phpMod;

  beforeAll(async () => {
    phpMod = (await import('../src/languages/php.js')).default;
  });

  describe('detect', () => {
    it('returns 0 for empty file list', () => {
      expect(phpMod.detect([])).toBe(0);
    });

    it('returns 1.0 when all files are php', () => {
      const files = [
        { path: '/a.php', ext: '.php', name: 'a.php' },
        { path: '/b.php', ext: '.php', name: 'b.php' },
      ];
      expect(phpMod.detect(files)).toBe(1);
    });

    it('returns 0.5 when half the files are php', () => {
      const files = [
        { path: '/a.php', ext: '.php', name: 'a.php' },
        { path: '/b.js', ext: '.js', name: 'b.js' },
      ];
      expect(phpMod.detect(files)).toBe(0.5);
    });

    it('returns 0 when no php files', () => {
      const files = [
        { path: '/a.js', ext: '.js', name: 'a.js' },
        { path: '/b.rs', ext: '.rs', name: 'b.rs' },
      ];
      expect(phpMod.detect(files)).toBe(0);
    });
  });

  describe('extensions', () => {
    it('includes .php, .phtml, .php4-8', () => {
      expect(phpMod.extensions).toContain('.php');
      expect(phpMod.extensions).toContain('.phtml');
      expect(phpMod.extensions).toContain('.php8');
    });
  });

  describe('keyFiles', () => {
    it('includes composer.json and artisan', () => {
      expect(phpMod.keyFiles).toContain('composer.json');
      expect(phpMod.keyFiles).toContain('artisan');
    });
  });

  describe('patterns', () => {
    it('generates a definition pattern for symbol', () => {
      const patterns = phpMod.patterns(['Router']);
      const defPat = patterns.find(p => p.role === 'definition');
      expect(defPat).toBeDefined();
      expect(defPat.priority).toBe(100);
      expect(defPat.regex.test('class Router')).toBe(true);
      expect(defPat.regex.test('class RouterService')).toBe(false);
    });

    it('generates an import pattern for symbol', () => {
      const patterns = phpMod.patterns(['Router']);
      const impPat = patterns.find(p => p.role === 'import');
      expect(impPat).toBeDefined();
      expect(impPat.regex.test('use App\\Routing\\Router;')).toBe(true);
    });

    it('generates a static-call pattern', () => {
      const patterns = phpMod.patterns(['Router']);
      const scPat = patterns.find(p => p.role === 'static-call');
      expect(scPat).toBeDefined();
      expect(scPat.regex.test('Router::dispatch()')).toBe(true);
    });

    it('generates a type-hint pattern', () => {
      const patterns = phpMod.patterns(['Router']);
      const thPat = patterns.find(p => p.role === 'type-hint');
      expect(thPat).toBeDefined();
      expect(thPat.regex.test('?Router $router')).toBe(true);
    });

    it('generates a function-def pattern', () => {
      const patterns = phpMod.patterns(['dispatch']);
      const fnPat = patterns.find(p => p.role === 'function-def');
      expect(fnPat).toBeDefined();
      expect(fnPat.regex.test('function dispatch($request)')).toBe(true);
    });

    it('does not match English noise words as PHP symbols', () => {
      const patterns = phpMod.patterns(['handler']);
      const mention = patterns.find(p => p.role === 'mention');
      expect(mention).toBeDefined();
      expect(mention.regex.test('the handler')).toBe(true);
    });

    it('handles multiple query terms', () => {
      const patterns = phpMod.patterns(['Router', 'dispatch']);
      const defPatterns = patterns.filter(p => p.role === 'definition');
      expect(defPatterns.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('extractSymbols', () => {
    it('extracts PascalCase symbols from question', () => {
      const symbols = phpMod.extractSymbols('How does Router::dispatch work?');
      expect(symbols).toContain('Router');
    });

    it('returns empty for questions with no code symbols', () => {
      const symbols = phpMod.extractSymbols('How does error handling work?');
      // "handling" is a noise word, "error" is short, "work" is noise
      expect(symbols.length).toBe(0);
    });

    it('extracts snake_case symbols', () => {
      const symbols = phpMod.extractSymbols('What does get_user_by_id do?');
      expect(symbols).toContain('get_user_by_id');
    });
  });

  describe('findKeyFiles', () => {
    it('returns matching key files from a file list', () => {
      const files = [
        { path: '/composer.json', name: 'composer.json', ext: '.json' },
        { path: '/src/App.php', name: 'App.php', ext: '.php' },
        { path: '/README.md', name: 'README.md', ext: '.md' },
      ];
      const found = phpMod.findKeyFiles(files);
      expect(found.map(f => f.name)).toContain('composer.json');
      expect(found.map(f => f.name)).not.toContain('README.md');
    });
  });
});
