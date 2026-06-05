'use strict';

/*
 * Keyless web search. Two backends, no API key either way:
 *   - SearXNG  : if AGENT_SEARXNG_URL is set, queries its JSON API (best quality).
 *   - DuckDuckGo: otherwise scrapes the HTML endpoint (html.duckduckgo.com).
 * Returns a compact list of {title, url, snippet} the model can act on.
 */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).trim(); }

// DDG html results wrap real URLs in a redirect: //duckduckgo.com/l/?uddg=<enc>
function unwrapDdg(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith('//') ? 'https:' + href : href;
}

async function searxng(base, query, n) {
  const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'runmywork-agent' } });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, n).map(r => ({
    title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300)
  }));
}

async function duckduckgo(query, n) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; runmywork-agent)' }
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();

  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    out.push({ url: unwrapDdg(decodeEntities(m[1])), title: stripTags(m[2]), snippet: '' });
  }
  // best-effort snippets, matched in document order
  const sn = [];
  const sre = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = sre.exec(html))) sn.push(stripTags(m[1]));
  out.forEach((r, i) => { if (sn[i]) r.snippet = sn[i].slice(0, 300); });
  return out;
}

module.exports = {
  name: 'web_search',
  description: 'Search the web and get a list of result titles, URLs, and snippets. Use it to find current information, then fetch_url the most relevant results to read them.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      count: { type: 'number', description: 'How many results (default 6, max 10).' }
    },
    required: ['query']
  },
  async run(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) return { error: 'query is required' };
    const n = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);

    try {
      const results = ctx.config.searxngUrl
        ? await searxng(ctx.config.searxngUrl, query, n)
        : await duckduckgo(query, n);
      if (!results.length) return { query, results: [], note: 'No results parsed.' };
      return { query, results };
    } catch (e) {
      return { error: `search failed: ${e.message}` };
    }
  }
};
