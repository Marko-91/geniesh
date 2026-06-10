import { buildPrompt, buildDirectPrompt, detectProjectStructure, buildSystemPrompt } from '../src/prompt.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('prompt', () => {
  describe('buildPrompt', () => {
    it('should build prompt from chunks', () => {
      const chunks = [
        { file: 'a.js', chunk: 'code1', startLine: 1, endLine: 10 },
        { file: 'b.js', chunk: 'code2', startLine: 1, endLine: 5 },
      ];
      const query = 'What does this do?';
      const result = buildPrompt(query, chunks);
      expect(result).toContain('Files:\na.js, b.js');
      expect(result).toContain('// File: a.js (lines 1–10)');
      expect(result).toContain('code1');
      expect(result).toContain('Task:\nWhat does this do?');
    });

    it('should respect context char limit', () => {
      const bigChunk = 'a'.repeat(15500);
      const chunks = [{ file: 'a.js', chunk: bigChunk, startLine: 1, endLine: 10 }];
      const result = buildPrompt('query', chunks);
      expect(result).toContain('(lines 1–10)');
      expect(result.length).toBeGreaterThan(10000);
      expect(result.length).toBeLessThan(20000);
    });
  });

  describe('buildDirectPrompt', () => {
    it('should build direct prompt', () => {
      const code = 'function test() { return 1; }';
      const query = 'Explain this';
      const result = buildDirectPrompt(query, code, 'test.js');
      expect(result).toContain('// test.js');
      expect(result).toContain('function test() { return 1; }');
      expect(result).toContain('Task:\nExplain this');
    });

    it('should truncate code if over limit', () => {
      const longCode = 'a'.repeat(18000);
      const result = buildDirectPrompt('query', longCode);
      expect(result).toContain('... (truncated)');
    });

    it('should handle no label', () => {
      const result = buildDirectPrompt('query', 'code');
      expect(result).not.toContain('//');
    });
  });

  describe('detectProjectStructure', () => {
    let tmpDir;

    afterEach(() => {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true }); } catch {} }
    });

    it('should detect src/ with .ts files', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      mkdirSync(join(tmpDir, 'src'));
      mkdirSync(join(tmpDir, 'tests'));
      writeFileSync(join(tmpDir, 'src', 'index.ts'), 'const x = 1;\n');
      writeFileSync(join(tmpDir, 'src', 'utils.ts'), 'export const y = 2;\n');
      writeFileSync(join(tmpDir, 'src', 'types.ts'), 'export type T = string;\n');

      const info = detectProjectStructure(tmpDir);
      expect(info.hasSrc).toBe(true);
      expect(info.sourceDirs).toContain('src');
      expect(info.extensions).toContain('.ts');
      expect(info.fileCount).toBe(3);
      expect(info.primaryLang).toBe('TypeScript');
      expect(info.topLevelLayout).toContain('src');
      expect(info.topLevelLayout).toContain('tests');
    });

    it('should detect flat .py files (no src/)', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      writeFileSync(join(tmpDir, 'app.py'), 'def main():\n    pass\n');
      writeFileSync(join(tmpDir, 'models.py'), 'class User:\n    pass\n');
      mkdirSync(join(tmpDir, 'tests'));
      writeFileSync(join(tmpDir, 'tests', 'test_app.py'), 'def test_main():\n    pass\n');

      const info = detectProjectStructure(tmpDir);
      expect(info.hasSrc).toBe(false);
      expect(info.sourceDirs).toContain('.');
      expect(info.extensions).toContain('.py');
      expect(info.fileCount).toBe(3);
      expect(info.primaryLang).toBe('Python');
    });

    it('should handle empty directory gracefully', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      const info = detectProjectStructure(tmpDir);
      expect(info.sourceDirs).toEqual(['.']);
      expect(info.fileCount).toBe(0);
      expect(info.extensions).toEqual([]);
      expect(info.primaryLang).toBe('Unknown');
    });

    it('should ignore non-source dirs', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      mkdirSync(join(tmpDir, 'node_modules'));
      mkdirSync(join(tmpDir, 'dist'));
      writeFileSync(join(tmpDir, 'node_modules', 'lodash.js'), 'module.exports = {};\n');
      writeFileSync(join(tmpDir, 'dist', 'bundle.js'), 'console.log(1);\n');

      const info = detectProjectStructure(tmpDir);
      expect(info.fileCount).toBe(0);
      expect(info.sourceDirs).toEqual(['.']);
    });

    it('should detect mixed extensions', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      mkdirSync(join(tmpDir, 'src'));
      writeFileSync(join(tmpDir, 'src', 'app.ts'), 'const x = 1;\n');
      writeFileSync(join(tmpDir, 'src', 'app.js'), 'const y = 2;\n');
      writeFileSync(join(tmpDir, 'src', 'styles.css'), 'body {}\n');

      const info = detectProjectStructure(tmpDir);
      expect(info.extensions).toContain('.ts');
      expect(info.extensions).toContain('.js');
      expect(info.extensions).not.toContain('.css');
      expect(info.fileCount).toBe(2);
      expect(info.primaryLang).toBe('TypeScript');
    });
  });

  describe('buildSystemPrompt', () => {
    let tmpDir;

    afterEach(() => {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true }); } catch {} }
    });

    it('should include project layout in prompt', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      mkdirSync(join(tmpDir, 'src'));
      writeFileSync(join(tmpDir, 'src', 'index.ts'), 'const x = 1;\n');

      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('Project layout:');
      expect(prompt).toContain('src');
      expect(prompt).toContain('Source directories:');
      expect(prompt).toContain('grep -rn "ClassName" --include="*.ts" src/');
      expect(prompt).not.toContain('--include="*.py"');
    });

    it('should generate correct grep example for flat projects', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      writeFileSync(join(tmpDir, 'main.py'), 'def main():\n    pass\n');
      writeFileSync(join(tmpDir, 'utils.py'), 'def util():\n    pass\n');

      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('grep -rn "ClassName" --include="*.py" .');
      expect(prompt).toContain('Primary languages: Python');
    });

    it('should handle directory with no source files', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('Project layout:');
      expect(prompt).toContain('Source directories:');
      // Should not reference specific extensions
      expect(prompt).not.toContain('--include=');
    });
  });
});