import { readFile } from './fs-utils.js';
import { parseFile, ensureTSParsers, SOURCE_EXTS } from './parsers/index.js';
import { detectCommunities } from './community.js';
import { chunkFile } from './chunker.js';
import { extname, dirname, join } from 'path';
import { stat } from 'fs/promises';

function nodeId(file, name) {
  return name ? `sym://${file}:${name}` : `file://${file}`;
}

export class CodeGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
    this.adj = new Map();
    this.revAdj = new Map();
    this.fileHashes = new Map();
    this.chunks = [];
    this.communityIds = new Map();
    this.communityCount = 0;
  }

  addNode(id, data) {
    if (this.nodes.has(id)) {
      const existing = this.nodes.get(id);
      if (data.lineRange && (!existing.lineRange || data.lineRange[1] - data.lineRange[0] > existing.lineRange[1] - existing.lineRange[0])) {
        existing.lineRange = data.lineRange;
      }
      if (data.exported && !existing.exported) existing.exported = true;
      return;
    }
    this.nodes.set(id, { ...data, id });
  }

  addFileNode(file) {
    const id = nodeId(file);
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, type: 'file', file, kind: 'file' });
    }
  }

  addEdge(fromId, toId, relation, at) {
    this.edges.push({ from: fromId, to: toId, relation, at: at || null });

    if (!this.adj.has(fromId)) this.adj.set(fromId, []);
    this.adj.get(fromId).push({ to: toId, relation, at: at || null });

    if (!this.revAdj.has(toId)) this.revAdj.set(toId, []);
    this.revAdj.get(toId).push({ from: fromId, relation, at: at || null });
  }

  getNeighbors(id, depth = 1, maxNodes = Infinity) {
    const seen = new Set([id]);
    const result = [];
    let queue = [id];

    for (let d = 0; d < depth && queue.length > 0 && result.length < maxNodes; d++) {
      const next = [];
      for (const nodeId of queue) {
        const forward = this.adj.get(nodeId) || [];
        const backward = this.revAdj.get(nodeId) || [];
        for (const edge of [...forward, ...backward]) {
          const neighborId = edge.to !== undefined ? edge.to : edge.from;
          if (neighborId === undefined || seen.has(neighborId)) continue;
          seen.add(neighborId);
          result.push({ node: this.nodes.get(neighborId), edge, distance: d + 1 });
          if (result.length >= maxNodes) break;
          next.push(neighborId);
        }
        if (result.length >= maxNodes) break;
      }
      queue = next;
    }

    return result;
  }

  getCallers(symId) {
    return (this.revAdj.get(symId) || []).filter(e => e.relation === 'calls').map(e => ({
      node: this.nodes.get(e.from),
      at: e.at,
    }));
  }

  getCallees(symId) {
    return (this.adj.get(symId) || []).filter(e => e.relation === 'calls').map(e => ({
      node: this.nodes.get(e.to),
      at: e.at,
    }));
  }

  getFileSymbols(file) {
    const fileId = nodeId(file);
    const symbols = [];
    for (const [id, node] of this.nodes) {
      if (node.type === 'symbol' && node.file === file) {
        symbols.push(node);
      }
    }
    return symbols;
  }

  getSymbol(name) {
    const results = [];
    for (const [id, node] of this.nodes) {
      if (node.type === 'symbol' && node.name === name) {
        results.push(node);
      }
    }
    return results;
  }

  getFileImports(file) {
    const fileId = nodeId(file);
    return (this.adj.get(fileId) || []).filter(e => e.relation === 'imports').map(e => ({
      file: this.nodes.get(e.to)?.file || e.to.replace('file://', ''),
    }));
  }

  getFileImporters(file) {
    const fileId = nodeId(file);
    return (this.revAdj.get(fileId) || []).filter(e => e.relation === 'imports').map(e => ({
      file: this.nodes.get(e.from)?.file || e.from.replace('file://', ''),
    }));
  }

  getCommunity(communityId) {
    const nodes = [];
    for (const [id, node] of this.nodes) {
      if (node.community === communityId) nodes.push(node);
    }
    return nodes;
  }

  addSymbolNode(name, file, kind, lineRange, exported) {
    const id = nodeId(file, name);
    this.addNode(id, {
      type: 'symbol', name, file, kind, lineRange, exported,
    });
    return id;
  }

  toJSON() {
    const nodes = {};
    for (const [id, node] of this.nodes) {
      nodes[id] = node;
    }
    return {
      version: 3,
      nodes,
      edges: this.edges,
      chunks: this.chunks,
      fileHashes: Object.fromEntries(this.fileHashes),
      communityCount: this.communityCount,
    };
  }

  static fromJSON(json) {
    const graph = new CodeGraph();
    if (!json || !json.nodes) return graph;

    for (const [id, data] of Object.entries(json.nodes)) {
      graph.nodes.set(id, { ...data, id });
    }
    for (const edge of json.edges || []) {
      graph.edges.push(edge);
      if (!graph.adj.has(edge.from)) graph.adj.set(edge.from, []);
      graph.adj.get(edge.from).push({ to: edge.to, relation: edge.relation, at: edge.at });
      if (!graph.revAdj.has(edge.to)) graph.revAdj.set(edge.to, []);
      graph.revAdj.get(edge.to).push({ from: edge.from, relation: edge.relation, at: edge.at });
    }
    graph.chunks = json.chunks || [];
    graph.fileHashes = new Map(Object.entries(json.fileHashes || {}));
    graph.communityCount = json.communityCount || 0;
    return graph;
  }
}

function fileHash(mtimeMs, size) {
  return `${mtimeMs}-${size}`;
}

function copyFileGraph(graph, prevGraph, file) {
  const fileId = nodeId(file);
  if (prevGraph.nodes.has(fileId)) {
    graph.nodes.set(fileId, { ...prevGraph.nodes.get(fileId) });
  }
  for (const [id, node] of prevGraph.nodes) {
    if (node.file === file && node.type === 'symbol') {
      graph.nodes.set(id, { ...node, id });
    }
  }
  for (const edge of prevGraph.edges) {
    const fromFile = edge.from.startsWith('sym://')
      ? decodeURIComponent(edge.from.slice(6)).split(':')[0]
      : decodeURIComponent(edge.from.slice(7));
    const toFile = edge.to.startsWith('sym://')
      ? decodeURIComponent(edge.to.slice(6)).split(':')[0]
      : decodeURIComponent(edge.to.slice(7));
    if (fromFile === file || toFile === file) {
      graph.edges.push({ ...edge });
      if (!graph.adj.has(edge.from)) graph.adj.set(edge.from, []);
      graph.adj.get(edge.from).push({ to: edge.to, relation: edge.relation, at: edge.at });
      if (!graph.revAdj.has(edge.to)) graph.revAdj.set(edge.to, []);
      graph.revAdj.get(edge.to).push({ from: edge.from, relation: edge.relation, at: edge.at });
    }
  }
}

function tryResolve(mod, sourceDir, knownFiles) {
  let p = mod.replace(/^['"]+|['"]+$/g, '');
  if (!p) return null;
  let resolved = null;

  if (p.startsWith('.')) {
    let clean = p;
    let depth = 0;
    while (clean.startsWith('.') && clean.length > 1) {
      if (clean.startsWith('..')) { depth++; clean = clean.slice(1); }
      else { clean = clean.slice(1); break; }
    }
    clean = clean.replace(/^[/\\]+/, '');
    let base = sourceDir;
    for (let i = 0; i < depth && base.length > 0; i++) {
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }

    if (!clean) {
      const initPy = join(base, '__init__.py').replace(/\\/g, '/');
      if (knownFiles.has(initPy)) return initPy;
      return tryExtensions(join(base, 'index'), knownFiles);
    }

    const candidate = join(base, clean);
    resolved = tryExtensions(candidate, knownFiles);

    if (!resolved && clean.includes('.') && !extname(clean)) {
      resolved = tryExtensions(join(base, clean.replace(/\./g, '/')), knownFiles);
    }
  } else {
    resolved = tryExtensions(join(sourceDir, p), knownFiles);

    if (!resolved && p.includes('.')) {
      resolved = tryExtensions(join(sourceDir, p.replace(/\./g, '/')), knownFiles);
    }

    if (!resolved) {
      const lastSeg = p.split('/').pop();
      if (lastSeg !== p) resolved = tryExtensions(join(sourceDir, lastSeg), knownFiles);
    }
  }

  return resolved;
}

function tryExtensions(basePath, knownFiles) {
  basePath = basePath.replace(/\\/g, '/');
  for (const f of knownFiles) {
    const fn = f.replace(/\\/g, '/');
    if (fn === basePath || fn === basePath + '/' || fn.startsWith(basePath + '/.')) return f;
  }
  const ext = extname(basePath).toLowerCase();
  if (ext && knownFiles.has(basePath)) return basePath;
  for (const sExt of SOURCE_EXTS) {
    const withExt = basePath + sExt;
    if (knownFiles.has(withExt)) return withExt;
    const index = join(basePath, 'index' + sExt).replace(/\\/g, '/');
    if (knownFiles.has(index)) return index;
  }
  const initPy = join(basePath, '__init__.py').replace(/\\/g, '/');
  if (knownFiles.has(initPy)) return initPy;
  return null;
}

export function resolveImportPath(mod, sourceDir, knownFiles) {
  return tryResolve(mod, sourceDir, knownFiles);
}

function extractImportBindings(content, ext) {
  const bindings = [];
  const lang = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext) ? 'js' :
               ext === '.py' ? 'py' : null;
  if (!lang) return bindings;

  if (lang === 'js') {
    const re = /import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const clause = m[1].trim();
      const mod = m[2];
      if (clause.startsWith('{')) {
        const inner = clause.slice(1, -1).trim();
        for (const spec of inner.split(',')) {
          const parts = spec.trim().split(/\s+as\s+/);
          const importedName = parts[0].trim();
          const localName = parts.length > 1 ? parts[1].trim() : importedName;
          bindings.push({ localName, importedName, sourceModule: mod });
        }
      } else if (clause.startsWith('*')) {
        const parts = clause.split(/\s+as\s+/);
        if (parts.length > 1) bindings.push({ localName: parts[1].trim(), importedName: '*', sourceModule: mod });
      } else if (/^\w+$/.test(clause)) {
        bindings.push({ localName: clause, importedName: 'default', sourceModule: mod });
      }
    }
  } else if (lang === 'py') {
    const re = /from\s+([\w.]+)\s+import\s+(.+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const mod = m[1];
      for (const target of m[2].split(',')) {
        const parts = target.trim().split(/\s+as\s+/);
        const importedName = parts[0].trim();
        const localName = parts.length > 1 ? parts[1].trim() : importedName;
        bindings.push({ localName, importedName, sourceModule: mod });
      }
    }
  }
  return bindings;
}

async function statSafe(file) {
  try { return await stat(file); } catch { return null; }
}

export async function buildGraph(dir, files, prevGraph = null, onProgress = null) {
  await ensureTSParsers();

  const graph = new CodeGraph();
  const knownFiles = new Set(files);
  const prevHashes = prevGraph ? prevGraph.fileHashes : new Map();
  const parsed = [];
  const unchangedFiles = [];
  const total = files.length;
  let done = 0;

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) { done++; continue; }

    const s = await statSafe(file);
    if (!s) { done++; continue; }
    const hash = fileHash(s.mtimeMs, s.size);
    const prevHash = prevHashes.get(file);

    if (prevGraph && prevHash === hash) {
      unchangedFiles.push(file);
      done++;
      if (onProgress) onProgress({ phase: 'parse', current: done, total, file });
      continue;
    }

    let content;
    try { content = await readFile(file); } catch { done++; continue; }
    const result = await parseFile(content, file);
    result.file = file;
    result.ext = ext;
    result.hash = hash;
    result.importBindings = extractImportBindings(content, ext);
    parsed.push(result);
    done++;
    if (onProgress) onProgress({ phase: 'parse', current: done, total, file });
  }

  for (const file of unchangedFiles) {
    copyFileGraph(graph, prevGraph, file);
  }

  const parsedTotal = parsed.length;
  for (let i = 0; i < parsedTotal; i++) {
    const { file, symbols, references, imports, importBindings } = parsed[i];
    if (onProgress) onProgress({ phase: 'graph', current: i + 1, total: parsedTotal, file });
    graph.addFileNode(file);

    for (const sym of symbols) {
      graph.addSymbolNode(sym.name, file, sym.kind, sym.lineRange, sym.exported !== false);
      graph.addEdge(nodeId(file), nodeId(file, sym.name), 'contains', [sym.lineRange[0], sym.lineRange[1]]);
    }

    for (const ref of references) {
      const refId = nodeId(file, ref.name);
      const refData = { type: 'symbol', name: ref.name, file, kind: 'reference', lineRange: ref.lineRange, exported: false };
      if (!graph.nodes.has(refId)) graph.addNode(refId, refData);

      let targets = graph.getSymbol(ref.name)
        .filter(s => s.file !== file || s.lineRange[0] !== ref.lineRange[0]);

      if (targets.length === 0) {
        const binding = importBindings.find(b => b.localName === ref.name && b.importedName !== '*' && b.importedName !== 'default');
        if (binding) {
          const imp = imports.find(i => i.module === binding.sourceModule);
          if (imp) {
            const resolvedFile = resolveImportPath(imp.module, dirname(file), knownFiles);
            if (resolvedFile) {
              targets = graph.getSymbol(binding.importedName)
                .filter(s => s.file === resolvedFile);
            }
          }
        }
      }

      if (targets.length > 0) {
        for (const target of targets) {
          graph.addEdge(refId, target.id, 'calls', ref.lineRange);
        }
      }
    }

    for (const imp of imports) {
      const resolvedFile = resolveImportPath(imp.module, dirname(file), knownFiles);
      if (resolvedFile) {
        graph.addFileNode(resolvedFile);
        graph.addEdge(nodeId(file), nodeId(resolvedFile), 'imports');
      }
    }
  }

  graph.communityCount = detectCommunities(graph);
  const allFileHashes = new Map();
  for (const file of files) {
    const s = await statSafe(file);
    if (s) allFileHashes.set(file, fileHash(s.mtimeMs, s.size));
  }
  graph.fileHashes = allFileHashes;

  return graph;
}

export function buildChunks(graph, files, contentMap) {
  const chunks = [];
  for (const file of files) {
    const content = contentMap.get(file);
    if (!content) continue;
    const fileChunks = chunkFile(file, content);
    chunks.push(...fileChunks.map(c => ({ ...c, nodeId: nodeId(file) })));
  }
  graph.chunks = chunks;
  return chunks;
}
