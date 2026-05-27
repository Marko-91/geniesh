import { jest } from '@jest/globals';

jest.mock('../packages/kernel/src/parsers/js-ts.js', () => ({
  parseJSFile: jest.fn((content, filePath) => {
    const symbols = [];
    const references = [];
    const imports = [];

    const importRE = /(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = importRE.exec(content)) !== null) {
      imports.push({ module: m[1] || m[2], type: 'import' });
    }

    const funcRE = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g;
    while ((m = funcRE.exec(content)) !== null) {
      symbols.push({ name: m[1], kind: 'function', lineRange: [1, 1], exported: true });
    }

    const typeRE = /(?:interface|type)\s+(\w+)/g;
    while ((m = typeRE.exec(content)) !== null) {
      symbols.push({ name: m[1], kind: m[0].startsWith('interface') ? 'type' : 'type', lineRange: [1, 1], exported: false });
    }

    return { symbols, references, imports };
  }),
  resolveImport: jest.fn((mod, sourceDir, knownFiles) => {
    const { dirname, join } = require('path');
    if (mod.startsWith('.')) {
      let clean = mod;
      let depth = 0;
      while (clean.startsWith('.') && clean.length > 1) {
        if (clean.startsWith('..')) { depth++; clean = clean.slice(1); }
        else { clean = clean.slice(1); break; }
      }
      clean = clean.replace(/^[/.]+/, '');
      let base = sourceDir;
      for (let i = 0; i < depth; i++) {
        const parent = dirname(base);
        if (parent === base) break;
        base = parent;
      }
      const exts = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs'];
      let candidate = join(base, clean).replace(/\\/g, '/');
      for (const f of knownFiles) {
        const fn = f.replace(/\\/g, '/');
        if (fn === candidate || fn.startsWith(candidate + '/.')) return f;
      }
      for (const ext of exts) {
        const withExt = candidate + ext;
        if (knownFiles.has(withExt.replace(/\\/g, '/'))) return withExt;
        const index = join(candidate, 'index' + ext).replace(/\\/g, '/');
        if (knownFiles.has(index)) return index;
      }
    }
    return null;
  }),
}));

jest.mock('../packages/kernel/src/parsers/php.js', () => ({
  parsePHPFile: jest.fn(() => null),
}));

describe('parsers', () => {
  describe('js-ts parser', () => {
    it('should parse JS with functions, imports, exports', async () => {
      const { parseJSFile } = await import('../packages/kernel/src/parsers/js-ts.js');
      const result = parseJSFile(
        'import { Router } from "express";\n' +
        'export function handle(req, res) { return res.json({ ok: true }); }\n' +
        'const PORT = process.env.PORT || 3000;\n' +
        'handle();\n',
        '/root/server.js'
      );
      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      expect(result.symbols.map(s => s.name)).toContain('handle');
      expect(result.imports.map(s => s.module)).toContain('express');
    });

    it('should parse TS with interfaces and types', async () => {
      const { parseJSFile } = await import('../packages/kernel/src/parsers/js-ts.js');
      const result = parseJSFile(
        'interface User { name: string; age: number; }\n' +
        'type Status = "active" | "inactive";\n' +
        'function greet(u: User): string { return "hello"; }\n',
        '/root/types.ts'
      );
      expect(result.symbols.filter(s => s.kind === 'type').map(s => s.name)).toContain('User');
    });

    it('should handle CJS require imports', async () => {
      const { parseJSFile } = await import('../packages/kernel/src/parsers/js-ts.js');
      const result = parseJSFile(
        'const express = require("express");\n' +
        'module.exports = { app: express() };\n',
        '/root/app.cjs'
      );
      expect(result.imports.map(s => s.module)).toContain('express');
    });
  });

  describe('generic parser', () => {
    it('should find symbols in unknown language', async () => {
      const { parseGenericFile } = await import('../packages/kernel/src/parsers/generic.js');
      const result = parseGenericFile(
        'func helloWorld() {\n  return greetUser("world");\n}\n' +
        'func addTwo(a, b) {\n  return a + b;\n}\n',
        '/root/test.generic'
      );
      expect(result.symbols.map(s => s.name)).toContain('helloWorld');
    });

    it('should filter english noise words', async () => {
      const { parseGenericFile } = await import('../packages/kernel/src/parsers/generic.js');
      const result = parseGenericFile(
        'func this() { return that; }\n' +
        'func helloWorld() { return 42; }\n',
        '/root/test.generic'
      );
      const names = result.symbols.map(s => s.name);
      expect(names).not.toContain('this');
      expect(names).not.toContain('that');
      expect(names).toContain('helloWorld');
    });
  });

  describe('resolveImport', () => {
    it('should resolve relative imports', async () => {
      const { resolveImport } = await import('../packages/kernel/src/parsers/js-ts.js');
      const knownFiles = new Set([
        '/root/src/utils.js',
        '/root/src/helpers/index.js',
        '/root/src/helpers/format.ts',
        '/root/lib/parse.ts',
      ]);
      expect(resolveImport('./utils', '/root/src', knownFiles)).toBe('/root/src/utils.js');
    });

    it('should resolve index files', async () => {
      const { resolveImport } = await import('../packages/kernel/src/parsers/js-ts.js');
      const knownFiles = new Set(['/root/src/helpers/index.js', '/root/src/index.ts']);
      expect(resolveImport('./helpers', '/root/src', knownFiles)).toBe('/root/src/helpers/index.js');
    });

    it('should resolve parent directory imports', async () => {
      const { resolveImport } = await import('../packages/kernel/src/parsers/js-ts.js');
      const knownFiles = new Set(['/root/lib/parse.js', '/root/src/app.ts']);
      expect(resolveImport('../lib/parse', '/root/src', knownFiles)).toBe('/root/lib/parse.js');
    });

    it('should return null for unresolvable imports', async () => {
      const { resolveImport } = await import('../packages/kernel/src/parsers/js-ts.js');
      expect(resolveImport('./nonexistent', '/root/src', new Set(['/root/src/app.js']))).toBeNull();
    });
  });
});
