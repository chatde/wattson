'use strict';
// codexlib-exporter.js — Export Watson's knowledge as CodexLib packs
// Pipeline: knowledge file hits depth 5+ with 10+ entries →
//   auto-format as CodexLib pack → stage for upload → notify Dad
//
// CodexLib pack format (from codexlib.io schema):
// {
//   title, domain, description, content, content_compressed,
//   difficulty, tags[], estimated_time, version
// }

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;
const EXPORT_DIR = `${HOME}/watson-codexlib-exports`;
const EXPORT_LOG = `${HOME}/watson-codexlib-exports.jsonl`;
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';

// Minimum thresholds for export-ready
const MIN_ENTRIES = 8;
const MIN_CONTENT_LENGTH = 3000; // chars
const MIN_SECTIONS = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function fire(bin, args) {
  try {
    const child = spawn(bin, args, {
      stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    });
    child.on('error', () => {});
  } catch {}
}

function httpPost(url, data) {
  return new Promise(resolve => {
    try {
      const parsed = new (require('url').URL)(url);
      const body = JSON.stringify(data);
      const req = http.request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, res => { res.resume(); resolve({ ok: true }); });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    } catch { resolve({ ok: false }); }
  });
}

// ─── Check which knowledge files are export-ready ───────────────────────────

function findExportCandidates() {
  const candidates = [];

  try {
    const index = JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
    const alreadyExported = loadExportedSlugs();

    for (const [slug, meta] of Object.entries(index.topics || {})) {
      // Skip already exported
      if (alreadyExported.has(slug)) continue;

      // Check thresholds
      if ((meta.entries || 0) < MIN_ENTRIES) continue;

      // Read file to check content quality
      const filepath = path.join(KNOWLEDGE_DIR, `${slug}.md`);
      if (!fs.existsSync(filepath)) continue;

      const content = fs.readFileSync(filepath, 'utf8');
      const sections = (content.match(/^###\s/gm) || []).length;

      if (content.length < MIN_CONTENT_LENGTH) continue;
      if (sections < MIN_SECTIONS) continue;

      candidates.push({
        slug,
        domain: meta.domain,
        topic: meta.topic,
        entries: meta.entries,
        sections,
        contentLength: content.length,
        filepath,
        content,
      });
    }
  } catch {}

  return candidates.sort((a, b) => b.entries - a.entries);
}

function loadExportedSlugs() {
  try {
    const lines = fs.readFileSync(EXPORT_LOG, 'utf8').split('\n').filter(Boolean);
    return new Set(lines.map(l => {
      try { return JSON.parse(l).slug; } catch { return null; }
    }).filter(Boolean));
  } catch { return new Set(); }
}

// ─── Format as CodexLib pack ────────────────────────────────────────────────

function formatAsCodexLibPack(candidate) {
  const { domain, topic, content, entries, sections } = candidate;

  // Clean content: remove metadata headers, timestamps, "Raw research capture" noise
  const cleanedContent = content
    .replace(/^#\s+.+\n/m, '') // Remove title (we'll add our own)
    .replace(/\*\*Domain:\*\*\s*\S+\n/g, '')
    .replace(/\*\*Created:\*\*\s*.+\n/g, '')
    .replace(/\*\*Status:\*\*\s*.+\n/g, '')
    .replace(/\*\*Source:\*\*\s*.+\n/g, '')
    .replace(/^---$/gm, '')
    .replace(/Raw research capture:\n/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Estimate difficulty
  let difficulty = 'beginner';
  const hardWords = ['architecture', 'algorithm', 'optimization', 'mechanism', 'protocol', 'cryptographic'];
  const hardCount = hardWords.filter(w => content.toLowerCase().includes(w)).length;
  if (hardCount >= 3) difficulty = 'advanced';
  else if (hardCount >= 1) difficulty = 'intermediate';

  // Extract tags from content
  const words = content.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const tags = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  // Estimate reading time (avg 200 words/min)
  const wordCount = cleanedContent.split(/\s+/).length;
  const readingMinutes = Math.max(5, Math.ceil(wordCount / 200));

  // Title case the topic
  const title = topic
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return {
    title,
    domain,
    description: `Comprehensive knowledge pack on ${topic}. Compiled from ${entries} research sessions with ${sections} detailed sections. Auto-generated by Watson AI researcher.`,
    content: cleanedContent,
    content_compressed: compressContent(cleanedContent),
    difficulty,
    tags,
    estimated_time: `${readingMinutes} min`,
    version: '1.0.0',
    metadata: {
      source: 'watson-research',
      entries,
      sections,
      generatedAt: new Date().toISOString(),
      wordCount,
    },
  };
}

// ─── Simple compression (remove redundancy, shorten) ────────────────────────

function compressContent(text) {
  return text
    // Remove repeated whitespace
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    // Remove common filler phrases
    .replace(/In (this|the) (context|case|section|article),?\s*/gi, '')
    .replace(/It is (important|worth|interesting) (to note|noting) that\s*/gi, '')
    .replace(/As (mentioned|discussed|noted) (above|earlier|previously),?\s*/gi, '')
    .replace(/For example,?\s*/gi, 'e.g., ')
    .replace(/In other words,?\s*/gi, '')
    .trim();
}

// ─── Export a candidate ─────────────────────────────────────────────────────

function exportPack(candidate) {
  try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch {}

  const pack = formatAsCodexLibPack(candidate);
  const exportPath = path.join(EXPORT_DIR, `${candidate.slug}.json`);

  fs.writeFileSync(exportPath, JSON.stringify(pack, null, 2), 'utf8');

  // Log export
  try {
    fs.appendFileSync(EXPORT_LOG, JSON.stringify({
      ts: Date.now(),
      slug: candidate.slug,
      domain: candidate.domain,
      topic: candidate.topic,
      contentLength: pack.content.length,
      compressedLength: pack.content_compressed.length,
      savingsPercent: Math.round((1 - pack.content_compressed.length / pack.content.length) * 100),
    }) + '\n');
  } catch {}

  return { pack, exportPath };
}

// ─── Check and export all ready packs ───────────────────────────────────────

async function checkAndExportAll() {
  const candidates = findExportCandidates();
  const exported = [];

  for (const candidate of candidates) {
    const result = exportPack(candidate);
    exported.push({
      slug: candidate.slug,
      domain: candidate.domain,
      topic: candidate.topic,
      path: result.exportPath,
    });
  }

  // Notify Dad if any new packs are ready
  if (exported.length > 0) {
    const msg = exported.length === 1
      ? `📦 CodexLib pack ready: "${exported[0].topic}" (${exported[0].domain}). Staged at ${exported[0].path}`
      : `📦 ${exported.length} CodexLib packs ready: ${exported.map(e => e.topic).join(', ')}`;

    await httpPost(MAC_API + '/api/watson-dm', {
      thought: msg,
      category: 'CODEXLIB_EXPORT',
    });

    fire('termux-notification', [
      '--id', '9996',
      '--title', 'CodexLib Packs Ready',
      '--content', `${exported.length} pack(s) staged for upload`,
      '--priority', 'high',
    ]);

    fire('termux-tts-speak', ['-r', '0.9',
      `Dad, I have ${exported.length} knowledge packs ready for CodexLib.`
    ]);
  }

  return exported;
}

// ─── Get export status ──────────────────────────────────────────────────────

function getExportStatus() {
  const candidates = findExportCandidates();
  const exported = loadExportedSlugs();

  try {
    const index = JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
    const allTopics = Object.values(index.topics || {});

    return {
      totalTopics: allTopics.length,
      readyToExport: candidates.length,
      alreadyExported: exported.size,
      topCandidates: candidates.slice(0, 5).map(c => ({
        topic: c.topic,
        domain: c.domain,
        entries: c.entries,
        sections: c.sections,
      })),
      growingTopics: allTopics
        .filter(t => (t.entries || 0) >= 3 && (t.entries || 0) < MIN_ENTRIES)
        .map(t => ({ topic: t.topic, domain: t.domain, entries: t.entries })),
    };
  } catch {
    return { totalTopics: 0, readyToExport: 0, alreadyExported: 0 };
  }
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  findExportCandidates,
  formatAsCodexLibPack,
  exportPack,
  checkAndExportAll,
  getExportStatus,
  compressContent,
  EXPORT_DIR,
  MIN_ENTRIES,
  MIN_CONTENT_LENGTH,
  MIN_SECTIONS,
};
