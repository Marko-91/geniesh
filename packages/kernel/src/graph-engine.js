import { readFile } from './fs-utils.js';
import { parseFile, ensureTSParsers, SOURCE_EXTS } from './parsers/index.js';
import { detectCommunities } from './community.js';
import { chunkFile } from './chunker.js';
import { extname, dirname, join } from 'path';
import { stat } from 'fs/promises';

function nodeId(file, name) {
  const f = file.replace(/\\/g, '/');
  return name ? `sym://${f}:${name}` : `file://${f}`;
}

const KIND_MAP = { file: 0, class: 1, function: 2, variable: 3, reference: 4 };
const KIND_REVERSE = ['file', 'class', 'function', 'variable', 'reference'];
const RELATION_MAP = { imports: 0, calls: 1, extends: 2, defines: 3, references: 4 };
const RELATION_REVERSE = ['imports', 'calls', 'extends', 'defines', 'references'];

export class CodeGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
    this.adj = new Map();
    this.revAdj = new Map();
    this.fileHashes = new Map();
    this.communityIds = new Map();
    this.communityCount = 0;
    this._fileSymbols = new Map();
    this._symByName = new Map();
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
    const node = { ...data, id };
    this.nodes.set(id, node);
    if (data.type === 'symbol' && data.name && data.file) {
      const list = this._fileSymbols.get(node.file);
      if (list) list.push(node); else this._fileSymbols.set(node.file, [node]);
      const byName = this._symByName.get(node.name);
      if (byName) byName.push(node); else this._symByName.set(node.name, [node]);
    }
  }

  addFileNode(file) {
    file = file.replace(/\\/g, '/');
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
    return this._fileSymbols.get(file) || [];
  }

  getSymbol(name) {
    return this._symByName.get(name) || [];
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
    file = file.replace(/\\/g, '/');
    const id = nodeId(file, name);
    this.addNode(id, {
      type: 'symbol', name, file, kind, lineRange, exported,
    });
    return id;
  }

  toJSON() {
    // Build file index
    const fileSet = new Set();
    for (const node of this.nodes.values()) {
      if (node.file) fileSet.add(node.file.replace(/\\/g, '/'));
    }
    const files = [...fileSet];
    const fileIdx = new Map(files.map((f, i) => [f, i]));

    // Serialize nodes as compact arrays
    const nodeArr = [];
    const nodeIdToIdx = new Map();
    let idx = 0;
    for (const [id, node] of this.nodes) {
      const file = node.file ? node.file.replace(/\\/g, '/') : null;
      const fi = file != null ? fileIdx.get(file) : -1;
      let entry;
      if (node.type === 'file') {
        entry = [0, fi];
      } else {
        const ki = node.kind != null ? (KIND_MAP[node.kind] ?? 3) : 3;
        const lr = node.lineRange || null;
        entry = [1, fi, node.name || '', ki, lr ? lr[0] : null, lr ? lr[1] : null, node.exported ? 1 : 0, node.community != null ? node.community : null];
      }
      nodeArr.push(entry);
      nodeIdToIdx.set(id, idx);
      idx++;
    }

    // Serialize edges as compact arrays
    const edgeArr = [];
    for (const edge of this.edges) {
      const fi = nodeIdToIdx.get(edge.from);
      const ti = nodeIdToIdx.get(edge.to);
      if (fi == null || ti == null) continue;
      const ri = RELATION_MAP[edge.relation] ?? 0;
      const at = edge.at || null;
      edgeArr.push([fi, ti, ri, at ? at[0] : null, at ? at[1] : null]);
    }

    return {
      version: 4,
      files,
      nodes: nodeArr,
      edges: edgeArr,
      fileHashes: Object.fromEntries(
        [...this.fileHashes.entries()].map(([k, v]) => [k.replace(/\\/g, '/'), v])
      ),
      communityCount: this.communityCount,
    };
  }

  static fromJSON(json) {
    const graph = new CodeGraph();
    if (!json || !json.nodes) return graph;

    if (json.version === 4 && Array.isArray(json.nodes)) {
      // Compact v4 format — expand
      const files = json.files || [];
      const filePathFor = (idx) => idx >= 0 && idx < files.length ? files[idx] : null;
      for (let i = 0; i < json.nodes.length; i++) {
        const entry = json.nodes[i];
        const type = entry[0]; // 0=file, 1=symbol
        const fileIdx = entry[1];
        const file = filePathFor(fileIdx);
        if (type === 0) {
          // File node
          const id = nodeId(file);
          const data = { id, type: 'file', file, kind: 'file' };
          graph.nodes.set(id, data);
        } else {
          // Symbol node
          const name = entry[2] || '';
          const kindIdx = entry[3] != null ? entry[3] : 3;
          const lineStart = entry[4] || null;
          const lineEnd = entry[5] || null;
          const exported = entry[6] === 1;
          const community = entry[7] != null ? entry[7] : null;
          const id = nodeId(file, name);
          const data = {
            id, type: 'symbol', file, name,
            kind: KIND_REVERSE[kindIdx] || 'variable',
            lineRange: lineStart != null && lineEnd != null ? [lineStart, lineEnd] : undefined,
            exported,
          };
          if (community != null) data.community = community;
          graph.nodes.set(id, data);
        }
      }

      // Rebuild edges
      for (const edge of json.edges || []) {
        const fromNode = json.nodes[edge[0]];
        const toNode = json.nodes[edge[1]];
        if (!fromNode || !toNode) continue;
        const fromFile = filePathFor(fromNode[1]);
        const toFile = filePathFor(toNode[1]);
        const fromName = fromNode[0] === 0 ? null : fromNode[2] || '';
        const toName = toNode[0] === 0 ? null : toNode[2] || '';
        const fromId = fromName ? `sym://${fromFile}:${fromName}` : `file://${fromFile}`;
        const toId = toName ? `sym://${toFile}:${toName}` : `file://${toFile}`;
        const relation = RELATION_REVERSE[edge[2]] || 'references';
        const at = edge[3] != null && edge[4] != null ? [edge[3], edge[4]] : null;
        graph.addEdge(fromId, toId, relation, at);
      }

      graph.fileHashes = new Map(
        Object.entries(json.fileHashes || {}).map(([k, v]) => [k.replace(/\\/g, '/'), v])
      );
      graph.communityCount = json.communityCount || 0;
    } else {
      // Legacy v3 format — expand from dict
      for (const [id, data] of Object.entries(json.nodes)) {
        const normalized = { ...data, id };
        if (normalized.file) normalized.file = normalized.file.replace(/\\/g, '/');
        graph.nodes.set(id, normalized);
      }
      for (const edge of json.edges || []) {
        graph.addEdge(edge.from, edge.to, edge.relation, edge.at);
      }
      graph.fileHashes = new Map(
        Object.entries(json.fileHashes || {}).map(([k, v]) => [k.replace(/\\/g, '/'), v])
      );
      graph.communityCount = json.communityCount || 0;
    }
    // Rebuild file/symbol indexes for O(1) lookups
    for (const node of graph.nodes.values()) {
      if (node.type === 'symbol' && node.name && node.file) {
        let list = graph._fileSymbols.get(node.file);
        if (!list) { list = []; graph._fileSymbols.set(node.file, list); }
        list.push(node);
        let byName = graph._symByName.get(node.name);
        if (!byName) { byName = []; graph._symByName.set(node.name, byName); }
        byName.push(node);
      }
    }
    return graph;
  }
}

function fileHash(mtimeMs, size) {
  return `${mtimeMs}-${size}`;
}

function copyFileGraph(graph, prevGraph, file) {
  file = file.replace(/\\/g, '/');
  const fileId = nodeId(file);
  if (prevGraph.nodes.has(fileId)) {
    graph.nodes.set(fileId, { ...prevGraph.nodes.get(fileId) });
  }
  for (const [id, node] of prevGraph.nodes) {
    if ((node.file || '').replace(/\\/g, '/') === file && node.type === 'symbol') {
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
    if (fromFile.replace(/\\/g, '/') === file || toFile.replace(/\\/g, '/') === file) {
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

const PARSE_TIMEOUT_MS = 30_000;

async function statSafe(file) {
  try { return await stat(file); } catch { return null; }
}

async function parseFileWithTimeout(content, file, done, total, onProgress) {
  try {
    return await Promise.race([
      parseFile(content, file),
      sleep(PARSE_TIMEOUT_MS).then(() => { throw new Error('timeout'); }),
    ]);
  } catch (err) {
    if (err?.message === 'timeout') {
      if (onProgress) onProgress({ phase: 'parse', current: done + 1, total, file });
      console.warn(`[warn] parse timeout, skipping: ${file}`);
    }
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    const result = await parseFileWithTimeout(content, file, done, total, onProgress);
    if (!result) continue;
    result.file = file.replace(/\\/g, '/');
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
