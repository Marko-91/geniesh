import { readFile, writeFile } from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { structuredPatch } = require('diff');

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function findFile(rawPath, allFiles) {
  const norm = normalizePath(rawPath).replace(/['"]/g, '');
  // Direct match
  let m = allFiles.find(f => normalizePath(f) === norm);
  if (m) return m;
  // Ends-with match
  m = allFiles.find(f => normalizePath(f).endsWith(norm) || normalizePath(f).endsWith('/' + norm));
  if (m) return m;
  // Basename match
  const base = norm.split('/').pop();
  m = allFiles.find(f => f.split(/[/\\]/).pop().toLowerCase() === base);
  return m;
}

// Parse search/replace blocks in Aider format:
// path/to/file
// ```search/replace  or  SEARCH / REPLACE markers
export function parseSearchReplace(text, allFiles) {
  // Format:
  // file/path.js
  // SEARCH
  // old text
  // REPLACE
  // new text
  // Markers may have leading/trailing whitespace
  const blocks = [];
  const blockRe = /^([^\n]+)\n\s*SEARCH\s*\n([\s\S]*?)\n\s*REPLACE\s*\n([\s\S]*?)(?=\n\n\S|\n\s*SEARCH\s*\n|$(?!\n))/gm;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const search = match[2].trimEnd();
    const replace = match[3].trimEnd();
    if (!rawPath || !search) continue;
    const file = findFile(rawPath, allFiles);
    if (file) {
      blocks.push({ type: 'search-replace', file, search, replace });
    }
  }
  return blocks;
}

// Parse full-file edits: ```lang:filepath content ``` or
// file mentioned before code block
export function parseFullFileEdits(text, allFiles) {
  const edits = [];
  const seen = new Set();

  // Pattern 1: ```lang:filepath or ```:filepath
  const re1 = /```(\w[\w+-]*)?\s*:\s*([^\n`]+?)\n([\s\S]*?)```/g;
  let match;
  while ((match = re1.exec(text)) !== null) {
    const rawPath = match[2].trim();
    const content = match[3];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = findFile(rawPath, allFiles);
    if (file) edits.push({ file, content });
  }

  // Pattern 2: "in file.js" or "edit file.js" followed by a code block
  // Only match if the code block is substantial (>= 10 lines) to avoid
  // treating inline snippets as full-file replacements
  const re2 = /(?:in|for|edit|update|change|modify)\s+[`'\"]?([^\s`'\"]+(?:\.[a-z]+)+)[`'\"]?[^]*?\n```(?:\w+)?\n([\s\S]*?)```/gi;
  while ((match = re2.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    const lines = content.split('\n');
    if (lines.length < 10) continue; // too small to be a full file
    seen.add(rawPath);
    const file = findFile(rawPath, allFiles);
    if (file) edits.push({ file, content });
  }

  // Pattern 3: file path line immediately followed by a fenced code block
  //   path/to/file.php
  //   ```php
  //   full file content
  //   ```
  const re3 = /^([^\n`]+\.\w+)\s*\n```(?:\w+)?\n([\s\S]*?)```/gm;
  while ((match = re3.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2];
    if (!rawPath || !content || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = findFile(rawPath, allFiles);
    if (file) edits.push({ file, content });
  }

  return edits;
}

// Parse ```search / ```replace fenced code block pairs (GitHub diff format)
// Pattern:
//   ```search
//   # BFS: method — path/to/file.php
//   old code
//   ```
//
//   ```replace
//   new code
//   ```
export function parseSearchReplaceFenced(text, allFiles) {
  const edits = [];
  const seenPairs = new Set();

  // Match ```search / ```replace pairs. Allow any text (including comments) between them.
  const pairRe = /```search\s*\n([\s\S]*?)```\s*\n([\s\S]*?)```replace\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = pairRe.exec(text)) !== null) {
    const searchBlock = match[1].trimEnd();
    const between = match[2];  // text between the two blocks
    const replaceBlock = match[3].trimEnd();
    if (!searchBlock || !replaceBlock) continue;

    // Extract file path from BFS comment in the search block: # BFS: method (depth N) — path/to/file
    let filePath = null;
    const bfsComment = searchBlock.match(/BFS:[^—–]*—–\s*(.+?)(?:\n|$)/);
    if (bfsComment) {
      filePath = bfsComment[1].trim();
    } else {
      // Fallback: extract from a # or // comment in first 3 lines of search block
      const commentLine = searchBlock.match(/^(?:#|\/\/)\s*(.+?\.php|.+?\.js|.+?\.ts|.+?\.py|.+?\.go|.+?\.rs)(?:\n|$)/m);
      if (commentLine) {
        filePath = commentLine[1].trim().replace(/^[—–]\s*/, '').split(/[—–]/).pop()?.trim() || commentLine[1].trim();
      }
    }

    if (!filePath) continue;
    const file = findFile(filePath, allFiles);
    if (!file) continue;

    // Deduplicate by file + first line of search
    const firstSearchLine = searchBlock.split('\n').find(l => !l.startsWith('#') && !l.startsWith('//') && l.trim()) || '';
    const key = file + '::' + firstSearchLine.trim().substring(0, 60);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    // Strip comment lines from the search block so we compare actual code
    const searchCode = searchBlock.split('\n').filter(l => !l.startsWith('# BFS:') && !l.startsWith('# Lines')).join('\n').trimStart();
    const replaceCode = replaceBlock.trimStart();
    if (searchCode && replaceCode) {
      edits.push({ type: 'sr', file, search: searchCode, replace: replaceCode });
    }
  }
  return edits;
}

// Parse git-diff SEARCH/REPLACE conflict-marker format:
//   <<<<<<< SEARCH
//   old code
//   =======
//   new code
//   >>>>>>> REPLACE
// These may be wrapped inside ```lang or ```diff fenced blocks.
// File path is inferred from surrounding text or content matching.
export function parseSearchReplaceGitDiff(text, allFiles) {
  const edits = [];
  const seenPairs = new Set();

  // Match <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks
  // Allow optional surrounding ``` fences
  const blockRe = /(?:```\w*\s*\n)?<<<<<<< SEARCH\s*\n([\s\S]*?)=======\s*\n([\s\S]*?)>>>>>>> REPLACE\s*\n?(?:```)?/g;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const searchCode = match[1].trimEnd();
    const replaceCode = match[2].trimEnd();
    if (!searchCode || !replaceCode) continue;

    // Find the most likely file path from surrounding context
    const textBefore = text.substring(0, match.index);
    let filePath = null;

    // Priority 1: file path mentioned in preceding sentence
    // Match patterns like "src/Router.php", "in Router.php", "the Router class"
    let pathMatch = textBefore.match(/\b([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_./-]+\.\w+)\b/);
    if (!pathMatch) {
      // Single filename with extension: "Router.php"
      pathMatch = textBefore.match(/\b(\w+\.php)\b/);
    }
    if (!pathMatch) {
      // "the Router class", "Router class", "the Router" — find file by entity name
      let entityName = textBefore.match(/the\s+(\w+)\s+class/i);
      if (!entityName) entityName = textBefore.match(/\b(\w+)\s+class\b/i);
      if (!entityName) entityName = textBefore.match(/\b(?:class|interface|trait)\s+(\w+)/i);
      if (entityName) {
        const found = allFiles.find(f => {
          const base = f.split(/[/\\]/).pop()?.replace(/\.\w+$/, '');
          return base === entityName[1];
        });
        if (found) {
          filePath = found;
        }
      }
    }
    if (!filePath && pathMatch) {
      filePath = pathMatch[1].trim();
    }

    // Priority 2: class/interface name in SEARCH block — find which file defines it
    if (!filePath) {
      const classMatch = searchCode.match(/(?:class|interface|trait)\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        const classFile = allFiles.find(f => {
          const base = f.split(/[/\\]/).pop()?.replace(/\.\w+$/, '');
          return base === className || f.toLowerCase().includes('/' + className.toLowerCase() + '.php');
        });
        if (classFile) filePath = classFile;
      }
    }

    // Priority 3: filename mentioned in any sentence before
    if (!filePath) {
      const nameMatch = textBefore.match(/\b(\w+\.php)\b/);
      if (nameMatch) {
        const found = findFile(nameMatch[1], allFiles);
        if (found) filePath = found;
      }
    }

    if (!filePath) continue;
    const file = findFile(filePath, allFiles);
    if (!file) continue;

    // Deduplicate by file + first code line of search
    const key = file + '::' + searchCode.split('\n')[0]?.trim().substring(0, 60);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    edits.push({ type: 'sr', file, search: searchCode, replace: replaceCode });
  }
  return edits;
}

// Parse conflict-marker format without <<<<<<<:
//   FILE_PATH
//   SEARCH
//   old code
//   =======
//   new code
//   >>>>>>> REPLACE
export function parseSearchReplaceConflict(text, allFiles) {
  const edits = [];
  const seenPairs = new Set();

  const re = /(?:^|\n)([^\n]+)\n\s*SEARCH\s*\n([\s\S]*?)\n\s*={3,}\s*\n([\s\S]*?)\n\s*>>>>>>> REPLACE/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const search = match[2].trimEnd();
    const replace = match[3].trimEnd();
    if (!rawPath || !search) continue;

    const file = findFile(rawPath, allFiles);
    if (!file) continue;

    const key = file + '::' + search.split('\n')[0]?.trim().substring(0, 60);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    edits.push({ type: 'sr', file, search, replace });
  }
  return edits;
}

export function parseFileEdits(text, allFiles) {
  const edits = [];

  // Search/replace blocks take priority
  const sr = parseSearchReplace(text, allFiles);
  edits.push(...sr.map(e => ({ ...e, type: 'sr' })));

  // SEARCH ... ======= ... >>>>>>> REPLACE format
  const conflict = parseSearchReplaceConflict(text, allFiles);
  edits.push(...conflict);

  // Fenced ```search / ```replace pairs
  const fenced = parseSearchReplaceFenced(text, allFiles);
  edits.push(...fenced);

  // Git-diff <<<<<<< SEARCH format
  const gd = parseSearchReplaceGitDiff(text, allFiles);
  edits.push(...gd);

  // Full-file edits
  const ff = parseFullFileEdits(text, allFiles);
  edits.push(...ff.map(e => ({ ...e, type: 'full' })));

  return edits;
}

export function formatDiff(oldContent, newContent, filePath) {
  if (oldContent === newContent) return null;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const max = Math.max(oldLines.length, newLines.length);

  const changed = [];
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) changed.push(i);
  }
  if (!changed.length) return null;

  const firstIdx = Math.max(0, changed[0] - 2);
  const lastIdx = Math.min(max - 1, changed[changed.length - 1] + 2);
  const changeSet = new Set(changed);

  const out = [`\x1b[1m${filePath}\x1b[0m — L${changed[0] + 1}–L${changed[changed.length - 1] + 1}`];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const ln = String(i + 1).padStart(4);
    if (changeSet.has(i)) {
      if (oldLines[i] !== undefined)
        out.push(` \x1b[31m-${ln}│ ${oldLines[i]}\x1b[0m`);
      if (newLines[i] !== undefined)
        out.push(` \x1b[32m+${ln}│ ${newLines[i]}\x1b[0m`);
    } else {
      out.push(` \x1b[90m ${ln}│ ${oldLines[i]}\x1b[0m`);
    }
  }
  return out.join('\n');
}

export function formatSearchReplaceDiff(file, search, replace, fileContent) {
  if (fileContent && fileContent.includes(search)) {
    const patch = structuredPatch(file, file, search, replace);
    if (!patch.hunks.length) return null;

    const contentLines = fileContent.split('\n');
    const searchFirst = search.split('\n')[0].trim();
    const li = contentLines.findIndex(l => l.includes(searchFirst));
    if (li < 0) {
      return `\x1b[1m${file}\x1b[0m — search/replace\n` +
        `\x1b[31m- ${search.split('\n')[0]}${search.includes('\n') ? ' …' : ''}\x1b[0m\n` +
        `\x1b[32m+ ${replace.split('\n')[0]}${replace.includes('\n') ? ' …' : ''}\x1b[0m`;
    }

    const out = [];
    for (const hunk of patch.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const absStart = li + hunk.oldStart;
      const absEnd = li + hunk.oldStart + hunk.oldLines - 1;
      out.push(`\x1b[1m${file}\x1b[0m — L${absStart}–L${absEnd}`);

      for (const line of hunk.lines) {
        const prefix = line[0];
        const text = line.slice(1);
        if (prefix === ' ') {
          out.push(` \x1b[90m${String(li + oldLine).padStart(4)}│ ${text}\x1b[0m`);
          oldLine++; newLine++;
        } else if (prefix === '-') {
          out.push(` \x1b[31m-${String(li + oldLine).padStart(4)}│ ${text}\x1b[0m`);
          oldLine++;
        } else if (prefix === '+') {
          out.push(` \x1b[32m+${String(li + newLine).padStart(4)}│ ${text}\x1b[0m`);
          newLine++;
        }
      }
    }
    return out.join('\n');
  }
  return `\x1b[1m${file}\x1b[0m — search/replace\n` +
    `\x1b[31m- ${search.split('\n')[0]}${search.includes('\n') ? ' …' : ''}\x1b[0m\n` +
    `\x1b[32m+ ${replace.split('\n')[0]}${replace.includes('\n') ? ' …' : ''}\x1b[0m`;
}

export async function applySearchReplace(file, search, replace) {
  const content = await readFile(file, 'utf-8');
  if (!content.includes(search)) {
    throw new Error(`Search text not found in ${file}`);
  }
  // Use function replacer to avoid $&, $`, $' interpretation
  const newContent = content.replace(search, () => replace);
  await writeFile(file, newContent, 'utf-8');
  return content;
}

export async function applyFullFileEdit(file, content) {
  const old = await readFile(file, 'utf-8').catch(() => '');
  await writeFile(file, content, 'utf-8');
  return old;
}
