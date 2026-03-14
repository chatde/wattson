'use strict';
// obsidian-sync.js — Bidirectional learning: write lessons to Obsidian, read before acting
// Vault location: /sdcard/Android/data/md.obsidian/files/Wattson/lessons/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SELF_ADB_BIN = '/data/data/com.termux/files/usr/bin/adb';
const SELF_ADB_DEV = '127.0.0.1:5555';
const OBSIDIAN_VAULT = '/sdcard/Android/data/md.obsidian/files/Wattson';
const LESSONS_DIR = path.join(OBSIDIAN_VAULT, 'lessons');
const NAV_PATTERNS_DIR = path.join(OBSIDIAN_VAULT, 'nav-patterns');

// ─── Ensure directories exist ───────────────────────────────────────────────

function ensureDirs() {
  try { fs.mkdirSync(LESSONS_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(NAV_PATTERNS_DIR, { recursive: true }); } catch {}
}

// ─── Write a navigation lesson ──────────────────────────────────────────────

function writeLesson(appName, taskName, steps, outcome) {
  ensureDirs();
  const slug = `${appName}-${taskName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const filepath = path.join(LESSONS_DIR, `${slug}.md`);
  const now = new Date().toISOString();

  const content = `# ${taskName} on ${appName}
> Learned: ${now}
> Outcome: ${outcome.ok ? 'SUCCESS' : 'FAILED'}
> Duration: ${outcome.durationMs || 0}ms

## Steps
${steps.map((s, i) => `${i + 1}. ${s.action} ${s.details || ''} ${s.coordinates ? `(${s.coordinates.x}, ${s.coordinates.y})` : ''}\n   - Expected: ${s.expected || 'n/a'}\n   - Actual: ${s.actual || 'n/a'}\n   - Worked: ${s.worked !== false ? 'yes' : 'no'}`).join('\n')}

## Notes
${outcome.notes || 'None'}
`;

  // Append if exists (multiple attempts improve the lesson), write if new
  if (fs.existsSync(filepath)) {
    fs.appendFileSync(filepath, `\n---\n## Attempt ${now}\n${content}`, 'utf8');
  } else {
    fs.writeFileSync(filepath, content, 'utf8');
  }

  return filepath;
}

// ─── Write a navigation pattern (app-specific shortcuts) ────────────────────

function writeNavPattern(appName, patternData) {
  ensureDirs();
  const slug = appName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const filepath = path.join(NAV_PATTERNS_DIR, `${slug}.md`);
  const now = new Date().toISOString();

  const entry = `\n## ${now}\n` +
    `- Screen: ${patternData.screenState || 'unknown'}\n` +
    `- Action: ${patternData.action || 'n/a'}\n` +
    `- Result: ${patternData.result || 'n/a'}\n` +
    `- Shortcut: ${patternData.shortcut || 'n/a'}\n`;

  if (fs.existsSync(filepath)) {
    fs.appendFileSync(filepath, entry, 'utf8');
  } else {
    fs.writeFileSync(filepath, `# ${appName} Navigation Patterns\n${entry}`, 'utf8');
  }
}

// ─── Read a lesson before acting ────────────────────────────────────────────

function findLesson(appName, taskName) {
  ensureDirs();

  try {
    const files = fs.readdirSync(LESSONS_DIR).filter(f => f.endsWith('.md'));
    // Exact match first
    const exactSlug = `${appName}-${taskName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const exact = files.find(f => f.replace('.md', '') === exactSlug);
    if (exact) return parseLesson(path.join(LESSONS_DIR, exact));

    // Fuzzy: find files containing app name and any part of task
    const taskWords = taskName.toLowerCase().split(/\s+/);
    const fuzzy = files.find(f => {
      const name = f.toLowerCase();
      return name.includes(appName.toLowerCase()) && taskWords.some(w => w.length > 2 && name.includes(w));
    });
    if (fuzzy) return parseLesson(path.join(LESSONS_DIR, fuzzy));
  } catch {}

  return null;
}

function parseLesson(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const steps = [];
    const stepRegex = /^\d+\.\s+(.+)$/gm;
    let match;
    while ((match = stepRegex.exec(content)) !== null) {
      const line = match[1];
      const coordMatch = line.match(/\((\d+),\s*(\d+)\)/);
      steps.push({
        action: line.replace(/\([\d,\s]+\)/, '').trim(),
        coordinates: coordMatch ? { x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10) } : null,
      });
    }
    // Check last attempt outcome
    const outcomeMatch = content.match(/Outcome:\s*(SUCCESS|FAILED)/g);
    const lastOutcome = outcomeMatch ? outcomeMatch[outcomeMatch.length - 1] : null;

    return {
      filepath,
      steps,
      lastSucceeded: lastOutcome ? lastOutcome.includes('SUCCESS') : null,
      raw: content,
    };
  } catch { return null; }
}

// ─── Search lessons by keyword ──────────────────────────────────────────────

function searchLessons(keyword) {
  ensureDirs();
  const results = [];
  try {
    const files = fs.readdirSync(LESSONS_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      if (file.toLowerCase().includes(keyword.toLowerCase())) {
        const lesson = parseLesson(path.join(LESSONS_DIR, file));
        if (lesson) results.push(lesson);
      }
    }
  } catch {}
  return results;
}

// ─── Open Obsidian app (keep vault warm in memory) ──────────────────────────

function spawnAdb(cmd, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(SELF_ADB_BIN, ['-s', SELF_ADB_DEV, 'shell', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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

async function openObsidianApp() {
  return spawnAdb('am start -a android.intent.action.VIEW -d "obsidian://open?vault=Wattson"', 5000);
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  writeLesson,
  writeNavPattern,
  findLesson,
  searchLessons,
  parseLesson,
  openObsidianApp,
  LESSONS_DIR,
  NAV_PATTERNS_DIR,
  OBSIDIAN_VAULT,
};
