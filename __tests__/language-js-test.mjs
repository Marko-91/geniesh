import { jest } from '@jest/globals';

jest.mock('../packages/kernel/src/parsers/index.js', () => ({
  parseFile: jest.fn(() => ({ symbols: [], references: [], imports: [] })),
}));

describe('language JS module', () => {
  let jsMod;

  beforeAll(async () => {
    jsMod = (await import('../src/languages/js.js')).default;
  });

  describe('detect', () => {
    it('returns 0 for empty file list', () => {
      expect(jsMod.detect([])).toBe(0);
    });

    it('returns 1.0 when all files are js/ts', () => {
      const files = [
        { path: '/a.js', ext: '.js', name: 'a.js' },
        { path: '/b.ts', ext: '.ts', name: 'b.ts' },
        { path: '/c.jsx', ext: '.jsx', name: 'c.jsx' },
      ];
      expect(jsMod.detect(files)).toBe(1);
    });

    it('returns 0.5 when half the files are js', () => {
      const files = [
        { path: '/a.js', ext: '.js', name: 'a.js' },
        { path: '/b.py', ext: '.py', name: 'b.py' },
      ];
      expect(jsMod.detect(files)).toBe(0.5);
    });

    it('returns 0 when no js files', () => {
      const files = [
        { path: '/a.php', ext: '.php', name: 'a.php' },
        { path: '/b.rs', ext: '.rs', name: 'b.rs' },
      ];
      expect(jsMod.detect(files)).toBe(0);
    });
  });

  describe('extensions', () => {
    it('includes .js, .ts, .jsx, .tsx, .mjs, .cjs', () => {
      expect(jsMod.extensions).toContain('.js');
      expect(jsMod.extensions).toContain('.ts');
      expect(jsMod.extensions).toContain('.tsx');
      expect(jsMod.extensions).toContain('.mjs');
    });
  });

  describe('patterns', () => {
    it('generates a class definition pattern', () => {
      const patterns = jsMod.patterns(['Router']);
      const defPat = patterns.find(p => p.role === 'definition');
      expect(defPat).toBeDefined();
      expect(defPat.regex.test('class Router {')).toBe(true);
      expect(defPat.regex.test('export class Router {')).toBe(true);
      expect(defPat.regex.test('export default class Router {')).toBe(true);
    });

    it('generates a function definition pattern', () => {
      const patterns = jsMod.patterns(['handle']);
      const fnPat = patterns.find(p => p.role === 'function-def');
      expect(fnPat).toBeDefined();
      expect(fnPat.regex.test('function handle(req, res) {')).toBe(true);
      expect(fnPat.regex.test('export function handle(req) {')).toBe(true);
    });

    it('generates an import pattern', () => {
      const patterns = jsMod.patterns(['Router']);
      const impPat = patterns.find(p => p.role === 'import');
      expect(impPat).toBeDefined();
      expect(impPat.regex.test('import { Router } from "express"')).toBe(true);
      expect(impPat.regex.test('import Router from "express"')).toBe(true);
    });

    it('generates an interface pattern', () => {
      const patterns = jsMod.patterns(['Router']);
      const intPat = patterns.find(p => p.role === 'interface');
      expect(intPat).toBeDefined();
      expect(intPat.regex.test('interface Router {')).toBe(true);
      expect(intPat.regex.test('export interface Router {')).toBe(true);
    });

    it('generates a variable pattern', () => {
      const patterns = jsMod.patterns(['router']);
      const varPat = patterns.find(p => p.role === 'variable');
      expect(varPat).toBeDefined();
      expect(varPat.regex.test('const router = new Router()')).toBe(true);
    });

    it('does not match class with different name', () => {
      const patterns = jsMod.patterns(['Router']);
      const defPat = patterns.find(p => p.role === 'definition');
      expect(defPat.regex.test('class RouterController {')).toBe(false);
    });

    it('generates a JSDoc pattern', () => {
      const patterns = jsMod.patterns(['Router']);
      const jsdocPat = patterns.find(p => p.role === 'jsdoc');
      expect(jsdocPat).toBeDefined();
      expect(jsdocPat.regex.test('@type {Router}')).toBe(true);
    });
  });

  describe('extractSymbols', () => {
    it('extracts PascalCase symbols from question', () => {
      const symbols = jsMod.extractSymbols('How does Router.handle work?');
      expect(symbols).toContain('Router');
    });

    it('extracts camelCase symbols', () => {
      const symbols = jsMod.extractSymbols('What is the createRouter function?');
      expect(symbols).toContain('createRouter');
    });

    it('returns empty for questions with no code symbols', () => {
      const symbols = jsMod.extractSymbols('How does this application work?');
      expect(symbols.length).toBe(0);
    });
  });

  describe('findKeyFiles', () => {
    it('returns matching key files from a file list', () => {
      const files = [
        { path: '/package.json', name: 'package.json', ext: '.json' },
        { path: '/tsconfig.json', name: 'tsconfig.json', ext: '.json' },
        { path: '/src/index.ts', name: 'index.ts', ext: '.ts' },
      ];
      const found = jsMod.findKeyFiles(files);
      expect(found.map(f => f.name)).toContain('package.json');
      expect(found.map(f => f.name)).toContain('tsconfig.json');
    });
  });
});
