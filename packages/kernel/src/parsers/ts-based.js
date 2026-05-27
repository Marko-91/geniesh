import { extname } from 'path';
import { initTSParsers } from './index.js';

function nodeText(node) {
  try { return node.text; } catch { return ''; }
}

function nodeRange(node) {
  const sp = node.startPosition;
  const ep = node.endPosition;
  return [sp.row + 1, ep.row + 1];
}

function children(node) {
  const c = node.children;
  return c ? [...c] : [];
}

function namedChildren(node) {
  const c = node.namedChildren;
  return c ? [...c] : [];
}

function childOfType(node, type) {
  for (const c of children(node)) {
    if (c.type === type) return c;
  }
  return null;
}

function childrenOfType(node, type) {
  return children(node).filter(c => c.type === type);
}

function findByType(node, type) {
  const results = [];
  function walk(n) {
    if (n.type === type) results.push(n);
    for (const c of children(n)) walk(c);
  }
  walk(node);
  return results;
}

function findNamedByType(node, type) {
  const results = [];
  function walk(n) {
    if (n.type === type) results.push(n);
    for (const c of namedChildren(n)) walk(c);
  }
  walk(node);
  return results;
}

async function parseWithWasm(content, ext) {
  const parsers = await initTSParsers();
  const p = parsers[ext];
  if (!p) return null;
  try {
    return p.parse(content);
  } catch {
    return null;
  }
}

function extractPython(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'function_definition') {
      const name = childOfType(node, 'identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: false,
        });
      }
      for (const c of namedChildren(node)) walk(c);
    } else if (node.type === 'class_definition') {
      const name = childOfType(node, 'identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'class',
          lineRange: nodeRange(node), exported: false,
        });
      }
      const bases = findByType(node, 'argument_list');
      for (const base of bases) {
        for (const id of findAllIdentifiers(base)) {
          const r = nodeRange(node);
          references.push({ name: id, kind: 'reference', lineRange: [r[0], r[0]] });
        }
      }
      for (const c of namedChildren(node)) walk(c);
    } else if (node.type === 'assignment') {
      const left = childOfType(node, 'identifier');
      if (left && node.parent?.type === 'module') {
        const isAnnotated = childOfType(node, 'type') !== null;
        symbols.push({
          name: nodeText(left), kind: isAnnotated ? 'variable' : 'variable',
          lineRange: nodeRange(node), exported: true,
        });
      }
      for (const c of namedChildren(node)) {
        if (c.type !== 'identifier') walk(c);
      }
    } else if (node.type === 'call') {
      const fn = childOfType(node, 'identifier') || childOfType(node, 'attribute');
      if (fn) {
        const name = fn.type === 'attribute' ? nodeText(fn).split('.').pop() : nodeText(fn);
        references.push({ name, kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
      }
    } else {
      for (const c of namedChildren(node)) walk(c);
    }
  }

  function findAllIdentifiers(node) {
    const ids = [];
    function find(n) {
      if (n.type === 'identifier') ids.push(nodeText(n));
      for (const c of namedChildren(n)) find(c);
    }
    find(node);
    return ids;
  }

  const importStmts = [
    ...findByType(root, 'import_statement'),
    ...findByType(root, 'import_from_statement'),
  ];

  for (const imp of importStmts) {
    const mods = childrenOfType(imp, 'dotted_name').map(nodeText);
    imports.push({ module: mods.join('.'), type: 'import' });
  }

  walk(root);

  return { symbols, references, imports };
}

function extractGo(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'function_declaration') {
      const name = childOfType(node, 'identifier');
      if (name) {
        const isMethod = childOfType(node, 'receiver') !== null;
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: nodeText(name)[0] >= 'A' && nodeText(name)[0] <= 'Z',
        });
      }
    } else if (node.type === 'method_declaration') {
      const name = childOfType(node, 'field_identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: nodeText(name)[0] >= 'A' && nodeText(name)[0] <= 'Z',
        });
      }
    } else if (node.type === 'type_declaration') {
      for (const td of namedChildren(node)) {
        const name = childOfType(td, 'type_identifier');
        if (name) {
          symbols.push({
            name: nodeText(name), kind: 'type',
            lineRange: nodeRange(td), exported: nodeText(name)[0] >= 'A' && nodeText(name)[0] <= 'Z',
          });
        }
      }
    } else if (node.type === 'type_spec') {
      const name = childOfType(node, 'type_identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'type',
          lineRange: nodeRange(node), exported: nodeText(name)[0] >= 'A' && nodeText(name)[0] <= 'Z',
        });
      }
    } else if (node.type === 'call_expression') {
      const fn = node.firstNamedChild;
      if (fn) {
        const name = fn.type === 'identifier' ? nodeText(fn) :
                     fn.type === 'field_expression' ? nodeText(fn).split('.').pop() : null;
        if (name) {
          references.push({ name, kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
        }
      }
    } else {
      for (const c of namedChildren(node)) walk(c);
    }
  }

  const importDecls = findByType(root, 'import_declaration');
  for (const imp of importDecls) {
    for (const spec of findByType(imp, 'import_spec')) {
      const path = childOfType(spec, 'interpreted_string_literal');
      if (path) imports.push({ module: nodeText(path).replace(/"/g, ''), type: 'import' });
    }
  }

  walk(root);
  return { symbols, references, imports };
}

function extractRust(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'function_item' || node.type === 'function_signature') {
      const name = childOfType(node, 'identifier');
      if (name) {
        const pub = findByType(node, 'visibility_modifier').length > 0;
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: pub,
        });
      }
    } else if (node.type === 'struct_item' || node.type === 'enum_item') {
      const name = childOfType(node, 'type_identifier');
      if (name) {
        const pub = findByType(node, 'visibility_modifier').length > 0;
        symbols.push({
          name: nodeText(name), kind: 'type',
          lineRange: nodeRange(node), exported: pub,
        });
      }
    } else if (node.type === 'impl_item') {
      const type = childOfType(node, 'type_identifier');
      if (type) {
        symbols.push({
          name: nodeText(type), kind: 'class',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (node.type === 'call_expression') {
      const fn = node.firstNamedChild;
      if (fn) {
        const name = fn.type === 'identifier' ? nodeText(fn) :
                     fn.type === 'scoped_identifier' ? nodeText(fn).split('::').pop() : null;
        if (name) {
          references.push({ name, kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
        }
      }
    } else {
      for (const c of namedChildren(node)) walk(c);
    }
  }

  const useItems = findByType(root, 'use_declaration');
  for (const item of useItems) {
    imports.push({ module: nodeText(item).replace(/^use\s+/, '').replace(/;\s*$/, ''), type: 'import' });
  }

  walk(root);
  return { symbols, references, imports };
}

function extractJava(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'method_declaration') {
      const name = childOfType(node, 'identifier');
      if (name) {
        const mods = childrenOfType(node, 'modifiers').flatMap(m => children(m).map(c => nodeText(c)));
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: mods.includes('public'),
        });
      }
    } else if (node.type === 'class_declaration') {
      const name = childOfType(node, 'identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'class',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (node.type === 'interface_declaration') {
      const name = childOfType(node, 'identifier');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'interface',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (node.type === 'method_invocation') {
      const name = childOfType(node, 'identifier');
      if (name) {
        references.push({ name: nodeText(name), kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
      }
    } else {
      for (const c of namedChildren(node)) walk(c);
    }
  }

  const importDecls = findByType(root, 'import_declaration');
  for (const imp of importDecls) {
    const scoped = childOfType(imp, 'scoped_identifier');
    if (scoped) imports.push({ module: nodeText(scoped), type: 'import' });
  }

  walk(root);
  return { symbols, references, imports };
}

function extractC(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'function_definition') {
      const decl = childOfType(node, 'function_declarator');
      const name = decl ? childOfType(decl, 'identifier') : null;
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (node.type === 'declaration') {
      const decl = childOfType(node, 'init_declarator') || childOfType(node, 'function_declarator');
      if (decl) {
        const name = childOfType(decl, 'identifier');
        if (name && name !== decl) {
          const isFn = childOfType(decl, 'parameter_list') !== null;
          symbols.push({
            name: nodeText(name), kind: isFn ? 'function' : 'variable',
            lineRange: nodeRange(node), exported: true,
          });
        }
      }
    } else if (node.type === 'call_expression') {
      const fn = childOfType(node, 'identifier');
      if (fn) {
        references.push({ name: nodeText(fn), kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
      }
    } else {
      for (const c of namedChildren(node)) walk(c);
    }
  }

  const preproc = findByType(root, 'preproc_include');
  for (const inc of preproc) {
    const path = childOfType(inc, 'string_literal') || childOfType(inc, 'system_lib_string');
    if (path) imports.push({ module: nodeText(path).replace(/["<>]/g, ''), type: 'include' });
  }

  walk(root);
  return { symbols, references, imports };
}

function extractPHP(tree, filePath) {
  const root = tree.rootNode;
  const symbols = [];
  const references = [];
  const imports = [];

  function walk(node) {
    const type = node.type;

    if (type === 'function_definition') {
      const name = childOfType(node, 'name');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (type === 'method_declaration') {
      const name = childOfType(node, 'name');
      const mods = childrenOfType(node, 'visibility_modifier').map(nodeText);
      if (name) {
        symbols.push({
          name: nodeText(name), kind: 'function',
          lineRange: nodeRange(node), exported: mods.includes('public'),
        });
      }
    } else if (type === 'class_declaration' || type === 'interface_declaration' || type === 'trait_declaration') {
      const name = childOfType(node, 'name');
      if (name) {
        symbols.push({
          name: nodeText(name), kind: type === 'class_declaration' ? 'class' : 'interface',
          lineRange: nodeRange(node), exported: true,
        });
      }
    } else if (['function_call_expression', 'method_call_expression', 'scoped_call_expression'].includes(type)) {
      const fn = childOfType(node, 'name') || childOfType(node, 'function_name');
      if (fn) {
        references.push({ name: nodeText(fn), kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
      }
    }

    for (const c of namedChildren(node)) walk(c);
  }

  walk(root);

  const phpUseRE = /^\s*use\s+([^;]+)/gm;
  let m;
  while ((m = phpUseRE.exec(tree.text || '')) !== null) {
    const parts = m[1].split('\\').filter(Boolean);
    imports.push({ module: parts.join('/'), type: 'import' });
  }

  return { symbols, references, imports };
}

export async function parseTSFile(content, filePath) {
  const ext = extname(filePath).toLowerCase();
  const parsers = await initTSParsers();
  const parser = parsers[ext];
  if (!parser) return null;

  const tree = await parseWithWasm(content, ext);
  if (!tree) return null;

  switch (ext) {
    case '.py': return extractPython(tree, filePath);
    case '.go': return extractGo(tree, filePath);
    case '.rs': return extractRust(tree, filePath);
    case '.java': return extractJava(tree, filePath);
    case '.c': case '.cpp': case '.h': return extractC(tree, filePath);
    case '.php': return extractPHP(tree, filePath);
    default: return null;
  }
}


