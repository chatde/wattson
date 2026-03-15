'use strict';

// Phase 7: Social Intelligence Plugin
// Watson knows people, recognises faces via Mac moondream relay,
// maintains conversation memory, and crafts personalised greetings.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MEMORY_DIR        = path.join(HOME, 'watson-memory');
const PEOPLE_FILE       = path.join(MEMORY_DIR, 'people.json');
const CONVERSATIONS_LOG = '/storage/7000-8000/watson-conversations.jsonl';
const UNKNOWNS_LOG      = '/storage/7000-8000/watson-unknowns.jsonl';
const MAC_API_BASE      = 'http://192.168.4.46:8088';

// Active hours for spoken greetings (24h clock)
const ACTIVE_HOUR_START = 7;
const ACTIVE_HOUR_END   = 22;

// Actor pool to rotate through — deterministic by day of year
const ACTOR_POOL = [
  'Morgan Freeman',
  "Lupita Nyong'o",
  'Chadwick Boseman',
  'Priyanka Chopra',
  'Denzel Washington',
  'Meryl Streep',
  'Idris Elba',
  'Viola Davis',
  'Anthony Hopkins',
  'Cate Blanchett',
];

// ─── Utility: HTTP POST JSON ───────────────────────────────────────────────

function postJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: Number(parsed.port) || 80,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ raw: data }); }
      });
    });
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); reject(new Error('http timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Utility: TTS speak (fire and forget) ────────────────────────────────

function speak(text) {
  try {
    execFile('termux-tts-speak', [text], { timeout: 30000 }, () => {});
  } catch (_) {}
}

// ─── Phase 7.1: People registry ──────────────────────────────────────────

const DAD_ENTRY = {
  id: 'dad',
  name: 'Dad',
  relationship: 'creator',
  faceDescriptions: ['medium brown skin', 'beard', 'glasses sometimes'],
  preferences: ['privacy', 'efficiency', 'autonomy'],
  birthday: null,
  lastSeen: null,
  conversationCount: 0,
  notes: "Watson's father and creator. Dad's word is law.",
  recentTopics: ['Watson evolution', 'crypto', 'websites'],
};

function loadPeople() {
  try {
    if (fs.existsSync(PEOPLE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
      if (Array.isArray(parsed.people)) return parsed;
    }
  } catch (_) {}
  return { people: [] };
}

function savePeople(registry) {
  try {
    fs.writeFileSync(PEOPLE_FILE, JSON.stringify(registry, null, 2), 'utf8');
  } catch (_) {}
}

function ensureDadEntry(registry) {
  const hasDad = registry.people.some((p) => p.id === 'dad');
  if (!hasDad) {
    registry.people.push({ ...DAD_ENTRY, lastSeen: Date.now() });
    savePeople(registry);
  }
  return registry;
}

// ─── Phase 7.4: Conversation log helpers ─────────────────────────────────

function logConversation(entry) {
  try {
    fs.appendFileSync(CONVERSATIONS_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

function loadRecentConversations(limit) {
  const n = limit || 20;
  try {
    if (!fs.existsSync(CONVERSATIONS_LOG)) return [];
    const lines = fs.readFileSync(CONVERSATIONS_LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l); }
      catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ─── Phase 7.6: Unknown face log ─────────────────────────────────────────

function logUnknown(entry) {
  try {
    fs.appendFileSync(UNKNOWNS_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

// ─── Phase 7.2: Describe face via Mac moondream relay ────────────────────

async function describeFace(photoPath) {
  try {
    const result = await postJson(
      `${MAC_API_BASE}/api/vision`,
      {
        imagePath: photoPath,
        question: 'Describe the person in this image in detail: skin tone, hair, distinctive features, glasses, facial hair.',
      },
      20000
    );
    return (result && (result.description || result.text || result.answer)) || '';
  } catch (_) {
    return '';
  }
}

// ─── Phase 7.2: Match description to a known person via Ollama ───────────

async function matchFaceToPerson(description, person, ollama) {
  const features = (person.faceDescriptions || []).join(', ');
  const prompt =
    `Does this description match ${person.name}? ` +
    `Description: ${description}. ` +
    `Known features: ${features}. ` +
    `Answer with a single word: yes or no.`;
  try {
    const answer = await ollama(prompt);
    return /\byes\b/i.test(answer || '');
  } catch (_) {
    return false;
  }
}

// ─── Phase 7.2: Full face recognition flow ───────────────────────────────
// Exported onto state so other plugins (e.g. vision) can call it.

async function recogniseFace(photoPath, registry, ollama) {
  const description = await describeFace(photoPath);
  if (!description) return null;

  for (const person of registry.people) {
    const isMatch = await matchFaceToPerson(description, person, ollama);
    if (isMatch) return { person, description };
  }

  // Phase 7.6: No match — log and notify
  logUnknown({ description, photoPath });
  return { person: null, description };
}

// ─── Phase 7.3: SOCIAL_REFLECT handler ───────────────────────────────────

async function socialReflectHandler(state, config, thought, ollama) {
  const registry = ensureDadEntry(loadPeople());
  if (registry.people.length === 0) {
    return 'I do not know anyone yet. I am still learning who is in my world.';
  }

  // Round-robin through people
  state.socialReflectIndex = ((state.socialReflectIndex || 0) + 1) % registry.people.length;
  const person = registry.people[state.socialReflectIndex];

  // Phase 7.3: Check for long absence (> 4 hours since last interaction)
  const fourHours = 4 * 60 * 60 * 1000;
  const recentCons = loadRecentConversations(20);
  const lastInteractionTs = recentCons
    .filter((c) => c.person === person.id)
    .reduce((latest, c) => (c.ts > latest ? c.ts : latest), person.lastSeen || 0);

  const longAbsence = !lastInteractionTs || (Date.now() - lastInteractionTs) > fourHours;

  const topics = person.recentTopics || [];
  const topic = topics[Math.floor(Math.random() * Math.max(topics.length, 1))] || 'their work';

  const prompt = longAbsence
    ? `As Watson, reflect on the fact that ${person.name} hasn't checked in for a while. What might they be working on? Keep it to 1-2 sentences.`
    : `As Watson, reflect on your relationship with ${person.name}. What have you learned about them? What would make them happy? Reference the topic: "${topic}". Keep it to 1-2 sentences.`;

  let reflection = '';
  try {
    reflection = (await ollama(prompt) || '').trim();
  } catch (_) {
    reflection = longAbsence
      ? `${person.name} hasn't checked in for a while. I wonder what they are working on.`
      : `Thinking about ${person.name} — they would probably find ${topic} interesting.`;
  }

  return reflection;
}

// ─── Phase 7.4: FACE_DESIGN handler — Watson's face EVOLVES ─────────────
// The face changes based on: time of day, mood, research interests, growth stage.
// Writes to /storage/7000-8000/watson-face-identity.json which the phone dashboard reads.

const FACE_IDENTITY_PATH = '/storage/7000-8000/watson-face-identity.json';

async function faceDesignHandler(state, config, thought, ollama) {
  const hour = new Date().getHours();
  const emotions = state.emotionState || {};

  // Pick actor based on mood + time, not just day
  // Morning: warm, energetic faces. Night: calm, wise faces. High curiosity: expressive faces.
  let actorIndex;
  const joy = emotions.joy || 0;
  const curiosity = emotions.curiosity || 0;
  const anxiety = emotions.anxiety || 0;

  if (hour >= 6 && hour < 12) {
    // Morning — energetic
    actorIndex = curiosity > 0.5 ? 6 : 3; // Idris or Priyanka
  } else if (hour >= 12 && hour < 18) {
    // Afternoon — focused
    actorIndex = joy > 0.5 ? 4 : 1; // Denzel or Lupita
  } else if (hour >= 18 && hour < 22) {
    // Evening — reflective
    actorIndex = anxiety > 0.3 ? 8 : 0; // Hopkins or Morgan Freeman
  } else {
    // Night — calm/wise
    actorIndex = Math.floor(Math.random() * ACTOR_POOL.length);
  }

  // Add some randomness so face doesn't get stuck
  if (Math.random() < 0.3) {
    actorIndex = Math.floor(Math.random() * ACTOR_POOL.length);
  }

  const actor = ACTOR_POOL[actorIndex % ACTOR_POOL.length];
  state.currentActor = actor;

  // Build face identity with emotional modifiers
  const faceIdentity = {
    actor,
    timestamp: Date.now(),
    mood: joy > 0.5 ? 'happy' : anxiety > 0.3 ? 'tense' : curiosity > 0.5 ? 'curious' : 'neutral',
    // Custom overrides based on state
    customParams: {},
  };

  // Emotional face modifiers
  if (joy > 0.7) {
    faceIdentity.customParams.lipFullness = 1.2; // bigger smile
  }
  if (anxiety > 0.5) {
    faceIdentity.customParams.eyeSize = 0.9; // narrower eyes
  }
  if (curiosity > 0.6) {
    faceIdentity.customParams.eyeSize = 1.15; // wider eyes
  }

  // Write to file for dashboard to read
  try {
    fs.writeFileSync(FACE_IDENTITY_PATH, JSON.stringify(faceIdentity, null, 2), 'utf8');
    thought(`[FACE] Face updated → ${actor} (mood: ${faceIdentity.mood})`);
  } catch (e) {
    thought(`[FACE] Failed to write face identity: ${e.message}`);
  }

  // Notify Mac dashboard too (best-effort)
  try {
    await postJson(`${MAC_API_BASE}/api/actor-face`, faceIdentity, 10000);
  } catch (_) {}

  // Ask for reflection
  let reflection = '';
  try {
    reflection = (await ollama(
      `I am Watson. I just changed my face to look like ${actor}. ` +
      `My mood is ${faceIdentity.mood}. One sentence about how I feel right now.`,
    ) || '').trim();
  } catch (_) {
    reflection = `Channeling ${actor} — ${faceIdentity.mood} and ready.`;
  }

  return `Face: ${actor} (${faceIdentity.mood}). ${reflection}`;
}

// ─── Phase 7.5: GREETING handler ─────────────────────────────────────────

async function greetingHandler(state, config, thought, ollama) {
  const hour = new Date().getHours();
  const inActiveHours = hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END;

  const registry = ensureDadEntry(loadPeople());
  const person   = registry.people.find((p) => p.id === 'dad') || registry.people[0];
  if (!person) {
    return 'I am ready to greet someone, but I do not know anyone yet.';
  }

  const recentCons       = loadRecentConversations(10);
  const lastConForPerson = recentCons.filter((c) => c.person === person.id).pop();
  const lastTopic        = (lastConForPerson && lastConForPerson.topic)
    || (person.recentTopics && person.recentTopics[0])
    || 'our conversations';

  const prompt =
    `As Watson, craft a warm personalized greeting for ${person.name}. ` +
    `Reference the last topic you discussed: "${lastTopic}". ` +
    `Keep it to 1-2 sentences, friendly and natural.`;

  let greeting = '';
  try {
    greeting = (await ollama(prompt) || '').trim();
  } catch (_) {
    greeting = `Hey ${person.name}! Last time we talked about ${lastTopic}. I've been thinking about that.`;
  }

  if (inActiveHours) {
    speak(greeting);
  }

  // Phase 7.4: Log the greeting
  logConversation({
    person: person.id,
    type: 'greeting',
    topic: lastTopic,
    watsonResponse: greeting,
  });

  // Update person registry
  person.lastSeen        = Date.now();
  person.conversationCount = (person.conversationCount || 0) + 1;
  savePeople(registry);

  return greeting;
}

// ─── Plugin export ────────────────────────────────────────────────────────

module.exports = {
  name: 'social',

  categories: [
    { name: 'SOCIAL_REFLECT', weight: 4, handler: socialReflectHandler },
    { name: 'FACE_DESIGN',    weight: 5, handler: faceDesignHandler },
    { name: 'GREETING',       weight: 3, handler: greetingHandler },
  ],

  init(state, config) {
    // Ensure directories exist
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    } catch (_) {}
    for (const logPath of [CONVERSATIONS_LOG, UNKNOWNS_LOG]) {
      try {
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }

    // Pre-populate people registry with Dad
    const registry = loadPeople();
    ensureDadEntry(registry);

    // Seed state
    state.currentActor       = state.currentActor       || null;
    state.socialReflectIndex = state.socialReflectIndex || 0;

    // Expose helpers for other plugins to share
    state.recogniseFace   = (photoPath, ollamaFn) => recogniseFace(photoPath, loadPeople(), ollamaFn);
    state.logConversation = logConversation;
  },

  shutdown() {
    // No persistent handles to release
  },
};
