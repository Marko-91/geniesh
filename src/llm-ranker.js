import { runGenerate } from './runner.js';

function truncateMiddle(str, maxLen) {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(str.length - half);
}

function buildRankPrompt(question, candidates) {
  const lines = [
    'You are scoring code files for relevance to a developer question.',
    '',
    `Question: "${question}"`,
    '',
    'Rate each file 0-10 for relevance:',
    '  10 = contains the EXACT definition/declaration of the main symbol',
    '  7-9 = important usages, callers, or imports of the symbol',
    '  4-6 = mentions the symbol but indirectly relevant',
    '  1-3 = incidental mentions (comments, unrelated code)',
    '  0 = completely irrelevant',
    '',
    'Return ONLY a JSON array sorted by score descending:',
    '[{ "file": "...", "score": 0-10, "reason": "short reason" }]',
    '',
    'Candidates:',
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const context = c.matchLine ? truncateMiddle(c.matchLine.trim(), 120) : '';
    lines.push(`[${i + 1}] ${c.file}`);
    lines.push(`    Grep score: ${c.grepScore !== undefined ? c.grepScore.toFixed(1) : 'N/A'}`);
    lines.push(`    BM25 score: ${c.bm25Score !== undefined ? c.bm25Score.toFixed(4) : 'N/A'}`);
    if (c.roles && c.roles.length > 0) {
      lines.push(`    Roles: ${c.roles.join(', ')}`);
    }
    if (context) lines.push(`    Match: ${context}`);
    lines.push('');
  }

  return lines.join('\n');
}

function parseRankResponse(content) {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(item => ({
      file: item.file,
      score: Math.max(0, Math.min(10, Math.round(item.score))),
      reason: item.reason || '',
    }));
  } catch {
    return null;
  }
}

export async function llmRank(question, candidates, { model } = {}) {
  if (candidates.length === 0) return [];

  try {
    const prompt = buildRankPrompt(question, candidates);
    const content = await runGenerate(prompt, model || 'qwen3-coder');
    const result = parseRankResponse(content);
    if (result && result.length > 0) return result;
  } catch (e) {
    process.stderr.write(`[re-ranker] LLM call failed: ${e.message}, using fallback\n`);
  }

  return candidates
    .map(c => ({
      file: c.file,
      score: Math.round(((c.grepScore || 0) * 2 + (c.bm25Score || 0) * 1000) / 100),
      reason: 'fallback (LLM unavailable)',
    }))
    .sort((a, b) => b.score - a.score);
}
