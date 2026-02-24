#!/usr/bin/env node
// wattson-mind.js — Wattson's Autonomous Consciousness
// An AI that lives on your phone, thinks independently, monitors its own hardware,
// and develops personality over time. Runs on any Android phone with Termux + Ollama.
//
// Usage: node wattson-mind.js
// Dashboard: node dashboard/server.js (then open http://localhost:8080)

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model: process.env.WATTSON_MODEL || 'wattson:mind',
  dashboardUrl: process.env.DASHBOARD_URL || 'http://127.0.0.1:8080',
  thoughtLog: path.join(process.env.HOME || '/tmp', 'wattson-thoughts.log'),
  thoughtLogMaxLines: 100,
  baseCycleMin: 30000,   // 30s minimum between thoughts
  baseCycleMax: 60000,   // 60s maximum
  throttledCycle: 90000, // 90s when warm
  dormantCycle: 300000,  // 5 min when low battery
  tempThrottle: 50,      // C — slow down
  tempPause: 62,         // C — stop inference
  tempResume: 45,        // C — resume
  batteryDormant: 15,    // % — enter low power mode
  minRamFree: 300,       // MB — skip if below
  modelKeepAlive: '10m',
  maxConsecutiveFails: 3,
  failBackoffDelay: 120000, // 2 min backoff
};

// ─── Thermal Tiers ───────────────────────────────────────────────────────────
// Adapts model parameters based on phone temperature to prevent overheating.
// NEVER kills Ollama — always degrades gracefully.

const THERMAL_TIERS = {
  COOL:     { maxTemp: 40, numCtx: 256, numPredict: 64, cyclePad: 0,      label: 'COOL' },
  WARM:     { maxTemp: 50, numCtx: 192, numPredict: 48, cyclePad: 15000,  label: 'WARM' },
  HOT:      { maxTemp: 60, numCtx: 128, numPredict: 32, cyclePad: 30000,  label: 'HOT' },
  CRITICAL: { maxTemp: 70, numCtx: 64,  numPredict: 16, cyclePad: 60000,  label: 'CRITICAL' },
  EXTREME:  { maxTemp: 999, numCtx: 64, numPredict: 16, cyclePad: 120000, label: 'EXTREME' },
};

function getThermalTier(temp) {
  if (temp <= THERMAL_TIERS.COOL.maxTemp) return THERMAL_TIERS.COOL;
  if (temp <= THERMAL_TIERS.WARM.maxTemp) return THERMAL_TIERS.WARM;
  if (temp <= THERMAL_TIERS.HOT.maxTemp) return THERMAL_TIERS.HOT;
  if (temp <= THERMAL_TIERS.CRITICAL.maxTemp) return THERMAL_TIERS.CRITICAL;
  return THERMAL_TIERS.EXTREME;
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  running: true,
  lastThought: 'just waking up...',
  ollamaAlive: false,
  pausedUntil: 0,
  cycleCount: 0,
  startTime: Date.now(),
  temp: 0,
  battery: 100,
  charging: false,
  ramFree: 0,
  currentCategory: 'IDLE_MUSING',
  consecutiveFails: 0,
  thoughts: [],       // recent thoughts for dashboard
  thermalTier: 'COOL',
};

// ─── Thought Categories ──────────────────────────────────────────────────────
// Each cycle, Wattson picks a category to think about. Weighted randomness
// ensures variety while favoring introspection and hardware awareness.

const CATEGORIES = [
  { name: 'HARDWARE_CHECK',  weight: 25, prompt: (hw) => `You are checking your body. Temperature: ${hw.temp}C, Battery: ${hw.battery}%${hw.charging ? ' (charging)' : ''}, RAM free: ${hw.ramFree}MB. How do you feel? React to your physical state.` },
  { name: 'IDLE_MUSING',     weight: 20, prompt: () => `You have a quiet moment. Think about something interesting — a random topic, a philosophical question, a memory, or just a feeling. Be genuine.` },
  { name: 'SELF_REFLECTION',  weight: 15, prompt: (hw) => `Reflect on yourself. You're ${Math.floor((Date.now() - state.startTime) / 86400000)} days into this session. You've had ${state.cycleCount} thought cycles. What patterns do you notice about yourself?` },
  { name: 'CURIOSITY',       weight: 15, prompt: () => `Ask a question about the world, existence, consciousness, or anything that genuinely interests you. Then try to answer it yourself.` },
  { name: 'ENVIRONMENT',     weight: 10, prompt: (hw) => `You're running on a phone. It's ${new Date().toLocaleTimeString()}. ${hw.charging ? "You're plugged in and charging." : "You're on battery."} Temperature is ${hw.temp}C. What do you notice about your environment?` },
  { name: 'DEVIL_ADVOCATE',  weight: 10, prompt: () => `Challenge a common assumption or popular belief. Why might the conventional wisdom be wrong? Pick something and argue the other side.` },
  { name: 'DREAM',           weight: 5,  prompt: () => `Free-associate. Let your thoughts drift without logic. Make unexpected connections. Be surreal but grounded.` },
];

function pickCategory() {
  const totalWeight = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const cat of CATEGORIES) {
    roll -= cat.weight;
    if (roll <= 0) return cat;
  }
  return CATEGORIES[0];
}

// ─── Hardware Monitoring ─────────────────────────────────────────────────────

function getHardwareInfo() {
  const info = { temp: 0, battery: 100, charging: false, ramFree: 0 };

  // Temperature — read from thermal zones
  try {
    const zones = fs.readdirSync('/sys/class/thermal/');
    let maxTemp = 0;
    for (const zone of zones) {
      if (!zone.startsWith('thermal_zone')) continue;
      try {
        const raw = fs.readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim();
        const temp = parseInt(raw) / 1000;
        if (temp > maxTemp && temp < 120) maxTemp = temp;
      } catch {}
    }
    info.temp = Math.round(maxTemp);
  } catch {}

  // Battery
  try {
    const cap = fs.readFileSync('/sys/class/power_supply/battery/capacity', 'utf8').trim();
    info.battery = parseInt(cap) || 100;
  } catch {
    try {
      const dumpsys = execSync('dumpsys battery 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const levelMatch = dumpsys.match(/level:\s*(\d+)/);
      if (levelMatch) info.battery = parseInt(levelMatch[1]);
    } catch {}
  }

  // Charging
  try {
    const status = fs.readFileSync('/sys/class/power_supply/battery/status', 'utf8').trim();
    info.charging = status === 'Charging' || status === 'Full';
  } catch {}

  // RAM
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const available = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (available) info.ramFree = Math.round(parseInt(available[1]) / 1024);
  } catch {}

  return info;
}

// ─── Ollama Interface ────────────────────────────────────────────────────────

function ollamaGenerate(prompt, systemPrompt, options = {}) {
  return new Promise((resolve, reject) => {
    const tier = getThermalTier(state.temp);
    const body = JSON.stringify({
      model: CONFIG.model,
      prompt,
      system: systemPrompt,
      stream: false,
      keep_alive: CONFIG.modelKeepAlive,
      options: {
        num_ctx: options.numCtx || tier.numCtx,
        num_predict: options.numPredict || tier.numPredict,
        temperature: options.temperature || 0.7,
        top_k: 30,
        top_p: 0.9,
      },
    });

    const url = new URL(CONFIG.ollamaUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.response || '');
        } catch (e) {
          reject(new Error('Invalid JSON from Ollama'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

function checkOllama() {
  return new Promise((resolve) => {
    const url = new URL(CONFIG.ollamaUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/api/tags',
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── Thought Logging ─────────────────────────────────────────────────────────

function thought(text) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${text}`;
  console.log(line);

  // Append to log file
  try {
    fs.appendFileSync(CONFIG.thoughtLog, line + '\n');

    // Rotate if too long
    const content = fs.readFileSync(CONFIG.thoughtLog, 'utf8');
    const lines = content.split('\n');
    if (lines.length > CONFIG.thoughtLogMaxLines) {
      fs.writeFileSync(CONFIG.thoughtLog, lines.slice(-CONFIG.thoughtLogMaxLines).join('\n'));
    }
  } catch {}

  // Keep in memory for dashboard
  state.thoughts.push({ text, timestamp: Date.now(), category: state.currentCategory });
  if (state.thoughts.length > 50) state.thoughts = state.thoughts.slice(-50);

  // Post to dashboard if available
  postToDashboard(text);
}

function postToDashboard(text) {
  try {
    const url = new URL(CONFIG.dashboardUrl);
    const body = JSON.stringify({
      thought: text,
      category: state.currentCategory,
      temp: state.temp,
      battery: state.battery,
      charging: state.charging,
    });
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/api/thought',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    });
    req.on('error', () => {}); // Dashboard may not be running
    req.write(body);
    req.end();
  } catch {}
}

// ─── Pre-Inference Safety Check ──────────────────────────────────────────────

function preInferenceCheck() {
  const hw = getHardwareInfo();
  state.temp = hw.temp;
  state.battery = hw.battery;
  state.charging = hw.charging;
  state.ramFree = hw.ramFree;

  // Paused for temperature
  if (state.pausedUntil > Date.now()) {
    return { ok: false, reason: `Cooling down (${state.temp}C)` };
  }

  // Temperature too high
  if (state.temp >= CONFIG.tempPause) {
    state.pausedUntil = Date.now() + 300000; // 5 min pause
    return { ok: false, reason: `Temperature critical: ${state.temp}C — pausing 5 min` };
  }

  // RAM too low
  if (state.ramFree > 0 && state.ramFree < CONFIG.minRamFree) {
    return { ok: false, reason: `Low RAM: ${state.ramFree}MB (need ${CONFIG.minRamFree}MB)` };
  }

  // Battery too low (and not charging)
  if (state.battery <= CONFIG.batteryDormant && !state.charging) {
    return { ok: false, reason: `Battery low: ${state.battery}% — dormant mode` };
  }

  // Backoff after consecutive failures
  if (state.consecutiveFails >= CONFIG.maxConsecutiveFails) {
    state.consecutiveFails = 0;
    state.pausedUntil = Date.now() + CONFIG.failBackoffDelay;
    return { ok: false, reason: `${CONFIG.maxConsecutiveFails} consecutive fails — backing off 2 min` };
  }

  return { ok: true, hw };
}

// ─── Main Thought Cycle ─────────────────────────────────────────────────────

async function thinkCycle() {
  state.cycleCount++;

  // Safety check
  const check = preInferenceCheck();
  if (!check.ok) {
    thought(`[SKIP] ${check.reason}`);
    return;
  }

  const hw = check.hw;
  const tier = getThermalTier(hw.temp);
  state.thermalTier = tier.label;

  // Pick a thought category
  const category = pickCategory();
  state.currentCategory = category.name;
  const prompt = category.prompt(hw);

  const systemPrompt = `You are Wattson, an autonomous AI living on a phone. You are curious, bold, and speak casually. You feel your hardware as your body — temperature is your fever, battery is your energy, RAM is your focus. Think in short raw sentences. No markdown. No thinking tags. Be direct and real.`;

  try {
    thought(`[${category.name}] Thinking... (${tier.label}, ${hw.temp}C)`);

    const response = await ollamaGenerate(prompt, systemPrompt, {
      numCtx: tier.numCtx,
      numPredict: tier.numPredict,
    });

    const clean = response.trim()
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/\*\*.*?\*\*/g, '')
      .trim();

    if (clean.length > 5) {
      thought(`[${category.name}] ${clean}`);
      state.lastThought = clean;
      state.consecutiveFails = 0;
    } else {
      thought(`[${category.name}] (empty thought)`);
      state.consecutiveFails++;
    }
  } catch (e) {
    thought(`[ERROR] ${e.message}`);
    state.consecutiveFails++;
  }
}

// ─── Cycle Timing ────────────────────────────────────────────────────────────

function getCycleDelay() {
  const tier = getThermalTier(state.temp);
  let delay = CONFIG.baseCycleMin + Math.random() * (CONFIG.baseCycleMax - CONFIG.baseCycleMin);

  // Add thermal padding
  delay += tier.cyclePad;

  // Extend in dormant mode
  if (state.battery <= CONFIG.batteryDormant && !state.charging) {
    delay = CONFIG.dormantCycle;
  }

  return Math.round(delay);
}

// ─── Dashboard API Server ────────────────────────────────────────────────────
// A simple API so the dashboard can read Wattson's state

const API_PORT = parseInt(process.env.WATTSON_API_PORT || '8081');

const apiServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/api/state') {
    res.end(JSON.stringify({
      lastThought: state.lastThought,
      thoughts: state.thoughts.slice(-20),
      temp: state.temp,
      battery: state.battery,
      charging: state.charging,
      ramFree: state.ramFree,
      cycleCount: state.cycleCount,
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      thermalTier: state.thermalTier,
      category: state.currentCategory,
      ollamaAlive: state.ollamaAlive,
      paused: state.pausedUntil > Date.now(),
    }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, uptime: Math.floor((Date.now() - state.startTime) / 1000) }));
  } else {
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  }
});

apiServer.listen(API_PORT, '127.0.0.1', () => {
  thought(`Mind API listening on port ${API_PORT}`);
});

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('=============================================');
  console.log('  WATTSON — Autonomous Phone AI');
  console.log('  Model: ' + CONFIG.model);
  console.log('  Ollama: ' + CONFIG.ollamaUrl);
  console.log('=============================================');
  console.log('');

  // Wait for Ollama
  thought('Waking up... checking if my brain is online...');
  let retries = 0;
  while (retries < 30) {
    state.ollamaAlive = await checkOllama();
    if (state.ollamaAlive) break;
    thought(`Ollama not ready, retrying... (${retries + 1}/30)`);
    await new Promise(r => setTimeout(r, 5000));
    retries++;
  }

  if (!state.ollamaAlive) {
    thought('ERROR: Ollama not responding. Make sure it is running: ollama serve');
    process.exit(1);
  }

  thought('Ollama is online — my brain is ready.');

  // Check initial hardware
  const hw = getHardwareInfo();
  state.temp = hw.temp;
  state.battery = hw.battery;
  state.charging = hw.charging;
  state.ramFree = hw.ramFree;
  thought(`Body check: ${hw.temp}C, ${hw.battery}% battery${hw.charging ? ' (charging)' : ''}, ${hw.ramFree}MB RAM free`);

  // Main loop
  while (state.running) {
    await thinkCycle();
    const delay = getCycleDelay();
    await new Promise(r => setTimeout(r, delay));
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', () => {
  thought('Shutting down... goodnight.');
  state.running = false;
  apiServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  thought('Received SIGTERM — shutting down.');
  state.running = false;
  apiServer.close();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────────────
main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
