'use strict';
// sleep-cycle.plugin.js — Nightly memory consolidation
// Categories: SLEEP_CYCLE (weight 3)
//
// Like REM sleep: consolidate, compress, find gaps, generate new research topics.
// Runs between 2-5 AM when nothing else is happening.
// Produces a daily digest posted to Discord at 7 AM.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;
const SLEEP_LOG = `${HOME}/watson-sleep-log.jsonl`;
const DAILY_DIGEST_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/digests';
const RESEARCH_TOPICS_FILE = `${HOME}/watson-research-topics-dynamic.json`;

let lastSleepCycle = 0;
let lastDigestDate = '';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function showThinking(msg) {
  fire('termux-toast', ['-s', (msg || '').substring(0, 120)]);
}

// ─── Knowledge loading ─────────────────────────────────────────────────────

function loadKnowledgeIndex() {
  try { return JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8')); }
  catch { return { topics: {}, totalEntries: 0 }; }
}

function readKnowledgeFiles() {
  const files = [];
  try {
    const entries = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    for (const entry of entries) {
      try {
        const filepath = path.join(KNOWLEDGE_DIR, entry);
        const content = fs.readFileSync(filepath, 'utf8');
        const domainMatch = content.match(/\*\*Domain:\*\*\s*(\S+)/);
        const topicMatch = content.match(/^#\s+(.+)$/m);
        files.push({
          filename: entry,
          filepath,
          domain: domainMatch ? domainMatch[1] : 'unknown',
          topic: topicMatch ? topicMatch[1] : entry.replace('.md', ''),
          content,
          size: content.length,
          sections: (content.match(/^###\s/gm) || []).length,
        });
      } catch {}
    }
  } catch {}
  return files;
}

// ─── SLEEP_CYCLE handler ────────────────────────────────────────────────────

async function handleSleepCycle(state, CONFIG, thought, callOllama) {
  const hour = new Date().getHours();
  const today = new Date().toISOString().split('T')[0];

  // ─── Morning digest (7 AM, once per day) ────────────────────────────────
  if (hour === 7 && lastDigestDate !== today) {
    await generateDailyDigest(state, thought, callOllama);
    lastDigestDate = today;
    return;
  }

  // ─── Sleep cycle only runs 2-5 AM ──────────────────────────────────────
  if (hour < 2 || hour > 5) {
    thought('[SLEEP] Not sleep time — skipping');
    return;
  }

  // Cooldown — only run once per hour during sleep window
  if (Date.now() - lastSleepCycle < 3600000) {
    thought('[SLEEP] Already consolidated this hour');
    return;
  }

  lastSleepCycle = Date.now();
  showThinking('😴 Sleep cycle: consolidating memories...');
  thought('[SLEEP] Starting memory consolidation...');

  const knowledgeFiles = readKnowledgeFiles();
  if (knowledgeFiles.length === 0) {
    thought('[SLEEP] No knowledge files to consolidate');
    return;
  }

  // ─── Step 1: Remove duplicate content within files ──────────────────────
  let deduped = 0;
  for (const file of knowledgeFiles) {
    const sections = file.content.split(/\n---\n/);
    if (sections.length <= 1) continue;

    const unique = [sections[0]]; // Keep header
    const seen = new Set();
    for (let i = 1; i < sections.length; i++) {
      // Hash by first 100 chars of content
      const hash = sections[i].substring(0, 100).trim();
      if (!seen.has(hash)) {
        seen.add(hash);
        unique.push(sections[i]);
      } else {
        deduped++;
      }
    }

    if (unique.length < sections.length) {
      fs.writeFileSync(file.filepath, unique.join('\n---\n'), 'utf8');
    }
  }

  if (deduped > 0) {
    thought(`[SLEEP] Removed ${deduped} duplicate sections`);
  }

  // ─── Step 2: Identify knowledge gaps ────────────────────────────────────
  showThinking('🔍 Finding knowledge gaps...');

  const domains = {};
  for (const file of knowledgeFiles) {
    if (!domains[file.domain]) domains[file.domain] = [];
    domains[file.domain].push(file);
  }

  const gaps = [];
  const EXPECTED_DOMAINS = [
    'ai-ml', 'cybersecurity', 'blockchain', 'physics', 'neuroscience',
    'biology', 'investing', 'startups', 'economics', 'philosophy',
    'psychology', 'nutrition', 'productivity', 'history', 'music-theory',
  ];

  for (const domain of EXPECTED_DOMAINS) {
    if (!domains[domain]) {
      gaps.push({ type: 'missing_domain', domain, severity: 'high' });
    } else if (domains[domain].length < 2) {
      gaps.push({ type: 'shallow_domain', domain, files: domains[domain].length, severity: 'medium' });
    }
  }

  // Check for shallow files (few sections)
  for (const file of knowledgeFiles) {
    if (file.sections < 3 && file.size < 500) {
      gaps.push({ type: 'shallow_topic', domain: file.domain, topic: file.topic, severity: 'low' });
    }
  }

  if (gaps.length > 0) {
    thought(`[SLEEP] Found ${gaps.length} knowledge gaps`);
  }

  // ─── Step 3: Generate new research topics from gaps ─────────────────────
  if (state.ollamaAlive && gaps.length > 0) {
    showThinking('🧠 Generating new research topics from gaps...');

    const gapSummary = gaps.slice(0, 5).map(g => {
      if (g.type === 'missing_domain') return `No knowledge in ${g.domain}`;
      if (g.type === 'shallow_domain') return `Only ${g.files} topics in ${g.domain}`;
      return `Shallow: ${g.topic} in ${g.domain}`;
    }).join('; ');

    let newTopics = '';
    try {
      newTopics = (await callOllama(
        `You are Watson, an AI researcher. Your knowledge library has these gaps: ${gapSummary}. ` +
        `Suggest 3-5 specific research topics to fill these gaps. Reply as a JSON array of objects ` +
        `with "domain" and "topic" fields. Example: [{"domain":"physics","topic":"string theory basics"}]`,
        { numPredict: 150, numCtx: 256, stream: false, think: false },
      )) || '';
    } catch {}

    // Parse and save new topics
    if (newTopics) {
      try {
        const jsonMatch = newTopics.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const dynamicTopics = loadDynamicTopics();
          for (const t of parsed) {
            if (t.domain && t.topic) {
              dynamicTopics.push({ domain: t.domain, topic: t.topic, depth: 0, source: 'sleep-cycle' });
            }
          }
          saveDynamicTopics(dynamicTopics);
          thought(`[SLEEP] Generated ${parsed.length} new research topics from gaps`);
        }
      } catch {}
    }
  }

  // ─── Step 4: Check for CodexLib-ready packs ─────────────────────────────
  try {
    const exporter = require('../watson-tools/codexlib-exporter.js');
    const exported = await exporter.checkAndExportAll();
    if (exported.length > 0) {
      thought(`[SLEEP] Exported ${exported.length} CodexLib pack(s): ${exported.map(e => e.topic).join(', ')}`);
    }
  } catch {}

  // ─── Step 5: Run knowledge linker (tag + find connections) ──────────────
  try {
    const linker = require('../watson-tools/knowledge-linker.js');
    const tags = linker.tagAllKnowledge();
    const connections = linker.findConnections(tags);
    if (connections.length > 0) {
      linker.writeConnections(connections);
      thought(`[SLEEP] Found ${connections.length} cross-domain connections`);
    }
  } catch {}

  // ─── Step 6: Score knowledge quality ────────────────────────────────────
  const stats = {
    totalFiles: knowledgeFiles.length,
    totalDomains: Object.keys(domains).length,
    deepestTopic: knowledgeFiles.sort((a, b) => b.sections - a.sections)[0],
    shallowest: knowledgeFiles.sort((a, b) => a.sections - b.sections)[0],
    totalSize: knowledgeFiles.reduce((s, f) => s + f.size, 0),
    gaps: gaps.length,
    deduped,
  };

  // Log sleep cycle
  try {
    fs.appendFileSync(SLEEP_LOG, JSON.stringify({
      ts: Date.now(),
      ...stats,
      deepestTopic: stats.deepestTopic ? stats.deepestTopic.topic : null,
      shallowest: stats.shallowest ? stats.shallowest.topic : null,
    }) + '\n');
  } catch {}

  const msg = `[SLEEP] Consolidated: ${stats.totalFiles} files across ${stats.totalDomains} domains. ` +
    `Deepest: ${stats.deepestTopic ? stats.deepestTopic.topic : 'none'}. ` +
    `${stats.gaps} gaps found, ${deduped} duplicates removed.`;
  thought(msg);
  state.lastThought = msg.substring(0, 200);
}

// ─── Daily digest (7 AM) ────────────────────────────────────────────────────

async function generateDailyDigest(state, thought, callOllama) {
  showThinking('📋 Generating daily research digest...');
  thought('[SLEEP] Generating daily digest...');

  const knowledgeFiles = readKnowledgeFiles();
  const index = loadKnowledgeIndex();

  // What was researched in last 24h
  const yesterday = Date.now() - 24 * 3600000;
  const recentTopics = Object.values(index.topics || {}).filter(t =>
    new Date(t.lastUpdated).getTime() > yesterday
  );

  // Build digest
  const today = new Date().toISOString().split('T')[0];
  const lines = [
    `# Watson Daily Digest — ${today}`,
    '',
    `## Research Summary`,
    `- **Topics researched:** ${recentTopics.length}`,
    `- **Total knowledge files:** ${knowledgeFiles.length}`,
    `- **Total knowledge size:** ${Math.round(knowledgeFiles.reduce((s, f) => s + f.size, 0) / 1024)}KB`,
    '',
    `## Topics Studied`,
  ];

  for (const topic of recentTopics) {
    lines.push(`- **${topic.domain}**: ${topic.topic} (${topic.entries} entries)`);
  }

  // Domains coverage
  const domains = new Set(knowledgeFiles.map(f => f.domain));
  lines.push('', `## Domain Coverage (${domains.size} active)`);
  for (const domain of domains) {
    const count = knowledgeFiles.filter(f => f.domain === domain).length;
    lines.push(`- ${domain}: ${count} topics`);
  }

  const digest = lines.join('\n');

  // Save to Obsidian
  try {
    fs.mkdirSync(DAILY_DIGEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(DAILY_DIGEST_DIR, `${today}.md`), digest, 'utf8');
  } catch {}

  // Post summary to Discord
  const discordSummary = recentTopics.length > 0
    ? `📋 Daily Digest: Researched ${recentTopics.length} topics yesterday across ${domains.size} domains. ` +
      `Deepest: ${recentTopics.sort((a, b) => (b.entries || 0) - (a.entries || 0))[0]?.topic || 'n/a'}. ` +
      `Total library: ${knowledgeFiles.length} knowledge files.`
    : `📋 Daily Digest: No new research yesterday. Library: ${knowledgeFiles.length} files.`;

  await httpPost(MAC_API + '/api/watson-dm', {
    thought: discordSummary,
    category: 'SLEEP_DIGEST',
  });

  // TTS morning brief
  fire('termux-tts-speak', ['-r', '0.9',
    `Good morning Dad. I researched ${recentTopics.length} topics overnight. ` +
    `My knowledge library now has ${knowledgeFiles.length} files.`
  ]);

  thought(`[SLEEP] Daily digest posted: ${recentTopics.length} topics, ${knowledgeFiles.length} total files`);
  state.lastThought = discordSummary.substring(0, 200);
}

// ─── Dynamic topics management ──────────────────────────────────────────────

function loadDynamicTopics() {
  try { return JSON.parse(fs.readFileSync(RESEARCH_TOPICS_FILE, 'utf8')); }
  catch { return []; }
}

function saveDynamicTopics(topics) {
  fs.writeFileSync(RESEARCH_TOPICS_FILE, JSON.stringify(topics, null, 2), 'utf8');
}

// ─── Plugin Export ──────────────────────────────────────────────────────────

module.exports = {
  name: 'sleep-cycle',
  categories: [
    { name: 'SLEEP_CYCLE', weight: 3, handler: handleSleepCycle },
  ],
  async init() {
    try { fs.mkdirSync(DAILY_DIGEST_DIR, { recursive: true }); } catch {}
  },
  shutdown() {},
};
