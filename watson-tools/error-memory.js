'use strict';
// error-memory.js — Watson remembers failures and avoids repeating them
// Every error gets logged with context. Before acting, Watson checks
// if he's failed this exact way before and tries a different approach.
//
// "Insanity is doing the same thing over and over and expecting different results."

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const ERROR_DB = `${HOME}/watson-error-memory.json`;
const ERROR_LOG = `${HOME}/watson-errors.jsonl`;

// ─── Load/save error database ───────────────────────────────────────────────

function loadErrorDb() {
  try { return JSON.parse(fs.readFileSync(ERROR_DB, 'utf8')); }
  catch {
    return {
      patterns: {},     // key → { count, lastSeen, context, avoidAction }
      totalErrors: 0,
      totalAvoided: 0,
    };
  }
}

function saveErrorDb(db) {
  fs.writeFileSync(ERROR_DB, JSON.stringify(db, null, 2), 'utf8');
}

// ─── Generate error key from context ────────────────────────────────────────

function errorKey(category, action, errorMsg) {
  // Normalize the error into a pattern key
  const cat = (category || 'unknown').toLowerCase();
  const act = (action || 'unknown').toLowerCase().substring(0, 50);
  const err = (errorMsg || 'unknown')
    .toLowerCase()
    .replace(/\d+/g, 'N')           // normalize numbers
    .replace(/[a-f0-9]{8,}/g, 'H')  // normalize hex strings
    .substring(0, 80);
  return `${cat}:${act}:${err}`;
}

// ─── Record an error ────────────────────────────────────────────────────────

function recordError(category, action, errorMsg, context) {
  const db = loadErrorDb();
  const key = errorKey(category, action, errorMsg);

  if (!db.patterns[key]) {
    db.patterns[key] = {
      count: 0,
      firstSeen: Date.now(),
      lastSeen: 0,
      action,
      error: errorMsg,
      category,
      context: null,
      avoidAction: null,
      resolved: false,
    };
  }

  const pattern = db.patterns[key];
  pattern.count++;
  pattern.lastSeen = Date.now();
  pattern.context = (context || '').substring(0, 200);

  // Auto-generate avoidance after 2+ occurrences
  if (pattern.count >= 2 && !pattern.avoidAction) {
    pattern.avoidAction = generateAvoidance(category, action, errorMsg);
  }

  db.totalErrors++;
  saveErrorDb(db);

  // Log to JSONL
  try {
    fs.appendFileSync(ERROR_LOG, JSON.stringify({
      ts: Date.now(), key, count: pattern.count,
      category, action, error: errorMsg,
      context: (context || '').substring(0, 100),
    }) + '\n');
  } catch {}

  return pattern;
}

// ─── Check if we've seen this error before ──────────────────────────────────

function hasSeenError(category, action, errorMsg) {
  const db = loadErrorDb();
  const key = errorKey(category, action, errorMsg);
  return db.patterns[key] || null;
}

// ─── Check if an action should be avoided ───────────────────────────────────

function shouldAvoid(category, action) {
  const db = loadErrorDb();
  const prefix = `${(category || '').toLowerCase()}:${(action || '').toLowerCase().substring(0, 50)}`;

  // Find all matching patterns
  const matches = Object.entries(db.patterns)
    .filter(([key, pattern]) => key.startsWith(prefix) && pattern.count >= 3 && !pattern.resolved)
    .map(([key, pattern]) => pattern);

  if (matches.length === 0) return null;

  // Return the most frequent matching error
  const worst = matches.sort((a, b) => b.count - a.count)[0];
  db.totalAvoided++;
  saveErrorDb(db);

  return {
    reason: worst.error,
    count: worst.count,
    avoidAction: worst.avoidAction,
    lastSeen: worst.lastSeen,
  };
}

// ─── Generate avoidance strategy ────────────────────────────────────────────

function generateAvoidance(category, action, errorMsg) {
  const err = (errorMsg || '').toLowerCase();

  if (err.includes('timeout')) return 'increase timeout or skip if slow';
  if (err.includes('not found')) return 'verify element exists before tapping';
  if (err.includes('stuck')) return 'try alternative navigation path';
  if (err.includes('permission')) return 'check permissions before attempting';
  if (err.includes('crash') || err.includes('stopped')) return 'force-stop and restart app';
  if (err.includes('network') || err.includes('connection')) return 'check connectivity first';
  if (err.includes('out of memory') || err.includes('oom')) return 'unload models before proceeding';
  if (err.includes('ad') || err.includes('interstitial')) return 'wait and dismiss ad first';

  return 'try alternative approach';
}

// ─── Mark an error pattern as resolved ──────────────────────────────────────

function resolveError(category, action, errorMsg) {
  const db = loadErrorDb();
  const key = errorKey(category, action, errorMsg);
  if (db.patterns[key]) {
    db.patterns[key].resolved = true;
    db.patterns[key].resolvedAt = Date.now();
    saveErrorDb(db);
  }
}

// ─── Get error stats ────────────────────────────────────────────────────────

function getErrorStats() {
  const db = loadErrorDb();
  const patterns = Object.values(db.patterns);
  return {
    totalPatterns: patterns.length,
    totalErrors: db.totalErrors,
    totalAvoided: db.totalAvoided,
    topErrors: patterns
      .filter(p => !p.resolved)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(p => ({ action: p.action, error: p.error, count: p.count })),
    resolvedCount: patterns.filter(p => p.resolved).length,
  };
}

// ─── Prune old resolved errors ──────────────────────────────────────────────

function pruneOldErrors(maxAgeDays) {
  const db = loadErrorDb();
  const cutoff = Date.now() - (maxAgeDays || 30) * 86400000;
  let pruned = 0;

  for (const [key, pattern] of Object.entries(db.patterns)) {
    if (pattern.resolved && pattern.resolvedAt < cutoff) {
      delete db.patterns[key];
      pruned++;
    }
  }

  if (pruned > 0) saveErrorDb(db);
  return pruned;
}

module.exports = {
  recordError,
  hasSeenError,
  shouldAvoid,
  resolveError,
  getErrorStats,
  pruneOldErrors,
  errorKey,
};
