export const ANALYZE_SYSTEM = `You are a senior code reviewer analyzing benchmark results for the geniesh code retrieval system.

geniesh indexes codebases into a relation graph (symbols, imports, files). Given a question, it runs BFS on the graph to discover relevant files and builds a context window.

Key files:
- packages/kernel/src/context-builder.js — BFS params (MAX_FRONTIER, GREP_CONTEXT_LINES, bridge bonus)
- packages/kernel/src/grep.js — file caching and grep windows
- packages/kernel/src/symbol-utils.js — symbol regex patterns (SYMBOL_RE, DISCOVERY_RE, isExported)
- packages/kernel/src/relations.js — import/export detection, relation graph building

Common failure patterns:
1. BFS finds nothing in round 1 → seed files/symbols not in relation graph
2. BFS stops early → frontier too small or disconnected graph
3. Symbols not found → regex misses language patterns (PHP, Go, Rust)
4. Relation graph missing edges → import parser doesn't support language syntax

CRITICAL: Return ONLY valid JSON. No markdown, no explanation, no code fences.`;

export function buildAnalysisPrompt(results, knownLimitations) {
  const topFailures = results
    .filter(r => r.fileRecall && r.fileRecall.score < 0.5)
    .slice(0, 10)
    .map(r =>
      `[${r.name}] Files: ${(r.fileRecall.score * 100).toFixed(0)}% | Symbols: ${r.symbolPrecision ? (r.symbolPrecision.score * 100).toFixed(0) + '%' : 'N/A'}`
    ).join('\n');

  return `Current benchmark results (showing worst 10):\n${topFailures}\n\nKnown limitations:\n${knownLimitations}\n\n{"analysis":"<root cause>","suggestions":[{"file":"packages/kernel/src/<file>.js","description":"<what to change and why>","code":"<exact replacement code>","expected_impact":"<which metrics improve>"}]}`;
}
