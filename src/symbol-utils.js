const SYMBOL_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  '|[a-z][a-z0-9]+_[a-z][a-z0-9_]+' +
  '|[a-z][a-z0-9]+(?:\\.[a-z][a-z0-9]+)+' +
  '|[A-Z][a-z]+[a-zA-Z0-9]*(?:\\.[a-zA-Z_$][a-zA-Z0-9_$]*)+' +
  '|[A-Z][a-z]{3,}' +
  '|[A-Z]{2,}(?:_[A-Z0-9]+)+' +
  ')\\b',
  'g',
);

const DISCOVERY_RE = new RegExp(
  '\\b(' +
  '[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*' +
  '|[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+' +
  ')\\b',
  'g',
);

const DOMAIN_RE = /\.(com|net|org|io|co|php|js|ts|html|css|json|md|txt|edu|gov|app|dev)(\.|$)/i;

export function extractSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)]
    .filter(s => !DOMAIN_RE.test(s))
    .slice(0, 6);
}

export function extractAllSymbols(text) {
  const raw = [...text.matchAll(SYMBOL_RE)].map(m => m[1]);
  return [...new Set(raw)].filter(s => !DOMAIN_RE.test(s));
}

export function extractDiscoverySymbols(text, maxResults = 6) {
  const raw = [...text.matchAll(DISCOVERY_RE)].map(m => m[1]);
  return [...new Set(raw)].slice(0, maxResults);
}
