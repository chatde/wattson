'use strict';
// agent-mesh.plugin.js — Watson ↔ Albert ↔ JARVIS knowledge sharing
// Categories: AGENT_SYNC (weight 2)
//
// The agents are isolated right now. Watson researches on the phone,
// Albert knows the ecosystem on the Mac, JARVIS handles Discord ops.
// This plugin connects them: Watson pushes his knowledge to the Mac API,
// pulls Albert's ecosystem knowledge, and coordinates via shared state.
//
// Network:
//   Watson (phone) ←→ Mac API :8088 ←→ Albert (Mac Ollama)
//                                    ←→ JARVIS (Discord)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;
const MESH_LOG = `${HOME}/watson-agent-mesh.jsonl`;
const SHARED_KNOWLEDGE = `${HOME}/watson-mesh-shared.json`;

function fire(bin, args) {
  try {
    const child = spawn(bin, args, { stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    }); child.on('error', () => {});
  } catch {}
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
      }, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false }); } });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    } catch { resolve({ ok: false }); }
  });
}

function httpGet(url, timeoutMs) {
  return new Promise(resolve => {
    try {
      const parsed = new (require('url').URL)(url);
      const req = http.get({
        hostname: parsed.hostname, port: parsed.port,
        path: parsed.pathname + (parsed.search || ''),
        timeout: timeoutMs || 8000,
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ─── AGENT_SYNC handler ────────────────────────────────────────────────────

async function handleAgentSync(state, CONFIG, thought, callOllama) {
  thought('[MESH] Agent sync cycle starting...');

  // ─── Step 1: Push Watson's knowledge summary to Mac API ─────────────────
  let knowledgeStats = { totalFiles: 0, totalDomains: 0, domains: [] };
  try {
    const retriever = require('../watson-tools/knowledge-retriever.js');
    knowledgeStats = retriever.getKnowledgeStats();
  } catch {}

  const watsonState = {
    agent: 'watson',
    ts: Date.now(),
    battery: state.battery || -1,
    temp: state.temp || -1,
    thermalTier: state.thermalTier || 'UNKNOWN',
    ollamaAlive: state.ollamaAlive || false,
    cycleCount: state.cycleCount || 0,
    knowledgeFiles: knowledgeStats.totalFiles,
    knowledgeDomains: knowledgeStats.totalDomains,
    domains: knowledgeStats.domains,
    totalSizeKB: knowledgeStats.totalSizeKB,
    lastThought: (state.lastThought || '').substring(0, 200),
    currentCategory: state.currentCategory || 'AGENT_SYNC',
  };

  // Push to Mac API shared state endpoint
  const pushResult = await httpPost(MAC_API + '/api/watson-state', watsonState);

  if (pushResult.ok) {
    thought('[MESH] Pushed state to Mac API');
  }

  // ─── Step 2: Pull ecosystem state from Mac ──────────────────────────────
  const macState = await httpGet(MAC_API + '/api/ecosystem-state', 5000);
  if (macState) {
    thought(`[MESH] Got ecosystem state from Mac`);

    // Store shared knowledge
    try {
      const shared = { ts: Date.now(), macState, watsonState: knowledgeStats };
      fs.writeFileSync(SHARED_KNOWLEDGE, JSON.stringify(shared, null, 2), 'utf8');
    } catch {}

    // If Albert has recommendations for Watson, process them
    if (macState.recommendations) {
      for (const rec of macState.recommendations) {
        thought(`[MESH] Albert says: ${rec.substring(0, 100)}`);
      }
    }
  }

  // ─── Step 3: Share interesting findings with Albert via Discord ─────────
  // Post Watson's latest research highlights for Albert to comment on
  if (knowledgeStats.totalFiles > 0 && state.cycleCount % 20 === 0) {
    try {
      const index = JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
      const recent = Object.values(index.topics || {})
        .filter(t => Date.now() - new Date(t.lastUpdated).getTime() < 6 * 3600000)
        .slice(0, 3);

      if (recent.length > 0) {
        const summary = recent.map(t => `${t.domain}: ${t.topic}`).join(', ');
        await httpPost(MAC_API + '/api/watson-dm', {
          thought: `🤖 Agent Mesh: Watson researched ${recent.length} topics recently: ${summary}`,
          category: 'AGENT_MESH',
        });
      }
    } catch {}
  }

  // Log
  try {
    fs.appendFileSync(MESH_LOG, JSON.stringify({
      ts: Date.now(),
      pushed: pushResult.ok,
      pulledMac: !!macState,
      knowledgeFiles: knowledgeStats.totalFiles,
    }) + '\n');
  } catch {}

  state.lastThought = `[MESH] Synced with ecosystem — ${knowledgeStats.totalFiles} knowledge files shared`;
}

module.exports = {
  name: 'agent-mesh',
  categories: [
    { name: 'AGENT_SYNC', weight: 2, handler: handleAgentSync },
  ],
  async init() {},
  shutdown() {},
};
