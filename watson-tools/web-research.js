'use strict';
// web-research.js — Fast web research via HTTP + HTML parsing
// 100x faster than Chrome + OCR. No screen needed. No Moondream needed.
// Watson can research in the background without touching the phone screen.
// Uses only Node.js built-in http/https — no dependencies.

const https = require('https');
const http = require('http');

// ─── Fetch a URL and extract text ──────────────────────────────────────────

function fetchUrl(url, timeoutMs) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    try {
      const req = mod.get(url, {
        timeout: timeoutMs || 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-N960U) AppleWebKit/537.36',
          'Accept': 'text/html,application/json,text/plain',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location, timeoutMs).then(resolve);
        }
        let body = '';
        res.on('data', c => { body += c; if (body.length > 500000) res.destroy(); });
        res.on('end', () => resolve({ ok: true, body, status: res.statusCode }));
      });
      req.on('error', e => resolve({ ok: false, body: '', error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', error: 'timeout' }); });
    } catch (e) { resolve({ ok: false, body: '', error: e.message }); }
  });
}

// ─── Strip HTML to plain text ───────────────────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Extract article content (best-effort) ──────────────────────────────────

function extractArticle(html) {
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (articleMatch) return htmlToText(articleMatch[1]);

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(html)) !== null) {
    const text = htmlToText(m[1]).trim();
    if (text.length > 30) paragraphs.push(text);
  }

  return paragraphs.length > 0 ? paragraphs.join('\n\n') : htmlToText(html);
}

// ─── Search Wikipedia (free, detailed, structured) ──────────────────────────

async function searchWikipedia(query) {
  const encoded = encodeURIComponent(query);
  const result = await fetchUrl(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, 10000);

  if (!result.ok) return null;
  try {
    const data = JSON.parse(result.body);
    if (data.type === 'standard') {
      return { title: data.title, extract: data.extract,
        description: data.description || '',
        url: data.content_urls && data.content_urls.desktop ? data.content_urls.desktop.page : '' };
    }
  } catch {}
  return null;
}

// ─── Search DuckDuckGo instant answers ──────────────────────────────────────

async function searchDuckDuckGo(query) {
  const encoded = encodeURIComponent(query);
  const result = await fetchUrl(
    `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`, 10000);

  if (!result.ok) return { results: [], abstract: '' };
  try {
    const data = JSON.parse(result.body);
    return {
      abstract: data.AbstractText || '',
      results: (data.RelatedTopics || []).filter(t => t.Text).slice(0, 5)
        .map(t => ({ text: t.Text, url: t.FirstURL || '' })),
      source: data.AbstractSource || 'DuckDuckGo',
    };
  } catch { return { results: [], abstract: '' }; }
}

// ─── Full research pipeline ─────────────────────────────────────────────────

async function researchTopic(query) {
  const results = { query, sources: [], content: '', success: false };

  // 1. Wikipedia (most structured, fastest)
  const wiki = await searchWikipedia(query);
  if (wiki && wiki.extract && wiki.extract.length > 100) {
    results.sources.push({ source: 'Wikipedia', title: wiki.title, url: wiki.url });
    results.content += `## Wikipedia: ${wiki.title}\n${wiki.extract}\n\n`;
  }

  // 2. DuckDuckGo instant answers
  const ddg = await searchDuckDuckGo(query);
  if (ddg.abstract) {
    results.sources.push({ source: ddg.source || 'DuckDuckGo', title: query });
    results.content += `## ${ddg.source || 'Summary'}\n${ddg.abstract}\n\n`;
  }

  // 3. Fetch first related URL for deeper content
  if (ddg.results.length > 0 && ddg.results[0].url) {
    const page = await fetchUrl(ddg.results[0].url, 12000);
    if (page.ok && page.body.length > 500) {
      const article = extractArticle(page.body);
      if (article.length > 100) {
        results.sources.push({ source: 'web', url: ddg.results[0].url });
        results.content += `## Related\n${article.substring(0, 3000)}\n\n`;
      }
    }
  }

  // 4. Full Wikipedia page if available
  if (wiki && wiki.url) {
    const fullPage = await fetchUrl(wiki.url, 12000);
    if (fullPage.ok) {
      const fullText = extractArticle(fullPage.body);
      if (fullText.length > 500) {
        results.content += `## Wikipedia Detail\n${fullText.substring(0, 4000)}\n\n`;
      }
    }
  }

  results.success = results.content.length > 100;
  return results;
}

module.exports = { fetchUrl, htmlToText, extractArticle, searchDuckDuckGo, searchWikipedia, researchTopic };
