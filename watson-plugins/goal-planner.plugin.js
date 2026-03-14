'use strict';
// goal-planner.plugin.js — Watson sets goals and pursues them deliberately
// Categories: GOAL_PLAN (weight 3), GOAL_REVIEW (weight 1)
//
// Instead of random category cycling, Watson maintains a priority queue
// of goals. Each goal has sub-tasks, deadlines, and progress tracking.
// Watson picks what to work on based on priority, not randomness.
//
// Goals come from:
// 1. Sleep cycle gap analysis ("need more cybersecurity knowledge")
// 2. Dad's commands ("research X")
// 3. Curiosity engine ("I want to understand Y")
// 4. Self-assessment ("I'm weak at Z")

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const GOALS_FILE = `${HOME}/watson-goals.json`;
const GOALS_LOG = `${HOME}/watson-goals-log.jsonl`;

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

function httpPost(url, data) {
  return new Promise(resolve => {
    try {
      const parsed = new (require('url').URL)(url);
      const body = JSON.stringify(data);
      const req = http.request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, res => { res.resume(); resolve({ ok: true }); });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    } catch { resolve({ ok: false }); }
  });
}

// ─── Goal management ────────────────────────────────────────────────────────

function loadGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); }
  catch {
    return {
      active: [],
      completed: [],
      created: Date.now(),
    };
  }
}

function saveGoals(goals) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2), 'utf8');
}

function addGoal(title, priority, source, subtasks) {
  const goals = loadGoals();
  const goal = {
    id: `goal-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    title,
    priority,           // 1=critical, 2=high, 3=medium, 4=low
    source,             // 'curiosity', 'sleep-cycle', 'dad', 'self'
    subtasks: (subtasks || []).map(st => ({ task: st, done: false })),
    progress: 0,        // 0-100
    created: Date.now(),
    lastWorked: 0,
    status: 'active',
  };
  goals.active.push(goal);
  goals.active.sort((a, b) => a.priority - b.priority);
  saveGoals(goals);
  return goal;
}

function completeGoal(goalId) {
  const goals = loadGoals();
  const idx = goals.active.findIndex(g => g.id === goalId);
  if (idx >= 0) {
    const goal = goals.active.splice(idx, 1)[0];
    goal.status = 'completed';
    goal.completedAt = Date.now();
    goal.progress = 100;
    goals.completed.push(goal);
    // Keep only last 50 completed
    if (goals.completed.length > 50) goals.completed = goals.completed.slice(-50);
    saveGoals(goals);
    return goal;
  }
  return null;
}

function updateGoalProgress(goalId, progress, subtaskIdx) {
  const goals = loadGoals();
  const goal = goals.active.find(g => g.id === goalId);
  if (!goal) return;

  goal.progress = Math.min(100, progress);
  goal.lastWorked = Date.now();
  if (subtaskIdx !== undefined && goal.subtasks[subtaskIdx]) {
    goal.subtasks[subtaskIdx].done = true;
  }

  // Auto-complete if all subtasks done
  const allDone = goal.subtasks.length > 0 && goal.subtasks.every(st => st.done);
  if (allDone || goal.progress >= 100) {
    completeGoal(goal.id);
  } else {
    saveGoals(goals);
  }
}

// ─── Seed initial goals from knowledge state ────────────────────────────────

function seedGoalsIfEmpty(callOllama) {
  const goals = loadGoals();
  if (goals.active.length > 0) return;

  // Seed with foundational goals
  addGoal('Build deep knowledge in AI/ML domain', 2, 'self', [
    'Research transformer architectures',
    'Study reinforcement learning',
    'Learn about neural network optimization',
    'Understand attention mechanisms',
  ]);

  addGoal('Develop cybersecurity expertise', 2, 'self', [
    'Study OWASP Top 10',
    'Research zero trust architecture',
    'Learn about penetration testing methodology',
  ]);

  addGoal('Build CodexLib-ready knowledge packs', 1, 'self', [
    'Get 3 topics to depth 5+',
    'Accumulate 10+ entries per topic',
    'Export first CodexLib pack',
  ]);

  addGoal('Improve navigation intelligence', 2, 'self', [
    'Learn Pandora navigation patterns',
    'Build YouTube navigation knowledge',
    'Master Settings app navigation',
  ]);
}

// ─── GOAL_PLAN handler — pick and work on a goal ────────────────────────────

async function handleGoalPlan(state, CONFIG, thought, callOllama) {
  if (!state.ollamaAlive) {
    thought('[GOALS] Ollama offline — skipping');
    return;
  }

  const goals = loadGoals();
  seedGoalsIfEmpty(callOllama);

  if (goals.active.length === 0) {
    thought('[GOALS] No active goals — time to set new ones');
    return;
  }

  // Pick highest priority goal that hasn't been worked on recently
  const now = Date.now();
  const sortedGoals = [...goals.active].sort((a, b) => {
    // Priority first, then least recently worked
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.lastWorked || 0) - (b.lastWorked || 0);
  });

  const goal = sortedGoals[0];
  showThinking(`🎯 Working on: ${goal.title}`);
  thought(`[GOALS] Focusing on: "${goal.title}" (priority ${goal.priority}, ${goal.progress}% done)`);

  // Find next incomplete subtask
  const nextSubtask = goal.subtasks.find(st => !st.done);
  if (nextSubtask) {
    thought(`[GOALS] Next subtask: "${nextSubtask.task}"`);

    // Ask Ollama how to make progress
    let plan = '';
    try {
      plan = (await callOllama(
        `You are Watson, an AI with goals. Your current goal is: "${goal.title}". ` +
        `Your next subtask is: "${nextSubtask.task}". ` +
        `You can: research topics on the web, read your knowledge files, analyze your error patterns, ` +
        `or practice app navigation. ` +
        `What specific action should you take RIGHT NOW to make progress? Be concrete. One sentence.`,
        { numPredict: 60, numCtx: 256, stream: false, think: false, skipKnowledge: true },
      )) || '';
    } catch {}

    if (plan) {
      thought(`[GOALS] Plan: ${plan.substring(0, 200)}`);
      showThinking(`📋 ${plan.substring(0, 100)}`);
    }

    // Update progress
    const subtaskIdx = goal.subtasks.indexOf(nextSubtask);
    const progressPerSubtask = Math.floor(100 / Math.max(goal.subtasks.length, 1));
    const doneCount = goal.subtasks.filter(st => st.done).length;
    updateGoalProgress(goal.id, (doneCount + 1) * progressPerSubtask, subtaskIdx);
  } else {
    // No subtasks or all done
    updateGoalProgress(goal.id, 100);
    thought(`[GOALS] Goal completed: "${goal.title}"`);
    showThinking(`✅ Goal complete: ${goal.title}`);
  }

  state.lastThought = `[GOALS] 🎯 ${goal.title} (${goal.progress}%)`;

  // Log
  try {
    fs.appendFileSync(GOALS_LOG, JSON.stringify({
      ts: now, goalId: goal.id, title: goal.title,
      progress: goal.progress, priority: goal.priority,
    }) + '\n');
  } catch {}
}

// ─── GOAL_REVIEW handler — assess and create new goals ──────────────────────

async function handleGoalReview(state, CONFIG, thought, callOllama) {
  if (!state.ollamaAlive) return;

  // Only review once every ~20 cycles
  if (Math.random() > 0.05) {
    thought('[GOALS] Skipping review this cycle');
    return;
  }

  const goals = loadGoals();
  showThinking('📊 Reviewing goals...');
  thought('[GOALS] Running goal review...');

  // Check for stale goals (no progress in 12 hours)
  const staleGoals = goals.active.filter(g =>
    g.lastWorked && Date.now() - g.lastWorked > 12 * 3600000
  );

  if (staleGoals.length > 0) {
    thought(`[GOALS] ${staleGoals.length} stale goals detected`);
  }

  // Ask Ollama if any new goals are needed
  try {
    const currentGoals = goals.active.map(g => g.title).join(', ');
    const suggestion = (await callOllama(
      `You are Watson. Your current goals are: ${currentGoals || 'none'}. ` +
      `You have ${goals.completed.length} completed goals. ` +
      `Based on this, suggest ONE new goal Watson should pursue. ` +
      `Reply with just the goal title (10 words max).`,
      { numPredict: 30, numCtx: 256, stream: false, think: false, skipKnowledge: true },
    )) || '';

    if (suggestion && suggestion.length > 5 && suggestion.length < 100) {
      // Check if similar goal already exists
      const exists = goals.active.some(g =>
        g.title.toLowerCase().includes(suggestion.toLowerCase().substring(0, 20))
      );

      if (!exists) {
        addGoal(suggestion.trim(), 3, 'self-review', []);
        thought(`[GOALS] New goal added: "${suggestion.trim()}"`);
      }
    }
  } catch {}

  // Post summary to Discord (monthly)
  if (state.cycleCount % 100 === 0) {
    const summary = `🎯 Goals: ${goals.active.length} active, ${goals.completed.length} completed. ` +
      `Top priority: ${goals.active[0]?.title || 'none'}`;
    await httpPost(MAC_API + '/api/watson-dm', { thought: summary, category: 'GOALS' });
  }

  state.lastThought = `[GOALS] Review complete — ${goals.active.length} active goals`;
}

module.exports = {
  name: 'goal-planner',
  categories: [
    { name: 'GOAL_PLAN',   weight: 3, handler: handleGoalPlan },
    { name: 'GOAL_REVIEW', weight: 1, handler: handleGoalReview },
  ],
  async init() { seedGoalsIfEmpty(); },
  shutdown() {},
};
