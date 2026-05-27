import { createRequire } from 'module';
import { extname, dirname, join } from 'path';

function getRequire() {
  try { return createRequire(import.meta.url); }
  catch { return () => { throw new Error('createRequire not available'); }; }
}
const _require = getRequire();

let napi = null;
const DECL_KINDS = new Set([
  'function_declaration', 'class_declaration', 'lexical_declaration',
  'variable_declaration', 'method_definition', 'arrow_function',
  'generator_function', 'interface_declaration', 'type_alias_declaration',
  'enum_declaration',
]);

function getNapi() {
  if (napi !== null) return napi;
  try {
    napi = _require('@ast-grep/napi');
    return napi;
  } catch {
    napi = false;
    return null;
  }
}

function getLang(ext) {
  const n = getNapi();
  if (!n) return null;
  const map = {
    '.js': n.js, '.mjs': n.js, '.cjs': n.js,
    '.jsx': n.jsx, '.ts': n.ts, '.tsx': n.tsx,
  };
  return map[ext] || null;
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

function toKind(nodeKind) {
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

export function parseJSFile(content, filePath) {
  const lang = getLang(filePath?.slice(filePath.lastIndexOf('.')).toLowerCase());
  if (!lang) return null;

  try {
    const ast = lang.parse(content);
    const root = ast.root();
    const symbols = [];
    const references = [];
    const imports = [];
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

        if (kind === 'call_expression') {
          const fn = child.child(0);
          if (fn) {
            const name = fn.kind() === 'identifier' ? fn.text() :
              fn.kind() === 'member_expression' ? fn.text().split('.').pop() : null;
            if (name) references.push({ name, kind: 'call', lineRange: [fn.range().start.line + 1, fn.range().start.line + 1] });
          }
        }

        if (DECL_KINDS.has(kind)) {
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
              name, kind: toKind(kind), exported,
              lineRange: [range.start.line + 1, range.end.line + 1],
            });
          }
        }

        if (kind === 'class_declaration') {
          for (const inner of child.children()) {
            if (inner.kind() === 'class_body') walkDecls(inner);
          }
        }

        if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
          for (const decl of child.children()) {
            if (decl.kind() === 'variable_declarator') {
              const init = decl.child(2);
              if (init && init.kind() === 'arrow_function') walkDecls(init);
            }
          }
        }
      }
    }
    walkDecls(root);

    const importRE = /(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = importRE.exec(content)) !== null) {
      imports.push({ module: m[1] || m[2], type: 'import' });
    }

    return { symbols, references, imports };
  } catch {
    return null;
  }
}

const JS_RESOLVE_EXTS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs'];

export function resolveImport(mod, sourceDir, knownFiles) {
  let p = mod.replace(/^['"]+|['"]+$/g, '');
  if (!p) return null;

  if (p.startsWith('.')) {
    let clean = p;
    let depth = 0;
    while (clean.startsWith('.') && clean.length > 1) {
      if (clean.startsWith('..')) { depth++; clean = clean.slice(1); }
      else { clean = clean.slice(1); break; }
    }
    clean = clean.replace(/^\/+/, '');
    let base = sourceDir;
    for (let i = 0; i < depth; i++) {
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
    if (clean) {
      const candidate = join(base, clean);
      return tryExtensions(candidate, knownFiles);
    }
  } else {
    return tryExtensions(join(sourceDir, p), knownFiles);
  }

  return null;
}

function tryExtensions(basePath, knownFiles) {
  const normalized = basePath.replace(/\\/g, '/');
  for (const f of knownFiles) {
    const fn = f.replace(/\\/g, '/');
    if (fn === normalized || fn === normalized + '/' || fn.startsWith(normalized + '/.')) return f;
  }
  const ext = extname(basePath).toLowerCase();
  if (ext && knownFiles.has(basePath)) return basePath;
  for (const sExt of JS_RESOLVE_EXTS) {
    const withExt = basePath + sExt;
    if (knownFiles.has(withExt)) return withExt;
    const index = join(basePath, 'index' + sExt);
    if (knownFiles.has(index)) return index;
  }
  const index = join(basePath, 'index');
  if (knownFiles.has(index)) return index;
  if (knownFiles.has(basePath)) return basePath;
  return null;
}
