const MAX_PAGE_SIZE = 50_000;

export function extractUrls(text) {
  const urlRe = /https?:\/\/[^\s,;:!?(){}[\]"']+/g;
  return [...new Set(text.match(urlRe) || [])];
}

function htmlToText(html) {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  const firstLine = text.split('\n')[0].replace(/[|•·●►].*/, '').trim();
  if (firstLine.length > 10 && firstLine.length < 120) {
    return `[${firstLine}]\n${text}`;
  }
  return text;
}

export async function fetchWebContent(url, maxChars = MAX_PAGE_SIZE) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'geniesh/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  const text = htmlToText(html);
  return text.length > maxChars ? text.slice(0, maxChars) + '\n... (truncated)' : text;
}
