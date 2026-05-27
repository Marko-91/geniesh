// Tree-sitter based extraction for JS/TS/JSX/TSX
import { createRequire } from 'module';

function getRequire() {
  try {
    return createRequire(import.meta.url);
  } catch {
    return (name) => { throw new Error(`Cannot require ${name} in this environment`); };
  }
}

let tsExtractors = null;
function getTSExtractors() {
  if (tsExtractors) return tsExtractors;
  try {
    const napi = getRequire()('@ast-grep/napi');
    const LANG_MAP = {
      '.js': napi.js, '.mjs': napi.js, '.cjs': napi.js,
      '.jsx': napi.jsx, '.ts': napi.ts, '.tsx': napi.tsx,
    };
    const DECL_KINDS = new Set([
      'function_declaration', 'class_declaration', 'lexical_declaration',
      'variable_declaration', 'method_definition', 'arrow_function',
      'generator_function', 'interface_declaration', 'type_alias_declaration',
      'enum_declaration',
    ]);
    tsExtractors = { napi, LANG_MAP, DECL_KINDS };
  } catch {
    tsExtractors = false;
  }
  return tsExtractors;
}

function getLangFromExt(ext) {
  const ts = getTSExtractors();
  if (!ts) return null;
  return ts.LANG_MAP[ext] || null;
}

function getDeclName(node) {
  const kind = node.kind();
  if (['function_declaration', 'class_declaration', 'generator_function',
       'interface_declaration', 'type_alias_declaration', 'enum_declaration'].includes(kind)) {
    const names = node.children().filter(c => c.kind() === 'identifier' || c.kind() === 'type_identifier');
    return names.length > 0 ? names[0].text() : null;
  }
  if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
    for (const c of node.children()) {
      if (c.kind() === 'variable_declarator') {
        const ids = c.children().filter(x => x.kind() === 'identifier');
        if (ids.length > 0) return ids[0].text();
      }
    }
    return null;
  }
  if (kind === 'method_definition') {
    const names = node.children().filter(c => c.kind() === 'property_identifier');
    return names.length > 0 ? names[0].text() : null;
  }
  return null;
}

function toSymbolKind(nodeKind) {
  switch (nodeKind) {
    case 'function_declaration': case 'generator_function':
    case 'method_definition': case 'arrow_function':
      return 'function';
    case 'class_declaration': return 'class';
    case 'lexical_declaration': case 'variable_declaration': return 'variable';
    case 'interface_declaration': case 'type_alias_declaration': return 'type';
    case 'enum_declaration': return 'enum';
    default: return 'reference';
  }
}

export function tsExtractAllSymbolsWithMetadata(content) {
  const ts = getTSExtractors();
  if (!ts) return null;
  try {
    const ast = ts.napi.ts.parse(content);
    const root = ast.root();
    const symbols = [];
    const exportNames = new Set();

    function findExportClauses(node) {
      if (node.kind() === 'export_clause') {
        for (const c of node.children()) {
          if (c.kind() === 'export_specifier') {
            const ids = c.children().filter(x => x.kind() === 'identifier');
            if (ids.length > 0) exportNames.add(ids[0].text());
          }
        }
      }
      if (node.kind() === 'export_statement') {
        const text = node.text();
        const m = text.match(/export\s+default\s+(\w+)/);
        if (m) exportNames.add(m[1]);
      }
      for (const child of node.children()) findExportClauses(child);
    }
    findExportClauses(root);

    function walkDecls(node) {
      for (const child of node.children()) {
        const kind = child.kind();
        if (kind === 'export_statement') { walkDecls(child); continue; }
        if (ts.DECL_KINDS.has(kind)) {
          const name = getDeclName(child);
          if (name) {
            const range = child.range();
            let exported = false;
            const parent = child.parent();
            if (parent && parent.kind() === 'export_statement') exported = true;
            if (exportNames.has(name)) exported = true;
            if (!exported && /module\.exports\s*=|exports\.\w+\s*=/.test(content)) {
              if (new RegExp(`module\\.exports\\.${name}\\b|exports\\.${name}\\b`).test(content)) exported = true;
            }
            symbols.push({
              name, kind: toSymbolKind(kind), exported,
              lineRange: [range.start.line + 1, range.end.line + 1],
            });
          }
        }
        if (kind === 'class_declaration') {
          for (const inner of child.children()) {
            if (inner.kind() === 'class_body') walkDecls(inner);
          }
        }
      }
    }
    walkDecls(root);
    return symbols;
  } catch {
    return null;
  }
}

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

const ENGLISH_NOISE_SYMS = new Set([
  'the','you','this','that','these','those','how','show','what','why','when',
  'where','which','who','are','was','but','not','from','with','they','them',
  'their','your','our','its','has','had','may','can','will','would','could',
  'should','shall','into','about','also','very','just','over','under','here',
  'there','then','else','still','already','more','most','other','each','every',
  'both','few','much','many','some','once','ever','again','upon','down','off',
  'near','red','see','old','out','than','thus','hence','while','after','before',
  'above','below','across','along','among','around','behind','beneath','beside',
  'between','beyond','during','except','inside','outside','since','through',
  'toward','within','without','having','doing','being','going','coming','making',
  'taking','giving','using','finding','keeping','looking','asking','telling',
  'working','calling','thinking','knowing','becoming','beginning','holding',
  'keeping','leaving','meaning','meeting','running','saying','seeing','selling',
  'sending','showing','sitting','speaking','standing','starting','stopping',
  'taking','teaching','telling','thinking','trying','turning','understanding',
  'using','waiting','walking','wanting','watching','working','writing',
  'begin','began','begun','hold','held','keep','kept','lay','laid','lie','lay',
  'rise','rose','risen','sit','sat','stand','stood','leave','left','mean','meant',
  'bring','brought','buy','bought','catch','caught','choose','chose','chosen',
  'come','came','do','did','done','draw','drew','drawn','drink','drank','drunk',
  'drive','drove','driven','eat','ate','eaten','fall','fell','fallen','feel',
  'felt','fight','fought','find','found','fly','flew','flown','forget','forgot',
  'forgiven','freeze','froze','frozen','give','gave','given','go','went','gone',
  'grow','grew','grown','hide','hid','hidden','hurt','know','knew','known',
  'lead','led','lend','lent','let','let','lose','lost','make','made','pay',
  'paid','put','read','ride','rode','ridden','ring','rang','rung','rise','rose',
  'run','ran','say','said','sell','sold','shake','shook','shaken','shine',
  'shone','shoot','shot','shut','shut','sing','sang','sung','sink','sank',
  'sunk','sleep','slept','speak','spoke','spoken','spend','spent','steal',
  'stole','stolen','stick','stuck','strike','struck','swear','swore','sworn',
  'sweep','swept','swim','swam','swum','swing','swung','take','took','taken',
  'teach','taught','tear','tore','torn','tell','told','think','thought',
  'throw','threw','thrown','understand','understood','wake','woke','woken',
  'wear','wore','worn','weep','wept','win','won','write','wrote','written',
]);

function isEnglishNoise(name) {
  return ENGLISH_NOISE_SYMS.has(name.toLowerCase());
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
    .filter(s => !DOMAIN_RE.test(s) && !isEnglishNoise(s))
    .slice(0, 6);
}

export function extractAllSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)].filter(s => !DOMAIN_RE.test(s) && !isEnglishNoise(s));
}

const FUNCTION_DEF_RE = /\b(function|const|let|var)\s+([a-z]{2,})(?:\s*[=(])/g;

const PROPERTY_FN_RE = /(?:\.|['"]?:?\s*)([a-z]{2,})\s*[:=]\s*(?:async\s+)?function\b/g;

const KIND_PREFERENCE = ['class', 'function', 'variable', 'reference'];

function bestKindFromSet(kinds) {
  for (const k of KIND_PREFERENCE) {
    if (kinds.has(k)) return k;
  }
  return 'reference';
}

export function extractAllSymbolsWithMetadata(content, filePath) {
  // Use tree-sitter for JS/TS/JSX/TSX if available
  if (filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const lang = getLangFromExt(ext);
    if (lang) {
      try {
        const ast = lang.parse(content);
        const root = ast.root();
        const symbols = [];
        const exportNames = new Set();
        const ts = getTSExtractors();

        function findExportClauses(node) {
          if (node.kind() === 'export_clause') {
            for (const c of node.children()) {
              if (c.kind() === 'export_specifier') {
                const ids = c.children().filter(x => x.kind() === 'identifier');
                if (ids.length > 0) exportNames.add(ids[0].text());
              }
            }
          }
          if (node.kind() === 'export_statement') {
            const text = node.text();
            const m = text.match(/export\s+default\s+(\w+)/);
            if (m) exportNames.add(m[1]);
          }
          for (const child of node.children()) findExportClauses(child);
        }
        findExportClauses(root);

        function walkDecls(node) {
          for (const child of node.children()) {
            const kind = child.kind();
            if (kind === 'export_statement') { walkDecls(child); continue; }
            if (ts.DECL_KINDS.has(kind)) {
              const name = getDeclName(child);
              if (name) {
                const range = child.range();
                let exported = false;
                const parent = child.parent();
                if (parent && parent.kind() === 'export_statement') exported = true;
                if (exportNames.has(name)) exported = true;
                if (!exported && /module\.exports\s*=|exports\.\w+\s*=/.test(content)) {
                  if (new RegExp(`module\\.exports\\.${name}\\b|exports\\.${name}\\b`).test(content)) exported = true;
                }
                symbols.push({
                  name, kind: toSymbolKind(kind), exported,
                  lineRange: [range.start.line + 1, range.end.line + 1],
                });
              }
            }
            if (kind === 'class_declaration') {
              for (const inner of child.children()) {
                if (inner.kind() === 'class_body') walkDecls(inner);
              }
            }
          }
        }
        walkDecls(root);
        return symbols;
      } catch {}
    }
  }

  // Fall back to regex for unsupported languages
  const lines = content.split('\n');
  const allSyms = new Map();

  const addMatch = (name, lineIndex, kind, exported) => {
    if (DOMAIN_RE.test(name) || isEnglishNoise(name)) return;
    if (!allSyms.has(name)) {
      allSyms.set(name, { kinds: new Set(), exported: false, firstMatchLine: lineIndex, firstDefLine: null });
    }
    const entry = allSyms.get(name);
    entry.kinds.add(kind);
    if (exported) entry.exported = true;
    const isDef = kind === 'class' || kind === 'function' || kind === 'variable';
    if (isDef && entry.firstDefLine === null) entry.firstDefLine = lineIndex;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(SYMBOL_RE)];
    if (matches.length === 0 && !FUNCTION_DEF_RE.test(line) && !PROPERTY_FN_RE.test(line)) continue;

    for (const m of matches) {
      const name = m[1];
      addMatch(name, i, findSymbolKind(line, name), isExported(line, name));
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
  }

  const result = [];
  for (const [name, entry] of allSyms) {
    const kind = bestKindFromSet(entry.kinds);
    const matchLine = entry.firstDefLine !== null ? entry.firstDefLine : entry.firstMatchLine;
    const lineRange = guessLineRange(lines, matchLine, kind);
    result.push({ name, kind, exported: entry.exported, lineRange });
  }
  return result;
}

export function extractDiscoverySymbols(text, maxResults = 6) {
  const raw = [...text.matchAll(DISCOVERY_RE)].map(m => m[1]);
  return [...new Set(raw)].slice(0, maxResults);
}
