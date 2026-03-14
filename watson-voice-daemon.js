#!/usr/bin/env node
'use strict';

// watson-voice-daemon.js — Wake word listener for Wattson
//
// Loop:
//   1. Record CHUNK_SECS of audio via termux-microphone-record
//   2. Transcribe via Groq Whisper (free tier)
//   3. If transcript contains "wattson": speak "Yes?", record 5s command, transcribe
//   4. Send command to Ollama wattson:chat, speak response
//
// Runs as a background daemon started from watson-core-boot.sh.
// Log: /sdcard/wattson-voice.log
//
// Security:
//   - All termux binary calls use execFile with arg arrays (no shell interpolation)
//   - Ollama prompt is sent via HTTP POST body (never shell-executed)
//   - Groq API key read from env var with hardcoded fallback

const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const { execFile, spawn } = require('child_process');
const path     = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const HOME      = process.env.HOME || '/data/data/com.termux/files/home';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const GROQ_KEY  = process.env.GROQ_API_KEY || '';
const OLLAMA_MODEL = 'wattson:chat';
const CHUNK_SECS   = 3;   // ambient listen window (seconds)
const COMMAND_SECS = 5;   // command capture window after wake word
const CHUNK_FILE   = '/sdcard/.wattson-chunk.aac';
const CMD_FILE     = '/sdcard/.wattson-cmd.aac';
const TTS_BIN      = path.join(TERMUX_BIN, 'termux-tts-speak');
const MIC_BIN      = path.join(TERMUX_BIN, 'termux-microphone-record');
const TTS_OPTS     = ['-e', 'com.google.android.tts', '-p', '0.7', '-r', '0.9', '-s', 'MUSIC'];
const LOG_FILE     = '/sdcard/wattson-voice.log';

let _running = false;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

function speak(text) {
  return new Promise(function(resolve) {
    var clean = text.replace(/[`$\\|;&><"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) return resolve();
    execFile(TTS_BIN, TTS_OPTS.concat([clean]), { timeout: 30000 }, function() { resolve(); });
  });
}

// ─── Microphone recording ─────────────────────────────────────────────────────
// termux-microphone-record starts immediately and returns.
// We sleep for the duration then send -q to stop recording.

function record(outFile, durationSecs) {
  return new Promise(function(resolve) {
    // Remove any stale file
    try { fs.unlinkSync(outFile); } catch (_) {}

    var rec = spawn(MIC_BIN, ['-l', String(durationSecs), '-f', outFile], {
      stdio: 'ignore',
      env: Object.assign({}, process.env, { PATH: TERMUX_BIN + ':' + (process.env.PATH || '') }),
    });
    rec.on('error', function() {});

    // Wait the full duration + 0.5s buffer, then stop
    setTimeout(function() {
      execFile(MIC_BIN, ['-q'], {
        env: Object.assign({}, process.env, { PATH: TERMUX_BIN + ':' + (process.env.PATH || '') }),
      }, function() {
        // Small extra wait for file to flush
        setTimeout(function() { resolve(); }, 300);
      });
    }, (durationSecs * 1000) + 500);
  });
}

// ─── Groq Whisper STT ─────────────────────────────────────────────────────────

function transcribe(audioFile) {
  return new Promise(function(resolve) {
    var fileData;
    try {
      fileData = fs.readFileSync(audioFile);
    } catch (_) {
      return resolve('');
    }

    if (fileData.length < 200) return resolve(''); // too small = silence

    var boundary = '----WattsonBoundary' + Date.now();
    var CRLF = '\r\n';

    // Build multipart/form-data body manually (no npm form-data needed)
    var before = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="audio.aac"' + CRLF +
      'Content-Type: audio/aac' + CRLF + CRLF
    );
    var middle = fileData;
    var after = Buffer.from(
      CRLF + '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="model"' + CRLF + CRLF +
      'whisper-large-v3-turbo' + CRLF +
      '--' + boundary + '--' + CRLF
    );

    var body = Buffer.concat([before, middle, after]);

    var req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          resolve(parsed.text || '');
        } catch (_) {
          resolve('');
        }
      });
    });
    req.on('error', function() { resolve(''); });
    req.setTimeout(15000, function() { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

// ─── Ollama chat ──────────────────────────────────────────────────────────────

function askWattson(question) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are Wattson, an autonomous AI running on a Samsung Galaxy Note 9. Answer concisely in 1-2 sentences. You are helpful, direct, and knowledgeable.',
        },
        { role: 'user', content: question },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.7, num_predict: 80 },
      keep_alive: '10m',
    });

    var req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          resolve((parsed.message && parsed.message.content) ? parsed.message.content.trim() : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(20000, function() { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Main listen loop ─────────────────────────────────────────────────────────

async function listenLoop() {
  if (_running) return;
  _running = true;

  log('[daemon] Wattson voice daemon started. Listening for wake word...');
  await speak('Voice daemon online. Say Wattson to activate.');

  while (true) {
    try {
      // Step 1: Record ambient chunk
      await record(CHUNK_FILE, CHUNK_SECS);

      // Step 2: Transcribe
      var transcript = await transcribe(CHUNK_FILE);
      if (transcript) log('[listen] heard: ' + transcript);

      // Step 3: Check for wake word
      if (!transcript || !transcript.toLowerCase().includes('wattson')) continue;

      log('[wake] Wake word detected! Transcript: ' + transcript);

      // Step 4: Acknowledge
      await speak('Yes?');

      // Step 5: Record command
      log('[command] Listening for command...');
      await record(CMD_FILE, COMMAND_SECS);

      // Step 6: Transcribe command
      var command = await transcribe(CMD_FILE);
      log('[command] heard: ' + (command || '(silence)'));

      if (!command || command.trim().length < 3) {
        await speak('I didn\'t catch that. Try again.');
        continue;
      }

      // Step 7: Ask Wattson's brain
      log('[brain] sending to Ollama: ' + command);
      var answer = await askWattson(command);

      if (!answer) {
        await speak('I\'m thinking, but my brain is busy. Try again in a moment.');
        continue;
      }

      log('[response] ' + answer);

      // Step 8: Speak response
      await speak(answer);

    } catch (err) {
      log('[error] ' + err.message);
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

listenLoop().catch(function(err) {
  log('[fatal] ' + err.message);
  process.exit(1);
});
