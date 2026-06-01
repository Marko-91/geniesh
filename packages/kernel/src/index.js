export { scanDir, readFile } from './fs-utils.js';
export {
  extractSymbols,
  extractAllSymbols,
  extractAllSymbolsWithMetadata,
  extractDiscoverySymbols,
} from './symbol-utils.js';
export { grepFiles, grepDir } from './grep.js';
export {
  buildRelations,
  fileRelationsToNames,
  symbolRelationsToFiles,
} from './relations.js';
export { chunkFile } from './chunker.js';
export { CodeGraph } from './graph-engine.js';
export { detectCommunities } from './community.js';
