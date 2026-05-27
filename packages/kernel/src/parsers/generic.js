const SYMBOL_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  '|[a-z][a-z0-9]+_[a-z][a-z0-9_]+' +
  '|[a-z][a-z0-9]+(?:-[a-z][a-z0-9]+)+' +
  '|[a-z][a-z0-9]+(?:\\.[a-z][a-z0-9]+)+' +
  '|[A-Z][a-z]+[a-zA-Z0-9]*(?:\\.[a-zA-Z_$][a-zA-Z0-9_$]*)+' +
  '|[A-Z][a-z]{2,}' +
  '|[A-Z]{2,}(?:_[A-Z0-9]+)+' +
  ')\\b', 'g',
);

const FUNCTION_DEF_RE = /\b(function|const|let|var)\s+([a-z]{2,})(?:\s*[=(])/g;
const PROPERTY_FN_RE = /(?:\.|['"]?:?\s*)([a-z]{2,})\s*[:=]\s*(?:async\s+)?function\b/g;

const DOMAIN_RE = /\.(com|net|org|io|co|php|js|ts|html|css|json|md|txt|edu|gov|app|dev)(\.|$)/i;

const ENGLISH_NOISE = new Set([
  'the','this','that','these','those','how','what','why','when','where','which',
  'are','was','but','not','from','with','they','them','their','your','our','its',
  'has','had','may','can','will','would','could','should','shall','into','about',
  'also','very','just','over','under','here','there','then','else','still','more',
  'most','other','each','every','both','few','much','many','some','once','again',
  'upon','down','off','near','see','old','out','than','thus','while','after',
  'before','above','below','having','doing','being','going','coming','making',
  'taking','giving','using','finding','keeping','looking','asking','telling',
  'working','calling','thinking','knowing','become','became','begin','began',
  'begin','hold','held','keep','kept','leave','left','mean','meant','running',
  'saying','seeing','selling','sending','showing','sitting','speaking','standing',
  'starting','taking','teaching','telling','trying','turning','understanding',
  'using','waiting','walking','wanting','watching','working','writing',
]);

const KIND_PREFERENCE = ['class', 'function', 'variable', 'reference'];

function isNoise(name) {
  return DOMAIN_RE.test(name) || ENGLISH_NOISE.has(name.toLowerCase());
}

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

function findScopeEnd(lines, startIndex) {
  let depth = 0, started = false;
  for (let i = startIndex; i < lines.length; i++) {
    const { open, close } = countBraces(lines[i]);
    if (open > 0) { depth += open; started = true; }
    depth -= close;
    if (started && depth <= 0) return i;
  }
  return startIndex;
}

function guessLineRange(lines, lineIndex, kind) {
  if (kind === 'class' || kind === 'function') {
    return [lineIndex + 1, findScopeEnd(lines, lineIndex) + 1];
  }
  return [lineIndex + 1, lineIndex + 1];
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
  if (/^\s*export\s/.test(line)) return true;
  if (new RegExp(`module\\.exports\\.${n}\\b`).test(line)) return true;
  if (new RegExp(`exports\\.${n}\\b`).test(line)) return true;
  return false;
}

export function parseGenericFile(content, filePath) {
  const lines = content.split('\n');
  const allSyms = new Map();
  const references = [];
  const imports = [];

  function addMatch(name, lineIndex, kind, exported) {
    if (isNoise(name)) return;
    if (!allSyms.has(name)) {
      allSyms.set(name, { kinds: new Set(), exported: false, firstMatchLine: lineIndex, firstDefLine: null });
    }
    const entry = allSyms.get(name);
    entry.kinds.add(kind);
    if (exported || kind === 'class') entry.exported = true;
    if ((kind === 'class' || kind === 'function' || kind === 'variable') && entry.firstDefLine === null) {
      entry.firstDefLine = lineIndex;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(SYMBOL_RE)];
    if (matches.length === 0 && !FUNCTION_DEF_RE.test(line) && !PROPERTY_FN_RE.test(line)) continue;

    for (const m of matches) {
      const name = m[1];
      const kind = findSymbolKind(line, name);
      addMatch(name, i, kind, isExported(line, name));
      if (kind === 'function' && line.includes(name + '(')) {
        references.push({ name, kind: 'call', lineRange: [i + 1, i + 1] });
      }
    }

    FUNCTION_DEF_RE.lastIndex = 0;
    let fm;
    while ((fm = FUNCTION_DEF_RE.exec(line)) !== null) {
      addMatch(fm[2], i, 'function', isExported(line, fm[2]));
    }

    PROPERTY_FN_RE.lastIndex = 0;
    let pm;
    while ((pm = PROPERTY_FN_RE.exec(line)) !== null) {
      addMatch(pm[1], i, 'function', isExported(line, pm[1]));
    }

    const importMatch = line.match(/(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|#include\s+"([^"]+)"/);
    if (importMatch) {
      const mod = importMatch[1] || importMatch[2] || importMatch[3];
      if (mod) imports.push({ module: mod, type: 'import' });
    }
  }

  const symbols = [];
  for (const [name, entry] of allSyms) {
    const kindOrder = ['class', 'function', 'variable', 'reference'];
    let bestKind = 'reference';
    for (const k of kindOrder) {
      if (entry.kinds.has(k)) { bestKind = k; break; }
    }
    const matchLine = entry.firstDefLine !== null ? entry.firstDefLine : entry.firstMatchLine;
    symbols.push({
      name, kind: bestKind, exported: entry.exported,
      lineRange: guessLineRange(lines, matchLine, bestKind),
    });
  }

  return { symbols, references, imports };
}
