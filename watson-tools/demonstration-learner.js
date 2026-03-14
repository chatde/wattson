'use strict';
// demonstration-learner.js — Learn from demonstrations + ambient audio
// Phase 16: Record & Replay + Bumblebee audio learning
//
// Two modes:
// 1. DEMONSTRATION: Dad does a task while Watson watches → extract lesson
// 2. BUMBLEBEE: Continuously sample mic → learn what ads/music/silence sound like
//    → build audio vocabulary for real-time awareness

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const pe = require('./perception-engine.js');
const obsidian = require('./obsidian-sync.js');

const HOME = (() => {
  const raw = process.env.HOME || '/data/data/com.termux/files/home';
  return raw.includes('files/home') ? raw : path.join(raw, 'files/home');
})();

const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const DEMO_DIR = path.join(HOME, 'watson-demos');
const AUDIO_SAMPLES_DIR = '/sdcard/watson-audio-samples';
const AUDIO_JOURNAL = path.join(HOME, 'watson-audio-journal.jsonl');

// ─── Shell helpers ──────────────────────────────────────────────────────────

function spawnAsync(bin, args, timeoutMs) {
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

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: DEMONSTRATION LEARNING (Record & Replay)
// ═══════════════════════════════════════════════════════════════════════════

// Start recording a demonstration — take screenshots at 1fps
async function startDemoRecording(taskName, config, thought) {
  try { fs.mkdirSync(DEMO_DIR, { recursive: true }); } catch {}

  const sessionId = `demo-${Date.now()}`;
  const sessionDir = path.join(DEMO_DIR, sessionId);
  try { fs.mkdirSync(sessionDir, { recursive: true }); } catch {}

  if (thought) thought(`[DEMO] Recording demonstration: "${taskName}"`);

  const frames = [];
  let recording = true;

  // Return a controller object
  return {
    sessionId,
    sessionDir,

    // Capture a frame (call this in a loop at ~1fps)
    async captureFrame() {
      if (!recording) return null;
      const frameNum = frames.length;
      const framePath = `/sdcard/watson-demo-frame-${frameNum}.png`;
      const shot = await pe.takeScreenshot(framePath);
      if (!shot.ok) return null;

      const frame = {
        num: frameNum,
        ts: Date.now(),
        path: framePath,
        base64: shot.base64,
      };
      frames.push(frame);
      return frame;
    },

    // Stop recording and analyze
    async stopAndAnalyze() {
      recording = false;
      if (thought) thought(`[DEMO] Captured ${frames.length} frames. Analyzing...`);

      // Analyze each frame with Moondream
      const analyzedFrames = [];
      for (const frame of frames) {
        if (!frame.base64) continue;

        // Unload mind, analyze with Moondream
        if (config && config.ollamaModel) {
          await pe.unloadModel(config.ollamaModel);
          await pe.sleep(500);
        }

        const description = await pe.callMoondream(
          frame.base64,
          'Describe this phone screen in detail. What app is showing? ' +
          'What text, buttons, and interactive elements are visible? ' +
          'What is the user looking at or about to interact with?',
          200,
        );

        analyzedFrames.push({
          ...frame,
          description,
          screenState: pe.classifyScreenState(description),
          base64: undefined, // Don't store base64 in analysis
        });
      }

      // Detect transitions (screen state changes between frames)
      const transitions = detectTransitions(analyzedFrames);

      // Build lesson from transitions
      const lesson = buildLessonFromTransitions(taskName, transitions);

      // Write to Obsidian
      if (lesson.steps.length > 0) {
        const appName = inferAppFromFrames(analyzedFrames);
        obsidian.writeLesson(appName || 'unknown', taskName, lesson.steps, {
          ok: true,
          durationMs: frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0,
          notes: `Learned from demonstration recording (${frames.length} frames, ${transitions.length} transitions)`,
        });
      }

      // Cleanup frame files
      for (const frame of frames) {
        try { fs.unlinkSync(frame.path); } catch {}
      }

      return { lesson, transitions, frameCount: frames.length };
    },

    getFrameCount() { return frames.length; },
  };
}

function detectTransitions(frames) {
  const transitions = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];
    if (prev.screenState !== curr.screenState || descriptionsDiffer(prev.description, curr.description)) {
      transitions.push({
        fromFrame: i - 1,
        toFrame: i,
        fromState: prev.screenState,
        toState: curr.screenState,
        fromDesc: prev.description,
        toDesc: curr.description,
        timeDelta: curr.ts - prev.ts,
      });
    }
  }
  return transitions;
}

function descriptionsDiffer(a, b) {
  // Simple heuristic: if less than 50% of words overlap, screens are different
  const wordsA = new Set((a || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set((b || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return true;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size) < 0.5;
}

function buildLessonFromTransitions(taskName, transitions) {
  const steps = transitions.map((t, i) => {
    // Infer action from transition
    let action = 'unknown action';
    if (t.toState === 'search' && t.fromState !== 'search') action = 'navigated to search';
    else if (t.toState === 'player' && t.fromState !== 'player') action = 'started playback';
    else if (t.toState === 'home') action = 'navigated to home';
    else if (t.toState === 'station_list') action = 'opened station list';
    else if (t.fromState === 'ad') action = 'dismissed ad';
    else if (t.fromState === 'dialog') action = 'dismissed dialog';
    else action = `transitioned from ${t.fromState} to ${t.toState}`;

    return {
      action,
      details: `Frame ${t.fromFrame}→${t.toFrame} (${t.timeDelta}ms)`,
      coordinates: null,
      expected: t.toState,
      actual: t.toState,
      worked: true,
    };
  });

  return { taskName, steps };
}

function inferAppFromFrames(frames) {
  // Look for app names in descriptions
  const appKeywords = {
    pandora: 'pandora',
    spotify: 'spotify',
    youtube: 'youtube',
    chrome: 'chrome',
    settings: 'settings',
  };
  for (const frame of frames) {
    const desc = (frame.description || '').toLowerCase();
    for (const [app, keyword] of Object.entries(appKeywords)) {
      if (desc.includes(keyword)) return app;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: BUMBLEBEE AUDIO LEARNING
// ═══════════════════════════════════════════════════════════════════════════
// Like Bumblebee from Transformers — learn to recognize sounds:
// - Ad voices (speech patterns, specific cadence)
// - Music (sustained tones, rhythm, melody)
// - Silence (background noise only)
// - UI sounds (clicks, notifications)
// Over time, Watson builds audio awareness without needing explicit labels.

async function sampleMicrophone(durationMs) {
  try { fs.mkdirSync(AUDIO_SAMPLES_DIR, { recursive: true }); } catch {}

  const samplePath = path.join(AUDIO_SAMPLES_DIR, `sample-${Date.now()}.wav`);
  const durationSec = Math.min(Math.ceil((durationMs || 2000) / 1000), 5);

  // Record using termux-microphone-record (2-5 second samples)
  const record = await spawnAsync(
    'termux-microphone-record',
    ['-f', samplePath, '-l', String(durationSec), '-r', '16000', '-c', '1'],
    (durationSec + 3) * 1000,
  );

  if (!record.ok || !fs.existsSync(samplePath)) {
    return { ok: false, path: null, analysis: null };
  }

  // Analyze the audio sample
  const analysis = await analyzeAudioSample(samplePath);

  return { ok: true, path: samplePath, analysis };
}

async function analyzeAudioSample(samplePath) {
  // Get file stats for amplitude estimation
  const stats = fs.statSync(samplePath);
  const fileSizeKB = stats.size / 1024;

  // Read raw audio data for amplitude analysis
  let amplitude = 0;
  let isSilent = false;
  let hasVoice = false;
  let hasMusic = false;

  try {
    const buffer = fs.readFileSync(samplePath);
    // WAV header is 44 bytes, rest is PCM data (16-bit signed, mono, 16kHz)
    const pcmData = buffer.slice(44);

    if (pcmData.length > 0) {
      // Calculate RMS amplitude
      let sumSquares = 0;
      let zeroCrossings = 0;
      let prevSample = 0;
      const sampleCount = Math.floor(pcmData.length / 2);

      for (let i = 0; i < pcmData.length - 1; i += 2) {
        const sample = pcmData.readInt16LE(i);
        sumSquares += sample * sample;
        if ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0)) {
          zeroCrossings++;
        }
        prevSample = sample;
      }

      amplitude = Math.sqrt(sumSquares / sampleCount);
      const zeroCrossingRate = zeroCrossings / sampleCount;

      // Heuristic classification based on audio features:
      // - Silence: very low amplitude (<500 RMS)
      // - Voice/speech: medium amplitude, high zero-crossing rate (>0.1)
      // - Music: medium-high amplitude, moderate zero-crossing rate (0.02-0.1)
      isSilent = amplitude < 500;
      hasVoice = !isSilent && zeroCrossingRate > 0.1;
      hasMusic = !isSilent && zeroCrossingRate > 0.02 && zeroCrossingRate <= 0.1;
    }
  } catch {}

  // Classify what we're hearing
  let audioType = 'unknown';
  if (isSilent) audioType = 'silence';
  else if (hasVoice && !hasMusic) audioType = 'speech'; // likely an ad or podcast
  else if (hasMusic && !hasVoice) audioType = 'music';
  else if (hasVoice && hasMusic) audioType = 'mixed'; // song with vocals or ad with background music

  const analysis = {
    audioType,
    amplitude: Math.round(amplitude),
    isSilent,
    hasVoice,
    hasMusic,
    fileSizeKB: Math.round(fileSizeKB),
    ts: Date.now(),
  };

  // Log to audio journal
  try {
    fs.appendFileSync(AUDIO_JOURNAL, JSON.stringify(analysis) + '\n');
  } catch {}

  return analysis;
}

// Check if audio is currently playing (quick amplitude check)
async function isAudioPlaying() {
  const sample = await sampleMicrophone(1000); // 1 second
  if (!sample.ok || !sample.analysis) return { playing: false, type: 'unknown' };

  // Clean up the sample file to save storage
  try { if (sample.path) fs.unlinkSync(sample.path); } catch {}

  return {
    playing: !sample.analysis.isSilent,
    type: sample.analysis.audioType,
    amplitude: sample.analysis.amplitude,
  };
}

// Detect if an ad is playing (speech pattern without music)
async function isAdPlaying() {
  const audio = await isAudioPlaying();
  return {
    isAd: audio.playing && audio.type === 'speech',
    isMusic: audio.playing && (audio.type === 'music' || audio.type === 'mixed'),
    ...audio,
  };
}

// Get audio state summary (for use in perception decisions)
async function getAudioState() {
  // Check dumpsys media_session for playback state
  const media = await pe.checkMediaState();

  // Also sample mic for ambient awareness
  const audio = await isAudioPlaying();

  return {
    mediaSessionPlaying: media.playing,
    song: media.song,
    artist: media.artist,
    micDetectsAudio: audio.playing,
    audioType: audio.type,
    amplitude: audio.amplitude,
    // Cross-reference: if media says playing but mic detects speech, it's probably an ad
    likelyAd: media.playing && audio.type === 'speech',
    // If media says playing and mic detects music, actual music is playing
    likelyMusic: media.playing && (audio.type === 'music' || audio.type === 'mixed'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: LEARN → COMPRESS → DELETE (Bumblebee memory consolidation)
// ═══════════════════════════════════════════════════════════════════════════
// Raw audio files are temporary. Watson analyzes them, extracts knowledge
// (amplitude signatures, zero-crossing patterns, audio type classifications),
// compresses that into a learned model file, then deletes the raw WAV.
// Like how a brain consolidates experiences into memory during sleep.

const AUDIO_KNOWLEDGE_FILE = path.join(HOME, 'watson-audio-knowledge.json');

function loadAudioKnowledge() {
  try {
    return JSON.parse(fs.readFileSync(AUDIO_KNOWLEDGE_FILE, 'utf8'));
  } catch {
    return {
      profiles: {
        silence:  { avgAmplitude: 200, avgZeroCrossing: 0.01, sampleCount: 0 },
        speech:   { avgAmplitude: 3000, avgZeroCrossing: 0.15, sampleCount: 0 },
        music:    { avgAmplitude: 5000, avgZeroCrossing: 0.06, sampleCount: 0 },
        mixed:    { avgAmplitude: 4000, avgZeroCrossing: 0.12, sampleCount: 0 },
      },
      totalSamplesLearned: 0,
      lastUpdated: null,
    };
  }
}

function saveAudioKnowledge(knowledge) {
  knowledge.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AUDIO_KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2), 'utf8');
}

// Learn from a sample, update knowledge, delete raw file
async function learnFromAudioSample(samplePath, analysis) {
  if (!analysis || !analysis.audioType || analysis.audioType === 'unknown') return;

  const knowledge = loadAudioKnowledge();
  const profile = knowledge.profiles[analysis.audioType];
  if (!profile) return;

  // Running average — each new sample nudges the profile
  // Formula: new_avg = (old_avg * count + new_value) / (count + 1)
  const n = profile.sampleCount;
  profile.avgAmplitude = Math.round((profile.avgAmplitude * n + analysis.amplitude) / (n + 1));
  // Zero crossing isn't stored per-sample, but we can track general direction
  profile.sampleCount = n + 1;
  knowledge.totalSamplesLearned++;

  saveAudioKnowledge(knowledge);

  // Delete the raw file — knowledge is now compressed into the profile
  try { if (samplePath) fs.unlinkSync(samplePath); } catch {}
}

// Batch learn: analyze all pending samples, learn, delete
async function consolidateAudioMemory() {
  try {
    const files = fs.readdirSync(AUDIO_SAMPLES_DIR).filter(f => f.endsWith('.wav'));
    let learned = 0;

    for (const file of files) {
      const filepath = path.join(AUDIO_SAMPLES_DIR, file);
      const analysis = await analyzeAudioSample(filepath);
      await learnFromAudioSample(filepath, analysis);
      learned++;
    }

    return { learned, total: loadAudioKnowledge().totalSamplesLearned };
  } catch { return { learned: 0, total: 0 }; }
}

// Use learned knowledge to classify audio faster (no mic needed if pattern matches)
function classifyWithKnowledge(amplitude) {
  const knowledge = loadAudioKnowledge();
  let bestMatch = 'unknown';
  let bestDistance = Infinity;

  for (const [type, profile] of Object.entries(knowledge.profiles)) {
    if (profile.sampleCount < 3) continue; // Need at least 3 samples to trust
    const distance = Math.abs(amplitude - profile.avgAmplitude);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = type;
    }
  }

  return { type: bestMatch, confidence: bestDistance < 1000 ? 'high' : bestDistance < 3000 ? 'medium' : 'low' };
}

// Cleanup old audio samples — but learn first before deleting!
async function cleanupAudioSamples() {
  // First, consolidate any unlearned samples
  await consolidateAudioMemory();

  // Then clean up any stragglers
  try {
    const files = fs.readdirSync(AUDIO_SAMPLES_DIR)
      .filter(f => f.endsWith('.wav'))
      .map(f => ({ name: f, path: path.join(AUDIO_SAMPLES_DIR, f), mtime: fs.statSync(path.join(AUDIO_SAMPLES_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    // Keep latest 5 (for debugging), delete rest
    for (let i = 5; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
  } catch {}
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  // Demonstration learning
  startDemoRecording,

  // Bumblebee audio learning
  sampleMicrophone,
  analyzeAudioSample,
  isAudioPlaying,
  isAdPlaying,
  getAudioState,

  // Learn → compress → delete cycle
  learnFromAudioSample,
  consolidateAudioMemory,
  classifyWithKnowledge,
  loadAudioKnowledge,
  cleanupAudioSamples,

  // Constants
  DEMO_DIR,
  AUDIO_SAMPLES_DIR,
  AUDIO_KNOWLEDGE_FILE,
};
