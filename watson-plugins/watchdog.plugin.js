'use strict';
// watchdog.plugin.js — Proactive monitoring of things Dad cares about
// Categories: WATCHDOG (weight 3)
//
// Watson doesn't just research — he watches. Crypto prices, server health,
// weather alerts, news about topics Dad tracks. When something noteworthy
// happens, Watson alerts via Discord + TTS.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const WATCHDOG_STATE = `${HOME}/watson-watchdog-state.json`;
const WATCHDOG_LOG = `${HOME}/watson-watchdog.jsonl`;

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between same alerts
let alertCooldowns = {};

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
      }, res => { res.resume(); resolve({ ok: true }); });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    } catch { resolve({ ok: false }); }
  });
}

function httpsGet(url, timeoutMs) {
  return new Promise(resolve => {
    try {
      const req = https.get(url, { timeout: timeoutMs || 10000 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function canAlert(key) {
  const now = Date.now();
  if (alertCooldowns[key] && now - alertCooldowns[key] < ALERT_COOLDOWN_MS) return false;
  alertCooldowns[key] = now;
  return true;
}

async function sendAlert(message, priority, thought) {
  if (thought) thought(`[WATCHDOG] ${message}`);

  await httpPost(MAC_API + '/api/watson-dm', {
    thought: `🔔 ${message}`,
    category: 'WATCHDOG_ALERT',
  });

  if (priority === 'high') {
    fire('termux-notification', [
      '--id', '9995',
      '--title', 'Watson Alert',
      '--content', message.substring(0, 120),
      '--priority', 'high',
    ]);
    const hour = new Date().getHours();
    if (hour >= 7 && hour < 22) {
      fire('termux-tts-speak', ['-r', '0.9', message.substring(0, 100)]);
    }
  }
}

// ─── Load/save watchdog state ───────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(WATCHDOG_STATE, 'utf8')); }
  catch {
    return {
      lastBtcPrice: 0, lastEthPrice: 0,
      lastWeatherCheck: 0, lastServerCheck: 0,
      lastCryptoCheck: 0,
    };
  }
}

function saveState(wdState) {
  fs.writeFileSync(WATCHDOG_STATE, JSON.stringify(wdState, null, 2), 'utf8');
}

// ─── Check crypto prices (CoinGecko free API) ──────────────────────────────

async function checkCrypto(thought) {
  const data = await httpsGet(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
    8000,
  );
  if (!data) return;

  const wdState = loadState();
  const alerts = [];

  if (data.bitcoin) {
    const btc = data.bitcoin;
    const price = Math.round(btc.usd);
    const change = (btc.usd_24h_change || 0).toFixed(1);

    // Alert on significant moves (>5% in 24h)
    if (Math.abs(btc.usd_24h_change || 0) > 5 && canAlert('btc_move')) {
      alerts.push(`BTC ${change > 0 ? '📈' : '📉'} $${price.toLocaleString()} (${change}% 24h)`);
    }

    // Alert on crossing major thresholds
    const thresholds = [50000, 75000, 100000, 125000, 150000];
    for (const t of thresholds) {
      if (wdState.lastBtcPrice < t && price >= t && canAlert(`btc_${t}`)) {
        alerts.push(`BTC crossed $${t.toLocaleString()}! Now at $${price.toLocaleString()}`);
      }
    }
    wdState.lastBtcPrice = price;
  }

  if (data.ethereum) {
    const eth = data.ethereum;
    const price = Math.round(eth.usd);
    const change = (eth.usd_24h_change || 0).toFixed(1);

    if (Math.abs(eth.usd_24h_change || 0) > 7 && canAlert('eth_move')) {
      alerts.push(`ETH ${change > 0 ? '📈' : '📉'} $${price.toLocaleString()} (${change}% 24h)`);
    }
    wdState.lastEthPrice = price;
  }

  wdState.lastCryptoCheck = Date.now();
  saveState(wdState);

  for (const alert of alerts) {
    await sendAlert(alert, 'high', thought);
  }

  // Always log current prices
  if (thought && data.bitcoin) {
    thought(`[WATCHDOG] Crypto: BTC $${Math.round(data.bitcoin.usd).toLocaleString()}, ETH $${Math.round(data.ethereum?.usd || 0).toLocaleString()}`);
  }

  return data;
}

// ─── Check server health ────────────────────────────────────────────────────

async function checkServers(thought) {
  const servers = [
    { name: 'Mac API', url: 'http://192.168.4.46:8088/api/health', timeout: 5000 },
    { name: 'Pi Monitor', url: 'http://192.168.5.50:8085/health', timeout: 5000 },
  ];

  for (const server of servers) {
    try {
      const data = await new Promise(resolve => {
        const parsed = new (require('url').URL)(server.url);
        const req = http.get({
          hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
          timeout: server.timeout,
        }, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      });

      if (!data.ok && canAlert(`server_${server.name}`)) {
        await sendAlert(`${server.name} is DOWN!`, 'high', thought);
      }
    } catch {}
  }
}

// ─── Check weather alerts (Open-Meteo, no API key needed) ──────────────────

async function checkWeather(thought) {
  // San Jose, CA coordinates
  const data = await httpsGet(
    'https://api.open-meteo.com/v1/forecast?latitude=37.34&longitude=-121.89&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=America/Los_Angeles&forecast_days=1',
    8000,
  );
  if (!data || !data.current) return;

  const temp = data.current.temperature_2m;
  const weatherCode = data.current.weather_code;

  // Alert on extreme weather
  if (temp > 38 && canAlert('heat')) { // >100°F
    await sendAlert(`Extreme heat: ${Math.round(temp * 9/5 + 32)}°F in San Jose`, 'high', thought);
  }
  if (weatherCode >= 95 && canAlert('storm')) { // thunderstorm codes
    await sendAlert(`Thunderstorm warning in San Jose!`, 'high', thought);
  }

  if (thought) {
    thought(`[WATCHDOG] Weather: ${Math.round(temp * 9/5 + 32)}°F in San Jose`);
  }
}

// ─── WATCHDOG handler ───────────────────────────────────────────────────────

async function handleWatchdog(state, CONFIG, thought, callOllama) {
  thought('[WATCHDOG] Running checks...');

  const wdState = loadState();
  const now = Date.now();

  // Crypto: check every 15 min
  if (now - (wdState.lastCryptoCheck || 0) > 15 * 60000) {
    await checkCrypto(thought);
  }

  // Servers: check every 10 min
  if (now - (wdState.lastServerCheck || 0) > 10 * 60000) {
    await checkServers(thought);
    wdState.lastServerCheck = now;
    saveState(wdState);
  }

  // Weather: check every hour
  if (now - (wdState.lastWeatherCheck || 0) > 3600000) {
    await checkWeather(thought);
    wdState.lastWeatherCheck = now;
    saveState(wdState);
  }

  state.lastThought = '[WATCHDOG] All checks complete';
}

module.exports = {
  name: 'watchdog',
  categories: [
    { name: 'WATCHDOG', weight: 3, handler: handleWatchdog },
  ],
  async init() {},
  shutdown() {},
};
