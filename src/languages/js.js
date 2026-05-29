import { parseFile } from '../../packages/kernel/src/parsers/index.js';

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

const JS_SYMBOL_RE = /[A-Z][a-zA-Z0-9]+/g;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  id: 'js',
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  keyFiles: ['package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.ts', 'next.config.js', '.eslintrc.js'],

  detect(files) {
    if (files.length === 0) return 0;
    let count = 0;
    for (const f of files) {
      if (this.extensions.includes(f.ext)) count++;
    }
    return count / files.length;
  },

  patterns(terms) {
    return terms.flatMap(term => {
      const e = escapeRegex(term);
      return [
        { regex: new RegExp('(export\\s+)?(default\\s+)?class\\s+' + e + '\\b'),       priority: 100, role: 'definition' },
        { regex: new RegExp('(export\\s+)?interface\\s+' + e + '\\b'),                  priority: 100, role: 'interface' },
        { regex: new RegExp('(export\\s+)?type\\s+' + e + '\\b'),                        priority: 100, role: 'type' },
        { regex: new RegExp('(export\\s+)?(async\\s+)?function\\s+' + e + '\\s*\\('),   priority: 100, role: 'function-def' },
        { regex: new RegExp('(export\\s+)?(const|let|var)\\s+' + e + '\\s*[=:(]'),      priority: 90,  role: 'variable' },
        { regex: new RegExp('import\\s+.*\\b' + e + '\\b', 'm'),                       priority: 90,  role: 'import' },
        { regex: new RegExp('new\\s+' + e + '[\\s(;]'),                                  priority: 70,  role: 'instantiation' },
        { regex: new RegExp('\\b' + e + '\\.(prototype\\.)?' + term.toLowerCase()),     priority: 65,  role: 'member-access' },
        { regex: new RegExp('typeof\\s+' + e + '\\b'),                                   priority: 60,  role: 'type-ref' },
        { regex: new RegExp('instanceof\\s+' + e + '\\b'),                               priority: 60,  role: 'type-check' },
        { regex: new RegExp('extends\\s+' + e + '\\b'),                                  priority: 50,  role: 'extends' },
        { regex: new RegExp('implements\\s+' + e + '\\b'),                               priority: 50,  role: 'implements' },
        { regex: new RegExp('\\@(type|param|returns?|typedef)\\s+\\{' + e + '\\}'),      priority: 40,  role: 'jsdoc' },
        { regex: new RegExp('\\b' + e + '\\b'),                                           priority: 1,   role: 'mention' },
      ];
    });
  },

  extractSymbols(query) {
    const matches = [];
    let m;
    JS_SYMBOL_RE.lastIndex = 0;
    while ((m = JS_SYMBOL_RE.exec(query)) !== null) {
      const s = m[0];
      if (s.length >= 3 && !ENGLISH_NOISE.has(s.toLowerCase())) {
        matches.push(s);
      }
    }
    const camelMatches = query.match(/[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*/g);
    if (camelMatches) {
      for (const s of camelMatches) {
        if (s.length >= 3 && !ENGLISH_NOISE.has(s.toLowerCase())) {
          matches.push(s);
        }
      }
    }
    return [...new Set(matches)];
  },

  parseFile(content, filePath) {
    return parseFile(content, filePath);
  },

  findKeyFiles(files) {
    return files.filter(f => this.keyFiles.includes(f.name));
  },
};
