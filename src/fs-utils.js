import { extname, basename } from 'path';

export { scanDir, readFile } from '../packages/kernel/src/fs-utils.js';

const FILE_REF_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.yml', '.yaml', '.json', '.md', '.sh',
  '.lisp', '.lsp', '.cl',
  '.cs', '.fs', '.fsx', '.vb',
]);

export function extractFileRefs(query, allFiles) {
  const words = query.split(/\s+/);
  const matches = new Set();

  for (const word of words) {
    const clean = word.replace(/[.,;:!?)\]]+$/, '');
    if (clean.length < 3) continue;
    if (FILE_REF_EXTS.size > 0) {
      const hasExt = FILE_REF_EXTS.has(extname(clean).toLowerCase());
      if (!hasExt && !clean.includes('/') && !clean.includes('\\')) continue;
    }

    const normalized = clean.replace(/\\/g, '/').replace(/^\.\//, '');

    for (const fp of allFiles) {
      const fpNorm = fp.replace(/\\/g, '/');

      if (basename(fpNorm) === normalized || basename(fpNorm).toLowerCase() === normalized.toLowerCase()) {
        matches.add(fp);
        continue;
      }

      if (normalized.includes('/') && fpNorm.includes(normalized)) {
        matches.add(fp);
      }
    }

    if (matches.size >= 3) break;
  }

  return [...matches];
}
