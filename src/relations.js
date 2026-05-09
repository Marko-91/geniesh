import { readFile as fsReadFile, writeFile, stat } from 'fs/promises';
import { scanDir } from './fs-utils.js';

export {
  buildRelations,
  fileRelationsToNames,
  symbolRelationsToFiles,
} from '../packages/kernel/src/relations.js';

const RELATIONS_FILE = '.ai-relations.json';

export async function tryLoadRelations() {
  try {
    const raw = await fsReadFile(RELATIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
