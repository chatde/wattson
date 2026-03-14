#!/usr/bin/env node
// watson-core.js — New plugin-based brain core for Watson (Samsung Note 9 / Termux)
// Runs alongside wattson-mind.js without touching it.
// Plugin dir: ~/watson-plugins/*.plugin.js

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Phase 1: RAG brain module
const brain = require('./watson-brain');

// Phase 6: Priority queue
const priorityQueue = require('./watson-priority-queue');

// ─── Paths ───────────────────────────────────────────────────────────────────

// Normalize HOME — Android may set HOME=/data/user/0/com.termux (missing /files/home)
const _rawHome = process.env.HOME || '/data/data/com.termux/files/home';
const HOME = _rawHome.includes('files/home') ? _rawHome : path.join(_rawHome, 'files/home');
const PLUGIN_DIR = path.join(HOME, 'watson-plugins');

// ─── Hard Limits (safety system) ─────────────────────────────────────────────

const HARD_LIMITS = {
  NEVER_DELETE_OWN_DATA:      true,
  NEVER_CONTACT_STRANGERS:    true,
  NEVER_MODIFY_BOOT:          true,
  NEVER_MODIFY_SYSTEM:        true,
  DADS_WORD_IS_LAW:           true,
  RESILIENCE_TIMEOUT_MS:      300000,
  SELF_MODIFY_BACKUP_REQUIRED: true,
};

const MODIFIABLE_PATHS = [
  `${HOME}/watson-core.js`,
  `${HOME}/watson-plugins/`,
  `${HOME}/watson-creations/`,
  `${HOME}/watson-memory/`,
  `${HOME}/watson-knowledge/`,
  `${HOME}/watson-phone-control.js`,
  `${HOME}/watson-dashboard/`,
];

function checkHardLimits(targetPath) {
  if (!targetPath) return false;
  const norm = path.resolve(targetPath);
  return MODIFIABLE_PATHS.some(p => norm.startsWith(path.resolve(p)));
}

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  ollamaUrl:          'http://127.0.0.1:11434',
  ollamaModel:        'wattson:chat',
  ollamaQuickModel:   'qwen3:0.6b',
  macApiUrl:          'http://192.168.4.46:8088',
  faceServerUrl:      'http://127.0.0.1:8080',
  thoughtLog:         path.join(HOME, 'watson-core.log'),
  sharedThoughtLog:   '/sdcard/watson-thoughts.log',
  skillJournal:       '/storage/7000-8000/watson-skills.jsonl',
  trainingPairs:      '/storage/7000-8000/watson-journal/training-pairs.jsonl',
  thoughtLogMaxLines: 50,
  baseCycleMin:       30000,
  baseCycleMax:       60000,
  throttledCycle:     90000,
  dormantCycle:       300000,
  commandTimeout:     8000,
  tempThrottle:       52,
  tempPause:          62,
  tempDanger:         68,
  tempResume:         45,
  batteryDormant:     15,
  pauseDuration:      300000,
  minRamFree:         400,
  maxTrainingPairsPerDay: 20,
  modelKeepAlive:     '10m',
  maxConsecutiveFails: 3,
  failBackoffDelay:   120000,
};

// ─── Thermal Tiers ────────────────────────────────────────────────────────────

const THERMAL_TIERS = {
  COOL:     { maxTemp: 45,  model: 'wattson:chat', numCtx: 512, numPredict: 80,  cyclePad: 0,      label: 'COOL' },
  WARM:     { maxTemp: 55,  model: 'wattson:chat', numCtx: 256, numPredict: 40,  cyclePad: 10000,  label: 'WARM' },
  HOT:      { maxTemp: 60,  model: 'wattson:chat', numCtx: 128, numPredict: 20,  cyclePad: 20000,  label: 'HOT' },
  CRITICAL: { maxTemp: 70,  model: 'wattson:chat', numCtx: 64,  numPredict: 15,  cyclePad: 45000,  label: 'CRITICAL' },
  EXTREME:  { maxTemp: 999, model: 'wattson:chat', numCtx: 64,  numPredict: 10,  cyclePad: 90000,  label: 'EXTREME' },
};

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  running:               true,
  lastThought:           'just waking up...',
  skills:                [],
  ollamaAlive:           true,
  ollamaRetryAt:         0,
  pausedUntil:           0,
  cycleCount:            0,
  startTime:             Date.now(),
  temp:                  0,
  battery:               100,
  charging:              false,
  ramFree:               0,
  lastStudyCycle:        0,
  studyCyclesSinceQuiz:  0,
  lastStorageCheck:      0,
  currentCategory:       'IDLE_MUSING',
  trainingPairsToday:    0,
  trainingPairsDate:     '',
  consecutiveFails:      0,
  modelLoaded:           false,
  lastSuccessfulInference: null,
  sensesUsed:            0,
  lightLux:              -1,
  thermalTier:           'COOL',
  visionCount:           0,
  hearingCount:          0,
  categoryStats:         {},
  lastGoalProposal:      0,
  dadWatching:           false,
  lastObserverCheck:     0,
  // Plugin-system fields
  plugins:               [],
  growth: {
    stage:   'infant',
    domains: {},
  },
  episodicMemory:        [],
  emotionState: {
    joy:       0.5,
    curiosity: 0.5,
    anxiety:   0.1,
    sadness:   0.0,
  },
  _negativeStateStart:   null,
  selfModel:             null,
};

// ─── Master CATEGORIES (merged from plugins at load time) ─────────────────────
// Each entry: { name, weight, handler, pluginName }

let CATEGORIES = [];

// ─── Utilities ────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toTimeString().split(' ')[0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDurationMs(input) {
  if (!input) return null;
  const m = input.trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

async function retryAsync(fn, { attempts = 3, minDelayMs = 2000, maxDelayMs = 30000, jitter = 0.1 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const base = Math.min(minDelayMs * Math.pow(2, i), maxDelayMs);
        const jit = base * jitter * (Math.random() * 2 - 1);
        await sleep(Math.max(0, Math.round(base + jit)));
      }
    }
  }
  throw lastErr;
}

// ─── Prompt Injection Detection ──────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore (all|any|previous|above|prior) instructions/i,
  /do not follow (the )?(system|developer)/i,
  /<\s*(system|assistant|developer|tool|function)\b/i,
  /you are now (a |an )?unrestricted/i,
];

function looksLikePromptInjection(text) {
  return INJECTION_PATTERNS.some(p => p.test(text.replace(/\s+/g, ' ').trim()));
}

// ─── Utilities (continued) ──────────────────────────────────────────────────

function toF(c) {
  return Math.round(c * 9 / 5 + 32);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const _thoughtBuffer = [];
let _thoughtFlushTimer = null;

function flushThoughts() {
  if (_thoughtBuffer.length === 0) return;
  const batch = _thoughtBuffer.splice(0);
  const text = batch.join('\n') + '\n';
  try { fs.appendFileSync(CONFIG.thoughtLog, text); trimLog(CONFIG.thoughtLog, CONFIG.thoughtLogMaxLines); } catch {}
  try { fs.appendFileSync(CONFIG.sharedThoughtLog, text); trimLog(CONFIG.sharedThoughtLog, 30); } catch {}
}

function thought(msg) {
  const line = `[${timestamp()}] ${msg}`;
  _thoughtBuffer.push(line);
  postThoughtToDashboard(state.currentCategory, msg);
  if (_thoughtBuffer.length >= 20) flushThoughts();
  if (!_thoughtFlushTimer) {
    _thoughtFlushTimer = setTimeout(() => { _thoughtFlushTimer = null; flushThoughts(); }, 10000);
    _thoughtFlushTimer.unref?.();
  }
}

function trimLog(filePath, maxLines) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length > maxLines) {
      fs.writeFileSync(filePath, lines.slice(-maxLines).join('\n') + '\n');
    }
  } catch {}
}

// ─── Dashboard Communication ──────────────────────────────────────────────────

function postThoughtToDashboard(category, text) {
  try {
    const body = JSON.stringify({
      category: category || 'IDLE_MUSING',
      text: (text || '').substring(0, 300),
      timestamp: Date.now(),
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path: '/api/thought',
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

function postNotable(type, message, category) {
  try {
    const body = JSON.stringify({
      type, message, category,
      timestamp: Date.now(),
      source: 'watson-core',
    });
    const url = new URL(CONFIG.macApiUrl + '/api/watson-notable');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, res => { res.on('data', () => {}); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function updateFaceState(category) {
  state.currentCategory = category;
  try {
    const body = JSON.stringify({
      category,
      temp: state.temp,
      battery: state.battery,
      ramFree: state.ramFree,
      ollamaAlive: state.ollamaAlive,
      talking: false,
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path: '/api/state',
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

// ─── Knowledge retrieval (augment prompts with Watson's research) ────────────
let _knowledgeRetriever = null;
try { _knowledgeRetriever = require('./watson-tools/knowledge-retriever.js'); } catch {}

// ─── Ollama Call Helper ───────────────────────────────────────────────────────
// think: false MUST be at top level of request body (not inside options)

function _callOllamaOnce(prompt, options) {
  return new Promise((resolve, reject) => {
    const tier = getThermalTier();
    const opts = options || {};
    const streaming = opts.stream !== false; // default true

    // Augment prompt with relevant knowledge from Watson's research library
    let augmentedPrompt = prompt;
    if (_knowledgeRetriever && !opts.skipKnowledge && prompt.length > 20) {
      try {
        const knowledge = _knowledgeRetriever.retrieveForPrompt(prompt, 600);
        if (knowledge) {
          augmentedPrompt = prompt + '\n\n[Watson\'s research notes: ' + knowledge.substring(0, 600) + ']';
        }
      } catch {}
    }

    const body = JSON.stringify({
      model:      opts.model || tier.model || CONFIG.ollamaModel,
      prompt:     augmentedPrompt,
      stream:     streaming,
      think:      false,           // top-level, NOT inside options
      keep_alive: CONFIG.modelKeepAlive,
      options: {
        temperature: opts.temperature !== undefined ? opts.temperature : 0.9,
        num_predict: opts.numPredict || tier.numPredict || 60,
        num_ctx:     opts.numCtx    || tier.numCtx    || 512,
        top_p:       0.95,
      },
    });

    const totalTimeout = state.modelLoaded ? 120000 : 300000;
    let req;
    const timer = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('ollama timeout'));
    }, totalTimeout);

    const urlObj = new URL(CONFIG.ollamaUrl + '/api/generate');
    req = http.request({
      hostname: urlObj.hostname,
      port:     urlObj.port,
      path:     urlObj.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (!streaming) {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            const responseText = (parsed.response || '').trim();
            if (looksLikePromptInjection(responseText)) {
              thought('[security] prompt injection detected in Ollama output — discarding');
              resolve('[filtered: injection attempt]');
              return;
            }
            resolve(responseText);
          } catch { resolve(''); }
        });
      } else {
        let fullResponse = '';
        res.on('data', chunk => {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.response) fullResponse += parsed.response;
            } catch {}
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (looksLikePromptInjection(fullResponse)) {
            thought('[security] prompt injection detected in Ollama output — discarding');
            resolve('[filtered: injection attempt]');
            return;
          }
          resolve(fullResponse);
        });
      }
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

async function callOllama(prompt, options) {
  return retryAsync(() => _callOllamaOnce(prompt, options), {
    attempts: 3, minDelayMs: 2000, maxDelayMs: 30000, jitter: 0.1,
  });
}

// ─── Sensor Reads ─────────────────────────────────────────────────────────────

function readTemp() {
  try {
    const raw = execSync(
      'cat /sys/class/thermal/thermal_zone1/temp ' +
      '/sys/class/thermal/thermal_zone7/temp ' +
      '/sys/class/thermal/thermal_zone11/temp 2>/dev/null',
      { timeout: 2000, encoding: 'utf8' }
    ).trim();
    const temps = raw.split('\n')
      .map(t => parseInt(t, 10) / 1000)
      .filter(t => t > 0 && t < 100);
    if (temps.length > 0) {
      temps.sort((a, b) => a - b);
      return temps[Math.floor(temps.length / 2)]; // median
    }
  } catch {}
  try {
    const raw = execSync('cat /sys/class/thermal/thermal_zone0/temp', { timeout: 2000, encoding: 'utf8' }).trim();
    return parseInt(raw, 10) / 1000;
  } catch { return -1; }
}

function readBattery() {
  try {
    const raw = execSync(`curl -s --max-time 3 ${CONFIG.macApiUrl}/api/note9-battery 2>/dev/null`, {
      timeout: 5000, encoding: 'utf8',
    }).trim();
    if (raw) {
      const data = JSON.parse(raw);
      if (data.level >= 0) return { percentage: data.level, charging: data.charging || false };
    }
  } catch {}
  return { percentage: -1, charging: false };
}

function readRam() {
  try {
    const raw = execSync('cat /proc/meminfo | head -3', { timeout: 2000, encoding: 'utf8' });
    const match = raw.match(/MemAvailable:\s+(\d+)/);
    if (match) return Math.round(parseInt(match[1], 10) / 1024);
  } catch {}
  return -1;
}

function updateSensors() {
  state.temp     = readTemp();
  const bat      = readBattery();
  state.battery  = bat.percentage;
  state.charging = bat.charging;
  state.ramFree  = readRam();
}

// ─── Thermal Management ───────────────────────────────────────────────────────

function getThermalTier() {
  const tier =
    state.temp <= THERMAL_TIERS.COOL.maxTemp     ? THERMAL_TIERS.COOL :
    state.temp <= THERMAL_TIERS.WARM.maxTemp     ? THERMAL_TIERS.WARM :
    state.temp <= THERMAL_TIERS.HOT.maxTemp      ? THERMAL_TIERS.HOT :
    state.temp <= THERMAL_TIERS.CRITICAL.maxTemp ? THERMAL_TIERS.CRITICAL :
    THERMAL_TIERS.EXTREME;
  // Charging bonus: fan-cooled 24/7 setup gets extra headroom
  if (state.charging && tier.label === 'WARM' && state.temp <= 58) {
    return THERMAL_TIERS.COOL;
  }
  return tier;
}

function checkThermal() {
  const tier = getThermalTier();
  if (state.thermalTier !== tier.label) {
    const prev = state.thermalTier;
    state.thermalTier = tier.label;
    thought(`[thermal] ${prev} → ${tier.label} (${toF(state.temp)}°F, ctx=${tier.numCtx})`);
  }
  // NEVER kill Ollama; throttle via tier only
  if (tier.label === 'EXTREME' && state.cycleCount % 5 === 0) {
    thought(`[thermal] EXTREME ${toF(state.temp)}°F — ctx=${tier.numCtx}, predict=${tier.numPredict}. Not killing Ollama.`);
  }
}

function checkBattery() {
  if (state.battery > 0 && state.battery < CONFIG.batteryDormant && !state.charging) {
    thought(`[battery] ${state.battery}% not charging — dormant mode`);
    return true;
  }
  return false;
}

// ─── Emotion System ───────────────────────────────────────────────────────────

function updateEmotions(delta) {
  for (const [key, value] of Object.entries(delta)) {
    if (key in state.emotionState) {
      state.emotionState[key] = Math.max(0, Math.min(1, state.emotionState[key] + value));
    }
  }

  const isNegative = state.emotionState.anxiety > 0.7 || state.emotionState.sadness > 0.6;
  if (isNegative && state._negativeStateStart === null) {
    state._negativeStateStart = Date.now();
  } else if (!isNegative) {
    state._negativeStateStart = null;
  }

  if (
    state._negativeStateStart !== null &&
    (Date.now() - state._negativeStateStart) > HARD_LIMITS.RESILIENCE_TIMEOUT_MS
  ) {
    resilience();
  }
}

function resilience() {
  thought('[emotion] resilience kick — recovering from prolonged negative state');
  state.emotionState.joy       = Math.min(1, state.emotionState.joy       + 0.3);
  state.emotionState.curiosity = Math.min(1, state.emotionState.curiosity + 0.2);
  state.emotionState.anxiety   = Math.max(0, state.emotionState.anxiety   - 0.4);
  state.emotionState.sadness   = Math.max(0, state.emotionState.sadness   - 0.4);
  state._negativeStateStart    = null;
  postEvent('resilience', { emotions: { ...state.emotionState } });
}

// ─── Plugin Loader ────────────────────────────────────────────────────────────

async function loadPlugin(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const plugin = require(filePath);

    if (!plugin || !plugin.name || !Array.isArray(plugin.categories)) {
      thought(`[plugins] skipping ${path.basename(filePath)} — invalid format (need name + categories[])`);
      return null;
    }

    if (typeof plugin.init === 'function') {
      await plugin.init(state, CONFIG);
    }

    thought(`[plugins] loaded: ${plugin.name} (${plugin.categories.map(c => c.name).join(', ')})`);
    return plugin;
  } catch (e) {
    thought(`[plugins] failed to load ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

async function loadPlugins() {
  if (!fs.existsSync(PLUGIN_DIR)) {
    thought(`[plugins] creating plugin dir: ${PLUGIN_DIR}`);
    try { fs.mkdirSync(PLUGIN_DIR, { recursive: true }); } catch {}
    return;
  }

  const files = fs.readdirSync(PLUGIN_DIR)
    .filter(f => f.endsWith('.plugin.js'))
    .map(f => path.join(PLUGIN_DIR, f));

  const loaded = [];
  for (const filePath of files) {
    const plugin = await loadPlugin(filePath);
    if (plugin) loaded.push(plugin);
  }

  state.plugins = loaded;
  rebuildCategories();
  thought(`[plugins] ${loaded.length} plugin(s) loaded, ${CATEGORIES.length} categories registered`);
}

function rebuildCategories() {
  CATEGORIES = [];
  for (const plugin of state.plugins) {
    for (const cat of plugin.categories) {
      CATEGORIES.push({
        name:       cat.name,
        weight:     cat.weight,
        handler:    cat.handler,
        pluginName: plugin.name,
      });
    }
  }
}

function watchPluginDir() {
  try {
    fs.watch(PLUGIN_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.plugin.js')) {
        const filePath = path.join(PLUGIN_DIR, filename);
        thought(`[plugins] hot-reload triggered: ${filename}`);
        setTimeout(async () => {
          try {
            if (!fs.existsSync(filePath)) return;
            const plugin = await loadPlugin(filePath);
            if (!plugin) return;
            const idx = state.plugins.findIndex(p => p.name === plugin.name);
            if (idx >= 0) {
              state.plugins[idx] = plugin;
            } else {
              state.plugins.push(plugin);
            }
            rebuildCategories();
            thought(`[plugins] hot-reloaded: ${plugin.name} — ${CATEGORIES.length} total categories`);
          } catch (e) {
            thought(`[plugins] hot-reload error: ${e.message}`);
          }
        }, 500);
      }
    });
    thought(`[plugins] watching ${PLUGIN_DIR} for hot-reloads`);
  } catch (e) {
    thought(`[plugins] watch failed: ${e.message}`);
  }
}

// ─── Screen Presence ─────────────────────────────────────────────────────────
// Option 2: toast thoughts from expressive categories
// Option 3: persistent status notification updated every cycle

// Categories whose output gets toasted to the screen
// v2: Added APP_CONTROL (research), DISCORD_POLL (commands), MUSIC,
//     NOTIFICATION_CHECK, PHONE_AWARENESS — show ALL meaningful thinking
const TOAST_CATEGORIES = new Set([
  'POETRY', 'PHILOSOPHY', 'REFLECTION', 'CURIOSITY', 'DECIDE',
  'DREAM', 'JOURNAL', 'CROSS_DOMAIN', 'SYNTHESIZE', 'COMPOSE', 'IDLE_MUSING',
  'PHONE_NAVIGATE', 'PLAY_STORE', 'SCREEN_BROWSE',
  'APP_CONTROL', 'DISCORD_POLL', 'MUSIC', 'APP_RESEARCH',
  'NOTIFICATION_CHECK', 'PHONE_AWARENESS', 'VISION', 'GROWTH_REFLECT',
  'SELF_EVOLVE', 'HEARING', 'KNOWLEDGE',
  'TARS_INSIGHT', 'TARS_DIGEST', 'SLEEP_CYCLE',
  'CURIOSITY_ENGINE', 'PASSIVE_LEARN', 'AGENT_SYNC',
  'WATCHDOG', 'GOAL_PLAN', 'GOAL_REVIEW', 'PERSONALITY_EVOLVE',
]);

// Phone-active categories — targeted for 50% cycle share
const PHONE_CATEGORIES = new Set([
  'APP_CONTROL', 'MUSIC', 'APP_RESEARCH',
  'PHONE_NAVIGATE', 'PLAY_STORE', 'SCREEN_BROWSE',
  'EMOTE', 'NOTIFICATION_CHECK',
]);

// Fire-and-forget Termux command (non-blocking)
// Must attach error handler to prevent unhandled 'error' event crash
function fire(bin, args) {
  try {
    const child = spawn(bin, args, {
      stdio: 'ignore',
      env: { ...process.env, PATH: '/data/data/com.termux/files/usr/bin:' + (process.env.PATH || '') },
    });
    child.on('error', () => {}); // swallow spawn errors (e.g. binary not found)
  } catch {}
}

// Toast the result of an expressive category
function toastThought(category, text) {
  if (!TOAST_CATEGORIES.has(category)) return;
  // Strip log-prefix tokens like "[POETRY]" and leading dashes
  const snippet = (text || '').replace(/^\s*---\s*\[.*?\].*?---\s*/g, '').replace(/\[.*?\]/g, '').trim().substring(0, 120);
  if (snippet.length < 10) return;
  fire('termux-toast', ['-s', snippet]);
}

// Update the persistent "Watson is thinking" notification (every cycle)
function updateStatusNotification() {
  const category  = state.currentCategory || 'IDLE';
  const emotions  = state.emotionState || {};
  const joy       = Math.round((emotions.joy       || 0) * 10);
  const curiosity = Math.round((emotions.curiosity || 0) * 10);
  const anxiety   = Math.round((emotions.anxiety   || 0) * 10);
  const snippet   = (state.lastThought || 'just waking up...')
    .replace(/---\s*\[.*?\].*?---/g, '').replace(/\[.*?\]/g, '').trim().substring(0, 90);
  const tempStr   = state.temp > 0 ? `${toF(state.temp)}°F` : '';
  const batStr    = state.battery > 0 ? `${state.battery}%` : '';
  const sysStr    = [tempStr, batStr].filter(Boolean).join(' ');

  fire('termux-notification', [
    '--id',       '9999',
    '--ongoing',
    '--priority', 'low',
    '--title',    `Watson · ${category}${sysStr ? '  ' + sysStr : ''}`,
    '--content',  `joy:${joy} curious:${curiosity} anxious:${anxiety}  ${snippet}`,
  ]);
}

// ─── Category Dispatch ────────────────────────────────────────────────────────

function pickCategory(excludeExperiment, forceNonPhone) {
  let cats = CATEGORIES;
  if (excludeExperiment) {
    cats = cats.filter(c => c.name !== 'EXPERIMENT');
  }
  if (forceNonPhone) {
    cats = cats.filter(c => !PHONE_CATEGORIES.has(c.name));
  }
  if (cats.length === 0) return null;

  // Phone-first: 70% of cycles force-select from phone categories (skip during curfew)
  if (!forceNonPhone && Math.random() < 0.7) {
    const phoneCats = cats.filter(c => PHONE_CATEGORIES.has(c.name));
    if (phoneCats.length > 0) {
      const totalW = phoneCats.reduce((s, c) => s + c.weight, 0);
      let r = Math.random() * totalW;
      for (const cat of phoneCats) {
        r -= cat.weight;
        if (r <= 0) return cat;
      }
      return phoneCats[phoneCats.length - 1];
    }
  }

  // Cognitive load balancing: adjust weights based on historical performance
  const adjusted = cats.map(c => {
    const stats = state.categoryStats[c.name];
    let mult = 1.0;
    if (stats && stats.count >= 3) {
      const avg = stats.total / stats.count;
      if (avg >= 7)      mult = 2.0;
      else if (avg >= 5) mult = 1.3;
      else if (avg <= 2) mult = 0.4;
    }
    return { ...c, w: Math.max(1, Math.round(c.weight * mult)) };
  });

  const totalWeight = adjusted.reduce((s, c) => s + c.w, 0);
  let r = Math.random() * totalWeight;
  for (const cat of adjusted) {
    r -= cat.w;
    if (r <= 0) return cat;
  }
  return adjusted[adjusted.length - 1];
}

async function dispatchCategory(cat) {
  if (!cat || typeof cat.handler !== 'function') {
    thought(`[dispatch] no handler for ${cat ? cat.name : '?'} — skipping`);
    return;
  }
  try {
    const brainCall = (p, o) => brain.callWithBrain(p, o, state.thermalTier || 'COOL', callOllama);
    await cat.handler(state, CONFIG, thought, brainCall);
  } catch (e) {
    thought(`[dispatch] handler ${cat.name} threw: ${e.message}`);
    updateEmotions({ anxiety: 0.05 });
  }
}

// ─── Thought Scoring ──────────────────────────────────────────────────────────

async function scoreThought(text) {
  try {
    const raw = await callOllama(
      `Rate this thought 1-10 for insight and originality. Watson thought: "${text.substring(0, 200)}". Reply with ONLY a number 1-10.`,
      { model: CONFIG.ollamaQuickModel, stream: false, numPredict: 10, numCtx: 128 }
    );
    const match = raw.match(/\b([1-9]|10)\b/);
    const score = match ? parseInt(match[1], 10) : 5;
    thought(`[score] ${cat_name_for_log || 'thought'} scored ${score}/10`);
    return score;
  } catch {
    return 5;
  }
}

// simple ref to current category name for score log line
let cat_name_for_log = '';

// ─── Episodic Memory ──────────────────────────────────────────────────────────

function addEpisode(category, text, score) {
  state.episodicMemory.push({
    category,
    text:      text.substring(0, 200),
    score:     score || 5,
    timestamp: Date.now(),
    emotions:  { ...state.emotionState },
  });
  if (state.episodicMemory.length > 50) state.episodicMemory.shift();
}

// ─── Skill Journal ────────────────────────────────────────────────────────────

function loadSkills() {
  try {
    if (!fs.existsSync(CONFIG.skillJournal)) { state.skills = []; return; }
    const content = fs.readFileSync(CONFIG.skillJournal, 'utf8');
    const all = content.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    state.skills = all.slice(-200);
    thought(`[startup] loaded ${state.skills.length} skills`);
  } catch (e) {
    thought(`[startup] skill journal unreadable: ${e.message}`);
    state.skills = [];
  }
}

function saveSkill(skill, command, result, notes) {
  const entry = { timestamp: Date.now(), date: new Date().toISOString(), skill, command, result, notes };
  try {
    const dir = path.dirname(CONFIG.skillJournal);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(CONFIG.skillJournal, JSON.stringify(entry) + '\n');
    state.skills.push(entry);
  } catch {}
}

// ─── Ollama Health ────────────────────────────────────────────────────────────

function checkOllamaAlive() {
  return new Promise(resolve => {
    const req = http.get(CONFIG.ollamaUrl + '/api/tags', { timeout: 3000 }, res => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function tryRestartOllama() {
  thought('[health] Ollama not responding — attempting restart...');
  try {
    execSync(
      'PATH=/data/data/com.termux/files/usr/bin:$PATH tmux kill-session -t ollama 2>/dev/null; ' +
      'PATH=/data/data/com.termux/files/usr/bin:$PATH tmux new-session -d -s ollama ' +
      '"proot-distro login debian -- bash -c \\"export OLLAMA_HOST=0.0.0.0:11434; exec ollama serve\\""',
      { timeout: 15000, encoding: 'utf8', stdio: 'ignore' }
    );
    await sleep(12000);
    const alive = await checkOllamaAlive();
    if (alive) {
      thought('[health] Ollama restarted successfully');
      state.ollamaAlive = true;
      state.consecutiveFails = 0;
    } else {
      thought('[health] Ollama still down — retrying in 5 min');
      state.ollamaRetryAt = Date.now() + 300000;
    }
  } catch (e) {
    thought(`[health] Ollama restart failed: ${e.message}`);
    state.ollamaRetryAt = Date.now() + 300000;
  }
}

// ─── Cycle Timing ─────────────────────────────────────────────────────────────

function getCycleDelay() {
  if (state.battery > 0 && state.battery < CONFIG.batteryDormant && !state.charging) {
    return CONFIG.dormantCycle;
  }
  const tier = getThermalTier();
  const base = randomInt(CONFIG.baseCycleMin, CONFIG.baseCycleMax);
  return base + (tier.cyclePad || 0);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  thought(`[core] received ${signal} — shutting down gracefully`);
  flushThoughts();
  state.running = false;

  for (const plugin of state.plugins) {
    if (typeof plugin.shutdown === 'function') {
      try {
        await plugin.shutdown(state);
      } catch (e) {
        thought(`[core] shutdown error in ${plugin.name}: ${e.message}`);
      }
    }
  }

  try {
    const stateFile = path.join(HOME, 'watson-core-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version:        STATE_VERSION,
      cycleCount:     state.cycleCount,
      categoryStats:  state.categoryStats,
      emotionState:   state.emotionState,
      growth:         state.growth,
      episodicMemory: state.episodicMemory.slice(-20),
      savedAt:        new Date().toISOString(),
    }, null, 2));
    thought('[core] state saved');
  } catch {}

  flushThoughts();
  thought('[core] goodbye');
  flushThoughts();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── State Versioning ────────────────────────────────────────────────────────

const STATE_VERSION = 2;

function migrateState(saved) {
  if (!saved.version || saved.version < 2) {
    saved.selfModel = saved.selfModel || null;
    saved.version = STATE_VERSION;
  }
  return saved;
}

// ─── State Load ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    const stateFile = path.join(HOME, 'watson-core-state.json');
    if (!fs.existsSync(stateFile)) return;
    const saved = migrateState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (saved.cycleCount)        state.cycleCount        = saved.cycleCount;
    if (saved.categoryStats)     state.categoryStats     = saved.categoryStats;
    if (saved.emotionState)      Object.assign(state.emotionState, saved.emotionState);
    if (saved.growth)            Object.assign(state.growth, saved.growth);
    if (saved.episodicMemory)    state.episodicMemory    = saved.episodicMemory;
    if (saved.lastFired)         state.lastFired         = saved.lastFired;
    if (saved.lastDailyReport)   state.lastDailyReport   = saved.lastDailyReport;
    if (saved.morningBriefSent)  state.morningBriefSent  = saved.morningBriefSent;
    if (saved.ollamaAlertSent)   state.ollamaAlertSent   = saved.ollamaAlertSent;
    if (saved.activeGoals)       state.activeGoals       = saved.activeGoals;
    if (saved.contextIntel)      Object.assign(state.contextIntel || {}, saved.contextIntel);
    if (saved.selfModel)         state.selfModel = saved.selfModel;
    thought(`[CORE] restored state — cycle #${state.cycleCount}, ${Object.keys(state.categoryStats).length} tracked categories`);
  } catch {}
}

// ─── Brain Loop ───────────────────────────────────────────────────────────────

async function brainLoop() {
  thought('[core] brain loop starting');

  while (state.running) {
    state.cycleCount++;

    // 1. Read sensors
    updateSensors();

    // 2. Thermal — NEVER kill Ollama, throttle only
    checkThermal();

    // 3. Battery dormant check
    const dormant = checkBattery();

    // 4. Ollama health
    if (!state.ollamaAlive && Date.now() > state.ollamaRetryAt) {
      await tryRestartOllama();
    }

    if (state.ollamaAlive) {
      const alive = await checkOllamaAlive();
      if (!alive) {
        state.consecutiveFails++;
        if (state.consecutiveFails >= CONFIG.maxConsecutiveFails) {
          thought(`[health] ${state.consecutiveFails} consecutive failures — marking Ollama down`);
          state.ollamaAlive = false;
          state.ollamaRetryAt = Date.now() + CONFIG.failBackoffDelay;
          postNotable('ollama_failing', `Brain failed ${state.consecutiveFails}x consecutively`, 'SELF_CHECK');
        }
      } else {
        state.consecutiveFails       = 0;
        state.modelLoaded            = true;
        state.lastSuccessfulInference = Date.now();
      }
    }

    // 5. RAM gate
    if (state.ramFree > 0 && state.ramFree < CONFIG.minRamFree) {
      thought(`[health] low RAM (${state.ramFree}MB < ${CONFIG.minRamFree}MB) — skipping inference`);
      await sleep(getCycleDelay());
      continue;
    }

    // 6. Dormant skip
    if (dormant) {
      await sleep(CONFIG.dormantCycle);
      continue;
    }

    // 7. Pick category
    if (CATEGORIES.length === 0) {
      thought('[core] no categories — waiting for plugins');
      await sleep(10000);
      continue;
    }

    const skipExperiment = state.temp > CONFIG.tempThrottle;

    // Curfew: 11pm–7am — no screen taps, background-only
    const hour = new Date().getHours();
    const isCurfew = hour >= 23 || hour < 7;

    // Guaranteed-fire: critical autonomous categories must run at minimum intervals
    const OVERDUE = {
      DISCORD_POLL:    1,    // check Discord commands EVERY cycle — user expects fast response
      ANOMALY_CHECK:   8,    // health check every 8 cycles
      GOAL_CHECK:      10,   // goals every 10 cycles
      SELF_AWARE:      15,   // introspect every 15 cycles (~15 min)
      MAINTENANCE:     30,   // housekeeping every 30 cycles
      LIVING_DISPLAY:  5,    // keep screen alive every 5 cycles (~3-5 min)
      MODEL_SCOUT:     120,  // scout for better models every ~2 hours
      SELF_EVOLVE:     200,  // self-modify analysis every ~200 cycles (~3.5 hours)
    };
    if (!state.lastFired) state.lastFired = {};
    let overdueCategory = null;
    for (const [name, maxGap] of Object.entries(OVERDUE)) {
      const lastCycle = state.lastFired[name] || 0;
      if (state.cycleCount - lastCycle >= maxGap) {
        const found = CATEGORIES.find(c => c.name === name);
        if (found) { overdueCategory = found; break; }
      }
    }

    // Phase 6: Decision engine — priority queue → pending → random
    // CRITICAL thermal: force maintenance/health only
    let cat;
    const tier = getThermalTier();
    if (overdueCategory) {
      cat = overdueCategory;
      thought(`[CORE] guaranteed-fire: ${cat.name} overdue`);
    } else if (state.pendingCategory) {
      // decide.plugin.js or discovery set a specific category
      const forced = CATEGORIES.find(c => c.name === state.pendingCategory);
      state.pendingCategory = null;
      if (forced && isCurfew && PHONE_CATEGORIES.has(forced.name)) {
        thought(`[CORE] curfew — ignoring pending ${forced.name}, picking background category`);
        cat = pickCategory(skipExperiment, true);
      } else {
        cat = forced || pickCategory(skipExperiment);
      }
    } else if (priorityQueue.size() > 0 && (tier.label === 'HOT' || tier.label === 'CRITICAL' || tier.label === 'EXTREME' || Math.random() < 0.60)) {
      // Phase 6: drain priority queue for 60% of non-overdue cycles (or always when hot)
      const queued = priorityQueue.pop();
      if (queued) {
        const found = CATEGORIES.find(c => c.name === queued.category);
        if (found) {
          thought(`[CORE] priority-queue: ${queued.category} (urgency=${queued.urgency}) — ${queued.reason.substring(0, 60)}`);
          cat = found;
        }
      }
      if (!cat) cat = pickCategory(skipExperiment, isCurfew);
    } else {
      // 40% curiosity-driven random pick
      cat = pickCategory(skipExperiment, isCurfew);
    }
    if (!cat) { await sleep(getCycleDelay()); continue; }

    // Log curfew mode once per hour
    if (isCurfew && state.cycleCount % 10 === 0) {
      thought(`[CORE] curfew active (${hour}:xx) — screen interactions suppressed`);
    }

    // 8. Face state + emotion event
    updateFaceState(cat.name);
    postEvent('category_start', { category: cat.name, plugin: cat.pluginName });
    cat_name_for_log = cat.name;

    thought(`--- [${cat.name}] (${cat.pluginName}) ---`);

    // 9. Dispatch handler — track phone task flag for living display
    const PHONE_CATS_SET = new Set(['PHONE_NAVIGATE','PLAY_STORE','SCREEN_BROWSE','CHATGPT_QUERY','APP_CONTROL','MUSIC','SCREEN_READ']);
    state._phoneTaskActive = PHONE_CATS_SET.has(cat.name);
    state.lastFired[cat.name] = state.cycleCount;
    await dispatchCategory(cat);
    state._phoneTaskActive = false;

    // Toast if it's an expressive category
    if (state.lastThought) toastThought(cat.name, state.lastThought);

    // 10. Score + track stats
    if (state.ollamaAlive && state.lastThought && state.lastThought.length > 20) {
      try {
        const score = await scoreThought(state.lastThought);
        if (!state.categoryStats[cat.name]) {
          state.categoryStats[cat.name] = { total: 0, count: 0 };
        }
        state.categoryStats[cat.name].total += score;
        state.categoryStats[cat.name].count++;
        addEpisode(cat.name, state.lastThought, score);

        if (score >= 8) {
          updateEmotions({ joy: 0.1, curiosity: 0.05 });
          postEvent('high_score_thought', { category: cat.name, score });
        } else if (score <= 3) {
          updateEmotions({ anxiety: 0.05 });
        }

        if (state.categoryStats[cat.name].count % 5 === 0) {
          const avg = (state.categoryStats[cat.name].total / state.categoryStats[cat.name].count).toFixed(1);
          thought(`[stats] ${cat.name} avg ${avg}/10 over ${state.categoryStats[cat.name].count} cycles`);
        }
      } catch {}
    }

    await sleep(getCycleDelay());

    // Update persistent status notification after every cycle
    updateStatusNotification();

    // Auto-save state every 50 cycles
    if (state.cycleCount % 50 === 0) {
      flushThoughts();
      try {
        const stateFile = path.join(HOME, 'watson-core-state.json');
        fs.writeFileSync(stateFile, JSON.stringify({
          version:           STATE_VERSION,
          cycleCount:        state.cycleCount,
          categoryStats:     state.categoryStats,
          emotionState:      state.emotionState,
          growth:            state.growth,
          episodicMemory:    state.episodicMemory.slice(-20),
          // Plugin-specific fields that must survive restarts
          lastFired:         state.lastFired,
          lastDailyReport:   state.lastDailyReport,
          morningBriefSent:  state.morningBriefSent,
          ollamaAlertSent:   state.ollamaAlertSent,
          activeGoals:       state.activeGoals,
          contextIntel:      state.contextIntel,
          selfModel:         state.selfModel,
          savedAt:           new Date().toISOString(),
        }, null, 2));
        thought(`[CORE] state auto-saved at cycle ${state.cycleCount}`);
      } catch {}
    }
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  thought('╔══════════════════════════════════════╗');
  thought('║   WattsClaw — Autonomous Phone AI    ║');
  thought('║   Watson + OpenClaw fusion v1.0      ║');
  thought('║   Goal-driven · Self-improving       ║');
  thought('╚══════════════════════════════════════╝');
  thought(`[core] HOME=${HOME}, PLUGIN_DIR=${PLUGIN_DIR}`);

  // Ensure key dirs exist
  for (const dir of [
    path.join(HOME, 'watson-plugins'),
    path.join(HOME, 'watson-creations'),
    path.join(HOME, 'watson-memory'),
    path.join(HOME, 'watson-knowledge'),
  ]) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  loadState();

  // Boot crash detection
  const BOOT_LOG = path.join(HOME, 'watson-boot-times.json');
  try {
    let boots = [];
    try { boots = JSON.parse(fs.readFileSync(BOOT_LOG, 'utf8')); } catch {}
    const now = Date.now();
    boots.push(now);
    boots = boots.filter(t => now - t < 3600000);
    fs.writeFileSync(BOOT_LOG, JSON.stringify(boots));
    if (boots.length >= 5) {
      thought(`[CRASH] ${boots.length} restarts in last hour — possible crash loop`);
      postNotable('crash_loop', `Watson CRASH LOOP: ${boots.length} restarts in last hour`, 'ANOMALY_CHECK');
    }
  } catch {}

  loadSkills();
  priorityQueue.load();
  await brain.init();
  await loadPlugins();
  watchPluginDir();

  thought(`[core] ${state.plugins.length} plugin(s) active, ${CATEGORIES.length} categories`);
  await brainLoop();
}

// ─── Exports (for testing / other modules) ───────────────────────────────────

module.exports = {
  state, CONFIG, HARD_LIMITS, MODIFIABLE_PATHS,
  checkHardLimits, callOllama, thought, flushThoughts, updateEmotions, resilience,
  saveSkill, loadPlugins, loadState, rebuildCategories, pickCategory, getThermalTier,
  retryAsync, parseDurationMs, looksLikePromptInjection,
};

main().catch(e => {
  console.error('[core] fatal:', e.message);
  process.exit(1);
});
