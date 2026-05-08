import { scanDir, readFile } from './fs-utils.js';
import { extractAllSymbols } from './symbol-utils.js';
import { readFile as fsReadFile, writeFile } from 'fs/promises';

const RELATIONS_FILE = '.ai-relations.json';

export async function buildRelations(dir) {
  const files = await scanDir(dir);
  const bySymbol = {};
  const byFile = {};

  for (const file of files) {
    const content = await readFile(file);
    const symbols = new Set(extractAllSymbols(content));

    byFile[file] = [...symbols];

    for (const sym of symbols) {
      if (!Object.hasOwn(bySymbol, sym)) bySymbol[sym] = [];
      bySymbol[sym].push(file);
    }
  }

  const relations = { version: 1, bySymbol, byFile };
  return relations;
}

export function saveRelations(relations) {
  return writeFile(RELATIONS_FILE, JSON.stringify(relations), 'utf-8');
}

export async function loadRelations() {
  const raw = await fsReadFile(RELATIONS_FILE, 'utf-8');
  return JSON.parse(raw);
}

export async function relationsExist() {
  try {
    await fsReadFile(RELATIONS_FILE, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
