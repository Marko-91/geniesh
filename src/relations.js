import { access } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { chain } from 'stream-chain';
import { parserStream } from 'stream-json';
import { disassembler } from 'stream-json/disassembler.js';
import { stringer } from 'stream-json/stringer.js';
import { Assembler } from 'stream-json/Assembler.js';
import { buildRelations as kernelBuildRelations } from '../packages/kernel/src/relations.js';
import { CodeGraph } from '../packages/kernel/src/graph-engine.js';
import { loadIgnoreFile } from '../packages/kernel/src/fs-utils.js';

export {
  fileRelationsToNames,
  symbolRelationsToFiles,
} from '../packages/kernel/src/relations.js';

const GRAPH_FILE = 'geniesh-graph.json';

export async function saveGraph(graph) {
  const ws = createWriteStream(GRAPH_FILE, 'utf-8');
  const pipeline = chain([disassembler(), stringer(), ws]);
  const data = graph.toJSON();
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', resolve);
    pipeline.write(data);
    pipeline.end();
  });
}

async function streamParseGraph(readable) {
  const graph = new CodeGraph();
  const pipeline = chain([readable, parserStream()]);

  let topKey = null;
  let depth = 0;
  let assembler = null;
  let savedNodeId = null;
  const meta = {};

  for await (const tok of pipeline) {
    if (tok.name === 'keyValue') {
      if (depth === 1) topKey = tok.value;
      if (depth === 2 && topKey === 'nodes') savedNodeId = tok.value;
      if (assembler) assembler.consume(tok);
      continue;
    }

    if (tok.name === 'startObject') {
      depth++;
      if (depth === 3 && topKey === 'nodes') assembler = new Assembler();
      else if (depth === 3 && topKey === 'edges') assembler = new Assembler();
      else if (depth === 2 && topKey === 'fileHashes') assembler = new Assembler();
      if (assembler) assembler.consume(tok);
      continue;
    }

    if (tok.name === 'startArray') {
      depth++;
      if (depth === 2 && topKey === 'chunks') assembler = new Assembler();
      if (assembler) assembler.consume(tok);
      continue;
    }

    if (tok.name === 'endObject') {
      if (depth === 3 && topKey === 'nodes' && assembler) {
        assembler.consume(tok);
        graph.nodes.set(savedNodeId, { ...assembler.current, id: savedNodeId });
        assembler = null;
        savedNodeId = null;
      } else if (depth === 3 && topKey === 'edges' && assembler) {
        assembler.consume(tok);
        const edge = assembler.current;
        graph.edges.push(edge);
        if (!graph.adj.has(edge.from)) graph.adj.set(edge.from, []);
        graph.adj.get(edge.from).push({ to: edge.to, relation: edge.relation, at: edge.at });
        if (!graph.revAdj.has(edge.to)) graph.revAdj.set(edge.to, []);
        graph.revAdj.get(edge.to).push({ from: edge.from, relation: edge.relation, at: edge.at });
        assembler = null;
      } else if (depth === 2 && topKey === 'fileHashes' && assembler) {
        assembler.consume(tok);
        meta.fileHashes = assembler.current;
        assembler = null;
      } else if (assembler) {
        assembler.consume(tok);
      }
      depth--;
      continue;
    }

    if (tok.name === 'endArray') {
      if (depth === 2 && topKey === 'chunks' && assembler) {
        assembler.consume(tok);
        meta.chunks = assembler.current;
        assembler = null;
      } else if (assembler) {
        assembler.consume(tok);
      }
      depth--;
      continue;
    }

    if (tok.name === 'numberValue' && depth === 1) {
      if (topKey === 'version') meta.version = Number(tok.value);
      else if (topKey === 'communityCount') meta.communityCount = Number(tok.value);
      continue;
    }

    if (assembler) assembler.consume(tok);
  }

  graph.chunks = meta.chunks || [];
  graph.fileHashes = new Map(Object.entries(meta.fileHashes || {}));
  graph.communityCount = meta.communityCount || 0;
  return graph;
}

export async function tryLoadGraph() {
  try {
    return await streamParseGraph(createReadStream(GRAPH_FILE));
  } catch {
    return null;
  }
}

export async function loadGraph() {
  return await streamParseGraph(createReadStream(GRAPH_FILE));
}

export async function graphExists() {
  try {
    await access(GRAPH_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function buildRelations(dir, onProgress = null) {
  const [prevGraph, ignorePatterns] = await Promise.all([
    tryLoadGraph(),
    loadIgnoreFile(dir),
  ]);
  const result = await kernelBuildRelations(dir, prevGraph, ignorePatterns, onProgress);
  return result;
}
