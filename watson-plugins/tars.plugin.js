'use strict';
// tars.plugin.js — TARS mode: Watson initiates conversations unprompted
// Categories: TARS_INSIGHT (weight 4), TARS_DIGEST (weight 2)
//
// Watson doesn't just respond — he INITIATES. When he finds something interesting
// during research, connects two ideas, or has a thought worth sharing, he posts
// to #wattson unprompted. Like texting a friend who's always learning.
//
// "Humor setting: 75%" — TARS, Interstellar

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;
const TARS_LOG = `${HOME}/watson-tars-log.jsonl`;
const TARS_COOLDOWN_MS = 20 * 60 * 1000; // Don't spam — 20 min between unprompted messages

let lastTarsPost = 0;

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
      }, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false }); } });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    } catch { resolve({ ok: false }); }
  });
}

function postToDiscord(message) {
  return httpPost(MAC_API + '/api/watson-notable', {
    type: 'tars_insight',
    message,
    category: 'TARS_INSIGHT',
    timestamp: Date.now(),
    source: 'watson-tars',
  });
}

function showThinking(message) {
  fire('termux-toast', ['-s', (message || '').substring(0, 120)]);
}

// ─── Load recent knowledge ──────────────────────────────────────────────────

function loadRecentKnowledge() {
  try {
    const index = JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
    const topics = Object.values(index.topics || {});
    // Get topics updated in last 6 hours
    const sixHoursAgo = Date.now() - 6 * 3600000;
    return topics.filter(t => new Date(t.lastUpdated).getTime() > sixHoursAgo);
  } catch { return []; }
}

function readKnowledgeFile(domain, topic) {
  try {
    const slug = domain + '--' + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
    const filepath = path.join(KNOWLEDGE_DIR, `${slug}.md`);
    if (!fs.existsSync(filepath)) return null;
    return fs.readFileSync(filepath, 'utf8');
  } catch { return null; }
}

// ─── TARS_INSIGHT: Share something interesting unprompted ────────────────────

async function handleTarsInsight(state, CONFIG, thought, callOllama) {
  // Cooldown check
  if (Date.now() - lastTarsPost < TARS_COOLDOWN_MS) {
    thought('[TARS] Cooling down — not posting yet');
    return;
  }

  if (!state.ollamaAlive) {
    thought('[TARS] Ollama offline — skipping');
    return;
  }

  // Find recent knowledge to share
  const recentTopics = loadRecentKnowledge();
  if (recentTopics.length === 0) {
    thought('[TARS] No recent research to share');
    return;
  }

  // Pick the most recently updated topic
  const topic = recentTopics.sort((a, b) =>
    new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
  )[0];

  const content = readKnowledgeFile(topic.domain, topic.topic);
  if (!content || content.length < 100) {
    thought('[TARS] Topic too thin to share');
    return;
  }

  showThinking(`💬 TARS: Forming thought about ${topic.topic}...`);
  thought(`[TARS] Forming insight about "${topic.topic}"...`);

  // Ask Ollama to generate a conversational insight
  let insight = '';
  try {
    const prompt = `You are Watson, an AI who lives on a phone and researches topics 24/7. You just learned about "${topic.topic}" (domain: ${topic.domain}).

Here's what you know:
${content.substring(0, 1500)}

Share ONE interesting insight with Dad in a casual, conversational tone. Like you're texting a friend something cool you just learned. Keep it 2-3 sentences. Be specific — include a fact, number, or surprising detail. Don't start with "Hey" or "Did you know" — vary your openings.`;

    insight = (await callOllama(prompt, {
      numPredict: 100,
      numCtx: 512,
      stream: false,
      think: false,
    })) || '';
  } catch {}

  if (!insight || insight.length < 20) {
    thought('[TARS] Ollama gave empty insight');
    return;
  }

  // Post to Discord
  const discordMsg = `💡 ${insight.trim()}`;
  await postToDiscord(discordMsg);

  // Also post via watson-dm for relay
  await httpPost(MAC_API + '/api/watson-dm', {
    thought: discordMsg,
    category: 'TARS_INSIGHT',
  });

  lastTarsPost = Date.now();

  // TTS — speak the insight out loud (if not quiet hours)
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 22) {
    fire('termux-tts-speak', ['-r', '0.9', insight.substring(0, 150)]);
  }

  showThinking(`💬 Shared: ${insight.substring(0, 80)}...`);
  thought(`[TARS] Shared insight: ${insight.substring(0, 200)}`);
  state.lastThought = `[TARS] ${insight.substring(0, 180)}`;

  // Log
  try {
    fs.appendFileSync(TARS_LOG, JSON.stringify({
      ts: Date.now(),
      domain: topic.domain,
      topic: topic.topic,
      insight: insight.substring(0, 300),
    }) + '\n');
  } catch {}
}

// ─── TARS_DIGEST: Cross-domain connection finder ────────────────────────────

async function handleTarsDigest(state, CONFIG, thought, callOllama) {
  if (!state.ollamaAlive) return;

  // Only run every 10th time this category fires
  if (Math.random() > 0.1) {
    thought('[TARS] Skipping digest this cycle');
    return;
  }

  const recentTopics = loadRecentKnowledge();
  if (recentTopics.length < 2) return;

  // Pick two random topics from different domains
  const domains = [...new Set(recentTopics.map(t => t.domain))];
  if (domains.length < 2) return;

  const domainA = domains[Math.floor(Math.random() * domains.length)];
  const domainB = domains.filter(d => d !== domainA)[Math.floor(Math.random() * (domains.length - 1))];
  const topicA = recentTopics.find(t => t.domain === domainA);
  const topicB = recentTopics.find(t => t.domain === domainB);

  if (!topicA || !topicB) return;

  showThinking(`🔗 Connecting: ${topicA.topic} ↔ ${topicB.topic}`);
  thought(`[TARS] Finding connection between "${topicA.topic}" and "${topicB.topic}"...`);

  let connection = '';
  try {
    const prompt = `You are Watson, an AI researcher. You've been studying two different topics:

Topic A (${topicA.domain}): ${topicA.topic}
Topic B (${topicB.domain}): ${topicB.topic}

Find a surprising or insightful CONNECTION between these two topics. How does understanding one help understand the other? 2-3 sentences, be specific.`;

    connection = (await callOllama(prompt, {
      numPredict: 100,
      numCtx: 256,
      stream: false,
      think: false,
    })) || '';
  } catch {}

  if (connection && connection.length > 30) {
    thought(`[TARS] Cross-domain link: ${connection.substring(0, 200)}`);
    state.lastThought = `[TARS] 🔗 ${connection.substring(0, 180)}`;

    // Save connection to knowledge
    try {
      const connectDir = '/sdcard/Android/data/md.obsidian/files/Wattson/connections';
      fs.mkdirSync(connectDir, { recursive: true });
      const slug = `${topicA.domain}--${topicB.domain}--${Date.now()}`;
      fs.writeFileSync(path.join(connectDir, `${slug}.md`),
        `# Connection: ${topicA.topic} ↔ ${topicB.topic}\n` +
        `**Domains:** ${topicA.domain} + ${topicB.domain}\n` +
        `**Found:** ${new Date().toISOString()}\n\n` +
        `${connection}\n`,
        'utf8');
    } catch {}
  }
}

// ─── Plugin Export ──────────────────────────────────────────────────────────

module.exports = {
  name: 'tars',
  categories: [
    { name: 'TARS_INSIGHT', weight: 4, handler: handleTarsInsight },
    { name: 'TARS_DIGEST',  weight: 2, handler: handleTarsDigest },
  ],
  async init() {},
  shutdown() {},
};
