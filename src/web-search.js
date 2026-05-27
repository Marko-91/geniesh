const SEARCH_TIMEOUT = 10000;
const MAX_RETRIES = 2;

function parseResults(html) {
  const results = [];

  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const titles = [];
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    titles.push({
      url: match[1].replace(/&amp;/g, '&'),
      title: match[2].replace(/<[^>]+>/g, '').trim(),
    });
  }

  // If no results found, the page might have been blocked
  if (titles.length === 0) {
    const blocked = html.includes('Please try again later') || html.includes('captcha');
    if (blocked) throw new Error('DuckDuckGo rate-limited the request');
  }

  const snippetRe = /<a[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetMap = {};
  while ((match = snippetRe.exec(html)) !== null) {
    const url = match[1].replace(/&amp;/g, '&');
    snippetMap[url] = match[2].replace(/<[^>]+>/g, '').trim();
  }

  for (const t of titles) {
    results.push({
      url: t.url,
      title: t.title,
      snippet: snippetMap[t.url] || '',
    });
  }

  return results;
}

export async function webSearch(query, maxResults = 5) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
      const res = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: `q=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return parseResults(html).slice(0, maxResults);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function formatSearchResults(results) {
  if (results.length === 0) return 'No results found.';
  const lines = results.map((r, i) => {
    let entry = `${i + 1}. ${r.title}`;
    if (r.snippet) entry += `\n   ${r.snippet}`;
    entry += `\n   ${r.url}`;
    return entry;
  });
  return lines.join('\n\n');
}
