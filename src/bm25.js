const k1 = 1.2;
const b = 0.75;

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

export function tokenize(content) {
  const tokens = content.split(/[^a-zA-Z0-9_$]/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 3 && !ENGLISH_NOISE.has(t));
  const termCounts = new Map();
  for (const t of tokens) {
    termCounts.set(t, (termCounts.get(t) || 0) + 1);
  }
  return { tokens, termCounts, length: tokens.length };
}

export function computeBM25(queryTerms, fileContents) {
  if (fileContents.length === 0) return [];

  const docs = fileContents.map(fc => ({
    path: fc.path,
    doc: tokenize(fc.content),
  }));

  const avgdl = docs.reduce((sum, d) => sum + d.doc.length, 0) / docs.length;
  if (avgdl === 0) {
    return docs.map(d => ({ file: d.path, bm25Score: 0, topTerms: [] }));
  }

  const idf = {};
  for (const term of queryTerms) {
    const t = term.toLowerCase();
    let matching = 0;
    for (const d of docs) {
      if (d.doc.termCounts.has(t)) matching++;
    }
    idf[term] = Math.log(1 + (docs.length - matching + 0.5) / (matching + 0.5));
  }

  return docs.map(d => {
    let score = 0;
    const termScores = [];
    for (const term of queryTerms) {
      const t = term.toLowerCase();
      const tf = d.doc.termCounts.get(t) || 0;
      if (tf === 0) { termScores.push({ term, tf: 0, contribution: 0 }); continue; }
      const contribution = idf[term] * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.doc.length / avgdl));
      score += contribution;
      termScores.push({ term, tf, contribution });
    }
    const topTerms = termScores
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .filter(t => t.tf > 0)
      .map(t => ({ term: t.term, count: t.tf }));
    return { file: d.path, bm25Score: score, topTerms };
  }).sort((a, b) => b.bm25Score - a.bm25Score);
}
