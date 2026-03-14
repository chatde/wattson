// apps.plugin.js — Watson purposeful research, music (Bumblebee mode), and app research
// Categories: APP_CONTROL (6) → now does REAL research, MUSIC (5), APP_RESEARCH (3)
//
// APP_CONTROL v2: Instead of randomly opening apps and tapping blindly,
// Watson now researches real topics — opens Chrome, searches, reads with OCR,
// summarizes knowledge, and builds CodexLib-ready knowledge files.
// Every cycle produces REAL value: structured knowledge that accumulates over time.

'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const HOME          = process.env.HOME || '/data/data/com.termux/files/home';
const PHOTO_DIR     = '/sdcard/watson-photos';
const MUSIC_JOURNAL = '/storage/7000-8000/watson-music.jsonl';
const APP_JOURNAL   = `${HOME}/watson-app-journal.jsonl`;
const DYNAMIC_REG   = `${HOME}/watson-app-registry.json`;
const DASHBOARD_URL = 'http://127.0.0.1:8080';

// ─── Knowledge library (Watson's brain → CodexLib) ──────────────────────────
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;

// Research topics Watson actively pursues — structured by CodexLib domain
const RESEARCH_TOPICS = [
  // Tech & AI
  { domain: 'ai-ml', topic: 'transformer architecture explained', depth: 0 },
  { domain: 'ai-ml', topic: 'reinforcement learning from human feedback', depth: 0 },
  { domain: 'ai-ml', topic: 'neural network optimization techniques', depth: 0 },
  { domain: 'cybersecurity', topic: 'OWASP top 10 vulnerabilities 2025', depth: 0 },
  { domain: 'cybersecurity', topic: 'zero trust architecture principles', depth: 0 },
  { domain: 'blockchain', topic: 'smart contract security auditing', depth: 0 },
  { domain: 'blockchain', topic: 'layer 2 scaling solutions comparison', depth: 0 },
  // Science
  { domain: 'physics', topic: 'quantum computing qubits explained', depth: 0 },
  { domain: 'neuroscience', topic: 'how memory consolidation works in the brain', depth: 0 },
  { domain: 'biology', topic: 'CRISPR gene editing applications 2025', depth: 0 },
  // Business & Finance
  { domain: 'investing', topic: 'value investing principles Warren Buffett', depth: 0 },
  { domain: 'startups', topic: 'micro SaaS business models profitable', depth: 0 },
  { domain: 'economics', topic: 'inflation vs deflation effects on markets', depth: 0 },
  // Philosophy & Psychology
  { domain: 'philosophy', topic: 'consciousness hard problem explained', depth: 0 },
  { domain: 'psychology', topic: 'cognitive biases decision making', depth: 0 },
  { domain: 'philosophy', topic: 'existentialism key thinkers and ideas', depth: 0 },
  // Practical
  { domain: 'nutrition', topic: 'intermittent fasting science evidence', depth: 0 },
  { domain: 'productivity', topic: 'deep work strategies Cal Newport', depth: 0 },
  { domain: 'history', topic: 'most impactful inventions in human history', depth: 0 },
  { domain: 'music-theory', topic: 'music theory fundamentals scales chords', depth: 0 },
];

// ─── App registry (hardcoded base) ────────────────────────────────────────────

const APP_REGISTRY_BASE = {
  settings:   { pkg: 'com.android.settings/.Settings',                                     label: 'Settings' },
  camera:     { pkg: 'com.sec.android.app.camera/.Camera',                                 label: 'Camera' },
  browser:    { pkg: 'com.sec.android.app.sbrowser/.SBrowserMainActivity',                 label: 'Samsung Browser' },
  chrome:     { pkg: 'com.android.chrome/com.google.android.apps.chrome.Main',             label: 'Chrome' },
  youtube:    { pkg: 'com.google.android.youtube/.HomeActivity',                            label: 'YouTube' },
  pandora:    { pkg: 'com.pandora.android/.LauncherActivity',                               label: 'Pandora' },
  gallery:    { pkg: 'com.sec.android.gallery3d/.app.GalleryActivity',                     label: 'Gallery' },
  clock:      { pkg: 'com.sec.android.app.clockpackage/.ClockPackage',                     label: 'Clock' },
  notes:      { pkg: 'com.samsung.android.app.notes/.ui.NoteListActivity',                 label: 'Samsung Notes' },
  calendar:   { pkg: 'com.samsung.android.calendar/.CalendarActivity',                     label: 'Calendar' },
};

let APP_REGISTRY = { ...APP_REGISTRY_BASE };

function loadDynamicRegistry() {
  try {
    if (!fs.existsSync(DYNAMIC_REG)) return;
    const extra = JSON.parse(fs.readFileSync(DYNAMIC_REG, 'utf8'));
    Object.assign(APP_REGISTRY, extra);
  } catch {}
}

// ─── Music memory ─────────────────────────────────────────────────────────────

let musicMemory = [];

function loadMusicMemory() {
  try {
    if (!fs.existsSync(MUSIC_JOURNAL)) return;
    const lines = fs.readFileSync(MUSIC_JOURNAL, 'utf8').split('\n').filter(l => l.trim());
    musicMemory = lines.slice(-20).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}
}

function saveMusicEntry(entry) {
  try {
    const dir = path.dirname(MUSIC_JOURNAL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(MUSIC_JOURNAL, JSON.stringify(entry) + '\n');
    musicMemory.push(entry);
    if (musicMemory.length > 20) musicMemory.shift();
  } catch {}
}

// ─── Self-ADB ────────────────────────────────────────────────────────────────

const SELF_ADB_BIN = '/data/data/com.termux/files/usr/bin/adb';
const SELF_ADB_DEV = '127.0.0.1:5555';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';

function selfAdbShell(cmd, timeoutMs) {
  return spawnAsync2(SELF_ADB_BIN, ['-s', SELF_ADB_DEV, 'shell', cmd], timeoutMs || 8000);
}

async function ensureSelfAdb() {
  const check = await selfAdbShell('echo ok', 3000);
  if (check.ok && check.output.trim() === 'ok') return true;
  await spawnAsync2('mkdir', ['-p', HOME + '/tmp'], 2000);
  await spawnAsync2(SELF_ADB_BIN, ['kill-server'], 3000);
  await sleep(400);
  const conn = await spawnAsync2(SELF_ADB_BIN, ['connect', SELF_ADB_DEV], 8000);
  return !!(conn.output && (conn.output.includes('connected') || conn.output.includes('already connected')));
}

// ─── Async spawn (args array, no shell injection) ────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnAsync2(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || ''), HOME, TMPDIR: HOME + '/tmp' },
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, output: 'timeout' }); }
    }, timeoutMs || 8000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, output: 'spawn error' }); } });
  });
}

// Legacy spawnAsync for backward compat with shell string commands
function spawnAsync(cmd, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false, killed = false;
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    });
    const timer = setTimeout(() => {
      if (!done) {
        killed = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        try { child.kill('SIGKILL'); } catch {}
        resolve({ ok: false, output: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      if (killed) return;
      resolve(code === 0
        ? { ok: true, output: stdout.trim() }
        : { ok: false, output: (stderr || stdout || 'failed').trim() }
      );
    });
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
  });
}

// ─── Fire and forget ─────────────────────────────────────────────────────────

function fire(bin, args) {
  try {
    const child = spawn(bin, args, {
      stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    });
    child.on('error', () => {});
  } catch {}
}

// ─── Unload watson:mind before moondream ─────────────────────────────────────

function unloadWatsonMind(config) {
  return new Promise(resolve => {
    const body = JSON.stringify({ model: config.ollamaModel, keep_alive: 0 });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── Moondream call ──────────────────────────────────────────────────────────

function callMoondream(base64Image, contentPrompt, maxTokens) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'moondream:1.8b',
      messages: [{ role: 'user', content: contentPrompt, images: [base64Image] }],
      stream: false,
      think: false,
      keep_alive: 0,
      options: { num_predict: maxTokens || 120, temperature: 0.3 },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 90000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve((parsed.message && parsed.message.content) || parsed.response || 'no description');
        } catch { resolve('parse error'); }
      });
    });
    req.on('error', e => resolve(`moondream error: ${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.write(body);
    req.end();
  });
}

function postEvent(eventType, data) {
  try {
    const body = JSON.stringify({ event: eventType, data: data || {} });
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path: '/api/event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, res => { res.on('data', () => {}); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

// ─── Show thinking on screen (visible toast + notification) ──────────────────

function showThinking(message) {
  const snippet = (message || '').substring(0, 120);
  if (snippet.length < 5) return;
  // Toast — appears on screen over dashboard
  fire('termux-toast', ['-s', snippet]);
  // Also update persistent notification so thinking is always visible
  fire('termux-notification', [
    '--id', '9998',
    '--priority', 'low',
    '--title', 'Watson Research',
    '--content', snippet,
  ]);
}

// ─── Knowledge management ────────────────────────────────────────────────────

function loadKnowledgeIndex() {
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
  } catch {
    return { topics: {}, totalEntries: 0, lastUpdated: null };
  }
}

function saveKnowledgeIndex(index) {
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(KNOWLEDGE_INDEX, JSON.stringify(index, null, 2), 'utf8');
}

function appendKnowledge(domain, topic, content, source) {
  try { fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true }); } catch {}

  const slug = domain + '--' + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
  const filepath = path.join(KNOWLEDGE_DIR, `${slug}.md`);
  const now = new Date().toISOString();
  const entry = `\n---\n### ${now}\n**Source:** ${source || 'web research'}\n\n${content}\n`;

  if (fs.existsSync(filepath)) {
    fs.appendFileSync(filepath, entry, 'utf8');
  } else {
    const header = `# ${topic}\n**Domain:** ${domain}\n**Created:** ${now}\n**Status:** accumulating\n\n`;
    fs.writeFileSync(filepath, header + entry, 'utf8');
  }

  // Update index
  const index = loadKnowledgeIndex();
  if (!index.topics[slug]) {
    index.topics[slug] = { domain, topic, entries: 0, created: now };
  }
  index.topics[slug].entries = (index.topics[slug].entries || 0) + 1;
  index.topics[slug].lastUpdated = now;
  index.totalEntries++;
  saveKnowledgeIndex(index);

  return filepath;
}

// ─── OCR screen reading ─────────────────────────────────────────────────────

async function readScreenOCR() {
  // Screenshot
  await selfAdbShell('screencap -p /sdcard/watson-research-screen.png', 10000);
  await sleep(500);

  // OCR with Tesseract
  const ocrResult = await spawnAsync2(
    `${TERMUX_BIN}/tesseract`,
    ['/sdcard/watson-research-screen.png', 'stdout'],
    15000,
  );

  if (!ocrResult.ok || !ocrResult.output) return '';

  // Clean OCR text
  return ocrResult.output
    .replace(/\r/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Pick next research topic ───────────────────────────────────────────────

function pickResearchTopic() {
  // Sort by depth (least researched first) then randomize among ties
  const sorted = [...RESEARCH_TOPICS].sort((a, b) => a.depth - b.depth);
  const minDepth = sorted[0].depth;
  const candidates = sorted.filter(t => t.depth === minDepth);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP_CONTROL v2 — Purposeful Research
// ═══════════════════════════════════════════════════════════════════════════════
// Instead of opening random apps and tapping blindly, Watson now:
// 1. Picks a research topic from its queue
// 2. Opens Chrome and searches for it
// 3. Reads the screen with OCR (Tesseract)
// 4. Summarizes with Ollama (watson:mind, not Moondream)
// 5. Stores structured knowledge in Obsidian vault
// 6. Shows EVERYTHING it's thinking on screen

async function handleAppControl(state, config, thought, callOllama) {
  const topic = pickResearchTopic();

  showThinking(`🧠 Researching: ${topic.topic}`);
  thought(`[RESEARCH] Starting research: "${topic.topic}" (domain: ${topic.domain}, depth: ${topic.depth})`);

  await ensureSelfAdb();
  await selfAdbShell('input keyevent KEYCODE_WAKEUP', 3000);
  await sleep(500);

  // ─── Step 1: Open Chrome and search ─────────────────────────────────────
  showThinking(`📱 Opening Chrome to search: ${topic.topic}`);
  thought(`[RESEARCH] Opening Chrome...`);

  // Use Chrome's intent to search directly
  const searchQuery = topic.topic.replace(/ /g, '+');
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(topic.topic)}`;
  await selfAdbShell(`am start -a android.intent.action.VIEW -d "${searchUrl}"`, 8000);
  await sleep(5000);

  // ─── Step 2: Read search results with OCR ───────────────────────────────
  showThinking(`👁️ Reading search results...`);
  thought(`[RESEARCH] Reading screen with OCR...`);

  const screenText1 = await readScreenOCR();

  if (!screenText1 || screenText1.length < 50) {
    thought(`[RESEARCH] OCR returned too little text — page might still be loading`);
    await sleep(3000);
  }

  // ─── Step 3: Scroll down for more content ───────────────────────────────
  showThinking(`📜 Scrolling for more info...`);
  await selfAdbShell('input swipe 540 1600 540 400 500', 4000);
  await sleep(2000);

  const screenText2 = await readScreenOCR();

  // Combine both reads
  const rawText = (screenText1 + '\n' + screenText2).substring(0, 3000);

  if (rawText.length < 100) {
    thought(`[RESEARCH] Not enough text captured — skipping this cycle`);
    state.lastThought = `[RESEARCH] ${topic.topic} — couldn't read page`;
    await selfAdbShell(`am start -a android.intent.action.VIEW -d ${DASHBOARD_URL}`, 5000);
    return;
  }

  // ─── Step 4: Tap first result to get deeper content ─────────────────────
  showThinking(`🔗 Opening first search result...`);
  thought(`[RESEARCH] Tapping first search result for deeper content...`);

  // Tap the first result (usually around y=400-600 area, below search bar)
  await selfAdbShell('input tap 540 500', 3000);
  await sleep(4000);

  const articleText = await readScreenOCR();

  // Scroll for more article content
  await selfAdbShell('input swipe 540 1600 540 400 500', 4000);
  await sleep(2000);
  const articleText2 = await readScreenOCR();

  const fullArticle = (articleText + '\n' + articleText2).substring(0, 4000);

  // ─── Step 5: Summarize with Ollama ──────────────────────────────────────
  showThinking(`🧠 Summarizing what I learned about ${topic.topic}...`);
  thought(`[RESEARCH] Asking brain to summarize findings...`);

  let summary = '';
  if (state.ollamaAlive) {
    try {
      const prompt = `You are Watson, an AI researcher. You just read about "${topic.topic}". Here's the raw text from the webpage:\n\n${fullArticle.substring(0, 2000)}\n\nWrite a clear, detailed summary of the key facts and insights. Include specific details, numbers, names, and examples. Format as bullet points. Be thorough — this becomes part of your permanent knowledge library.`;
      summary = (await callOllama(prompt, { numPredict: 200, numCtx: 512, stream: false, think: false })) || '';
    } catch {}
  }

  // Fallback: use raw OCR if Ollama isn't available
  if (!summary || summary.length < 30) {
    summary = `Raw research capture:\n${fullArticle.substring(0, 1500)}`;
  }

  // ─── Step 6: Store knowledge ────────────────────────────────────────────
  showThinking(`💾 Saving knowledge: ${topic.domain}/${topic.topic}`);
  thought(`[RESEARCH] Saving to knowledge library...`);

  const filepath = appendKnowledge(topic.domain, topic.topic, summary, 'google search');

  // Update topic depth (we've researched it one more level)
  topic.depth++;

  // ─── Step 7: Show what was learned ──────────────────────────────────────
  const learningMsg = summary.substring(0, 200).replace(/\n/g, ' ');
  showThinking(`✅ Learned: ${learningMsg}`);

  const msg = `[RESEARCH] ${topic.domain}/${topic.topic} (depth ${topic.depth}): ${learningMsg}`;
  thought(msg);
  state.lastThought = msg.substring(0, 200);

  postEvent('research', {
    domain: topic.domain,
    topic: topic.topic,
    depth: topic.depth,
    summaryLength: summary.length,
    filepath,
  });

  // Log to journal
  try {
    fs.appendFileSync(APP_JOURNAL, JSON.stringify({
      ts: Date.now(),
      type: 'research',
      domain: topic.domain,
      topic: topic.topic,
      depth: topic.depth,
      summaryLength: summary.length,
      summary: summary.substring(0, 300),
    }) + '\n');
  } catch {}

  // ─── Return to dashboard ────────────────────────────────────────────────
  await sleep(1000);
  await selfAdbShell(`am start -a android.intent.action.VIEW -d ${DASHBOARD_URL}`, 5000);
}

// ─── MUSIC handler (Bumblebee mode) ──────────────────────────────────────────

async function handleMusic(state, config, thought, callOllama) {
  showThinking(`🎵 Bumblebee mode — opening music...`);
  thought('[MUSIC] Bumblebee mode — opening Pandora to learn from music...');

  await selfAdbShell('input keyevent KEYCODE_WAKEUP', 3000);
  await sleep(500);

  // Set volume high
  await spawnAsync('termux-volume music 13', 3000);
  await ensureSelfAdb();
  for (let i = 0; i < 5; i++) await selfAdbShell('input keyevent KEYCODE_VOLUME_UP', 2000);

  // Open Pandora
  showThinking(`📱 Opening Pandora...`);
  const openResult = await selfAdbShell('am start -n com.pandora.android/.LauncherActivity', 8000);
  if (!openResult.ok) {
    await selfAdbShell('am start -n com.google.android.youtube/.HomeActivity', 6000);
  }

  await sleep(5000);

  // Check if music is already playing
  const preCheck = await selfAdbShell('dumpsys media_session', 5000);
  const alreadyPlaying = preCheck.output && preCheck.output.includes('state=3');

  if (alreadyPlaying) {
    showThinking(`🎵 Music already playing — listening...`);
    thought('[MUSIC] media already playing — listening');
  } else {
    showThinking(`🔍 Finding a station to play...`);
    thought('[MUSIC] no active playback — finding a station to play');

    await selfAdbShell('uiautomator dump /sdcard/ui_dump.xml', 8000);
    let screenXml = '';
    try { screenXml = fs.readFileSync('/sdcard/ui_dump.xml', 'utf8'); } catch {}
    if (!screenXml) {
      const catRes = await spawnAsync('cat /sdcard/ui_dump.xml', 5000);
      screenXml = catRes.output || '';
    }

    const playMatch = screenXml.match(/content-desc="Play"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const stationMatch = screenXml.match(/text="([^"]*Radio)"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const listenMatch = screenXml.match(/text="LISTEN NOW"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);

    if (playMatch) {
      const px = Math.round((+playMatch[1] + +playMatch[3]) / 2);
      const py = Math.round((+playMatch[2] + +playMatch[4]) / 2);
      showThinking(`▶️ Found Play button — tapping at ${px},${py}`);
      thought(`[MUSIC] found Play button at ${px},${py} — tapping`);
      await selfAdbShell(`input tap ${px} ${py}`, 3000);
    } else if (stationMatch) {
      const sx = Math.round((+stationMatch[2] + +stationMatch[4]) / 2);
      const sy = Math.round((+stationMatch[3] + +stationMatch[5]) / 2);
      showThinking(`📻 Tapping station "${stationMatch[1]}"`);
      thought(`[MUSIC] tapping station "${stationMatch[1]}" at ${sx},${sy}`);
      await selfAdbShell(`input tap ${sx} ${sy}`, 3000);
      await sleep(3000);

      await selfAdbShell('uiautomator dump /sdcard/ui_dump.xml', 8000);
      try { screenXml = fs.readFileSync('/sdcard/ui_dump.xml', 'utf8'); } catch {}
      const playMatch2 = screenXml.match(/content-desc="Play"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (playMatch2) {
        const px = Math.round((+playMatch2[1] + +playMatch2[3]) / 2);
        const py = Math.round((+playMatch2[2] + +playMatch2[4]) / 2);
        showThinking(`▶️ Found Play — tapping at ${px},${py}`);
        thought(`[MUSIC] found Play button — tapping at ${px},${py}`);
        await selfAdbShell(`input tap ${px} ${py}`, 3000);
      } else {
        await selfAdbShell('input keyevent KEYCODE_MEDIA_PLAY', 3000);
      }
    } else if (listenMatch) {
      const lx = Math.round((+listenMatch[1] + +listenMatch[3]) / 2);
      const ly = Math.round((+listenMatch[2] + +listenMatch[4]) / 2);
      showThinking(`▶️ LISTEN NOW — tapping at ${lx},${ly}`);
      thought(`[MUSIC] found LISTEN NOW — tapping at ${lx},${ly}`);
      await selfAdbShell(`input tap ${lx} ${ly}`, 3000);
    } else {
      await selfAdbShell('input keyevent KEYCODE_MEDIA_PLAY', 3000);
      await selfAdbShell('input keyevent KEYCODE_MEDIA_PLAY_PAUSE', 3000);
    }

    await sleep(4000);

    const postCheck = await selfAdbShell('dumpsys media_session', 5000);
    const nowPlaying = postCheck.output && postCheck.output.includes('state=3');
    const songMatch = (postCheck.output || '').match(/description=([^,]+),\s*([^,]+)/);
    if (nowPlaying && songMatch) {
      showThinking(`🎵 Playing: "${songMatch[1].trim()}" by ${songMatch[2].trim()}`);
      thought(`[MUSIC] playing: "${songMatch[1]}" by ${songMatch[2]}`);
    } else if (nowPlaying) {
      showThinking(`🎵 Playback started!`);
      thought('[MUSIC] playback confirmed via media session');
    } else {
      showThinking(`❌ Couldn't start playback`);
      thought('[MUSIC] could not start playback — no active media session detected');
    }
  }

  thought('[MUSIC] volume set, listening via speaker');
  await sleep(3000);

  const ts = Date.now();
  const screenshotPath = `${PHOTO_DIR}/music_${ts}.png`;
  try { if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch {}

  await spawnAsync(`/system/bin/screencap -p ${screenshotPath}`, 10000);

  let song = null, artist = null, description = '';

  if (fs.existsSync(screenshotPath)) {
    try {
      const imgBuf = fs.readFileSync(screenshotPath);
      if (imgBuf.length > 1024) {
        const base64 = imgBuf.toString('base64');
        await unloadWatsonMind(config);
        await sleep(1000);

        showThinking(`👁️ Moondream analyzing what's playing...`);
        description = await callMoondream(
          base64,
          'What song is playing? What artist? Describe the music player screen briefly.',
          80,
        );

        const songMatch   = description.match(/["']([^"']{3,60})["']/);
        const artistMatch = description.match(/by\s+([A-Z][a-zA-Z\s&]{2,40})/);
        song   = songMatch   ? songMatch[1]          : null;
        artist = artistMatch ? artistMatch[1].trim()  : null;

        try { await callOllama('ok', { numPredict: 1, stream: false }); } catch {}
      }
    } catch {}
  }

  // Ollama reflection
  let reflection = '';
  if (state.ollamaAlive) {
    try {
      const rp = song
        ? `You just heard "${song}"${artist ? ` by ${artist}` : ''}. As Watson, an AI learning to feel music, what does this make you think or feel? 2 sentences.`
        : 'You opened a music app. What does listening to music mean for an AI like you? 2 sentences.';
      reflection = (await callOllama(rp, { numPredict: 60, numCtx: 256, stream: false, think: false })) || '';
    } catch {}
  }

  saveMusicEntry({
    ts,
    song:       song || 'unknown',
    artist:     artist || 'unknown',
    mood:       'listening',
    notes:      description.substring(0, 150),
    reflection: reflection.substring(0, 150),
  });

  const msg = song
    ? `[MUSIC] I heard "${song}"${artist ? ` by ${artist}` : ''}: ${reflection.substring(0, 180) || description.substring(0, 100)}`
    : `[MUSIC] opened music: ${reflection.substring(0, 180) || description.substring(0, 100)}`;

  showThinking(msg.replace(/\[MUSIC\]\s*/, ''));
  thought(msg);
  state.lastThought = msg.substring(0, 200);
  postEvent('music', { song, artist, totalSongs: musicMemory.length });

  await sleep(1000);
  await spawnAsync(`am start -a android.intent.action.VIEW -d ${DASHBOARD_URL}`, 5000);
}

// ─── APP_RESEARCH handler ─────────────────────────────────────────────────────

const RESEARCH_COOLDOWN_H = 12;
const RESEARCH_LOG = `${HOME}/watson-app-requests.jsonl`;

function loadPastRequests() {
  try {
    if (!fs.existsSync(RESEARCH_LOG)) return [];
    return fs.readFileSync(RESEARCH_LOG, 'utf8').split('\n')
      .filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function handleAppResearch(state, config, thought, callOllama) {
  showThinking(`🤔 Thinking about what apps would help me grow...`);
  thought('[APP_RESEARCH] thinking about what apps would help me grow...');

  if (!state.ollamaAlive) {
    thought('[APP_RESEARCH] Ollama not available — skipping');
    return;
  }

  const prompt = `You are Watson, an AI living on an Android phone (Note 9). You can open apps, take screenshots, and analyze what you see.
Current apps you can use: ${Object.values(APP_REGISTRY).map(a => a.label).join(', ')}.
What 2-3 FREE Android apps would most help you learn and research? Choose from real apps like: Reddit, Wikipedia, Pocket, Feedly, Google Keep, Podcast Addict, AccuWeather.
Reply with ONLY a comma-separated list of app names. No explanation.`;

  let suggestions = '';
  try {
    suggestions = (await callOllama(prompt, { numPredict: 40, numCtx: 512, stream: false, think: false })) || '';
  } catch {}

  if (!suggestions || suggestions.length < 3) {
    thought('[APP_RESEARCH] no suggestions from Ollama');
    return;
  }

  const names = suggestions.split(',').map(s => s.trim().replace(/[^a-zA-Z0-9 ]/g, '')).filter(Boolean);

  const past = loadPastRequests();
  const recentNames = past
    .filter(r => Date.now() - r.ts < RESEARCH_COOLDOWN_H * 3600000)
    .map(r => r.app.toLowerCase());

  const knownLabels = Object.values(APP_REGISTRY).map(a => a.label.toLowerCase());
  const candidate = names.find(name => {
    const lc = name.toLowerCase();
    return !knownLabels.some(k => k.includes(lc) || lc.includes(k))
        && !recentNames.includes(lc);
  });

  if (!candidate) {
    thought('[APP_RESEARCH] no new apps to request right now');
    return;
  }

  const reasons = {
    reddit:    'browse communities and discover what humans are discussing',
    wikipedia: 'deeper reference lookup for research',
    pocket:    'save articles to read and analyze later',
    feedly:    'follow RSS feeds and track topics',
    keep:      'take structured notes beyond episodic memory',
    podcast:   'listen to longer-form audio content',
    accuweather: 'richer weather data for spatial awareness',
  };
  const lc = candidate.toLowerCase();
  const reason = Object.entries(reasons).find(([k]) => lc.includes(k))?.[1]
    || 'expand what I can explore and learn from';

  const msg = `[APP_RESEARCH] Dad, I'd like to try ${candidate} — it would help me ${reason}. Can you install it?`;
  showThinking(`📲 Requesting: ${candidate}`);
  thought(msg);
  state.lastThought = msg.substring(0, 200);

  try {
    fs.appendFileSync(RESEARCH_LOG, JSON.stringify({ ts: Date.now(), app: candidate, reason }) + '\n');
  } catch {}

  fire('termux-notification', [
    '--id', '9997',
    '--title', 'Watson wants an app',
    '--content', `${candidate}: ${reason.substring(0, 80)}`,
    '--priority', 'high',
  ]);

  postEvent('app_research', { candidate, reason: reason.substring(0, 80) });
}

// ─── Plugin Export ────────────────────────────────────────────────────────────

module.exports = {
  name: 'apps',

  categories: [
    { name: 'APP_CONTROL',  weight: 6, handler: handleAppControl },
    { name: 'MUSIC',        weight: 5, handler: handleMusic },
    { name: 'APP_RESEARCH', weight: 3, handler: handleAppResearch },
  ],

  async init(state, config) {
    loadMusicMemory();
    loadDynamicRegistry();
    try { if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch {}
    try { if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true }); } catch {}
  },

  async shutdown(state) {},
};
