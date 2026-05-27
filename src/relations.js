import { readFile, access } from 'fs/promises';
import { createWriteStream } from 'fs';
import { chain } from 'stream-chain';
import { disassembler } from 'stream-json/disassembler.js';
import { stringer } from 'stream-json/stringer.js';
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

export async function tryLoadGraph() {
  try {
    const content = await readFile(GRAPH_FILE, 'utf-8');
    return CodeGraph.fromJSON(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function loadGraph() {
  const content = await readFile(GRAPH_FILE, 'utf-8');
  return CodeGraph.fromJSON(JSON.parse(content));
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
