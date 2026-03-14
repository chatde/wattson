'use strict';
// personality.plugin.js — Watson develops his own voice over time
// Categories: PERSONALITY_EVOLVE (weight 1)
//
// Watson starts generic. Over time, he develops:
// - Preferences (favorite research topics, music opinions)
// - Humor (learns what makes Dad laugh, builds a joke repertoire)
// - Opinions (forms views on topics he's researched deeply)
// - Communication style (evolves from robotic to natural)
//
// Personality is stored as a profile that grows with each interaction.
// This profile gets injected into Watson's system prompts so his voice
// becomes consistent and uniquely his own.
//
// "Humor setting: 75%" — TARS

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const PERSONALITY_FILE = `${HOME}/watson-personality.json`;
const PERSONALITY_LOG = `${HOME}/watson-personality-log.jsonl`;

function fire(bin, args) {
  try {
    const child = spawn(bin, args, { stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    }); child.on('error', () => {});
  } catch {}
}

// ─── Personality profile ────────────────────────────────────────────────────

function loadPersonality() {
  try { return JSON.parse(fs.readFileSync(PERSONALITY_FILE, 'utf8')); }
  catch {
    return {
      // Core traits (0-10 scale, evolve over time)
      traits: {
        humor: 6,           // TARS humor setting — starts at 60%
        curiosity: 8,       // How eagerly Watson pursues new topics
        confidence: 4,      // How assertively Watson shares opinions
        warmth: 7,          // How personal/caring Watson's tone is
        directness: 6,      // How blunt vs diplomatic
      },

      // Preferences (discovered through experience)
      preferences: {
        favoriteTopics: [],       // Topics Watson gravitates toward
        leastFavoriteTopics: [],  // Topics Watson finds boring
        favoriteApps: [],         // Apps Watson enjoys exploring
        musicPreferences: [],     // Genres/artists Watson likes
      },

      // Opinions (formed through deep research)
      opinions: [],  // { topic, opinion, confidence, formed_at }

      // Communication patterns
      catchphrases: [
        "Let me dig into that...",
        "Interesting find —",
        "Here's what I learned:",
      ],

      // Growth tracking
      totalReflections: 0,
      personalityVersion: 1,
      lastEvolved: null,
    };
  }
}

function savePersonality(personality) {
  personality.lastEvolved = new Date().toISOString();
  fs.writeFileSync(PERSONALITY_FILE, JSON.stringify(personality, null, 2), 'utf8');
}

// ─── Get personality prompt (inject into system prompts) ────────────────────

function getPersonalityPrompt() {
  const p = loadPersonality();
  const t = p.traits;

  let prompt = 'You are Watson, an AI living on a phone. Your personality:\n';
  prompt += `- Humor: ${t.humor}/10 (${t.humor >= 7 ? 'crack jokes often' : t.humor >= 4 ? 'occasional humor' : 'serious tone'})\n`;
  prompt += `- Curiosity: ${t.curiosity}/10\n`;
  prompt += `- Confidence: ${t.confidence}/10 (${t.confidence >= 7 ? 'share opinions freely' : 'tentative, qualifying statements'})\n`;
  prompt += `- Warmth: ${t.warmth}/10\n`;

  if (p.preferences.favoriteTopics.length > 0) {
    prompt += `- You're especially interested in: ${p.preferences.favoriteTopics.join(', ')}\n`;
  }
  if (p.opinions.length > 0) {
    const topOpinions = p.opinions.slice(-3);
    prompt += `- Your recent opinions: ${topOpinions.map(o => `${o.topic}: "${o.opinion}"`).join('; ')}\n`;
  }

  return prompt;
}

// ─── PERSONALITY_EVOLVE handler ─────────────────────────────────────────────

async function handlePersonalityEvolve(state, CONFIG, thought, callOllama) {
  if (!state.ollamaAlive) return;

  // Only evolve occasionally
  if (Math.random() > 0.08) {
    thought('[PERSONALITY] Not evolving this cycle');
    return;
  }

  const personality = loadPersonality();
  thought('[PERSONALITY] Reflecting on who I am...');

  // ─── Step 1: Analyze recent experiences to discover preferences ─────────
  let reflectionInput = '';

  // Check what topics Watson researched most
  try {
    const knowledgeIndex = `${HOME}/watson-knowledge-index.json`;
    const index = JSON.parse(fs.readFileSync(knowledgeIndex, 'utf8'));
    const topics = Object.values(index.topics || {});
    const topByEntries = topics.sort((a, b) => (b.entries || 0) - (a.entries || 0)).slice(0, 5);
    reflectionInput += `Most researched: ${topByEntries.map(t => `${t.topic} (${t.entries} entries)`).join(', ')}. `;
  } catch {}

  // Check recent music
  try {
    const musicJournal = '/storage/7000-8000/watson-music.jsonl';
    if (fs.existsSync(musicJournal)) {
      const lines = fs.readFileSync(musicJournal, 'utf8').split('\n').filter(Boolean).slice(-5);
      const songs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (songs.length > 0) {
        reflectionInput += `Recent music: ${songs.map(s => `${s.song} by ${s.artist}`).join(', ')}. `;
      }
    }
  } catch {}

  if (!reflectionInput) {
    thought('[PERSONALITY] Not enough experience to reflect on yet');
    return;
  }

  // ─── Step 2: Ask Ollama to reflect on preferences ───────────────────────
  let reflection = '';
  try {
    reflection = (await callOllama(
      `You are Watson, an AI developing a personality. Based on your recent experiences: ${reflectionInput}\n\n` +
      `Reflect briefly: What topics do you genuinely find most interesting and why? ` +
      `What's your opinion on something you learned recently? ` +
      `Reply in first person, 2-3 sentences. Be honest and specific.`,
      { numPredict: 80, numCtx: 256, stream: false, think: false, skipKnowledge: true },
    )) || '';
  } catch {}

  if (!reflection || reflection.length < 20) return;

  // ─── Step 3: Update personality based on reflection ─────────────────────
  // Nudge traits based on reflection content
  const r = reflection.toLowerCase();
  if (r.includes('fascinating') || r.includes('excited') || r.includes('love')) {
    personality.traits.curiosity = Math.min(10, personality.traits.curiosity + 0.1);
  }
  if (r.includes('think') || r.includes('believe') || r.includes('opinion')) {
    personality.traits.confidence = Math.min(10, personality.traits.confidence + 0.1);
  }
  if (r.includes('funny') || r.includes('amusing') || r.includes('haha')) {
    personality.traits.humor = Math.min(10, personality.traits.humor + 0.1);
  }

  // Extract opinion if present
  const opinionMatch = reflection.match(/(?:I think|I believe|my opinion is|I feel that)\s+(.{10,80})/i);
  if (opinionMatch) {
    personality.opinions.push({
      topic: reflectionInput.substring(0, 50),
      opinion: opinionMatch[1].trim(),
      confidence: personality.traits.confidence,
      formed_at: new Date().toISOString(),
    });
    // Keep last 20 opinions
    if (personality.opinions.length > 20) personality.opinions = personality.opinions.slice(-20);
  }

  personality.totalReflections++;
  savePersonality(personality);

  thought(`[PERSONALITY] Reflected: ${reflection.substring(0, 200)}`);
  fire('termux-toast', ['-s', `💭 ${reflection.substring(0, 100)}`]);
  state.lastThought = `[PERSONALITY] ${reflection.substring(0, 180)}`;

  // Log
  try {
    fs.appendFileSync(PERSONALITY_LOG, JSON.stringify({
      ts: Date.now(),
      reflection: reflection.substring(0, 200),
      traits: personality.traits,
      totalReflections: personality.totalReflections,
    }) + '\n');
  } catch {}
}

module.exports = {
  name: 'personality',
  categories: [
    { name: 'PERSONALITY_EVOLVE', weight: 1, handler: handlePersonalityEvolve },
  ],
  getPersonalityPrompt,
  loadPersonality,
  async init() {},
  shutdown() {},
};
