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
  'add','list','output','input','show','tell','find','give','take','make',
  'call','work','look','read','write','run','put','set','get','use','try',
  'ask','check','test','fix','help','explain','describe','define','return',
  'simple','minimal','changes','change','need','want','suggest','suggestion',
  'like','include','include','please','step','guide','walk','through',
  'follow','example','below','above','note','info','summary','detail',
]);

const PHP_SYMBOL_RE = /[A-Z][a-zA-Z0-9]+/g;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  id: 'php',
  extensions: ['.php', '.phtml', '.php4', '.php5', '.php7', '.php8'],
  keyFiles: ['composer.json', 'artisan', '.php_cs.dist', 'phpstan.neon', 'phpunit.xml'],

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
        { regex: new RegExp('class\\s+' + e + '\\b'),                    priority: 100, role: 'definition' },
        { regex: new RegExp('interface\\s+' + e + '\\b'),                priority: 100, role: 'interface' },
        { regex: new RegExp('trait\\s+' + e + '\\b'),                    priority: 100, role: 'definition' },
        { regex: new RegExp('(function|function\\s+static)\\s+' + e + '\\s*\\('), priority: 100, role: 'function-def' },
        { regex: new RegExp('use\\s+.*\\\\' + e + '\\b'),                priority: 90,  role: 'import' },
        { regex: new RegExp(e + '::'),                                    priority: 80,  role: 'static-call' },
        { regex: new RegExp('\\$\\w+\\s*=\\s*new\\s+' + e + '[\\s(;]'),  priority: 75,  role: 'instantiation' },
        { regex: new RegExp(e + '\\s*\\$'),                                priority: 70,  role: 'type-hint' },
        { regex: new RegExp('\\$this->' + e + '\\s*\\(', 'i'),           priority: 65,  role: 'method-call' },
        { regex: new RegExp('new\\s+' + e + '[\\s(;]'),                  priority: 60,  role: 'instantiation' },
        { regex: new RegExp('extends\\s+' + e + '\\b'),                   priority: 50,  role: 'extends' },
        { regex: new RegExp('implements\\s+' + e + '\\b'),               priority: 50,  role: 'implements' },
        { regex: new RegExp('@(var|param|return|property|method|see)\\s+' + e + '\\b'), priority: 40, role: 'docblock' },
        { regex: new RegExp('\\b' + e + '\\b'),                           priority: 1,   role: 'mention' },
      ];
    });
  },

  extractSymbols(query) {
    const matches = [];
    let m;
    PHP_SYMBOL_RE.lastIndex = 0;
    while ((m = PHP_SYMBOL_RE.exec(query)) !== null) {
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
    const snakeMatches = query.match(/[a-z][a-z0-9]+_[a-z][a-z0-9_]+/g);
    if (snakeMatches) {
      for (const s of snakeMatches) {
        if (!ENGLISH_NOISE.has(s.toLowerCase())) {
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
