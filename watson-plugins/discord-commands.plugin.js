'use strict';
// discord-commands.plugin.js — Perception-first command execution
// Category: DISCORD_POLL (weight 12 — high priority, checked frequently)
// Flow: Discord → JARVIS → Mac API queue → Watson polls → parse → OODA loop → confirm
//
// OODA per action step: Observe → Orient → Decide → Act → Verify → Learn
// Subsumption: L0 Safety → L1 Recovery → L2 Orient → L3 Navigate

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ─── Perception engine + Obsidian sync + Bumblebee audio ────────────────────
const pe = require('../watson-tools/perception-engine.js');
const obsidian = require('../watson-tools/obsidian-sync.js');
const bumblebee = require('../watson-tools/demonstration-learner.js');

const HOME = (() => {
  const raw = process.env.HOME || '/data/data/com.termux/files/home';
  return raw.includes('files/home') ? raw : path.join(raw, 'files/home');
})();

const MAC_API = 'http://192.168.4.46:8088';
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const CMD_LOG = path.join(HOME, 'watson-command-log.jsonl');

// ─── Progress reporting (real-time feedback to Discord + phone toast) ────────

async function reportProgress(message, thought) {
  fire('termux-toast', ['-s', message.substring(0, 120)]);
  if (thought) thought(`[CMD] ${message}`);
  await httpPost(MAC_API + '/api/watson-notable', {
    type: 'command_progress',
    message: `📱🔥 ${message}`,
    category: 'DISCORD_POLL',
    timestamp: Date.now(),
    source: 'watson-command',
  });
}

async function reportStuck(what, thought) {
  const msg = `😅 I'm stuck — ${what}. Trying to recover...`;
  await reportProgress(msg, thought);
}

async function reportHelp(what, thought) {
  const msg = `🆘 I can't figure this out — ${what}. Can you send the command again or show me?`;
  await reportProgress(msg, thought);
  // TTS for important failure
  fire('termux-tts-speak', ['-r', '0.9', "I'm stuck and need help."]);
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function httpGet(url, timeoutMs) {
  return new Promise(resolve => {
    const parsed = new (require('url').URL)(url);
    const req = http.get({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + (parsed.search || ''),
      timeout: timeoutMs || 8000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function httpPost(url, data) {
  return new Promise(resolve => {
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
  });
}

// ─── Shell helpers ──────────────────────────────────────────────────────────

function fire(bin, args) {
  try {
    const child = spawn(bin, args, {
      stdio: 'ignore',
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || '') },
    });
    child.on('error', () => {});
  } catch {}
}

function spawnAsync(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: TERMUX_BIN + ':' + (process.env.PATH || ''), HOME, TMPDIR: HOME + '/tmp' },
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

// ─── Screen reading (UIAutomator — fast path) ──────────────────────────────

async function readScreen() {
  await pe.selfAdbShell('uiautomator dump /sdcard/ui_dump.xml', 8000);
  const cat = await spawnAsync('cat', ['/sdcard/ui_dump.xml'], 5000);
  if (!cat.ok || !cat.output) return [];
  const elements = [];
  const re = /<node([^>]*)\/>/g;
  let m;
  while ((m = re.exec(cat.output)) !== null) {
    const a = m[1];
    const get = k => { const r = new RegExp(`${k}="([^"]*)"`).exec(a); return r ? r[1] : ''; };
    const text = get('text'), desc = get('content-desc'), bounds = get('bounds');
    const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
    if ((text || desc) && bm) {
      elements.push({
        text, desc,
        cx: Math.round((+bm[1] + +bm[3]) / 2),
        cy: Math.round((+bm[2] + +bm[4]) / 2),
      });
    }
  }
  return elements;
}

function findEl(elements, query) {
  const q = query.toLowerCase();
  return elements.find(e =>
    (e.text && e.text.toLowerCase().includes(q)) ||
    (e.desc && e.desc.toLowerCase().includes(q))
  );
}

function findElExact(elements, query) {
  const q = query.toLowerCase();
  return elements.find(e =>
    (e.text && e.text.trim().toLowerCase() === q) ||
    (e.desc && e.desc.trim().toLowerCase() === q)
  );
}

// ─── Intent parsing ─────────────────────────────────────────────────────────

function parseIntent(command) {
  const c = command.toLowerCase();

  // Music: "play Drake on Pandora", "open Pandora and play Drake station"
  const musicMatch = c.match(/(?:play|put on|queue)\s+(.+?)(?:\s+(?:on|in|via)\s+(pandora|spotify|youtube))?(?:\s+station|\s+radio)?$/i)
    || c.match(/(?:open|launch)\s+(pandora|spotify|youtube)\s+(?:and\s+)?play\s+(.+?)(?:\s+station|\s+radio)?$/i);

  if (musicMatch) {
    let query, app;
    if (/^(pandora|spotify|youtube)/i.test(musicMatch[1])) {
      app = musicMatch[1]; query = musicMatch[2];
    } else {
      query = musicMatch[1]; app = musicMatch[2] || 'pandora';
    }
    return { type: 'music', app: app.toLowerCase(), query: query.trim() };
  }

  const openMatch = c.match(/(?:open|launch|start)\s+(\w[\w\s]*)/i);
  if (openMatch) return { type: 'open_app', app: openMatch[1].trim() };

  const volMatch = c.match(/(?:set|change|turn)\s+(?:the\s+)?volume\s+(?:to\s+)?(\d+|up|down|max)/i);
  if (volMatch) return { type: 'volume', level: volMatch[1] };

  const sayMatch = c.match(/(?:say|speak|announce)\s+(.+)/i);
  if (sayMatch) return { type: 'speak', text: sayMatch[1].trim() };

  if (/take\s+(?:a\s+)?(?:photo|picture|selfie|screenshot)/i.test(c)) return { type: 'photo' };

  return { type: 'unknown', raw: command };
}

// ─── Perception-driven music execution (OODA loop) ──────────────────────────

const APP_PACKAGES = {
  pandora:  { activity: 'com.pandora.android/.LauncherActivity', pkg: 'com.pandora.android' },
  spotify:  { activity: 'com.spotify.music/.MainActivity', pkg: 'com.spotify.music' },
  youtube:  { activity: 'com.google.android.youtube/.HomeActivity', pkg: 'com.google.android.youtube' },
};

async function executeMusic(intent, thought, config, callOllama) {
  const { app, query } = intent;
  const appInfo = APP_PACKAGES[app];
  if (!appInfo) return { ok: false, message: `Don't know how to open ${app}` };

  const startTime = Date.now();
  const actionLog = []; // Track steps for lesson writing

  // ─── L0: Safety check ───────────────────────────────────────────────────
  const safety = await pe.checkSafety(thought);
  if (!safety.safe) {
    return { ok: false, message: `Can't execute — ${safety.reason} (battery: ${safety.level}%)` };
  }

  // ─── Check Obsidian for existing lesson ─────────────────────────────────
  const lesson = obsidian.findLesson(app, `play ${query}`);
  if (lesson && lesson.lastSucceeded && lesson.steps.length > 0) {
    await reportProgress(`Found a lesson for "${query}" on ${app} — following it...`, thought);
    const lessonResult = await followLesson(lesson, appInfo, query, thought, config);
    if (lessonResult.ok) return lessonResult;
    await reportProgress(`Lesson didn't work this time — trying perception approach...`, thought);
  }

  // ─── Volume up ──────────────────────────────────────────────────────────
  await spawnAsync('termux-volume', ['music', '13'], 3000);
  for (let i = 0; i < 3; i++) await pe.selfAdbShell('input keyevent KEYCODE_VOLUME_UP', 1500);

  // ─── Step 1: Open app (ensure we leave any previous app first) ──────────
  await reportProgress(`Opening ${app}... 🎵`, thought);
  // Press home first to exit whatever app is in foreground (e.g. Chrome from research)
  await pe.selfAdbShell('input keyevent KEYCODE_HOME', 2000);
  await pe.sleep(1000);
  // Launch the music app
  await pe.selfAdbShell(`am start -n ${appInfo.activity}`, 8000);
  await pe.sleep(3000);
  // Verify we're in the right app — if not, try monkey launch
  const focusCheck = await pe.selfAdbShell('dumpsys window windows | grep mCurrentFocus', 3000);
  const inRightApp = focusCheck.ok && focusCheck.output.includes(appInfo.pkg);
  if (!inRightApp) {
    await reportProgress(`Not in ${app} yet — retrying launch...`, thought);
    await pe.selfAdbShell(`monkey -p ${appInfo.pkg} -c android.intent.category.LAUNCHER 1`, 5000);
    await pe.sleep(4000);
  }
  logStep(actionLog, 'open_app', { app, verified: inRightApp }, 'home', null);

  // ─── Step 2: OBSERVE — what screen are we on? ───────────────────────────
  let perception = await pe.perceiveScreen(config, thought);
  pe.recordScreenHash(perception.hash);

  // ─── Step 3: Handle obstacles (ads, dialogs, lock) ──────────────────────
  let stuckAttempts = 0;
  while (perception.screenState === 'ad' || perception.screenState === 'dialog' || perception.screenState === 'lock') {
    stuckAttempts++;
    if (stuckAttempts > 3) break;
    await reportProgress(`I see ${perception.screenState === 'ad' ? 'an ad' : 'a ' + perception.screenState}. Dismissing...`, thought);
    await pe.handleObstacle(perception.screenState, thought);
    logStep(actionLog, 'dismiss_obstacle', { type: perception.screenState }, null, null);
    perception = await pe.perceiveScreen(config, thought);
    pe.recordScreenHash(perception.hash);
  }

  // ─── Step 4: "Check Collection First" — look for station before searching
  const collectionResult = await checkCollectionFirst(appInfo, query, perception, thought, config, actionLog);
  if (collectionResult.found) {
    // Found in collection — tap it
    await reportProgress(`Found "${query}" in my collection! Tapping it...`, thought);
    await pe.selfAdbShell(`input tap ${collectionResult.x} ${collectionResult.y}`, 3000);
    await pe.sleep(4000);
    logStep(actionLog, 'tap_collection_item', { query, x: collectionResult.x, y: collectionResult.y }, 'player', null);

    // Verify playback
    const media = await pe.checkMediaState();
    if (media.playing) {
      const msg = media.song
        ? `🎵 Got it! Playing "${media.song}" by ${media.artist} on ${app}`
        : `🎵 Playing ${query} on ${app}!`;
      await reportProgress(msg, thought);
      fire('termux-tts-speak', ['-r', '0.9', `Playing ${query}`]);
      await writeSuccessLesson(app, query, actionLog, startTime);
      await pe.rewarmMind(callOllama);
      return { ok: true, message: msg };
    }
  }

  // ─── Step 5: Search flow (collection didn't have it) ────────────────────
  await reportProgress(`"${query}" not in collection — heading to Search...`, thought);
  await searchAndPlay(appInfo, query, thought, config, actionLog, callOllama);

  // ─── Step 6: Final verification ─────────────────────────────────────────
  await pe.sleep(3000);
  const finalMedia = await pe.checkMediaState();
  if (finalMedia.playing) {
    const msg = finalMedia.song
      ? `🎵 Got it! Playing "${finalMedia.song}" by ${finalMedia.artist} on ${app}`
      : `🎵 Music is playing on ${app}!`;
    await reportProgress(msg, thought);
    fire('termux-tts-speak', ['-r', '0.9', `Playing ${query}`]);
    await writeSuccessLesson(app, query, actionLog, startTime);
    await pe.rewarmMind(callOllama);
    return { ok: true, message: msg };
  }

  // ─── Step 7: Bumblebee ad detection — listen and learn ────────────────
  await reportProgress(`Listening to what's playing... (Bumblebee mode)`, thought);

  // Sample mic to detect if it's an ad (speech) or music
  const audioCheck = await bumblebee.isAdPlaying();
  if (audioCheck.isAd) {
    await reportProgress(`I hear an ad playing (speech detected). Waiting for music...`, thought);
    // Learn from this ad audio, then wait for it to end
    const adSample = await bumblebee.sampleMicrophone(3000);
    if (adSample.ok) await bumblebee.learnFromAudioSample(adSample.path, adSample.analysis);

    // Poll every 5s for up to 30s — wait for ad to end
    for (let i = 0; i < 6; i++) {
      await pe.sleep(5000);
      const check = await bumblebee.isAdPlaying();
      if (check.isMusic) {
        await reportProgress(`Ad ended — music is playing now!`, thought);
        break;
      }
    }
  } else if (audioCheck.isMusic) {
    await reportProgress(`I hear music playing!`, thought);
    // Learn what music sounds like
    const musicSample = await bumblebee.sampleMicrophone(2000);
    if (musicSample.ok) await bumblebee.learnFromAudioSample(musicSample.path, musicSample.analysis);
  } else {
    // Silence or unknown — wait and retry
    await pe.sleep(10000);
  }

  const retryMedia = await pe.checkMediaState();
  if (retryMedia.playing) {
    const msg = retryMedia.song
      ? `🎵 Playing now! "${retryMedia.song}" by ${retryMedia.artist} on ${app}`
      : `🎵 Music is playing on ${app}`;
    await reportProgress(msg, thought);
    await writeSuccessLesson(app, query, actionLog, startTime);
    await pe.rewarmMind(callOllama);
    return { ok: true, message: msg };
  }

  // ─── Give up ────────────────────────────────────────────────────────────
  await reportHelp(`Searched "${query}" on ${app} but can't confirm playback`, thought);
  await writeFailedLesson(app, query, actionLog, startTime);
  await pe.rewarmMind(callOllama);
  return { ok: false, message: `Searched "${query}" on ${app} but couldn't confirm playback` };
}

// ─── Check My Collection for existing station ───────────────────────────────

async function checkCollectionFirst(appInfo, query, currentPerception, thought, config, actionLog) {
  // Try to navigate to My Collection tab
  // UIAutomator first (fast) — look for "My Collection" or "My Stations" tab
  const els = await readScreen();
  const collectionTab = findEl(els, 'My Collection') || findEl(els, 'Collection') || findEl(els, 'My Stations');

  if (collectionTab) {
    await reportProgress(`Navigating to My Collection...`, thought);
    await pe.selfAdbShell(`input tap ${collectionTab.cx} ${collectionTab.cy}`, 3000);
    await pe.sleep(2500);
    logStep(actionLog, 'tap_collection_tab', { x: collectionTab.cx, y: collectionTab.cy }, 'station_list', null);
  } else {
    // No collection tab found via UIAutomator — try common bottom nav positions
    // Pandora: My Collection is usually the leftmost bottom tab
    await pe.selfAdbShell('input tap 135 2130', 3000);
    await pe.sleep(2500);
    logStep(actionLog, 'tap_collection_tab_guess', { x: 135, y: 2130 }, 'station_list', null);
  }

  // Scan visible stations — UIAutomator first
  const stationEls = await readScreen();
  const queryWords = query.toLowerCase().split(/\s+/);
  const directMatch = stationEls.find(e => {
    const label = ((e.text || '') + ' ' + (e.desc || '')).toLowerCase();
    return queryWords.every(w => label.includes(w));
  });

  if (directMatch) {
    logStep(actionLog, 'found_in_collection_uiautomator', { text: directMatch.text || directMatch.desc }, null, null);
    return { found: true, x: directMatch.cx, y: directMatch.cy, method: 'uiautomator' };
  }

  // UIAutomator didn't find it — try Moondream vision (slower but sees custom UI)
  const shot = await pe.takeScreenshot();
  if (shot.ok && shot.base64) {
    const searchResult = await pe.findOnScreen(shot.base64, query, config);
    if (searchResult.found && searchResult.position) {
      logStep(actionLog, 'found_in_collection_moondream', { query, position: searchResult.position }, null, null);
      return { found: true, x: searchResult.position.x, y: searchResult.position.y, method: 'moondream' };
    }
  }

  // Scroll down and check again (stations may be below fold)
  await pe.selfAdbShell('input swipe 540 1600 540 600 500', 4000);
  await pe.sleep(1500);
  logStep(actionLog, 'scroll_collection', {}, null, null);

  // Check again after scroll
  const scrolledEls = await readScreen();
  const scrolledMatch = scrolledEls.find(e => {
    const label = ((e.text || '') + ' ' + (e.desc || '')).toLowerCase();
    return queryWords.every(w => label.includes(w));
  });

  if (scrolledMatch) {
    logStep(actionLog, 'found_after_scroll_uiautomator', { text: scrolledMatch.text || scrolledMatch.desc }, null, null);
    return { found: true, x: scrolledMatch.cx, y: scrolledMatch.cy, method: 'uiautomator_scroll' };
  }

  // Second Moondream scan after scroll
  const shot2 = await pe.takeScreenshot();
  if (shot2.ok && shot2.base64) {
    const searchResult2 = await pe.findOnScreen(shot2.base64, query, config);
    if (searchResult2.found && searchResult2.position) {
      logStep(actionLog, 'found_after_scroll_moondream', { query, position: searchResult2.position }, null, null);
      return { found: true, x: searchResult2.position.x, y: searchResult2.position.y, method: 'moondream_scroll' };
    }
  }

  return { found: false };
}

// ─── Search and play flow ───────────────────────────────────────────────────

async function searchAndPlay(appInfo, query, thought, config, actionLog) {
  // Navigate to Search tab — try UIAutomator first
  const els = await readScreen();
  const searchTab = findEl(els, 'Search');

  if (searchTab) {
    await reportProgress(`Tapping Search tab...`, thought);
    await pe.selfAdbShell(`input tap ${searchTab.cx} ${searchTab.cy}`, 3000);
    await pe.sleep(2000);
    logStep(actionLog, 'tap_search_tab', { x: searchTab.cx, y: searchTab.cy }, 'search', null);
  } else {
    // Pandora Search is usually in bottom nav
    await pe.selfAdbShell('input tap 675 2130', 3000);
    await pe.sleep(2000);
    logStep(actionLog, 'tap_search_tab_guess', { x: 675, y: 2130 }, 'search', null);
  }

  // ─── OBSERVE: Are we on search screen? ──────────────────────────────────
  let perception = await pe.perceiveScreen(config, thought);
  pe.recordScreenHash(perception.hash);

  // Handle if we're NOT on search screen
  let navAttempts = 0;
  while (perception.screenState !== 'search' && navAttempts < 3) {
    navAttempts++;

    if (perception.screenState === 'ad' || perception.screenState === 'dialog') {
      await pe.handleObstacle(perception.screenState, thought);
    } else if (perception.screenState === 'player') {
      // Back out of player view
      await reportProgress(`On player screen — pressing back...`, thought);
      await pe.selfAdbShell('input keyevent KEYCODE_BACK', 2000);
      await pe.sleep(1500);
    } else {
      // Try pressing back and re-tapping search
      await pe.selfAdbShell('input keyevent KEYCODE_BACK', 2000);
      await pe.sleep(1000);
      await pe.selfAdbShell('input tap 675 2130', 3000);
      await pe.sleep(2000);
    }

    perception = await pe.perceiveScreen(config, thought);
    pe.recordScreenHash(perception.hash);
    logStep(actionLog, 'navigate_to_search', { attempt: navAttempts, state: perception.screenState }, 'search', perception.screenState);
  }

  // ─── Find and tap search field ──────────────────────────────────────────
  const searchEls = await readScreen();
  const searchField = searchEls.find(e =>
    (e.text && /search|type here|find/i.test(e.text)) ||
    (e.desc && /search|type here|find/i.test(e.desc))
  );

  if (searchField) {
    await reportProgress(`Tapping search field...`, thought);
    await pe.selfAdbShell(`input tap ${searchField.cx} ${searchField.cy}`, 3000);
  } else {
    // Default search field position (top of screen)
    await pe.selfAdbShell('input tap 540 150', 3000);
  }
  await pe.sleep(2000);

  // Tap again to ensure focus (first tap sometimes just selects, doesn't activate keyboard)
  if (searchField) {
    await pe.selfAdbShell(`input tap ${searchField.cx} ${searchField.cy}`, 2000);
  } else {
    await pe.selfAdbShell('input tap 540 150', 2000);
  }
  await pe.sleep(1500);
  logStep(actionLog, 'tap_search_field', {}, null, null);

  // Select all existing text and delete it (Ctrl+A then Delete)
  // This is more reliable than long-press backspace which hits wrong keys
  await pe.selfAdbShell('input keyevent KEYCODE_MOVE_END', 1500);
  await pe.selfAdbShell('input keyevent --longpress KEYCODE_DEL', 3000);
  await pe.sleep(500);
  // Also try select-all + delete as backup
  await pe.selfAdbShell('input keyevent 29 --longpress', 2000); // hold A
  await pe.selfAdbShell('input keyevent KEYCODE_DEL', 1500);
  await pe.sleep(500);

  // Type the search query — add small delay before first char to avoid keyboard eating it
  await reportProgress(`Searching for "${query}"... 🔍`, thought);
  await pe.sleep(800);
  const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').replace(/ /g, '%s');
  await pe.selfAdbShell(`input text ${safeQuery}`, 5000);
  logStep(actionLog, 'type_query', { query }, null, null);

  // Wait for autocomplete
  await reportProgress(`Waiting for "${query}" results...`, thought);
  await pe.sleep(5000);

  // ─── OBSERVE: Check results ─────────────────────────────────────────────
  // Check playback first (Pandora sometimes auto-starts)
  const autoPlay = await pe.checkMediaState();
  if (autoPlay.playing) {
    logStep(actionLog, 'autoplay_started', {}, 'player', 'player');
    return { ok: true };
  }

  // Try UIAutomator to find result
  const resultEls = await readScreen();
  const queryFirstWord = query.split(' ')[0].toLowerCase();
  const resultEl = resultEls.find(e =>
    e.text && e.text.toLowerCase().includes(queryFirstWord) && e.cy > 200 && e.cy < 1800
  );

  if (resultEl) {
    await reportProgress(`Found "${resultEl.text}" — tapping it...`, thought);
    await pe.selfAdbShell(`input tap ${resultEl.cx} ${resultEl.cy}`, 3000);
    await pe.sleep(4000);
    logStep(actionLog, 'tap_search_result', { text: resultEl.text, x: resultEl.cx, y: resultEl.cy }, 'player', null);
  } else {
    // Press enter to force search, then use Moondream
    await reportProgress(`Pressing Enter to search...`, thought);
    await pe.selfAdbShell('input keyevent KEYCODE_ENTER', 2000);
    await pe.sleep(3000);

    // Moondream scan for results
    const shot = await pe.takeScreenshot();
    if (shot.ok && shot.base64) {
      const resultSearch = await pe.findOnScreen(shot.base64, query, config);
      if (resultSearch.found && resultSearch.position) {
        await reportProgress(`Moondream found "${query}" — tapping...`, thought);
        await pe.selfAdbShell(`input tap ${resultSearch.position.x} ${resultSearch.position.y}`, 3000);
        await pe.sleep(4000);
        logStep(actionLog, 'tap_moondream_result', { query, position: resultSearch.position }, 'player', null);
      }
    }
  }

  // Look for Play/Shuffle button
  const playEls = await readScreen();
  const playBtn = findElExact(playEls, 'Play') || findEl(playEls, 'Play') || findEl(playEls, 'Shuffle') || findEl(playEls, 'Listen Now');
  if (playBtn) {
    await reportProgress(`Found "${playBtn.text || playBtn.desc}" button — pressing it...`, thought);
    await pe.selfAdbShell(`input tap ${playBtn.cx} ${playBtn.cy}`, 3000);
    await pe.sleep(4000);
    logStep(actionLog, 'tap_play_button', { text: playBtn.text || playBtn.desc, x: playBtn.cx, y: playBtn.cy }, 'player', null);
  }

  return { ok: false };
}

// ─── Follow a previously learned lesson ─────────────────────────────────────

async function followLesson(lesson, appInfo, query, thought, config) {
  await reportProgress(`Following learned lesson (${lesson.steps.length} steps)...`, thought);

  // Open app first
  await pe.selfAdbShell(`monkey -p ${appInfo.pkg} -c android.intent.category.LAUNCHER 1`, 5000);
  await pe.sleep(4000);

  for (const step of lesson.steps) {
    if (step.coordinates) {
      await pe.selfAdbShell(`input tap ${step.coordinates.x} ${step.coordinates.y}`, 3000);
      await pe.sleep(2000);
    }

    // Verify each step with a perception check
    const perception = await pe.perceiveScreen(config, thought);
    pe.recordScreenHash(perception.hash);

    // If stuck, abort lesson
    if (pe.isStuck()) {
      await reportStuck('same screen after lesson step', thought);
      return { ok: false, message: 'Lesson step didn\'t work' };
    }

    // Handle obstacles mid-lesson
    if (perception.screenState === 'ad' || perception.screenState === 'dialog') {
      await pe.handleObstacle(perception.screenState, thought);
    }
  }

  // Check if music is playing
  await pe.sleep(3000);
  const media = await pe.checkMediaState();
  if (media.playing) {
    const msg = media.song
      ? `🎵 Lesson worked! Playing "${media.song}" by ${media.artist}`
      : `🎵 Music is playing!`;
    await reportProgress(msg, thought);
    return { ok: true, message: msg };
  }

  return { ok: false, message: 'Lesson completed but music not playing' };
}

// ─── Action logging for lesson writing ──────────────────────────────────────

function logStep(actionLog, action, details, expected, actual) {
  actionLog.push({
    action,
    details: JSON.stringify(details || {}),
    coordinates: details && (details.x != null) ? { x: details.x, y: details.y } : null,
    expected: expected || 'n/a',
    actual: actual || 'n/a',
    worked: actual !== 'stuck',
    ts: Date.now(),
  });
}

async function writeSuccessLesson(app, query, actionLog, startTime) {
  try {
    obsidian.writeLesson(app, `play ${query}`, actionLog, {
      ok: true,
      durationMs: Date.now() - startTime,
      notes: `Successfully played ${query} on ${app}`,
    });
    obsidian.writeNavPattern(app, {
      screenState: 'station_list',
      action: `play ${query}`,
      result: 'success',
      shortcut: actionLog.find(s => s.action.includes('found_in_collection')) ? 'found in collection' : 'searched',
    });
  } catch {}
}

async function writeFailedLesson(app, query, actionLog, startTime) {
  try {
    obsidian.writeLesson(app, `play ${query}`, actionLog, {
      ok: false,
      durationMs: Date.now() - startTime,
      notes: `Failed to play ${query} on ${app} — needs manual help`,
    });
  } catch {}
}

// ─── Other executors (unchanged) ────────────────────────────────────────────

const KNOWN_APPS = {
  settings: 'com.android.settings/.Settings',
  camera: 'com.sec.android.app.camera/.Camera',
  browser: 'com.sec.android.app.sbrowser/.SBrowserMainActivity',
  chrome: 'com.android.chrome/com.google.android.apps.chrome.Main',
  youtube: 'com.google.android.youtube/.HomeActivity',
  pandora: 'com.pandora.android/.LauncherActivity',
  gallery: 'com.sec.android.gallery3d/.app.GalleryActivity',
  clock: 'com.sec.android.app.clockpackage/.ClockPackage',
  notes: 'com.samsung.android.app.notes/.ui.NoteListActivity',
  calendar: 'com.samsung.android.calendar/.CalendarActivity',
};

async function executeOpenApp(intent, thought) {
  const appName = intent.app.toLowerCase();
  const pkg = KNOWN_APPS[appName];
  await pe.selfAdbShell('input keyevent KEYCODE_WAKEUP', 3000);
  if (pkg) {
    const res = await pe.selfAdbShell(`am start -n ${pkg}`, 8000);
    return { ok: res.ok, message: res.ok ? `Opened ${appName}` : `Failed to open ${appName}` };
  }
  const res = await pe.selfAdbShell(`monkey -p ${appName} -c android.intent.category.LAUNCHER 1`, 5000);
  return { ok: res.ok, message: res.ok ? `Opened ${appName}` : `Couldn't find app "${appName}"` };
}

async function executeSpeak(intent, thought) {
  const text = intent.text.substring(0, 200).replace(/"/g, '');
  thought(`[CMD] Speaking: "${text}"`);
  await spawnAsync('termux-tts-speak', ['-r', '0.9', text], 15000);
  return { ok: true, message: `Said: "${text}"` };
}

async function executeVolume(intent) {
  let level = intent.level;
  if (level === 'max') level = '15';
  else if (level === 'up') level = '13';
  else if (level === 'down') level = '5';
  await spawnAsync('termux-volume', ['music', level], 3000);
  return { ok: true, message: `Volume set to ${level}` };
}

async function executePhoto(thought) {
  const filepath = `/sdcard/watson-photos/cmd-${Date.now()}.jpg`;
  thought('[CMD] Taking photo...');
  try { fs.mkdirSync('/sdcard/watson-photos', { recursive: true }); } catch {}
  await spawnAsync('termux-camera-photo', ['-c', '0', filepath], 10000);
  const exists = fs.existsSync(filepath);
  return { ok: exists, message: exists ? `Photo saved` : 'Camera failed' };
}

// ─── Command dispatcher ─────────────────────────────────────────────────────

async function executeCommand(command, thought, callOllama, config) {
  const intent = parseIntent(command);
  thought(`[CMD] Intent: ${intent.type} ${JSON.stringify(intent).substring(0, 80)}`);

  let result;
  switch (intent.type) {
    case 'music':    result = await executeMusic(intent, thought, config, callOllama); break;
    case 'open_app': result = await executeOpenApp(intent, thought); break;
    case 'speak':    result = await executeSpeak(intent, thought); break;
    case 'volume':   result = await executeVolume(intent); break;
    case 'photo':    result = await executePhoto(thought); break;
    default:
      result = { ok: false, message: `Don't know how to do: "${command}"` };
  }

  // Log for reinforcement learning
  try {
    fs.appendFileSync(CMD_LOG, JSON.stringify({
      ts: Date.now(), command, intent: intent.type,
      query: intent.query || intent.app || intent.text || '',
      ok: result.ok, message: (result.message || '').substring(0, 200),
    }) + '\n');
  } catch {}

  return result;
}

// ─── DISCORD_POLL handler ───────────────────────────────────────────────────

async function handleDiscordPoll(state, CONFIG, thought, callOllama) {
  const data = await httpGet(MAC_API + '/api/watson-command', 5000);
  if (!data || !data.commands || data.commands.length === 0) {
    state.lastThought = '[CMD] No pending commands';
    return;
  }

  const cmd = data.commands[0];
  thought(`[CMD] Discord command: "${cmd.command}"`);
  await reportProgress(`Received: "${cmd.command}"`, thought);

  const result = await executeCommand(cmd.command, thought, callOllama, CONFIG);

  // Acknowledge
  await httpPost(MAC_API + '/api/watson-command-ack', { timestamps: [cmd.ts] });

  // Report back to Discord
  const emoji = result.ok ? '✅' : '⚠️';
  await httpPost(MAC_API + '/api/watson-dm', {
    thought: `${emoji} ${result.message}`,
    category: 'COMMAND_RESULT',
  });

  // Open Obsidian periodically to keep vault warm
  if (state.cycleCount && state.cycleCount % 50 === 0) {
    obsidian.openObsidianApp();
  }

  // Consolidate audio memory every 100 cycles (learn → compress → delete raw files)
  if (state.cycleCount && state.cycleCount % 100 === 0) {
    bumblebee.consolidateAudioMemory();
  }

  state.lastThought = `[CMD] ${result.ok ? 'Done' : 'Failed'}: ${result.message}`.substring(0, 200);
}

// ─── Plugin export ──────────────────────────────────────────────────────────

module.exports = {
  name: 'discord-commands',
  categories: [
    { name: 'DISCORD_POLL', weight: 12, handler: handleDiscordPoll },
  ],
  async init() {},
  shutdown() {},
};
