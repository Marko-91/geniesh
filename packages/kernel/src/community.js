export function detectCommunities(graph) {
  const visited = new Set();
  let communityId = 0;

  for (const [nodeId] of graph.nodes) {
    if (visited.has(nodeId)) continue;

    const queue = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift();
      const node = graph.nodes.get(current);
      if (node) node.community = communityId;

      const neighbors = new Set();
      const forward = graph.adj.get(current) || [];
      const backward = graph.revAdj.get(current) || [];
      for (const edge of [...forward, ...backward]) {
        const neighbor = edge.to === current ? edge.from : edge.to;
        if (!visited.has(neighbor)) {
          neighbors.add(neighbor);
        }
      }
      for (const n of neighbors) {
        visited.add(n);
        queue.push(n);
      }
    }
    communityId++;
  }

  return communityId;
}
