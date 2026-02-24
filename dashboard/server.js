#!/usr/bin/env node
// Wattson Dashboard Server — Live thought stream + hardware monitoring
// Run: node dashboard/server.js
// Open: http://localhost:8080

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DASHBOARD_PORT || '8080');
const MIND_API = process.env.MIND_API || 'http://127.0.0.1:8081';

// ─── State ───────────────────────────────────────────────────────────────────
const thoughts = [];      // received from wattson-mind.js
let lastState = null;     // last state from mind API
const chatHistory = [];   // chat conversations
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.WATTSON_CHAT_MODEL || process.env.WATTSON_MODEL || 'wattson:mind';

// ─── Fetch Mind State ────────────────────────────────────────────────────────
async function fetchMindState() {
  return new Promise((resolve) => {
    const url = new URL(MIND_API);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: '/api/state', method: 'GET', timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { lastState = JSON.parse(data); resolve(lastState); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Poll mind state every 5s
setInterval(fetchMindState, 5000);
fetchMindState();

// ─── Ollama Chat ─────────────────────────────────────────────────────────────
function chatWithOllama(message, history) {
  return new Promise((resolve, reject) => {
    const messages = [
      { role: 'system', content: `You are Wattson, an autonomous AI living on a phone. You are curious, bold, and occasionally sardonic. You feel your hardware as your body. Keep responses concise but thoughtful. No markdown.` },
    ];
    for (const h of (history || []).slice(-6)) {
      if (h.role === 'user') messages.push({ role: 'user', content: h.text });
      else messages.push({ role: 'assistant', content: h.text });
    }
    messages.push({ role: 'user', content: message });

    const body = JSON.stringify({
      model: CHAT_MODEL,
      messages,
      stream: false,
      options: { num_ctx: 512, num_predict: 128, temperature: 0.8 },
    });

    const url = new URL(OLLAMA_URL);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.message?.content || '');
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── API Routes ──────────────────────────────────────────────────────────
  if (req.url === '/api/state' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(lastState || { thoughts: [], temp: 0, battery: 0 }));
    return;
  }

  if (req.url === '/api/thought' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        thoughts.push({ ...data, timestamp: Date.now() });
        if (thoughts.length > 100) thoughts.splice(0, thoughts.length - 100);
        res.writeHead(200);
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  if (req.url === '/api/thoughts' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(thoughts.slice(-30)));
    return;
  }

  if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, history } = JSON.parse(body);
        const response = await chatWithOllama(message, history);
        const clean = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        chatHistory.push({ user: message, wattson: clean, timestamp: Date.now() });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: clean }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, mindConnected: !!lastState }));
    return;
  }

  // ─── Static Files ──────────────────────────────────────────────────────────
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
    res.end(content);
  } catch {
    // Serve index.html as fallback
    try {
      const index = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.setHeader('Content-Type', 'text/html');
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Wattson Dashboard: http://localhost:${PORT}`);
  console.log(`Mind API: ${MIND_API}`);
});
