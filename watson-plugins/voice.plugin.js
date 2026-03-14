'use strict';

// voice.plugin.js — Wattson speaks her best thoughts aloud
//
// Categories:
//   SPEAK (weight 4) — rephrase last high-score thought into spoken form, then say it
//
// Handler signature (watson-core): handler(state, CONFIG, logFn, brainCall)
//   logFn:     function(msg) — writes to watson-thoughts.log
//   brainCall: function(prompt, opts) — calls Ollama via brain module
//
// TTS command: /data/data/com.termux/files/usr/bin/termux-tts-speak
//   -p 0.7  (deeper pitch, below 1.0 normal)
//   -r 0.9  (slightly slow, deliberate)
//   -s MUSIC (higher quality audio stream)
//
// Security: all TTS input is stripped of shell-dangerous chars and capped at 200 chars
//           before being passed to execFile (NOT exec) — no shell interpolation.

const { execFile } = require('child_process');

const TTS_BIN  = '/data/data/com.termux/files/usr/bin/termux-tts-speak';
const TTS_OPTS = ['-e', 'com.google.android.tts', '-p', '0.7', '-r', '0.9', '-s', 'MUSIC'];

// ─── Sanitize text before passing to TTS shell command ────────────────────────

function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[`$\\|;&><"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ─── Speak via termux-tts-speak (execFile — no shell injection risk) ──────────

function speakText(text) {
  return new Promise(function(resolve) {
    var clean = sanitize(text);
    if (!clean) return resolve();

    execFile(TTS_BIN, TTS_OPTS.concat([clean]), { timeout: 30000 }, function(err) {
      if (err) console.error('[VOICE] TTS error:', err.message);
      resolve();
    });
  });
}

// ─── State shared between handlers and init ───────────────────────────────────

var _lastSpokenText = null;
var _speaking = false;
var _pendingText = null; // text queued via onHighScoreThought

// ─── SPEAK category handler ───────────────────────────────────────────────────
// Signature: (state, config, logFn, brainCall)

async function handleSpeak(state, config, logFn, brainCall) {
  if (_speaking) return;

  // Prefer queued high-score thought, fall back to last thought in state
  var text = _pendingText
    || state.lastHighScoreThought
    || (state.lastThought && typeof state.lastThought === 'string' ? state.lastThought : null)
    || null;

  _pendingText = null; // consume it

  if (!text || text === _lastSpokenText) return;
  _lastSpokenText = text;
  _speaking = true;

  try {
    logFn('[VOICE] Speaking: ' + text.slice(0, 80));

    // Ask brain to rephrase into max-20-word spoken form
    var rephrasePrompt = 'Rephrase as a short spoken statement, first person, max 20 words, authoritative, no filler:\n\n' + text;
    var spoken = null;
    try {
      spoken = await brainCall(rephrasePrompt, { numPredict: 60, temperature: 0.6 });
      if (spoken) spoken = spoken.trim();
    } catch (_) {}

    if (!spoken) {
      // Fallback: first sentence of raw thought, cleaned up
      spoken = text.split(/[.!?]/)[0].trim();
    }

    await speakText(spoken);
    logFn('[VOICE] Said: ' + spoken);
  } catch (err) {
    console.error('[VOICE] handleSpeak error:', err.message);
  } finally {
    _speaking = false;
  }
}

// ─── Plugin export ────────────────────────────────────────────────────────────

module.exports = {
  name: 'voice',

  categories: [
    {
      name:    'SPEAK',
      weight:  4,
      handler: handleSpeak,
    },
  ],

  // init receives (state, CONFIG) from watson-core after hot-load
  init: function(state, config) {
    console.log('[VOICE] Plugin loaded. TTS:', TTS_BIN);

    // Register high-score callback on state.
    // watson-core calls this after any thought scoring >= 8.
    state.onHighScoreThought = function(thoughtText) {
      if (typeof thoughtText !== 'string') return;
      _pendingText = thoughtText;
      // SPEAK will be scheduled normally; we just queue the text here
    };

    // Announce Wattson is online when the plugin first loads
    setTimeout(function() {
      speakText('Wattson online. Systems nominal.').catch(function() {});
    }, 3000);
  },
};
