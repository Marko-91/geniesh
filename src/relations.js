import { readFile as fsReadFile, writeFile, access } from 'fs/promises';
import { buildRelations as kernelBuildRelations } from '../packages/kernel/src/relations.js';
import { CodeGraph } from '../packages/kernel/src/graph-engine.js';
import { loadIgnoreFile } from '../packages/kernel/src/fs-utils.js';

export {
  fileRelationsToNames,
  symbolRelationsToFiles,
} from '../packages/kernel/src/relations.js';

const GRAPH_FILE = 'geniesh-graph.json';

export async function tryLoadGraph() {
  try {
    const raw = await fsReadFile(GRAPH_FILE, 'utf-8');
    return CodeGraph.fromJSON(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveGraph(graph) {
  return writeFile(GRAPH_FILE, JSON.stringify(graph.toJSON()), 'utf-8');
}

export async function loadGraph() {
  const raw = await fsReadFile(GRAPH_FILE, 'utf-8');
  return CodeGraph.fromJSON(JSON.parse(raw));
}

export async function graphExists() {
  try {
    await access(GRAPH_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function buildRelations(dir) {
  const [prevGraph, ignorePatterns] = await Promise.all([
    tryLoadGraph(),
    loadIgnoreFile(dir),
  ]);
  const result = await kernelBuildRelations(dir, prevGraph, ignorePatterns);
  return result;
}
