import { createRequire } from 'module';

function getRequire() {
  try { return createRequire(import.meta.url); }
  catch { return () => { throw new Error('createRequire not available'); }; }
}
const _require = getRequire();

let tsPhp = null;

function getPhp() {
  if (tsPhp !== null) return tsPhp;
  try {
    tsPhp = _require('tree-sitter-php');
    return tsPhp;
  } catch {
    tsPhp = false;
    return null;
  }
}

export function parsePHPFile(content, filePath) {
  const PHP = getPhp();
  if (!PHP) return null;

  try {
    const Parser = _require('web-tree-sitter').default;
    if (!Parser) return null;
    // tree-sitter-php exports a Language
    const parser = new Parser();
    parser.setLanguage(PHP);
    const tree = parser.parse(content);
    if (!tree) return null;

    const root = tree.rootNode;
    const symbols = [];
    const references = [];
    const imports = [];

    function nodeText(node) {
      try { return node.text; } catch { return ''; }
    }

    function nodeRange(node) {
      return [node.startPosition.row + 1, node.endPosition.row + 1];
    }

    function walk(node) {
      const type = node.type;

      if (type === 'function_definition') {
        const name = findChild(node, 'name');
        if (name) {
          symbols.push({
            name: nodeText(name), kind: 'function',
            lineRange: nodeRange(node), exported: true,
          });
        }
      } else if (type === 'method_declaration') {
        const name = findChild(node, 'name');
        if (name) {
          const mods = findChildren(node, 'visibility_modifier').map(n => nodeText(n));
          symbols.push({
            name: nodeText(name), kind: 'function',
            lineRange: nodeRange(node), exported: mods.includes('public'),
          });
        }
      } else if (type === 'class_declaration' || type === 'interface_declaration' || type === 'trait_declaration') {
        const name = findChild(node, 'name');
        if (name) {
          symbols.push({
            name: nodeText(name), kind: type === 'class_declaration' ? 'class' : 'interface',
            lineRange: nodeRange(node), exported: true,
          });
        }
      } else if (type === 'function_call_expression' || type === 'method_call_expression' || type === 'scoped_call_expression') {
        const fn = findChildren(node, 'name')[0] || findChildren(node, 'function_name')[0];
        if (fn) {
          references.push({ name: nodeText(fn), kind: 'call', lineRange: [nodeRange(node)[0], nodeRange(node)[0]] });
        }
      }

      for (const c of node.children || []) walk(c);
    }

    function findChild(node, type) {
      for (const c of node.children || []) {
        if (c.type === type) return c;
      }
      return null;
    }

    function findChildren(node, type) {
      return (node.children || []).filter(c => c.type === type);
    }

    walk(root);

    const useRE = /^\s*use\s+([^;]+)/gm;
    let m;
    while ((m = useRE.exec(content)) !== null) {
      const parts = m[1].split('\\').filter(Boolean);
      imports.push({ module: parts.join('/'), type: 'import' });
    }

    return { symbols, references, imports };
  } catch {
    return null;
  }
}
