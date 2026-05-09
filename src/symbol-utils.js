const SYMBOL_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  '|[a-z][a-z0-9]+_[a-z][a-z0-9_]+' +
  '|[a-z][a-z0-9]+(?:\\.[a-z][a-z0-9]+)+' +
  '|[A-Z][a-z]+[a-zA-Z0-9]*(?:\\.[a-zA-Z_$][a-zA-Z0-9_$]*)+' +
  '|[A-Z][a-z]{3,}' +
  '|[A-Z]{2,}(?:_[A-Z0-9]+)+' +
  ')\\b',
  'g',
);

const DISCOVERY_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  ')\\b',
  'g',
);

const DOMAIN_RE = /\.(com|net|org|io|co|php|js|ts|html|css|json|md|txt|edu|gov|app|dev)(\.|$)/i;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countBraces(line) {
  let open = 0, close = 0;
  for (const ch of line) {
    if (ch === '{') open++;
    if (ch === '}') close++;
  }
  return { open, close };
}

function findSymbolKind(line, name) {
  const n = escapeRegex(name);
  if (new RegExp(`\\bclass\\s+${n}\\b`).test(line)) return 'class';
  if (new RegExp(`\\bfunction\\s+${n}\\b`).test(line)) return 'function';
  if (new RegExp(`\\b(const|let|var)\\s+${n}\\b`).test(line)) return 'variable';
  if (new RegExp(`${n}\\s*[=:]\\s*(?:async\\s+)?\\(`).test(line)) return 'function';
  if (new RegExp(`${n}\\s*[=:]\\s*(?:async\\s+)?function`).test(line)) return 'function';
  if (new RegExp(`\\bget\\s+${n}\\b`).test(line)) return 'function';
  if (new RegExp(`\\bset\\s+${n}\\b`).test(line)) return 'function';
  if (new RegExp(`${n}\\s*\\(`).test(line) && !new RegExp(`\\bnew\\s+${n}\\b`).test(line)) return 'function';
  return 'reference';
}

function isExported(line, name) {
  const n = escapeRegex(name);
  if (/\bexport\b/.test(line)) return true;
  if (new RegExp(`module\\.exports\\.${n}\\b`).test(line)) return true;
  if (new RegExp(`module\\.exports\\s*=\\s*\\{`).test(line)) return true;
  if (new RegExp(`exports\\.${n}\\b`).test(line)) return true;
  return false;
}

function findScopeEnd(lines, startIndex) {
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < lines.length; i++) {
    const { open, close } = countBraces(lines[i]);
    if (open > 0) { depth += open; started = true; }
    depth -= close;
    if (started && depth <= 0) return i;
  }
  return startIndex;
}

function guessLineRange(lines, matchLine, kind) {
  if (kind === 'class' || kind === 'function') {
    const end = findScopeEnd(lines, matchLine);
    return [matchLine + 1, end + 1];
  }
  return [matchLine + 1, matchLine + 1];
}

export function extractSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)]
    .filter(s => !DOMAIN_RE.test(s))
    .slice(0, 6);
}

export function extractAllSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)].filter(s => !DOMAIN_RE.test(s));
}

export function extractAllSymbolsWithMetadata(content) {
  const lines = content.split('\n');
  const seen = new Set();
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(SYMBOL_RE)];
    if (matches.length === 0) continue;

    for (const m of matches) {
      const name = m[1];
      if (seen.has(name) || DOMAIN_RE.test(name)) continue;
      seen.add(name);

      const kind = findSymbolKind(line, name);
      const exported = isExported(line, name);
      const lineRange = guessLineRange(lines, i, kind);

      result.push({ name, kind, exported, lineRange });
    }
  }

  return result;
}

export function extractDiscoverySymbols(text, maxResults = 6) {
  const raw = [...text.matchAll(DISCOVERY_RE)].map(m => m[1]);
  return [...new Set(raw)].slice(0, maxResults);
}
