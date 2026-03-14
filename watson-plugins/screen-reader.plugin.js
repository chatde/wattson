// screen-reader.plugin.js — Watson screen intelligence plugin
// Category: SCREEN_READ (weight 3)
// Takes a screenshot, runs Tesseract OCR, feeds interesting text to the brain.
// Brain rates relevance 1–10 and stores worthy content in watson-knowledge.

'use strict';

const { execFile, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ─── Paths ────────────────────────────────────────────────────────────────────

const TESSERACT_BIN = '/data/data/com.termux/files/usr/bin/tesseract';
const SCREENCAP_BIN = '/system/bin/screencap';
const SCREENSHOT    = '/sdcard/watson-screen.png';
const OCR_OUT_BASE  = '/sdcard/watson-screen-ocr';   // tesseract appends .txt
const OCR_OUT_TXT   = OCR_OUT_BASE + '.txt';
const KNOWLEDGE_LOG = '/sdcard/wattson-knowledge.jsonl';

// Min characters of OCR output needed before we bother the brain
const MIN_TEXT_LEN = 40;
// Max chars to send to brain (avoid huge prompts)
const MAX_TEXT_LEN = 600;
// Relevance threshold: store if brain scores >= this
const STORE_THRESHOLD = 6;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function execFileAsync(bin, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (err.message || stderr || '').trim() });
      } else {
        resolve({ ok: true, output: (stdout || '').trim() });
      }
    });
  });
}

function spawnAsync(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false, killed = false;

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: '/data/data/com.termux/files/usr/bin:' + (process.env.PATH || ''),
      },
    });

    const timer = setTimeout(() => {
      if (!done) {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ ok: false, output: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killed) return;
      resolve(code === 0
        ? { ok: true,  output: stdout.trim() }
        : { ok: false, output: (stderr || stdout || 'exit ' + code).trim() });
    });

    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
  });
}

// Clean OCR output: collapse whitespace, strip control chars, deduplicate blank lines
function cleanOcrText(raw) {
  return raw
    .replace(/\r/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')   // strip non-printable ASCII
    .replace(/[ \t]+/g, ' ')            // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')         // max 2 consecutive blank lines
    .trim();
}

// Ask the brain a question, return the trimmed response string
function askBrain(prompt, config, timeoutMs) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model:      config.ollamaModel,
      messages:   [{ role: 'user', content: prompt }],
      stream:     false,
      think:      false,
      keep_alive: '10m',
      options:    { num_predict: 80, temperature: 0.3 },
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port:     11434,
      path:     '/api/chat',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  timeoutMs,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(((parsed.message && parsed.message.content) || parsed.response || '').trim());
        } catch { resolve(''); }
      });
    });

    req.on('error', e => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

// Append one JSONL entry to the knowledge log
function storeKnowledge(entry) {
  try {
    fs.appendFileSync(KNOWLEDGE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

// ─── Cooldown: avoid repeated OCR of the same static screen ─────────────────

let _lastOcrHash   = '';
let _skipUntilCycle = 0;
let _failStreak    = 0;

// Simple cheap hash: length + first 20 + last 20 chars
function quickHash(str) {
  return str.length + '|' + str.slice(0, 20) + '|' + str.slice(-20);
}

// ─── SCREEN_READ handler ─────────────────────────────────────────────────────

async function handleScreenRead(state, config, thought, callOllama) {
  // Backoff if tesseract has been failing
  if (state.cycleCount < _skipUntilCycle) {
    thought(`[SCREEN] skipping — OCR in backoff until cycle ${_skipUntilCycle}`);
    return;
  }

  thought('[SCREEN] taking screenshot...');

  // Step 1: Screenshot
  const ssResult = await spawnAsync(SCREENCAP_BIN, ['-p', SCREENSHOT], 15000);
  if (!ssResult.ok) {
    thought(`[SCREEN] screencap failed: ${ssResult.output.slice(0, 80)}`);
    _failStreak++;
    if (_failStreak >= 3) {
      _skipUntilCycle = state.cycleCount + 8;
      thought(`[SCREEN] 3 fails — backoff 8 cycles`);
    }
    return;
  }

  // Step 2: Tesseract OCR
  const ocrResult = await execFileAsync(TESSERACT_BIN, [SCREENSHOT, OCR_OUT_BASE], 30000);
  if (!ocrResult.ok) {
    thought(`[SCREEN] tesseract failed: ${ocrResult.output.slice(0, 80)}`);
    _failStreak++;
    if (_failStreak >= 3) {
      _skipUntilCycle = state.cycleCount + 8;
      thought(`[SCREEN] 3 fails — backoff 8 cycles`);
    }
    return;
  }

  // Step 3: Read OCR output
  let rawText = '';
  try {
    rawText = fs.readFileSync(OCR_OUT_TXT, 'utf8');
  } catch (e) {
    thought(`[SCREEN] can't read OCR output: ${e.message}`);
    return;
  }

  const text = cleanOcrText(rawText);

  if (text.length < MIN_TEXT_LEN) {
    thought(`[SCREEN] OCR output too short (${text.length} chars) — screen may be blank or locked`);
    _failStreak = 0;
    return;
  }

  // Step 4: Deduplicate — skip if same screen content as last time
  const hash = quickHash(text);
  if (hash === _lastOcrHash) {
    thought('[SCREEN] screen unchanged since last read — skipping');
    return;
  }
  _lastOcrHash = hash;
  _failStreak  = 0;

  const excerpt = text.slice(0, MAX_TEXT_LEN);
  thought(`[SCREEN] OCR extracted ${text.length} chars — asking brain to rate relevance...`);

  // Step 5: Brain rates relevance
  const ratingPrompt =
    `You are Wattson, an autonomous AI. You just read this text from your phone screen via OCR:\n` +
    `"${excerpt}"\n\n` +
    `Rate how interesting or useful this content is on a scale of 1–10. ` +
    `High scores for: AI news, coding, tasks, important decisions, financial data, personal goals. ` +
    `Low scores for: UI chrome, menus, empty content, social media noise. ` +
    `Reply with ONLY the number.`;

  const ratingRaw  = await askBrain(ratingPrompt, config, 20000);
  const score      = parseInt(ratingRaw.replace(/\D/g, ''), 10);
  const validScore = !isNaN(score) && score >= 1 && score <= 10 ? score : 0;

  thought(`[SCREEN] brain rated screen content: ${validScore}/10`);

  // Step 6: If score is high enough, ask brain for a summary and store it
  if (validScore >= STORE_THRESHOLD) {
    const summaryPrompt =
      `You are Wattson. Summarize this screen content in 1–2 sentences, capturing what is important:\n` +
      `"${excerpt}"\n\nSummary:`;

    const summary = await askBrain(summaryPrompt, config, 20000);

    if (summary && summary.length > 10) {
      const entry = {
        ts:      Date.now(),
        source:  'screen-ocr',
        score:   validScore,
        summary,
        raw:     excerpt.slice(0, 200),
      };
      storeKnowledge(entry);
      thought(`[SCREEN] stored in knowledge (score ${validScore}): ${summary.slice(0, 120)}`);
      state.lastThought = `[screen] ${summary.slice(0, 100)}`;
    }
  } else {
    thought(`[SCREEN] content not worth storing (score ${validScore} < ${STORE_THRESHOLD})`);
  }
}

// ─── Plugin export ────────────────────────────────────────────────────────────

module.exports = {
  name: 'screen-reader',

  categories: [
    { name: 'SCREEN_READ', weight: 3, handler: handleScreenRead },
  ],

  async init(state, config) {
    // Nothing to set up — screencap and tesseract are system-level tools
  },

  async shutdown(state) {},
};
