const KIND_ORDER = { class: 0, function: 1, variable: 2, reference: 3 };
const HIGH_PRIORITY_DIRS = /[/\\](src|lib|app|core|include|packages)[/\\]/;
const LOW_PRIORITY_DIRS = /[/\\](test|spec|__tests__|__mocks__|fixtures|examples|docs)[/\\]/;

export function queryCallers(graph, symbolName) {
  const results = [];
  const symNodes = graph.getSymbol(symbolName);
  for (const sym of symNodes) {
    const callers = graph.getCallers(sym.id);
    for (const caller of callers) {
      results.push({ callerNode: caller.node, targetNode: sym, at: caller.at });
    }
  }
  return results;
}

export function queryCallees(graph, symbolName) {
  const results = [];
  const symNodes = graph.getSymbol(symbolName);
  for (const sym of symNodes) {
    const callees = graph.getCallees(sym.id);
    for (const callee of callees) {
      results.push({ callerNode: sym, targetNode: callee.node, at: callee.at });
    }
  }
  return results;
}

export function queryFileNeighbors(graph, file) {
  const fileId = `file://${file}`;
  const imports = graph.getFileImports(file);
  const importers = graph.getFileImporters(file);
  const symbols = graph.getFileSymbols(file);
  return { imports, importers, symbols };
}

export function queryCommunitySymbols(graph, communityId) {
  return graph.getCommunity(communityId).filter(n => n.type === 'symbol');
}

export function scoreSymbol(graph, name, queryTerms) {
  let score = 0;
  const symLower = name.toLowerCase();
  for (const qt of queryTerms) {
    if (qt === symLower) score += 1000000;
    else if (symLower.startsWith(qt)) score += 800000;
    else if (symLower.includes(qt)) score += 600000;
  }
  return score;
}

export function rankSymbols(graph, symbols, queryTerms, seenNames) {
  return symbols
    .filter(s => !seenNames.has(s.name))
    .map(s => {
      const metas = graph.getSymbol(s.name);
      const uniqFiles = new Set(metas.map(m => m.file)).size;
      const kindRank = KIND_ORDER[s.kind] ?? 99;
      const qScore = scoreSymbol(graph, s.name, queryTerms);
      const dirBoost = HIGH_PRIORITY_DIRS.test(s.file) ? -100 : LOW_PRIORITY_DIRS.test(s.file) ? 100 : 0;
      const bridgeBonus = -Math.min(uniqFiles, 20) * 10;
      const communityBonus = metas.length > 1 ? -50 : 0;
      const priority = -(qScore * 1000 + kindRank * 100 + bridgeBonus + dirBoost + communityBonus);
      return { node: s, priority, qScore, kindRank, uniqFiles };
    })
    .sort((a, b) => a.priority - b.priority);
}

export function formSymbolGroups(graph, frontier, files, contextGrep) {
  const groups = [];
  for (const sym of frontier) {
    const nodeIds = graph.getSymbol(sym.name).map(n => n.id);

    for (const nodeId of nodeIds) {
      const callers = graph.getCallers(nodeId);
      const callees = graph.getCallees(nodeId);
      const allRefs = [...callers, ...callees];

      const fileGroups = new Map();
      for (const ref of allRefs) {
        if (!ref.at || !ref.at[0]) continue;
        const f = ref.at[0] >= 0 && ref.node?.file ? ref.node.file : (ref.targetNode?.file || ref.callerNode?.file);
        if (!f) continue;
        if (!fileGroups.has(f)) fileGroups.set(f, []);
        fileGroups.get(f).push({
          startLine: ref.at[0],
          endLine: ref.at[1] || ref.at[0] + 5,
          symbol: sym.name,
          matchLines: [ref.at[0]],
        });
      }

      for (const [file, windows] of fileGroups) {
        groups.push({ sym: sym.name, file, windows });
      }
    }
  }
  return groups;
}
