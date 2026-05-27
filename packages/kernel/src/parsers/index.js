import { extname, dirname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { parseJSFile } from './js-ts.js';
import { resolveImport } from './js-ts.js';
import { parsePHPFile } from './php.js';
import { parseTSFile } from './ts-based.js';
import { parseGenericFile } from './generic.js';

function getRequire() {
  try { return createRequire(import.meta.url); }
  catch { return () => { throw new Error('createRequire not available'); }; }
}
const _require = getRequire();

export const SOURCE_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
  '.rb', '.php',
  '.swift', '.kt', '.scala', '.zig', '.lua',
  '.cs', '.fs', '.fsx', '.vb',
  '.lisp', '.lsp', '.cl',
]);

export const RESOLVE_EXTS = [...SOURCE_EXTS, '.md', '.sh'];

let tsParsersInit = false;

export async function ensureTSParsers() {
  if (tsParsersInit) return;
  tsParsersInit = true;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(__dirname, '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');

  try {
    const Parser = (await import('web-tree-sitter')).default;
    await Parser.init({ locateFile: () => wasmPath });

    const langs = [
      { ext: '.py',  file: 'tree-sitter-python/tree-sitter-python.wasm' },
      { ext: '.go',  file: 'tree-sitter-go/tree-sitter-go.wasm' },
      { ext: '.rs',  file: 'tree-sitter-rust/tree-sitter-rust.wasm' },
      { ext: '.java', file: 'tree-sitter-java/tree-sitter-java.wasm' },
      { ext: '.c',   file: 'tree-sitter-c/tree-sitter-c.wasm' },
      { ext: '.cpp', file: 'tree-sitter-c/tree-sitter-c.wasm' },
      { ext: '.h',   file: 'tree-sitter-c/tree-sitter-c.wasm' },
      { ext: '.php', file: 'tree-sitter-php/tree-sitter-php.wasm' },
    ];

    for (const { ext, file } of langs) {
      try {
        const wasmFile = join(__dirname, '..', '..', 'node_modules', file);
        const language = await Parser.Language.load(wasmFile);
        const parser = new Parser();
        parser.setLanguage(language);
        TS_PARSERS.set(ext, parser);
      } catch {}
    }
  } catch {}
}

const TS_PARSERS = new Map();

export function getTSParser(ext) {
  return TS_PARSERS.get(ext) || null;
}

export async function initTSParsers() {
  await ensureTSParsers();
  return Object.fromEntries(TS_PARSERS);
}

export async function parseFile(content, filePath) {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.js': case '.mjs': case '.cjs':
    case '.jsx': case '.ts': case '.tsx':
      return parseJSFile(content, filePath) || parseGenericFile(content, filePath);

    case '.php':
      await ensureTSParsers();
      return (await parseTSFile(content, filePath)) || parsePHPFile(content, filePath) || parseGenericFile(content, filePath);

    case '.py': case '.go': case '.rs':
    case '.java': case '.c': case '.cpp': case '.h':
      await ensureTSParsers();
      return (await parseTSFile(content, filePath)) || parseGenericFile(content, filePath);

    default:
      return parseGenericFile(content, filePath);
  }
}
