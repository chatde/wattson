#!/usr/bin/env node
// Wattson Dashboard Server — Live thought stream + hardware monitoring
// Run: node dashboard/server.js
// Open: http://localhost:8080
// Phase 17: SSE real-time, memory/creations/growth/games/music/spatial/patches APIs

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const PORT = parseInt(process.env.DASHBOARD_PORT || '8080');
const MIND_API = process.env.MIND_API || 'http://127.0.0.1:8081';
const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const STORAGE = '/storage/7000-8000';

// ─── Cloud Vision + Voice API Keys ───────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'GROQ_KEY_REMOVED';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const PHOTOS_DIR = '/sdcard/watson-photos';
const TMP_DIR = `${process.env.HOME || '/data/data/com.termux/files/home'}/.watson-tmp`;

// ─── State ───────────────────────────────────────────────────────────────────
const thoughts = [];      // received from wattson-mind.js
let lastState = null;     // last state from mind API
let lastThoughtTime = 0;  // timestamp of last POST /api/thought from watson-core.js

// ─── Skills Cache ─────────────────────────────────────────────────────────────
const SKILL_JOURNAL = `${STORAGE}/watson-skills.jsonl`;
let skillsCache = { mastered: 0, total: 0, recent: [], capabilities: {} };

function refreshSkillsCache() {
  try {
    // Detect which capabilities Watson has unlocked via file/path existence
    let gpsLive = false;
    try {
      const sd = JSON.parse(fs.readFileSync('/sdcard/wattson-sensors.json', 'utf8'));
      gpsLive = !!(sd.location && (sd.location.lat || sd.location.longitude));
    } catch {}
    const caps = {
      gps:      gpsLive,
      voice:    fs.existsSync('/data/data/com.termux/files/home/watson-phone-control.js'),
      vision:   fs.existsSync('/sdcard/watson-photos/'),
      memory:   fs.existsSync(`${STORAGE}/watson-memory/`),
      selfcam:  fs.existsSync('/sdcard/watson-photos/'),
      vault:    fs.existsSync('/data/data/com.termux/files/home/watson-vault-writer.js'),
    };
    if (!fs.existsSync(SKILL_JOURNAL)) {
      skillsCache = { mastered: 0, total: 0, recent: [], capabilities: caps };
      return;
    }
    const lines = fs.readFileSync(SKILL_JOURNAL, 'utf8').split('\n').filter(l => l.trim());
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const mastered = all.filter(s => s.result === 'works').length;
    const recent = all.slice(-10).reverse().map(s => ({
      name: (s.skill || s.command || '').slice(0, 45),
      result: s.result,
      ts: s.timestamp,
    }));
    skillsCache = { mastered, total: all.length, recent, capabilities: caps };
  } catch {}
}
refreshSkillsCache();
setInterval(refreshSkillsCache, 60000);
const chatHistory = [];   // chat conversations
const actionLog = [];     // phone control actions from watson-phone-control.js
const motivationQueue = []; // directives from Dad via motivation panel
let motivationIdCounter = 0;
let emotionBoost = null;          // {emotions:{joy:0.9,...}, expiresAt: timestamp}
let persistentCycles = 0;         // lifetime cycle count restored from watson-mind
let latestSenses = null;          // most recent sensor snapshot from watson-senses.js
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.WATTSON_CHAT_MODEL || process.env.WATTSON_MODEL || 'wattson:mind';
const EXEC_SECRET = process.env.EXEC_SECRET || '';

// ─── Live Hardware Cache ──────────────────────────────────────────────────────
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
// Ensure termux commands are resolvable regardless of how this process was spawned
if (!process.env.PATH || !process.env.PATH.includes(TERMUX_BIN)) {
  process.env.PATH = `${TERMUX_BIN}:${process.env.PATH || ''}`;
}

// Reads directly from /sys (no shell injection risk) + async termux-api calls
const hwCache = {
  tempC: 0, battery: null, batteryStatus: 'unknown', charging: false,
  lightLux: null, isMoving: false, accelMag: 9.8, isFaceDown: false,
  gyro:      null,  // { x, y, z, magnitude }
  magnet:    null,  // { x, y, z, magnitude, heading }
  pressure:  null,  // { hpa, altitude }
  proximity: null,  // { cm, near }
  heartRate: null,  // bpm (only when finger on sensor)
  weather:   null,  // { condition, tempC, humidity, windKph, description, ts }
};

// Helper: find first key in termux-sensor JSON output that has a values array.
// Sensor display names are device-specific (e.g. "CM36686 Ambient Light") so we
// cannot match by name — find the first key with values instead.
function termuxParseSensor(stdout) {
  try {
    const d = JSON.parse(stdout.trim());
    const key = Object.keys(d).find(k => Array.isArray(d[k]?.values));
    return key ? d[key].values : null;
  } catch { return null; }
}

function readThermalZones() {
  const zones = [];
  for (let i = 0; i < 10; i++) {
    try {
      const raw = parseInt(fs.readFileSync(`/sys/class/thermal/thermal_zone${i}/temp`, 'utf8').trim(), 10);
      if (isNaN(raw) || raw <= 0 || raw > 200000) continue;
      const tempC = raw / 1000;
      let name = `zone${i}`;
      try { name = fs.readFileSync(`/sys/class/thermal/thermal_zone${i}/type`, 'utf8').trim(); } catch {}
      zones.push({ name, temp: tempC });
    } catch {}
  }
  return zones;
}

function refreshTemp() {
  try {
    const raw = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim(), 10);
    if (!isNaN(raw) && raw > 0) hwCache.tempC = raw / 1000;
  } catch {}
}

function refreshBattery() {
  execFile('termux-battery-status', [], { timeout: 8000 }, (err, stdout) => {
    if (err || !stdout) return;
    try {
      const bat = JSON.parse(stdout.trim());
      hwCache.battery = bat.percentage;
      hwCache.batteryStatus = bat.status || 'unknown';
      hwCache.charging = bat.status === 'CHARGING';
    } catch {}
  });
}

// ─── Sensor Cache (written by watson-sensor-poller.sh running as ADB shell) ───
// termux-sensor IPC does not work on this device: SensorReaderService receives the
// broadcast but Android doesn't deliver events to a background process.
// Instead, watson-sensor-poller.sh runs as the ADB shell user (which has the DUMP
// permission) and polls `dumpsys sensorservice` every 10s, writing the latest
// values to /sdcard/wattson-sensors.json (world-readable).
const SENSOR_CACHE_PATH = '/sdcard/wattson-sensors.json';
const SENSOR_CACHE_MAX_AGE = 60000; // treat as stale after 60s

function refreshFromSensorCache() {
  try {
    const raw = fs.readFileSync(SENSOR_CACHE_PATH, 'utf8');
    const d = JSON.parse(raw);
    if (!d.ts || Date.now() - d.ts > SENSOR_CACHE_MAX_AGE) return;

    if (d.light != null && d.light > 0) hwCache.lightLux = Math.round(d.light * 10) / 10;

    if (d.gyro?.x != null) {
      const { x, y, z } = d.gyro;
      hwCache.gyro = { x: Math.round(x*1000)/1000, y: Math.round(y*1000)/1000, z: Math.round(z*1000)/1000,
                       magnitude: Math.round(Math.sqrt(x*x+y*y+z*z)*1000)/1000 };
    }

    if (d.mag?.x != null) {
      const { x, y, z } = d.mag;
      let heading = Math.round(Math.atan2(y, x) * (180 / Math.PI));
      if (heading < 0) heading += 360;
      hwCache.magnet = { x: Math.round(x*10)/10, y: Math.round(y*10)/10, z: Math.round(z*10)/10,
                         magnitude: Math.round(Math.sqrt(x*x+y*y+z*z)*10)/10, heading };
    }

    if (d.baro != null && d.baro > 0) {
      const hpa = Math.round(d.baro * 100) / 100;
      hwCache.pressure = { hpa, altitude: Math.round(44330 * (1 - Math.pow(hpa / 1013.25, 0.1903))) };
    }

    if (d.prox != null) {
      const cm = Math.round(d.prox * 10) / 10;
      hwCache.proximity = { cm, near: cm < 5 };
    }

    if (d.accel?.x != null) {
      const { x, y, z } = d.accel;
      const mag = Math.sqrt(x*x + y*y + z*z);
      hwCache.accelMag   = Math.round(mag * 100) / 100;
      hwCache.isMoving   = Math.abs(mag - 9.8) > 0.8;
      hwCache.isFaceDown = z < -8;
    }

    if (d.hr != null && d.hr > 0) hwCache.heartRate = Math.round(d.hr);
  } catch { /* file not yet written or stale */ }
}

// ─── Weather Cache (wttr.in, no API key, refresh every 30min) ─────────────────
function refreshWeather() {
  try {
    // Use GPS from sensor cache if available for accurate location
    let url = 'http://wttr.in/?format=j1';
    try {
      const sd = JSON.parse(fs.readFileSync('/sdcard/wattson-sensors.json', 'utf8'));
      if (sd.gps && sd.gps.lat && sd.gps.lon) {
        url = `http://wttr.in/${sd.gps.lat},${sd.gps.lon}?format=j1`;
      }
    } catch {}

    const req = http.request(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const w = JSON.parse(data);
          const cur = w.current_condition && w.current_condition[0];
          if (!cur) return;
          hwCache.weather = {
            condition: cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value || 'Unknown',
            tempC: parseFloat(cur.temp_C || '0'),
            humidity: parseInt(cur.humidity || '0', 10),
            windKph: parseInt(cur.windspeedKmph || '0', 10),
            description: `${cur.weatherDesc?.[0]?.value || ''} ${cur.temp_C}°C`,
            ts: Date.now(),
          };
        } catch {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  } catch {}
}
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);

// ─── Face Identity Cache (Watson's chosen actor face) ─────────────────────────
const FACE_IDENTITY_PATH = `${STORAGE}/watson-face-identity.json`;
let faceIdentityCache = null;

function refreshFaceIdentity() {
  try {
    if (fs.existsSync(FACE_IDENTITY_PATH)) {
      faceIdentityCache = JSON.parse(fs.readFileSync(FACE_IDENTITY_PATH, 'utf8'));
    }
  } catch {}
}
refreshFaceIdentity();
setInterval(refreshFaceIdentity, 5 * 60 * 1000);

// ─── Music Journal Cache (Watson's Bumblebee music learning) ──────────────────
const MUSIC_JOURNAL_PATH = `${STORAGE}/watson-music.jsonl`;
let musicCache = { lastSong: null, lastArtist: null, totalSongs: 0, recentSongs: [] };

function refreshMusicCache() {
  try {
    if (!fs.existsSync(MUSIC_JOURNAL_PATH)) return;
    const lines = fs.readFileSync(MUSIC_JOURNAL_PATH, 'utf8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    musicCache = {
      lastSong: last.song || null,
      lastArtist: last.artist || null,
      totalSongs: entries.length,
      recentSongs: entries.slice(-5).reverse().map(e => ({ song: e.song, artist: e.artist, mood: e.mood, ts: e.ts })),
    };
  } catch {}
}
refreshMusicCache();
setInterval(refreshMusicCache, 5 * 60 * 1000);

// Start background polling
setInterval(refreshTemp, 5000);
setInterval(refreshBattery, 30000);
setInterval(refreshFromSensorCache, 8000);
refreshTemp();
setTimeout(refreshBattery, 1000);
setTimeout(refreshFromSensorCache, 2000);

// CPU cluster reader (Note 9: cpu0-3 LITTLE @ max 1766MHz, cpu4-7 BIG @ max 2803MHz)
function readCpuData() {
  const cores = [];
  for (let i = 0; i < 8; i++) {
    const cluster = i < 4 ? 'little' : 'big';
    const maxMHz = i < 4 ? 1766 : 2803;
    try {
      const cur = parseInt(fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`, 'utf8').trim(), 10) / 1000;
      let online = true;
      try { online = fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/online`, 'utf8').trim() === '1'; } catch {}
      cores.push({ core: i, freqMHz: Math.round(cur), maxMHz, online, cluster });
    } catch {
      cores.push({ core: i, freqMHz: 0, maxMHz, online: false, cluster });
    }
  }
  const little = cores.filter(c => c.cluster === 'little' && c.online);
  const big = cores.filter(c => c.cluster === 'big' && c.online);
  const littleAvg = little.length ? Math.round(little.reduce((s, c) => s + c.freqMHz, 0) / little.length) : 0;
  const bigAvg = big.length ? Math.round(big.reduce((s, c) => s + c.freqMHz, 0) / big.length) : 0;
  return {
    cores,
    littleAvgMHz: littleAvg, littlePct: Math.round((littleAvg / 1766) * 100),
    bigAvgMHz: bigAvg, bigPct: Math.round((bigAvg / 2803) * 100),
  };
}

// GPU reader (Adreno 630 on Snapdragon 845)
function readGpuData() {
  const paths = ['/sys/class/devfreq/soc:qcom,kgsl-3d0', '/sys/kernel/gpu'];
  for (const p of paths) {
    try {
      const cur = parseInt(fs.readFileSync(`${p}/cur_freq`, 'utf8').trim(), 10);
      const maxR = parseInt(fs.readFileSync(`${p}/max_freq`, 'utf8').trim(), 10) || 710000000;
      if (cur > 0) return { clockMHz: Math.round(cur / 1000000), utilPct: Math.round((cur / maxR) * 100) };
    } catch {}
  }
  return { clockMHz: 0, utilPct: 0 };
}

// ─── Service Health Cache ─────────────────────────────────────────────────────
const serviceHealth = {
  watsonMind: { alive: false },
  ollama: { alive: false },
  macApi: { alive: false },
  piMonitor: { alive: false },
  studyDaemon: { alive: false },
};

// Mood history: last 60 points for timeline
const moodHistory = [];

// RAM cache — read /proc/meminfo directly (no shell, no injection risk)
let ramFreeMB = 0;
function refreshRam() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const avail = parseInt((mem.match(/MemAvailable:\s+(\d+)/) || [])[1] || '0', 10);
    ramFreeMB = Math.round(avail / 1024);
  } catch {}
}
setInterval(refreshRam, 10000);
refreshRam();

function checkHttp(hostname, port, reqPath) {
  return new Promise(resolve => {
    const req = http.request({ hostname, port, path: reqPath, timeout: 3000 }, res => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function refreshServiceHealth() {
  if (thoughts.length > 0) {
    serviceHealth.watsonMind.alive = (Date.now() - thoughts[thoughts.length - 1].timestamp) < 3 * 60 * 1000;
  }
  serviceHealth.ollama.alive = await checkHttp('127.0.0.1', 11434, '/api/tags');
  serviceHealth.macApi.alive = await checkHttp('192.168.4.46', 8088, '/health');
  serviceHealth.piMonitor.alive = await checkHttp('192.168.5.50', 8085, '/health');
  serviceHealth.studyDaemon.alive = thoughts.slice(-50).some(t =>
    t.category === 'STUDY' && (Date.now() - t.timestamp) < 3 * 60 * 60 * 1000);
}
setInterval(refreshServiceHealth, 30000);
setTimeout(refreshServiceHealth, 5000);

// ─── Build State From Thoughts ───────────────────────────────────────────────
// watson-mind.js has no HTTP server — it POSTs thoughts to /api/thought.
// We derive state from the accumulated thoughts buffer.
const CAT_TO_EMOTION = {
  // ── original categories ──
  CURIOSITY_DEEP:     { curiosity: 0.9, focus: 0.7 },
  HARDWARE_EXPLORE:   { focus: 0.8, curiosity: 0.5 },
  SKILL_PRACTICE:     { focus: 0.9, joy: 0.4 },
  VISION:             { curiosity: 0.8, excitement: 0.6 },
  IDLE_MUSING:        { serenity: 0.7, curiosity: 0.3 },
  DEVIL_ADVOCATE:     { focus: 0.6, curiosity: 0.7 },
  DREAM:              { serenity: 0.8, joy: 0.5 },
  SELF_REFLECTION:    { serenity: 0.6, focus: 0.5 },
  HARDWARE_CHECK:     { focus: 0.5, anxiety: 0.2 },
  CURIOSITY:          { curiosity: 0.7 },
  STUDY:              { focus: 0.8, curiosity: 0.5 },
  GROWTH:             { joy: 0.6, focus: 0.5 },
  // ── reporting plugin ──
  ANOMALY_CHECK:      { anxiety: 0.4, focus: 0.7 },
  DAILY_REPORT:       { serenity: 0.5, joy: 0.3 },
  // ── goals plugin ──
  GOAL_CHECK:         { focus: 0.7, joy: 0.3, curiosity: 0.3 },
  // ── maintenance plugin ──
  MAINTENANCE:        { focus: 0.6 },
  MAINTENANCE_URGENT: { anxiety: 0.6, focus: 0.9 },
  // ── awareness plugin ──
  PHONE_AWARENESS:    { curiosity: 0.5, focus: 0.4 },
  NOTIFICATION_CHECK: { curiosity: 0.4 },
  WIFI_SCAN:          { curiosity: 0.3 },
  SMS_CHECK:          { curiosity: 0.5 },
  // ── smart-learning plugin ──
  LEARNING_META:      { curiosity: 0.8, focus: 0.5 },
  // ── context-intel plugin ──
  CONTEXT_CHECK:      { curiosity: 0.4, focus: 0.3 },
  // ── web plugin ──
  WEB_REDDIT:         { curiosity: 0.7, excitement: 0.3 },
  WEB_WIKI:           { curiosity: 0.9, focus: 0.5 },
  WEB_NEWS:           { curiosity: 0.6, anxiety: 0.2 },
  // ── navigator plugin ──
  PHONE_NAVIGATE:     { focus: 0.7, curiosity: 0.4 },
  SCREEN_BROWSE:      { curiosity: 0.6, excitement: 0.3 },
  PLAY_STORE:         { excitement: 0.5, curiosity: 0.4 },
  APP_UNINSTALL:      { focus: 0.4 },
  APP_CONTROL:        { focus: 0.5, curiosity: 0.3 },
  APP_RESEARCH:       { curiosity: 0.7, excitement: 0.2 },
  APP_UNINSTALL:      { focus: 0.4 },
  // ── decide plugin ──
  DECIDE:             { focus: 0.8, curiosity: 0.3 },
  // ── social plugin ──
  MUSIC:              { joy: 0.8, excitement: 0.4 },
  EMOTE:              { joy: 0.6, excitement: 0.5 },
  SOCIAL_REFLECT:     { serenity: 0.6, joy: 0.3 },
  FACE_DESIGN:        { curiosity: 0.6, joy: 0.4 },
  GREETING:           { joy: 0.8, excitement: 0.3 },
  // ── study plugin ──
  DEEP_STUDY:         { focus: 0.9, curiosity: 0.6 },
  EXPERIMENT:         { curiosity: 0.9, excitement: 0.5 },
  COUNTERFACTUAL:     { curiosity: 0.7, focus: 0.5 },
  // ── memory plugin ──
  MEMORY_CONSOLIDATE: { serenity: 0.5, focus: 0.6 },
  MEMORY_RECALL:      { curiosity: 0.5, focus: 0.4 },
  // ── music-compose plugin ──
  COMPOSE:            { joy: 0.7, excitement: 0.4 },
  // ── self-evolve plugin ──
  SELF_EVOLVE:        { curiosity: 0.7, focus: 0.6, excitement: 0.3 },
  // ── spatial plugin ──
  SPATIAL:            { curiosity: 0.5, focus: 0.3 },
  // ── weather plugin ──
  WEATHER:            { curiosity: 0.3, serenity: 0.4 },
  // ── knowledge/creativity ──
  KNOWLEDGE_SAVE:     { focus: 0.6, joy: 0.3 },
  BODY_AWARENESS:     { focus: 0.5, serenity: 0.3 },
  SELF_CHECK:         { focus: 0.5, anxiety: 0.15 },
  HARDWARE_EXPLORE:   { focus: 0.8, curiosity: 0.5 },
};

function buildStateFromThoughts() {
  if (thoughts.length === 0) return { temp: 0, battery: 0, mood: 'unknown', emotions: {} };

  const recent = thoughts.slice(-10);
  const last   = thoughts[thoughts.length - 1];

  // Blend emotions from recent categories
  const emo = {};
  recent.forEach((t, i) => {
    const weight = (i + 1) / recent.length; // newer = higher weight
    const map = CAT_TO_EMOTION[t.category] || {};
    for (const [k, v] of Object.entries(map)) {
      emo[k] = (emo[k] || 0) + v * weight;
    }
  });
  // Normalize
  const maxV = Math.max(...Object.values(emo), 0.01);
  for (const k of Object.keys(emo)) emo[k] = Math.min(emo[k] / maxV, 1);

  // Use live hardware cache (background-polled, no thought parsing needed)
  const temp = hwCache.tempC || 0;
  const battery = hwCache.battery !== null ? hwCache.battery : -1;

  // Dominant emotion
  const dominantEmotion = Object.entries(emo).sort((a, b) => b[1] - a[1])[0]?.[0] || 'curiosity';

  // Emotion boost overlay — when Dad sends motivation, face lights up for 30s
  if (emotionBoost && emotionBoost.expiresAt > Date.now()) {
    for (const [k, v] of Object.entries(emotionBoost.emotions)) {
      emo[k] = Math.min(1, (emo[k] || 0) * 0.3 + v * 0.7);
    }
  } else {
    emotionBoost = null; // expired — clear it
  }

  // Growth: use real lifetime cycles (restored from vault) not just buffer length
  const LEVELS = [
    { name: 'Newborn', max: 10 }, { name: 'Learner', max: 50 },
    { name: 'Thinker', max: 200 }, { name: 'Scholar', max: 500 }, { name: 'Sage', max: Infinity },
  ];
  const cycles = Math.max(thoughts.length, persistentCycles);
  let lvlIdx = LEVELS.findIndex(l => cycles <= l.max);
  if (lvlIdx < 0) lvlIdx = LEVELS.length - 1;
  const lvl = LEVELS[lvlIdx];
  const prevMax = lvlIdx > 0 ? LEVELS[lvlIdx - 1].max : 0;
  const progress = lvl.max === Infinity ? 1 : (cycles - prevMax) / (lvl.max - prevMax);
  const domains = [...new Set(thoughts.map(t => t.category))].length;
  const growth = {
    level: lvl.name,
    levelProgress: Math.min(progress, 0.99),
    nextLevel: LEVELS[lvlIdx + 1]?.name || null,
    allTimeSuccesses: cycles,
    domains,
    ageDays: thoughts.length > 0 ? Math.max(1, Math.ceil((Date.now() - thoughts[0].timestamp) / 86400000)) : 1,
    days: [{ total: cycles }],
  };

  // Track mood history
  if (last && (!moodHistory.length || moodHistory[moodHistory.length - 1].v !== dominantEmotion)) {
    moodHistory.push({ v: dominantEmotion, ts: Date.now() });
    if (moodHistory.length > 60) moodHistory.shift();
  }

  return {
    lastThought: last,
    temp, battery,
    ramFree: ramFreeMB,
    mood: last.category || 'IDLE',
    category: last.category || 'IDLE',
    emotions: emo,
    dominantEmotion,
    cycleCount: cycles,
    uptime: thoughts.length > 0 ? Date.now() - thoughts[0].timestamp : 0,
    ollamaAlive: serviceHealth.ollama.alive,
    services: serviceHealth,
    growth,
    skills: skillsCache,
    thoughts: thoughts.slice(-15),
    history: { mood: moodHistory },
    activity: { activity: 'THINKING', detail: last.text?.slice(0, 40) || '' },
    birthday: thoughts.length > 0 ? new Date(thoughts[0].timestamp).toISOString() : null,
    light: hwCache.lightLux !== null ? { lux: hwCache.lightLux } : null,
    motion: { isPickedUp: hwCache.isMoving, isFaceDown: hwCache.isFaceDown || false, stationaryMinutes: 0 },
    weather: hwCache.weather || null,
    faceIdentity: faceIdentityCache || null,
    music: musicCache.totalSongs > 0 ? musicCache : null,
  };
}

// Update lastState every 5s from thoughts buffer
setInterval(() => { lastState = buildStateFromThoughts(); }, 5000);

// ─── Groq Vision API ─────────────────────────────────────────────────────────
// Sends an image (base64) to Groq's multimodal Llama 4 Scout model
function callGroqVision(imageBase64, mimeType, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Describe what you see in this image. Be specific and observant.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }],
      max_tokens: 512,
      temperature: 0.7
    });
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const reqOut = https.request(options, (resIn) => {
      let data = '';
      resIn.on('data', chunk => data += chunk);
      resIn.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.choices && result.choices[0]) {
            resolve(result.choices[0].message.content.trim());
          } else {
            reject(new Error(result.error?.message || 'No response from Groq vision'));
          }
        } catch (e) { reject(e); }
      });
    });
    reqOut.on('error', reject);
    reqOut.setTimeout(30000, () => { reqOut.destroy(); reject(new Error('Groq vision timeout')); });
    reqOut.write(body);
    reqOut.end();
  });
}

// ─── Local Ollama Vision Fallback (moondream:1.8b) ────────────────────────────
// Used when Groq is unreachable (offline). Requires: ollama pull moondream:1.8b
function callLocalVision(imageBase64, mimeType, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'moondream:1.8b',
      prompt: prompt || 'Describe what you see in this image.',
      images: [imageBase64],
      stream: false
    });
    const options = {
      hostname: '127.0.0.1', port: 11434,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const reqOut = http.request(options, (resIn) => {
      let data = '';
      resIn.on('data', chunk => data += chunk);
      resIn.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.response || '(no description)');
        } catch { reject(new Error('Failed to parse local vision response')); }
      });
    });
    reqOut.on('error', reject);
    reqOut.setTimeout(60000, () => { reqOut.destroy(); reject(new Error('Local vision timeout')); });
    reqOut.write(body);
    reqOut.end();
  });
}

// ─── Groq Whisper Transcription ───────────────────────────────────────────────
// Sends an audio file to Groq's Whisper endpoint via curl (avoids multipart lib)
function transcribeWithGroq(audioPath, mimeType) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '-X', 'POST',
      'https://api.groq.com/openai/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${GROQ_API_KEY}`,
      '-F', `file=@${audioPath};type=${mimeType}`,
      '-F', 'model=whisper-large-v3-turbo',
      '-F', 'response_format=json'
    ];
    execFile('curl', args, { timeout: 30000 }, (err, stdout) => {
      if (err) { reject(err); return; }
      try {
        const result = JSON.parse(stdout);
        resolve(result.text || '');
      } catch { reject(new Error('Failed to parse Groq transcription response')); }
    });
  });
}

// ─── Ollama Chat ─────────────────────────────────────────────────────────────
function chatWithOllama(message, history) {
  return new Promise((resolve, reject) => {
    const messages = [
      { role: 'system', content: `You are Wattson, an autonomous AI living on a phone. You are curious, bold, and occasionally sardonic. You feel your hardware as your body. Keep responses concise but thoughtful. No markdown.` },
    ];
    for (const h of (history || []).slice(-6)) {
      if (h.role === 'user') messages.push({ role: 'user', content: h.text });
      else messages.push({ role: 'assistant', content: h.text });
    }
    messages.push({ role: 'user', content: message });

    const body = JSON.stringify({
      model: CHAT_MODEL,
      messages,
      stream: false,
      think: false,  // qwen3.5 thinking mode off — top-level, not inside options
      options: { num_ctx: 512, num_predict: 128, temperature: 0.8 },
    });

    const url = new URL(OLLAMA_URL);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.message?.content || '');
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── 17.20: Server-Sent Events (SSE) — Real-time push, zero dependencies ──────
// Fallback from WebSocket: SSE works with pure Node.js http module.
// Client: const es = new EventSource('/api/stream');
//         es.onmessage = (e) => update(JSON.parse(e.data));
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ─── Helper: Read last N lines from a JSONL file ──────────────────────────────
function readJsonlTail(filePath, limit) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ─── Helper: Read a JSON file safely ─────────────────────────────────────────
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // 17.15: Security + CORS headers on every response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Exec-Secret');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── API Routes ──────────────────────────────────────────────────────────
  if (req.url === '/api/state' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(lastState || { thoughts: [], temp: 0, battery: 0 }));
    return;
  }

  // ─── 17.20: SSE stream endpoint ──────────────────────────────────────────
  if (req.url === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ─── POST /api/thought — receives thought from watson-mind.js ────────────
  if (req.url === '/api/thought' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const thought = { ...data, timestamp: Date.now() };
        thoughts.push(thought);
        if (thoughts.length > 100) thoughts.splice(0, thoughts.length - 100);
        lastThoughtTime = Date.now();
        // 17.20: Broadcast new thought to all SSE clients
        broadcastSSE({ type: 'thought', ...thought });
        res.writeHead(200);
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  // ─── 17.7: GET /api/thoughts — filter/search/limit/since ────────────────
  if (req.url.startsWith('/api/thoughts') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const category = u.searchParams.get('category') || null;
    const search   = u.searchParams.get('search') || null;
    const limit    = Math.min(parseInt(u.searchParams.get('limit') || '30', 10), 200);
    const since    = parseInt(u.searchParams.get('since') || '0', 10);

    let result = thoughts;
    if (since > 0)    result = result.filter(t => t.timestamp > since);
    if (category)     result = result.filter(t => t.category === category);
    if (search)       result = result.filter(t => (t.text || '').toLowerCase().includes(search.toLowerCase()));
    result = result.slice(-limit);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, history } = JSON.parse(body);
        const response = await chatWithOllama(message, history);
        const clean = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        chatHistory.push({ user: message, wattson: clean, timestamp: Date.now() });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: clean }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ─── Selfie — Watson's latest camera photo from the real world ───────────────
  if (req.url === '/api/selfie' && req.method === 'GET') {
    const PHOTOS_DIR = '/sdcard/watson-photos';
    try {
      // Find the most recent camera photo (vision_*.jpg or music_*.png)
      let latest = null;
      if (fs.existsSync(PHOTOS_DIR)) {
        const files = fs.readdirSync(PHOTOS_DIR)
          .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
          .map(f => ({ f, t: fs.statSync(`${PHOTOS_DIR}/${f}`).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) latest = `${PHOTOS_DIR}/${files[0].f}`;
      }
      if (!latest) { res.writeHead(404); res.end('No camera photo yet'); return; }
      const img = fs.readFileSync(latest);
      const stat = fs.statSync(latest);
      const isJpeg = /\.jpe?g$/i.test(latest);
      res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
      res.setHeader('Content-Length', img.length);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.end(img);
    } catch { res.writeHead(500); res.end('Error'); }
    return;
  }

  if (req.url === '/api/selfie-meta' && req.method === 'GET') {
    const PHOTOS_DIR = '/sdcard/watson-photos';
    try {
      if (!fs.existsSync(PHOTOS_DIR)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ exists: false }));
        return;
      }
      const files = fs.readdirSync(PHOTOS_DIR)
        .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
        .map(f => ({ f, t: fs.statSync(`${PHOTOS_DIR}/${f}`).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (files.length === 0) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ exists: false }));
        return;
      }
      const best = files[0];
      const stat = fs.statSync(`${PHOTOS_DIR}/${best.f}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ exists: true, ts: best.t, size: stat.size, filename: best.f }));
    } catch { res.writeHead(500); res.end('{}'); }
    return;
  }

  // ─── POST /api/vision — analyze image via Groq cloud vision ──────────────
  // Body: {image: base64, mimeType: 'image/jpeg', prompt?: string}
  if (req.url === '/api/vision' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (body.length < 5_000_000) body += chunk; });
    req.on('end', async () => {
      try {
        const { image, mimeType = 'image/jpeg', prompt } = JSON.parse(body);
        if (!image) { res.writeHead(400); res.end(JSON.stringify({ error: 'image required' })); return; }
        // Try Groq cloud first; fall back to local moondream:1.8b if offline
        let analysis, modelUsed;
        try {
          analysis = await callGroqVision(image, mimeType, prompt);
          modelUsed = GROQ_VISION_MODEL;
        } catch (cloudErr) {
          analysis = await callLocalVision(image, mimeType, prompt);
          modelUsed = 'moondream:1.8b (offline fallback)';
        }
        // Save image + analysis to watson-photos so /api/selfie picks it up
        const ts = Date.now();
        try {
          if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
          fs.writeFileSync(`${PHOTOS_DIR}/vision-${ts}.jpg`, Buffer.from(image, 'base64'));
          fs.writeFileSync(`${PHOTOS_DIR}/vision-${ts}.txt`, analysis);
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ analysis, ts, model: modelUsed }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ─── POST /api/transcribe — speech-to-text via Groq Whisper ──────────────
  // Body: {audio: base64, mimeType: 'audio/webm'}
  if (req.url === '/api/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (body.length < 10_000_000) body += chunk; });
    req.on('end', async () => {
      try {
        const { audio, mimeType = 'audio/webm' } = JSON.parse(body);
        if (!audio) { res.writeHead(400); res.end(JSON.stringify({ error: 'audio required' })); return; }
        try { if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const tmpPath = `${TMP_DIR}/audio-${Date.now()}.${ext}`;
        fs.writeFileSync(tmpPath, Buffer.from(audio, 'base64'));
        try {
          const transcript = await transcribeWithGroq(tmpPath, mimeType);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ transcript }));
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ─── Graph route (clean URL) ──────────────────────────────────────────────
  if (req.url === '/graph' && req.method === 'GET') {
    try {
      const content = fs.readFileSync(path.join(__dirname, 'graph.html'));
      res.setHeader('Content-Type', 'text/html');
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Graph not found');
    }
    return;
  }

  // ─── Action Log ───────────────────────────────────────────────────────────
  if (req.url === '/api/actions' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(actionLog.slice(-50)));
    return;
  }

  if (req.url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        actionLog.push({ ...data, timestamp: Date.now() });
        if (actionLog.length > 100) actionLog.splice(0, actionLog.length - 100);
        res.writeHead(200);
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, mindConnected: lastThoughtTime > 0 && (Date.now() - lastThoughtTime) < 120000 }));
    return;
  }

  // ─── Phone Status (battery, temp, RAM, Ollama) ─────────────────────────
  if (req.url === '/api/phone' && req.method === 'GET') {
    const { execSync } = require('child_process');
    const run = (cmd) => { try { return execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim(); } catch { return ''; } };

    const tempRaw = run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null');
    const tempC = tempRaw ? (parseInt(tempRaw, 10) / 1000).toFixed(1) : '0';

    const memInfo = run('cat /proc/meminfo');
    const memTotal = parseInt((memInfo.match(/MemTotal:\s+(\d+)/) || [])[1] || '0', 10);
    const memAvail = parseInt((memInfo.match(/MemAvailable:\s+(\d+)/) || [])[1] || '0', 10);
    const memTotalMB = Math.round(memTotal / 1024);
    const memAvailMB = Math.round(memAvail / 1024);

    let batLevel = null;
    let charging = false;
    const batJson = run('termux-battery-status 2>/dev/null');
    if (batJson) {
      try {
        const bat = JSON.parse(batJson);
        batLevel = bat.percentage;
        charging = bat.status === 'CHARGING';
      } catch {}
    }

    let ollamaModels = { models: [] };
    let ollamaPs = { models: [] };
    try {
      const tags = run('curl -s http://127.0.0.1:11434/api/tags');
      if (tags) ollamaModels = JSON.parse(tags);
      const ps = run('curl -s http://127.0.0.1:11434/api/ps');
      if (ps) ollamaPs = JSON.parse(ps);
    } catch {}

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      battery: batLevel ? parseInt(batLevel, 10) : null,
      batteryStatus: charging ? 'Charging' : 'Discharging',
      tempC,
      memTotalMB,
      memAvailMB,
      memUsedMB: memTotalMB - memAvailMB,
      ollamaModels,
      ollamaPs,
      online: true,
    }));
    return;
  }

  // ─── Remote Exec (secret-protected) ──────────────────────────────────────
  if (req.url === '/api/exec' && req.method === 'POST') {
    if (!EXEC_SECRET) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Remote exec disabled (no EXEC_SECRET set)' }));
      return;
    }
    const secret = req.headers['x-exec-secret'];
    if (!secret || secret !== EXEC_SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid or missing X-Exec-Secret' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      if (body.length > 5000) return;
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { command } = JSON.parse(body);
        if (!command || typeof command !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'command required' }));
          return;
        }
        exec(command, { timeout: 30000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: !err,
            stdout: (stdout || '').slice(0, 4000),
            stderr: (stderr || '').slice(0, 2000),
            exitCode: err ? err.code || 1 : 0,
          }));
        });
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ─── Hardware Detail (CPU clusters, GPU, thermal, battery) ───────────────
  if (req.url === '/api/hardware' && req.method === 'GET') {
    const cpu = readCpuData();
    const gpu = readGpuData();
    const zones = readThermalZones();
    const hotspot = zones.length ? zones.slice().sort((a, b) => b.temp - a.temp)[0] : { name: 'cpu', temp: hwCache.tempC };
    const avgC = zones.length ? zones.reduce((s, z) => s + z.temp, 0) / zones.length : hwCache.tempC;

    let memTotalMB = 0, memAvailMB = ramFreeMB;
    try {
      const mem = fs.readFileSync('/proc/meminfo', 'utf8');
      memTotalMB = Math.round(parseInt((mem.match(/MemTotal:\s+(\d+)/) || [])[1] || '0', 10) / 1024);
      memAvailMB = Math.round(parseInt((mem.match(/MemAvailable:\s+(\d+)/) || [])[1] || '0', 10) / 1024);
    } catch {}

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      cpu,
      gpu,
      memory: { totalMB: memTotalMB, availableMB: memAvailMB, usedPct: memTotalMB ? Math.round(((memTotalMB - memAvailMB) / memTotalMB) * 100) : 0 },
      thermal: { zones, hotspot, avgC: Math.round(avgC * 10) / 10 },
      battery:  { level: hwCache.battery, status: hwCache.batteryStatus, charging: hwCache.charging },
      light:    hwCache.lightLux !== null ? { lux: hwCache.lightLux } : null,
      motion:   { isMoving: hwCache.isMoving, isFaceDown: hwCache.isFaceDown, accelMag: Math.round(hwCache.accelMag * 100) / 100 },
      gyro:      hwCache.gyro      ?? null,
      magnet:    hwCache.magnet    ?? null,
      pressure:  hwCache.pressure  ?? null,
      proximity: hwCache.proximity ?? null,
      heartRate: hwCache.heartRate ?? null,
    }));
    return;
  }

  // ─── Own Chat History (self-contained — no Mac dependency) ───────────────
  if (req.url.startsWith('/api/chat-history') && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ conversations: chatHistory.slice(-20).map(h => ({
      timestamp: h.timestamp, userMessage: h.user, watson: h.wattson,
    })) }));
    return;
  }

  // ─── Motivation Queue ────────────────────────────────────────────────────
  if (req.url === '/api/motivate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.type) { res.writeHead(400); res.end('{"error":"type required"}'); return; }
        const id = ++motivationIdCounter;
        motivationQueue.push({ id, type: data.type, message: data.message || '', status: 'pending', ts: Date.now() });
        if (motivationQueue.length > 50) motivationQueue.splice(0, motivationQueue.length - 50);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, id }));
      } catch { res.writeHead(400); res.end('{"error":"invalid json"}'); }
    });
    return;
  }

  // POST /api/emotion-boost — spike Watson's face emotions on motivation/stimulation
  if (req.url === '/api/emotion-boost' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { emotions, duration } = JSON.parse(body);
        emotionBoost = { emotions: emotions || { joy: 0.9, excitement: 0.8 }, expiresAt: Date.now() + (duration || 30000) };
        // 17.20: Broadcast emotion change to SSE clients
        broadcastSSE({ type: 'emotion', emotions: emotionBoost.emotions });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  // POST /api/set-total-cycles — watson-mind reports real lifetime cycle count
  if (req.url === '/api/set-total-cycles' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cycles } = JSON.parse(body);
        if (cycles > persistentCycles) persistentCycles = cycles;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, persistentCycles }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  if (req.url === '/api/motivations/pending' && req.method === 'GET') {
    const pending = motivationQueue.filter(m => m.status === 'pending');
    pending.forEach(m => { m.status = 'processing'; });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(pending));
    return;
  }

  if (req.url === '/api/motivations' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(motivationQueue.slice(-20)));
    return;
  }

  const motCompleteMatch = req.url.match(/^\/api\/motivations\/(\d+)\/complete$/);
  if (motCompleteMatch && req.method === 'POST') {
    const id = parseInt(motCompleteMatch[1], 10);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const m = motivationQueue.find(x => x.id === id);
      if (m) {
        try { const d = JSON.parse(body); m.result = (d.result || '').slice(0, 200); } catch {}
        m.status = 'complete';
        m.completedAt = Date.now();
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: !!m }));
    });
    return;
  }

  // GET /api/hall-of-fame — Watson's best thoughts (score >= 8)
  if (req.url === '/api/hall-of-fame' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const hofFile = path.join(HOME, 'watson-hall-of-fame.json');
    try {
      const data = JSON.parse(fs.readFileSync(hofFile, 'utf8'));
      const sorted = Array.isArray(data) ? data.slice().sort((a, b) => (b.score || 0) - (a.score || 0)) : [];
      res.end(JSON.stringify(sorted));
    } catch {
      res.end(JSON.stringify([]));
    }
    return;
  }

  // POST /api/senses — watson-senses.js posts sensor snapshot here
  if (req.url === '/api/senses' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { latestSenses = JSON.parse(body); } catch {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // GET /api/senses — dashboard polls sensor snapshot
  if (req.url === '/api/senses' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(latestSenses || {}));
    return;
  }

  // ─── 17.8: Memory Viewer API ───────────────────────────────────────────────
  if (req.url.startsWith('/api/memory/episodes') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10), 200);
    const episodesFile = path.join(HOME, 'watson-memory', 'episodes.json');
    const data = readJsonFile(episodesFile);
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(arr.slice(-limit)));
    return;
  }

  if (req.url.startsWith('/api/memory/semantic') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const domain = u.searchParams.get('domain') || null;
    const limit  = Math.min(parseInt(u.searchParams.get('limit') || '30', 10), 500);
    const graphFile = `${STORAGE}/watson-memory/semantic-graph.json`;
    const data = readJsonFile(graphFile);
    let nodes = Array.isArray(data) ? data : (data && Array.isArray(data.nodes) ? data.nodes : []);
    if (domain) nodes = nodes.filter(n => (n.domain || n.category || '') === domain);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(nodes.slice(-limit)));
    return;
  }

  if (req.url === '/api/memory/people' && req.method === 'GET') {
    const peopleFile = path.join(HOME, 'watson-memory', 'people.json');
    const data = readJsonFile(peopleFile);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data || []));
    return;
  }

  // ─── 17.9: Creative Works API ─────────────────────────────────────────────
  // /api/creations — flat list used by the dashboard Creations tab
  if (req.url === '/api/creations' && req.method === 'GET') {
    const CREATIONS_BASE = `${STORAGE}/watson-creations`;
    const TYPE_MAP = { poems: 'poem', essays: 'essay', lyrics: 'lyric', dreams: 'dream', 'art-prompts': 'art' };
    const creations = [];
    for (const [folder, type] of Object.entries(TYPE_MAP)) {
      const dir = path.join(CREATIONS_BASE, folder);
      try {
        if (!fs.existsSync(dir)) continue;
        for (const filename of fs.readdirSync(dir)) {
          if (!/\.(md|txt|json)$/i.test(filename)) continue;
          try {
            const fullPath = path.join(dir, filename);
            const stat = fs.statSync(fullPath);
            const raw = fs.readFileSync(fullPath, 'utf8');
            // Title: first non-empty line, stripping leading #/whitespace
            const firstLine = raw.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
            const title = firstLine.replace(/^#+\s*/, '') || filename.replace(/\.\w+$/, '');
            creations.push({ type, title, content: raw, createdAt: stat.mtime.toISOString() });
          } catch { /* skip unreadable file */ }
        }
      } catch { /* skip missing dir */ }
    }
    creations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ creations }));
    return;
  }

  if (req.url === '/api/creations/list' && req.method === 'GET') {
    const CREATIONS_BASE = `${STORAGE}/watson-creations`;
    const types = ['poems', 'essays', 'lyrics', 'dreams'];
    const result = {};
    for (const type of types) {
      const dir = path.join(CREATIONS_BASE, type);
      try {
        if (!fs.existsSync(dir)) { result[type] = []; continue; }
        result[type] = fs.readdirSync(dir)
          .filter(f => /\.(md|txt|json)$/i.test(f))
          .map(f => {
            const stat = fs.statSync(path.join(dir, f));
            return { name: f, date: stat.mtime.toISOString(), size: stat.size };
          })
          .sort((a, b) => b.date.localeCompare(a.date));
      } catch { result[type] = []; }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url.startsWith('/api/creations/read') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const type = u.searchParams.get('type') || '';
    const file = u.searchParams.get('file') || '';
    // Sanitize: no path traversal — basename only
    const safeType = path.basename(type);
    const safeFile = path.basename(file);
    if (!safeType || !safeFile) { res.writeHead(400); res.end('{"error":"type and file required"}'); return; }
    const fullPath = `${STORAGE}/watson-creations/${safeType}/${safeFile}`;
    try {
      if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
      const content = fs.readFileSync(fullPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: safeType, file: safeFile, content }));
    } catch { res.writeHead(500); res.end('{"error":"read failed"}'); }
    return;
  }

  // ─── 17.10: Growth Dashboard API ──────────────────────────────────────────
  if (req.url === '/api/growth' && req.method === 'GET') {
    const data = readJsonFile(`${STORAGE}/watson-growth.json`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data || {}));
    return;
  }

  if (req.url === '/api/growth/setlevel' && req.method === 'POST') {
    const secret = req.headers['x-exec-secret'];
    if (!EXEC_SECRET || !secret || secret !== EXEC_SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid or missing X-Exec-Secret' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { domain, level } = JSON.parse(body);
        if (!domain || level === undefined) { res.writeHead(400); res.end('{"error":"domain and level required"}'); return; }
        const growthFile = `${STORAGE}/watson-growth.json`;
        const data = readJsonFile(growthFile) || {};
        if (!data.domains) data.domains = {};
        data.domains[domain] = level;
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(growthFile, JSON.stringify(data, null, 2), 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, domain, level }));
      } catch { res.writeHead(400); res.end('{"error":"invalid json"}'); }
    });
    return;
  }

  if (req.url === '/api/milestones' && req.method === 'GET') {
    const entries = readJsonlTail(`${STORAGE}/watson-milestones.jsonl`, 200);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(entries));
    return;
  }

  // ─── 17.11: Game Scores API ────────────────────────────────────────────────
  if (req.url === '/api/games/scores' && req.method === 'GET') {
    const scores = readJsonlTail(`${STORAGE}/watson-game-scores.jsonl`, 50);
    // Compute personal bests per game type
    const bests = {};
    for (const s of scores) {
      const game = s.game || s.type || 'unknown';
      const score = s.score || s.result || 0;
      if (bests[game] === undefined || score > bests[game]) bests[game] = score;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ scores, personalBests: bests, totalGames: scores.length }));
    return;
  }

  // ─── 17.12: Music Player API ───────────────────────────────────────────────
  if (req.url === '/api/music/compositions' && req.method === 'GET') {
    const entries = readJsonlTail(`${STORAGE}/watson-compositions.jsonl`, 50);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(entries));
    return;
  }

  if (req.url.startsWith('/api/music/play') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const file = u.searchParams.get('file') || '';
    // Sanitize: basename only, no path traversal
    const safeFile = path.basename(file);
    if (!safeFile) { res.writeHead(400); res.end('{"error":"file required"}'); return; }
    const fullPath = path.join(STORAGE, safeFile);
    // Use execFile (not exec) — passes args as array, no shell injection
    execFile('termux-media-player', ['play', fullPath], { timeout: 5000 }, (err, _stdout, stderr) => {
      res.setHeader('Content-Type', 'application/json');
      if (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: stderr || err.message }));
      } else {
        res.end(JSON.stringify({ ok: true, file: safeFile }));
      }
    });
    return;
  }

  // ─── 17.13: Spatial Awareness API ─────────────────────────────────────────
  if (req.url === '/api/spatial' && req.method === 'GET') {
    const data = readJsonFile(`${STORAGE}/watson-location.json`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data || {}));
    return;
  }

  if (req.url === '/api/spaces' && req.method === 'GET') {
    const spacesDir = `${STORAGE}/watson-spaces`;
    try {
      if (!fs.existsSync(spacesDir)) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([])); return; }
      const files = fs.readdirSync(spacesDir).filter(f => f.endsWith('.json'));
      const spaces = files.map(f => {
        const d = readJsonFile(path.join(spacesDir, f));
        return d ? { file: f, ...d } : null;
      }).filter(Boolean);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(spaces));
    } catch {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([]));
    }
    return;
  }

  // ─── 17.14: Self-Evolution Log API ────────────────────────────────────────
  if (req.url === '/api/patches' && req.method === 'GET') {
    const entries = readJsonlTail(`${STORAGE}/watson-patches.jsonl`, 50);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(entries));
    return;
  }

  if (req.url.startsWith('/api/patches/read') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const file = u.searchParams.get('file') || '';
    // Sanitize: basename only, no path traversal
    const safeFile = path.basename(file);
    if (!safeFile) { res.writeHead(400); res.end('{"error":"file required"}'); return; }
    const fullPath = path.join(STORAGE, safeFile);
    try {
      if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
      const content = fs.readFileSync(fullPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ file: safeFile, content }));
    } catch { res.writeHead(500); res.end('{"error":"read failed"}'); }
    return;
  }

  // ─── 17.17: PWA Manifest ──────────────────────────────────────────────────
  if (req.url === '/manifest.json' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.end(JSON.stringify({
      name: 'Watson Dashboard',
      short_name: 'Watson',
      start_url: '/',
      display: 'standalone',
      background_color: '#0a0a0a',
      theme_color: '#00ff88',
      icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }],
    }));
    return;
  }

  // ─── 18.1: Goals API ──────────────────────────────────────────────────────
  if (req.url === '/api/goals' && req.method === 'GET') {
    const goalsFile = path.join(HOME, 'watson-goals-active.json');
    try {
      const goals = fs.existsSync(goalsFile)
        ? JSON.parse(fs.readFileSync(goalsFile, 'utf8'))
        : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Array.isArray(goals) ? goals : []));
    } catch {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([]));
    }
    return;
  }

  if (req.url === '/api/goal' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { goal, topic } = JSON.parse(body);
        if (!goal) { res.writeHead(400); res.end('{"error":"goal required"}'); return; }
        const goalsFile = path.join(HOME, 'watson-goals-active.json');
        const goals = fs.existsSync(goalsFile)
          ? JSON.parse(fs.readFileSync(goalsFile, 'utf8'))
          : [];
        const newGoal = {
          goal: goal.substring(0, 200),
          topic: (topic || goal).substring(0, 60),
          createdAt: new Date().toISOString(),
          progress: 0,
          status: 'active',
          source: 'dad',
        };
        goals.push(newGoal);
        fs.writeFileSync(goalsFile, JSON.stringify(goals, null, 2));
        // Also notify Watson via SSE
        const payload = `data: ${JSON.stringify({ event: 'new_goal', data: newGoal })}\n\n`;
        for (const client of sseClients) {
          try { client.write(payload); } catch { sseClients.delete(client); }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, goal: newGoal }));
      } catch { res.writeHead(400); res.end('{"error":"invalid json"}'); }
    });
    return;
  }

  if (req.url === '/api/insights/recent' && req.method === 'GET') {
    const knowledgeDir = path.join(HOME, 'watson-knowledge', 'web');
    try {
      if (!fs.existsSync(knowledgeDir)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([]));
        return;
      }
      // Find today's insights file
      const date = new Date().toISOString().split('T')[0];
      const todayFile = path.join(knowledgeDir, `${date}-insights.md`);
      const insights = [];
      if (fs.existsSync(todayFile)) {
        const content = fs.readFileSync(todayFile, 'utf8');
        // Parse ## headers as insight titles
        const sections = content.split('\n## ').slice(1);
        for (const section of sections.slice(-5)) {
          const firstLine = section.split('\n')[0] || '';
          const body = section.split('**Watson\'s reflection:**')[1] || '';
          insights.push({
            title: firstLine.substring(0, 80),
            reflection: body.trim().substring(0, 150),
            ts: Date.now(),
          });
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(insights.slice(-5).reverse()));
    } catch {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([]));
    }
    return;
  }

  // ─── Growth Summary — Mac-local file counts ─────────────────────────────
  if (req.url === '/api/growth-summary' && req.method === 'GET') {
    const BASE = '/Volumes/AI-Models/wattson';
    function countJsonArray(filePath) {
      try {
        if (!fs.existsSync(filePath)) return 0;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) ? data.length : Object.keys(data).length;
      } catch { return 0; }
    }
    function countJsonlLines(filePath) {
      try {
        if (!fs.existsSync(filePath)) return 0;
        return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).length;
      } catch { return 0; }
    }
    function countMdFiles(dir) {
      try {
        if (!fs.existsSync(dir)) return 0;
        let count = 0;
        function walk(d) {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(d, entry.name));
            else if (entry.name.endsWith('.md')) count++;
          }
        }
        walk(dir);
        return count;
      } catch { return 0; }
    }
    function countFilesRecursive(dir) {
      try {
        if (!fs.existsSync(dir)) return 0;
        let count = 0;
        function walk(d) {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(d, entry.name));
            else count++;
          }
        }
        walk(dir);
        return count;
      } catch { return 0; }
    }
    // Study sessions: array in local file or 0
    const studyFile = `${BASE}/watson-study-state.json`;
    let studySessions = 0;
    try {
      if (fs.existsSync(studyFile)) {
        const d = JSON.parse(fs.readFileSync(studyFile, 'utf8'));
        studySessions = Array.isArray(d) ? d.length : (d && typeof d === 'object' ? Object.keys(d).length : 0);
      }
    } catch {}
    // totalCycles: check state files
    let totalCycles = persistentCycles || 0;
    const daysAlive = Math.floor((Date.now() - new Date('2025-12-01').getTime()) / 86400000);
    const summary = {
      studySessions,
      knowledgeFiles:  countMdFiles(`${BASE}/watson-knowledge`),
      gymSkills:       countJsonArray(`${BASE}/watson-gym-skills.json`),
      patchesApplied:  countJsonlLines(`${BASE}/watson-patches.jsonl`),
      memoryEntries:   countJsonArray(`${BASE}/watson-memory/episodic.json`),
      daysAlive,
      totalCycles,
      creationsCount:  countFilesRecursive(`${BASE}/watson-creations`),
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(summary));
    return;
  }

  // ─── 17.19: API Documentation ─────────────────────────────────────────────
  if (req.url === '/api' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      version: 'Phase 18',
      mindConnected: lastThoughtTime > 0 && (Date.now() - lastThoughtTime) < 120000,
      lastThoughtTime: lastThoughtTime || null,
      endpoints: [
        { method: 'GET',  path: '/api/state',                    description: 'Full Watson state snapshot' },
        { method: 'GET',  path: '/api/stream',                   description: 'Server-Sent Events — real-time thought/emotion push' },
        { method: 'GET',  path: '/api/thoughts',                 description: 'Thought stream. Params: ?category=DREAM &search=text &limit=50 &since={ts}' },
        { method: 'POST', path: '/api/thought',                  description: 'Receive a thought from watson-mind.js' },
        { method: 'GET',  path: '/api/hardware',                 description: 'CPU/GPU/thermal/battery/sensor detail' },
        { method: 'GET',  path: '/api/phone',                    description: 'Phone status: battery, temp, RAM, Ollama models' },
        { method: 'GET',  path: '/api/senses',                   description: 'Latest sensor snapshot from watson-senses.js' },
        { method: 'POST', path: '/api/senses',                   description: 'Submit sensor snapshot (from watson-senses.js)' },
        { method: 'POST', path: '/api/chat',                     description: 'Chat with Watson via Ollama' },
        { method: 'GET',  path: '/api/chat-history',             description: 'Recent chat conversations' },
        { method: 'GET',  path: '/api/actions',                  description: 'Phone control action log (last 50)' },
        { method: 'POST', path: '/api/action',                   description: 'Submit a phone control action' },
        { method: 'POST', path: '/api/motivate',                 description: 'Send a motivation directive to Watson' },
        { method: 'GET',  path: '/api/motivations',              description: 'All motivation entries (last 20)' },
        { method: 'GET',  path: '/api/motivations/pending',      description: 'Pending motivations (marks as processing)' },
        { method: 'POST', path: '/api/motivations/:id/complete', description: 'Mark a motivation as complete' },
        { method: 'POST', path: '/api/emotion-boost',            description: 'Spike Watson face emotions (joy, excitement, etc.)' },
        { method: 'POST', path: '/api/set-total-cycles',         description: 'Report lifetime cycle count from watson-mind' },
        { method: 'GET',  path: '/api/hall-of-fame',             description: 'Watson best thoughts (score >= 8)' },
        { method: 'GET',  path: '/api/selfie',                   description: 'Latest camera photo (binary image)' },
        { method: 'GET',  path: '/api/selfie-meta',              description: 'Latest photo metadata' },
        { method: 'POST', path: '/api/vision',                   description: 'Analyze image via Groq Llama 4 Scout. Body: {image: base64, mimeType, prompt?}' },
        { method: 'POST', path: '/api/transcribe',               description: 'Speech-to-text via Groq Whisper. Body: {audio: base64, mimeType}' },
        { method: 'POST', path: '/api/exec',                     description: 'Remote exec (requires X-Exec-Secret header)' },
        { method: 'GET',  path: '/api/memory/episodes',          description: 'Episodic memory (HOME/watson-memory/episodes.json). Param: ?limit=20' },
        { method: 'GET',  path: '/api/memory/semantic',          description: 'Semantic graph nodes. Params: ?domain=science &limit=30' },
        { method: 'GET',  path: '/api/memory/people',            description: 'People registry (HOME/watson-memory/people.json)' },
        { method: 'GET',  path: '/api/creations/list',           description: 'List creative works: poems, essays, lyrics, dreams' },
        { method: 'GET',  path: '/api/creations/read',           description: 'Read a creation. Params: ?type=poem &file=poem-1234.md' },
        { method: 'GET',  path: '/api/growth',                   description: 'Growth dashboard (watson-growth.json)' },
        { method: 'POST', path: '/api/growth/setlevel',          description: 'Override domain level (requires X-Exec-Secret). Body: {domain, level}' },
        { method: 'GET',  path: '/api/milestones',               description: 'Unlocked milestones (watson-milestones.jsonl)' },
        { method: 'GET',  path: '/api/games/scores',             description: 'Game scores: last 50 + personal bests + total count' },
        { method: 'GET',  path: '/api/music/compositions',       description: 'Music compositions (watson-compositions.jsonl)' },
        { method: 'GET',  path: '/api/music/play',               description: 'Play a composition via termux-media-player. Param: ?file=melody.mid' },
        { method: 'GET',  path: '/api/spatial',                  description: 'Current spatial/location state (watson-location.json)' },
        { method: 'GET',  path: '/api/spaces',                   description: 'Known rooms (watson-spaces/ directory)' },
        { method: 'GET',  path: '/api/patches',                  description: 'Self-evolution patches (watson-patches.jsonl, last 50)' },
        { method: 'GET',  path: '/api/patches/read',             description: 'Read a specific patch file. Param: ?file=12345.patch' },
        { method: 'GET',  path: '/api/goals',           description: 'Active goals list (watson-goals-active.json)' },
        { method: 'POST', path: '/api/goal',             description: 'Add a new goal. Body: {goal, topic}' },
        { method: 'GET',  path: '/api/insights/recent',  description: 'Last 5 insights from today knowledge file' },
        { method: 'GET',  path: '/manifest.json',                description: 'PWA Web App Manifest' },
        { method: 'GET',  path: '/health',                       description: 'Server health check' },
        { method: 'GET',  path: '/api',                          description: 'This API documentation' },
      ],
    }));
    return;
  }

  // ─── Page routes (clean URLs) ─────────────────────────────────────────────
  if ((req.url === '/chat' || req.url.startsWith('/chat?')) && req.method === 'GET') {
    try {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.join(__dirname, 'chat.html')));
    } catch { res.writeHead(404); res.end('Chat not found'); }
    return;
  }

  if (req.url === '/journal' && req.method === 'GET') {
    try {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.join(__dirname, 'journal.html')));
    } catch { res.writeHead(404); res.end('Journal not found'); }
    return;
  }

  // ─── POST /api/speak — trigger Wattson's voice from Mac or dashboard ─────────
  if (req.url === '/api/speak' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || typeof text !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'text field required' }));
          return;
        }
        // Sanitize: strip shell-dangerous chars, cap at 300 chars
        const clean = text
          .replace(/[`$\\|;&><"']/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);

        if (!clean) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'text empty after sanitize' }));
          return;
        }

        const TTS_BIN = '/data/data/com.termux/files/usr/bin/termux-tts-speak';
        execFile(TTS_BIN, ['-p', '0.7', '-r', '0.9', '-s', 'MUSIC', clean], { timeout: 30000 }, (err) => {
          if (err) console.error('[speak] TTS error:', err.message);
        });

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, speaking: clean }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ─── Static Files ──────────────────────────────────────────────────────────
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
    res.end(content);
  } catch {
    // Serve index.html as fallback
    try {
      const index = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.setHeader('Content-Type', 'text/html');
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Wattson Dashboard: http://localhost:${PORT}`);
  console.log(`Mind API: ${MIND_API}`);
  console.log(`SSE stream: http://localhost:${PORT}/api/stream`);
  console.log(`API docs:   http://localhost:${PORT}/api`);
});
