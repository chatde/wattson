'use strict';
// passive-learning.plugin.js — Watch Dad use the phone, learn silently
// Categories: PASSIVE_LEARN (weight 2)
//
// When Watson detects he's NOT the one controlling the phone (someone else
// has the screen), he watches silently — reads UI state via UIAutomator,
// and learns navigation patterns, app layouts, and user behavior.
// Like a kid watching a parent cook — absorbing without interfering.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const SELF_ADB_BIN = '/data/data/com.termux/files/usr/bin/adb';
const SELF_ADB_DEV = '127.0.0.1:5555';
const PASSIVE_LOG = `${HOME}/watson-passive-learning.jsonl`;
const PASSIVE_PATTERNS_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/passive-patterns';

let lastScreenHash = '';
let screenUnchangedCount = 0;
let lastActiveApp = '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function selfAdbShell(cmd, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(SELF_ADB_BIN, ['-s', SELF_ADB_DEV, 'shell', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || ''), HOME },
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

function spawnFile(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || ''), HOME },
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

// ─── Detect if someone else is using the phone ─────────────────────────────

async function isUserActive() {
  const screenState = await selfAdbShell('dumpsys display | grep mScreenState', 3000);
  if (!screenState.ok || !screenState.output.includes('ON')) return false;

  const focus = await selfAdbShell('dumpsys window windows | grep mCurrentFocus', 3000);
  const isDashboard = focus.ok && focus.output.includes('127.0.0.1');
  if (isDashboard) return false;

  return true;
}

async function getCurrentApp() {
  const focus = await selfAdbShell('dumpsys window windows | grep mCurrentFocus', 3000);
  if (!focus.ok) return 'unknown';
  const match = (focus.output || '').match(/\{[^}]*\s(\S+\/\S+)\}/);
  return match ? match[1].split('/')[0] : 'unknown';
}

async function getScreenSnapshot() {
  await selfAdbShell('uiautomator dump /sdcard/ui_dump_passive.xml', 8000);
  const cat = await spawnFile('cat', ['/sdcard/ui_dump_passive.xml'], 5000);
  return cat.ok ? cat.output : '';
}

function hashXml(xml) {
  if (!xml || xml.length < 50) return 'empty';
  return `${xml.length}-${xml.substring(0, 100)}-${xml.substring(xml.length - 100)}`;
}

function extractElements(xml) {
  const elements = [];
  const re = /<node([^>]*)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1];
    const get = k => { const r = new RegExp(`${k}="([^"]*)"`).exec(a); return r ? r[1] : ''; };
    const text = get('text'), desc = get('content-desc'), cls = get('class'), bounds = get('bounds');
    if ((text || desc) && bounds) {
      elements.push({ text, desc, class: cls, bounds });
    }
  }
  return elements;
}

// ─── PASSIVE_LEARN handler ──────────────────────────────────────────────────

async function handlePassiveLearn(state, CONFIG, thought, callOllama) {
  const userActive = await isUserActive();
  if (!userActive) {
    thought('[PASSIVE] No external user activity — skipping');
    return;
  }

  const currentApp = await getCurrentApp();
  thought(`[PASSIVE] 👀 Dad is using ${currentApp} — watching silently...`);

  const xml = await getScreenSnapshot();
  const currentHash = hashXml(xml);

  if (currentHash === lastScreenHash) {
    screenUnchangedCount++;
    if (screenUnchangedCount > 3) {
      thought('[PASSIVE] Same screen — Dad might be reading');
      return;
    }
  } else {
    screenUnchangedCount = 0;
  }
  lastScreenHash = currentHash;

  const elements = extractElements(xml);
  const textContent = elements
    .map(e => e.text || e.desc).filter(Boolean).join(' | ').substring(0, 500);

  const appChanged = currentApp !== lastActiveApp;
  if (appChanged && lastActiveApp) {
    thought(`[PASSIVE] App switch: ${lastActiveApp} → ${currentApp}`);
  }
  lastActiveApp = currentApp;

  try { fs.mkdirSync(PASSIVE_PATTERNS_DIR, { recursive: true }); } catch {}

  const entry = {
    ts: Date.now(), app: currentApp, appChanged,
    elementCount: elements.length,
    textSample: textContent.substring(0, 200),
    buttons: elements.filter(e => (e.class || '').includes('Button')).map(e => e.text || e.desc).filter(Boolean),
    tabs: elements.filter(e => (e.class || '').includes('Tab')).map(e => e.text || e.desc).filter(Boolean),
  };

  try { fs.appendFileSync(PASSIVE_LOG, JSON.stringify(entry) + '\n'); } catch {}

  if (appChanged) {
    const patternFile = path.join(PASSIVE_PATTERNS_DIR, `${currentApp.replace(/\./g, '-')}.md`);
    const patternEntry = `\n## ${new Date().toISOString()}\n` +
      `- Opened from: ${lastActiveApp || 'home'}\n` +
      `- Visible tabs: ${entry.tabs.join(', ') || 'none'}\n` +
      `- Visible buttons: ${entry.buttons.join(', ') || 'none'}\n` +
      `- Screen text: ${textContent.substring(0, 100)}\n`;

    if (fs.existsSync(patternFile)) {
      fs.appendFileSync(patternFile, patternEntry, 'utf8');
    } else {
      fs.writeFileSync(patternFile,
        `# ${currentApp} — Navigation Patterns\n> Learned from passive observation\n` + patternEntry, 'utf8');
    }
  }

  if (state.ollamaAlive && textContent.length > 50 && Math.random() < 0.3) {
    try {
      const insight = await callOllama(
        `You see this on a phone screen (app: ${currentApp}): "${textContent.substring(0, 300)}". ` +
        `In one sentence, what is the user doing or looking at?`,
        { numPredict: 40, numCtx: 256, stream: false, think: false, skipKnowledge: true },
      );
      if (insight && insight.length > 10) {
        thought(`[PASSIVE] I think Dad is: ${insight.substring(0, 150)}`);
        state.lastThought = `[PASSIVE] 👀 ${insight.substring(0, 150)}`;
      }
    } catch {}
  } else {
    state.lastThought = `[PASSIVE] 👀 Watching Dad use ${currentApp} (${elements.length} elements visible)`;
  }
}

module.exports = {
  name: 'passive-learning',
  categories: [
    { name: 'PASSIVE_LEARN', weight: 2, handler: handlePassiveLearn },
  ],
  async init() {
    try { fs.mkdirSync(PASSIVE_PATTERNS_DIR, { recursive: true }); } catch {}
  },
  shutdown() {},
};
