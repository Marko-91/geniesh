import { readFile } from '../../packages/kernel/src/fs-utils.js';
import { parseFile } from '../../packages/kernel/src/parsers/index.js';

const SYMBOL_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  '|[a-z][a-z0-9]+_[a-z][a-z0-9_]+' +
  '|[a-z][a-z0-9]+(?:-[a-z][a-z0-9]+)+' +
  '|[A-Z]{2,}(?:_[A-Z0-9]+)+' +
  ')\\b', 'g'
);

const ENGLISH_NOISE = new Set([
  'the','this','that','these','those','how','what','why','when','where','which',
  'are','was','but','not','from','with','they','them','their','your','our','its',
  'has','had','may','can','will','would','could','should','shall','into','about',
  'also','very','just','over','under','here','there','then','else','still','more',
  'most','other','each','every','both','few','much','many','some','once','again',
  'upon','down','off','near','see','old','out','than','thus','while','after',
  'before','above','below','having','doing','being','going','coming','making',
  'taking','giving','using','finding','keeping','looking','asking','telling',
  'working','calling','thinking','knowing','become','became','begin','began',
  'running','saying','seeing','selling','sending','showing','sitting','speaking',
  'standing','starting','taking','teaching','telling','trying','turning',
  'understanding','using','waiting','walking','wanting','watching','working',
  'writing',
]);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  id: 'generic',
  extensions: [],
  keyFiles: ['README.md', 'README', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'Makefile', 'Dockerfile'],

  detect(files) {
    return 0;
  },

  patterns(terms) {
    return terms.flatMap(term => [
      { regex: new RegExp('\\b' + escapeRegex(term) + '\\b'), priority: 50, role: 'mention' },
    ]);
  },

  extractSymbols(query) {
    const matches = [];
    let m;
    SYMBOL_RE.lastIndex = 0;
    while ((m = SYMBOL_RE.exec(query)) !== null) {
      if (!ENGLISH_NOISE.has(m[1].toLowerCase())) {
        matches.push(m[1]);
      }
    }
    return [...new Set(matches)];
  },

  parseFile(content, filePath) {
    return parseFile(content, filePath);
  },
};
