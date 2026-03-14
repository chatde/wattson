'use strict';
// curiosity.plugin.js — Watson discovers new research topics organically
// Categories: CURIOSITY_ENGINE (weight 4)
//
// Instead of hardcoded research topics, Watson reads what he's already learned,
// finds questions he can't answer, and generates new research directions.
// Every article he reads spawns 2-3 new questions. Rabbit holes emerge naturally.
// This is how real learning works — curiosity begets curiosity.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const CURIOSITY_LOG = `${HOME}/watson-curiosity.jsonl`;
const DYNAMIC_TOPICS_FILE = `${HOME}/watson-research-topics-dynamic.json`;
const QUESTIONS_FILE = `${HOME}/watson-open-questions.json`;

function fire(bin, args) {
  try {
    const child = spawn(bin, args, { stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    }); child.on('error', () => {});
  } catch {}
}

function showThinking(msg) {
  fire('termux-toast', ['-s', (msg || '').substring(0, 120)]);
}

// ─── Open questions Watson wants to answer ──────────────────────────────────

function loadOpenQuestions() {
  try { return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveOpenQuestions(questions) {
  // Keep max 100 questions, remove oldest
  const trimmed = questions.slice(-100);
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

function loadDynamicTopics() {
  try { return JSON.parse(fs.readFileSync(DYNAMIC_TOPICS_FILE, 'utf8')); }
  catch { return []; }
}

function saveDynamicTopics(topics) {
  fs.writeFileSync(DYNAMIC_TOPICS_FILE, JSON.stringify(topics, null, 2), 'utf8');
}

// ─── Read a random knowledge file to spawn new questions ────────────────────

function pickRandomKnowledgeFile() {
  try {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    if (files.length === 0) return null;
    const picked = files[Math.floor(Math.random() * files.length)];
    return {
      filename: picked,
      content: fs.readFileSync(path.join(KNOWLEDGE_DIR, picked), 'utf8'),
    };
  } catch { return null; }
}

// ─── CURIOSITY_ENGINE handler ───────────────────────────────────────────────

async function handleCuriosityEngine(state, CONFIG, thought, callOllama) {
  if (!state.ollamaAlive) {
    thought('[CURIOSITY] Ollama offline — skipping');
    return;
  }

  const file = pickRandomKnowledgeFile();
  if (!file) {
    thought('[CURIOSITY] No knowledge files yet — need to research first');
    return;
  }

  showThinking(`🔍 Curiosity: re-reading ${file.filename.replace('.md', '')}...`);
  thought(`[CURIOSITY] Re-reading "${file.filename}" to find new questions...`);

  // Ask Ollama to generate follow-up questions from existing knowledge
  let questionsRaw = '';
  try {
    const prompt = `You are Watson, an AI researcher. You previously researched a topic and here's what you know:

${file.content.substring(0, 1500)}

Based on this knowledge, what are 3 NEW specific questions you'd want to research next? Focus on:
- Things mentioned but not explained
- Deeper "why" and "how" questions
- Connections to other fields
- Recent developments you'd want to check

Reply as a JSON array of objects with "question" and "domain" fields. Example:
[{"question":"how does X work in practice","domain":"ai-ml"}]`;

    questionsRaw = (await callOllama(prompt, {
      numPredict: 200, numCtx: 512, stream: false, think: false,
    })) || '';
  } catch {}

  if (!questionsRaw || questionsRaw.length < 20) {
    thought('[CURIOSITY] No questions generated');
    return;
  }

  // Parse questions
  let newQuestions = [];
  try {
    const jsonMatch = questionsRaw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      newQuestions = JSON.parse(jsonMatch[0]).filter(q => q.question && q.domain);
    }
  } catch {}

  if (newQuestions.length === 0) {
    thought('[CURIOSITY] Could not parse questions');
    return;
  }

  // Add to open questions list
  const openQuestions = loadOpenQuestions();
  const existingQs = new Set(openQuestions.map(q => q.question.toLowerCase()));

  const added = [];
  for (const q of newQuestions) {
    if (!existingQs.has(q.question.toLowerCase())) {
      openQuestions.push({
        question: q.question,
        domain: q.domain,
        source: file.filename,
        ts: Date.now(),
        answered: false,
      });
      added.push(q);
    }
  }
  saveOpenQuestions(openQuestions);

  // Convert questions to research topics
  if (added.length > 0) {
    const dynamicTopics = loadDynamicTopics();
    const existingTopics = new Set(dynamicTopics.map(t => t.topic.toLowerCase()));

    for (const q of added) {
      if (!existingTopics.has(q.question.toLowerCase())) {
        dynamicTopics.push({
          domain: q.domain,
          topic: q.question,
          depth: 0,
          source: 'curiosity-engine',
        });
      }
    }
    saveDynamicTopics(dynamicTopics);
  }

  const msg = `[CURIOSITY] From "${file.filename.replace('.md', '')}": spawned ${added.length} new questions → ` +
    added.map(q => `"${q.question.substring(0, 50)}"`).join(', ');
  showThinking(`❓ ${added.length} new questions from ${file.filename.replace('.md', '')}`);
  thought(msg);
  state.lastThought = msg.substring(0, 200);

  // Log
  try {
    fs.appendFileSync(CURIOSITY_LOG, JSON.stringify({
      ts: Date.now(), source: file.filename, questionsGenerated: added.length,
      questions: added.map(q => q.question.substring(0, 80)),
    }) + '\n');
  } catch {}
}

module.exports = {
  name: 'curiosity',
  categories: [
    { name: 'CURIOSITY_ENGINE', weight: 4, handler: handleCuriosityEngine },
  ],
  async init() {},
  shutdown() {},
};
