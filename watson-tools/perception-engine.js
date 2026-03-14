'use strict';
// perception-engine.js — Watson's eyes: screenshot → understand → decide → act → verify
// OODA loop + subsumption layers for phone interaction
// Usage: const pe = require('./watson-tools/perception-engine.js');

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = (() => {
  const raw = process.env.HOME || '/data/data/com.termux/files/home';
  return raw.includes('files/home') ? raw : path.join(raw, 'files/home');
})();

const SELF_ADB_BIN = '/data/data/com.termux/files/usr/bin/adb';
const SELF_ADB_DEV = '127.0.0.1:5555';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const SCREENSHOT_DIR = '/sdcard/watson-photos';
const SCREENSHOT_PATH = '/sdcard/watson-nav-perception.png';
const PERCEPTION_LOG = path.join(HOME, 'watson-perception.jsonl');

// ─── Shell helpers (mirrors discord-commands pattern) ────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnAsync(bin, args, timeoutMs) {
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

function selfAdbShell(cmd, timeoutMs) {
  return spawnAsync(SELF_ADB_BIN, ['-s', SELF_ADB_DEV, 'shell', cmd], timeoutMs || 8000);
}

// ─── Model management ────────────────────────────────────────────────────────

function unloadModel(modelName) {
  return new Promise(resolve => {
    const body = JSON.stringify({ model: modelName, keep_alive: 0 });
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

function callMoondream(base64Image, prompt, maxTokens) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'moondream:1.8b',
      messages: [{ role: 'user', content: prompt, images: [base64Image] }],
      stream: false,
      think: false,
      keep_alive: 0,
      options: { num_predict: maxTokens || 150, temperature: 0.3 },
    });

    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve((parsed.message && parsed.message.content) || parsed.response || '');
        } catch { resolve(''); }
      });
    });

    req.on('error', e => resolve(`moondream error: ${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.write(body);
    req.end();
  });
}

// ─── Screenshot capture ─────────────────────────────────────────────────────

async function takeScreenshot(filepath) {
  const target = filepath || SCREENSHOT_PATH;
  const result = await selfAdbShell(`screencap -p ${target}`, 15000);
  if (!result.ok) return { ok: false, base64: null, path: target };

  // Read and encode to base64
  try {
    const catResult = await spawnAsync('base64', [target], 30000);
    if (catResult.ok && catResult.output) {
      return { ok: true, base64: catResult.output.replace(/\s/g, ''), path: target };
    }
  } catch {}
  return { ok: false, base64: null, path: target };
}

// ─── Screenshot hash for stuck detection ────────────────────────────────────

function screenshotHash(base64) {
  if (!base64 || base64.length < 100) return 'empty';
  // Fast hash: sample chunks from beginning, middle, and end
  const len = base64.length;
  return `${len}-${base64.substring(0, 40)}-${base64.substring(Math.floor(len / 2), Math.floor(len / 2) + 40)}-${base64.substring(len - 40)}`;
}

// ─── Screen state classification ────────────────────────────────────────────

const SCREEN_STATES = ['home', 'search', 'player', 'station_list', 'ad', 'dialog', 'browser', 'lock', 'unknown'];

function classifyScreenState(moondreamOutput) {
  const text = (moondreamOutput || '').toLowerCase();

  if (/lock\s*screen|slide to unlock|enter (pin|password|pattern)/i.test(text)) return 'lock';
  if (/advertis|interstitial|continue to|skip ad|close ad|upgrade|subscribe|premium/i.test(text)) return 'ad';
  if (/dialog|popup|permission|allow|deny|ok\s*cancel|alert/i.test(text)) return 'dialog';
  if (/search\s*(bar|field|box|input)|type here|search for/i.test(text)) return 'search';
  if (/now playing|playing|pause|skip|album art|progress bar|shuffle|repeat/i.test(text)) return 'player';
  if (/station|playlist|collection|my music|library|browse/i.test(text)) return 'station_list';
  if (/home|dashboard|feed|for you|trending|discover/i.test(text)) return 'home';
  if (/browser|url bar|http|www\.|\.com/i.test(text)) return 'browser';

  return 'unknown';
}

// ─── Core: Perceive screen ──────────────────────────────────────────────────

async function perceiveScreen(config, thought) {
  // 1. Take screenshot
  const shot = await takeScreenshot();
  if (!shot.ok || !shot.base64) {
    if (thought) thought('[PERCEIVE] Screenshot failed');
    return { ok: false, screenState: 'unknown', description: '', elements: [], raw: '' };
  }

  // 2. Unload watson:mind to free RAM for Moondream
  if (config && config.ollamaModel) {
    await unloadModel(config.ollamaModel);
    await sleep(800);
  }

  // 3. Ask Moondream structured questions
  const description = await callMoondream(
    shot.base64,
    'Describe this phone screen. What app is showing? What text is visible? ' +
    'List any buttons, tabs, or interactive elements. ' +
    'Is there a search field? Is music playing? Are there any ads or dialogs?',
    200,
  );

  if (thought) thought(`[PERCEIVE] Screen: ${description.substring(0, 200)}`);

  // 4. Classify screen state
  const screenState = classifyScreenState(description);

  // 5. Extract visible elements from description
  const elements = extractVisibleElements(description);

  // 6. Log perception
  logPerception({ screenState, description, elements });

  return {
    ok: true,
    screenState,
    description,
    elements,
    base64: shot.base64,
    hash: screenshotHash(shot.base64),
    raw: description,
  };
}

function extractVisibleElements(description) {
  const elements = [];
  const text = description || '';

  // Extract quoted items (station names, button labels, etc.)
  const quoted = text.match(/"([^"]+)"/g);
  if (quoted) {
    for (const q of quoted) {
      elements.push({ type: 'text', label: q.replace(/"/g, '') });
    }
  }

  // Extract items after bullet points or numbers
  const listed = text.match(/(?:^|\n)\s*[-•*\d.]+\s+([^\n]+)/g);
  if (listed) {
    for (const item of listed) {
      elements.push({ type: 'list_item', label: item.replace(/^\s*[-•*\d.]+\s+/, '').trim() });
    }
  }

  return elements;
}

// ─── Targeted perception (ask specific question about screen) ───────────────

async function askAboutScreen(base64, question, config) {
  if (config && config.ollamaModel) {
    await unloadModel(config.ollamaModel);
    await sleep(500);
  }
  return callMoondream(base64, question, 150);
}

// ─── Check for specific element on screen ───────────────────────────────────

async function findOnScreen(base64, targetName, config) {
  const prompt = `Look at this phone screen. Is "${targetName}" visible anywhere on the screen? ` +
    `If yes, describe where it is (top, middle, bottom, left, right). ` +
    `List all station names, artist names, or playlist names you can see.`;

  const response = await askAboutScreen(base64, prompt, config);
  const found = response.toLowerCase().includes(targetName.toLowerCase());

  return {
    found,
    response,
    position: found ? estimatePosition(response) : null,
  };
}

function estimatePosition(description) {
  const text = description.toLowerCase();
  // Rough position estimation — will be refined with UIAutomator for tapping
  let y = 960; // default center
  let x = 540;
  if (text.includes('top')) y = 300;
  if (text.includes('upper')) y = 500;
  if (text.includes('middle') || text.includes('center')) y = 960;
  if (text.includes('lower') || text.includes('bottom half')) y = 1400;
  if (text.includes('bottom')) y = 1800;
  if (text.includes('left')) x = 270;
  if (text.includes('right')) x = 810;
  return { x, y };
}

// ─── Verify action outcome ──────────────────────────────────────────────────

async function verifyAction(expectedState, config, thought) {
  const actual = await perceiveScreen(config, thought);
  const matched = actual.screenState === expectedState;

  return {
    matched,
    expected: expectedState,
    actual: actual.screenState,
    description: actual.description,
    perception: actual,
    needsRecovery: !matched && (actual.screenState === 'ad' || actual.screenState === 'dialog' || actual.screenState === 'lock'),
  };
}

// ─── Subsumption Layer 0: Safety checks ─────────────────────────────────────

async function checkSafety(thought) {
  // Check battery
  const battery = await selfAdbShell('dumpsys battery | grep level', 3000);
  const levelMatch = (battery.output || '').match(/level:\s*(\d+)/);
  const level = levelMatch ? parseInt(levelMatch[1], 10) : 100;

  if (level < 5) {
    if (thought) thought('[SAFETY] Battery critically low: ' + level + '%');
    return { safe: false, reason: 'battery_critical', level };
  }

  // Check for lock screen
  const lockCheck = await selfAdbShell('dumpsys window | grep mDreamingLockscreen', 3000);
  const locked = (lockCheck.output || '').includes('mDreamingLockscreen=true');

  if (locked) {
    // Try to wake and unlock
    await selfAdbShell('input keyevent KEYCODE_WAKEUP', 2000);
    await sleep(500);
    await selfAdbShell('input swipe 540 1800 540 800 300', 3000);
    await sleep(1000);
  }

  return { safe: true, batteryLevel: level };
}

// ─── Subsumption Layer 1: Stuck recovery ────────────────────────────────────

const stuckHistory = [];
const MAX_STUCK_HISTORY = 10;

function recordScreenHash(hash) {
  stuckHistory.push({ hash, ts: Date.now() });
  if (stuckHistory.length > MAX_STUCK_HISTORY) stuckHistory.shift();
}

function isStuck() {
  if (stuckHistory.length < 3) return false;
  const last3 = stuckHistory.slice(-3);
  return last3[0].hash === last3[1].hash && last3[1].hash === last3[2].hash;
}

async function recoverFromStuck(attempts, appPackage, thought) {
  if (thought) thought(`[RECOVERY] Stuck detected — attempt ${attempts}`);

  if (attempts <= 1) {
    // Level 1: Press back
    await selfAdbShell('input keyevent KEYCODE_BACK', 2000);
    await sleep(1500);
    return 'pressed_back';
  }

  if (attempts <= 2) {
    // Level 2: Press home, relaunch
    await selfAdbShell('input keyevent KEYCODE_HOME', 2000);
    await sleep(2000);
    if (appPackage) {
      await selfAdbShell(`monkey -p ${appPackage} -c android.intent.category.LAUNCHER 1`, 5000);
      await sleep(3000);
    }
    return 'relaunched_app';
  }

  if (attempts <= 3) {
    // Level 3: Force-stop and restart
    if (appPackage) {
      await selfAdbShell(`am force-stop ${appPackage}`, 3000);
      await sleep(2000);
      await selfAdbShell(`monkey -p ${appPackage} -c android.intent.category.LAUNCHER 1`, 5000);
      await sleep(4000);
    }
    return 'force_restarted';
  }

  // Level 4: Give up — report to Discord
  return 'give_up';
}

// ─── Subsumption Layer 2: Handle obstacles (ads, dialogs) ───────────────────

async function handleObstacle(screenState, thought) {
  if (screenState === 'ad') {
    if (thought) thought('[OBSTACLE] Ad detected — dismissing...');
    // Try common dismiss patterns
    await selfAdbShell('input keyevent KEYCODE_BACK', 2000);
    await sleep(1500);

    // Try tapping common "X" positions (top-right corner)
    await selfAdbShell('input tap 1020 120', 2000);
    await sleep(1000);

    // Try "Skip" button area (bottom-right)
    await selfAdbShell('input tap 900 1900', 2000);
    await sleep(1000);
    return 'dismissed_ad';
  }

  if (screenState === 'dialog') {
    if (thought) thought('[OBSTACLE] Dialog detected — dismissing...');
    await selfAdbShell('input keyevent KEYCODE_BACK', 2000);
    await sleep(1000);
    return 'dismissed_dialog';
  }

  if (screenState === 'lock') {
    if (thought) thought('[OBSTACLE] Lock screen — unlocking...');
    await selfAdbShell('input keyevent KEYCODE_WAKEUP', 2000);
    await sleep(500);
    await selfAdbShell('input swipe 540 1800 540 800 300', 3000);
    await sleep(1500);
    return 'unlocked';
  }

  return 'no_obstacle';
}

// ─── Media state check ──────────────────────────────────────────────────────

async function checkMediaState() {
  const result = await selfAdbShell('dumpsys media_session', 5000);
  const output = result.output || '';
  const playing = output.includes('state=3');
  const songMatch = output.match(/description=([^,]+),\s*([^,]+)/);

  return {
    playing,
    song: songMatch ? songMatch[1].trim() : null,
    artist: songMatch ? songMatch[2].trim() : null,
  };
}

// ─── Re-warm watson:mind after perception ───────────────────────────────────

async function rewarmMind(callOllama) {
  if (callOllama) {
    try {
      await callOllama('ok', { numPredict: 1, stream: false });
    } catch {}
  }
}

// ─── Perception logging ─────────────────────────────────────────────────────

function logPerception(entry) {
  try {
    fs.appendFileSync(PERCEPTION_LOG, JSON.stringify({
      ts: Date.now(),
      ...entry,
    }) + '\n');
  } catch {}
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  // Core perception
  perceiveScreen,
  takeScreenshot,
  askAboutScreen,
  findOnScreen,
  verifyAction,
  classifyScreenState,

  // Subsumption layers
  checkSafety,
  isStuck,
  recordScreenHash,
  recoverFromStuck,
  handleObstacle,

  // Media
  checkMediaState,

  // Model management
  unloadModel,
  callMoondream,
  rewarmMind,

  // Utilities
  selfAdbShell,
  spawnAsync,
  sleep,
  screenshotHash,

  // Constants
  SCREENSHOT_DIR,
  SCREENSHOT_PATH,
};
