# Wattson — Next Session Pointer

**Read this first when starting any session on the Wattson project.**

## Current Status
- **Active Phase:** Phase 1 — Voice I/O
- **Next task:** Task 1.4, Step 7 — End-to-end wake word test (say "Wattson" near the phone)
- **Full plan:** `docs/plans/wattson-jarvis.md`

## What Was Just Done (2026-03-13 session 2)
- TTS pitch set: 70 (deeper), rate: 85 (deliberate) — stored in Android secure settings
- TTS engines confirmed: Samsung SMT (default) + Google TTS, both work at pitch 0.7 / rate 0.9
- `watson-plugins/voice.plugin.js` deployed — SPEAK category (weight 4), hot-reloaded OK (68 categories)
  - Handler signature: `(state, CONFIG, logFn, brainCall)` — NOT `(state, config, thought)`
  - Uses `_pendingText` queue so `onHighScoreThought` doesn't conflict with logFn param
- `/api/speak` added to `dashboard/server.js` — tested successfully from Mac
  - `curl -s -X POST http://192.168.4.32:8080/api/speak -H 'Content-Type: application/json' -d '{"text":"Hello"}' ` → phone speaks
- `watson-voice-daemon.js` created and deployed
  - Wake word: "wattson" in transcript → speaks "Yes?" → records command → Groq Whisper → Ollama → TTS
  - STT: Groq Whisper (not termux-speech-to-text — that opens Android dialog, unusable in background)
  - MIC: `termux-microphone-record -l N -f FILE` (flag is `-f` not `-o`)
  - Daemon confirmed running: `[daemon] Wattson voice daemon started. Listening for wake word...`
- `start-watson.sh` updated to include voice daemon in boot sequence

## Start Here Next Session

**Test the end-to-end wake word** — say "Wattson" near the phone and verify it responds:
```bash
adb -s 4359534a49413498 shell "tail -20 /sdcard/wattson-voice.log"
```

If daemon is not running, start it:
```bash
adb -s 4359534a49413498 shell "run-as com.termux sh -c 'nohup /data/data/com.termux/files/usr/bin/node /data/data/com.termux/files/home/watson-voice-daemon.js >> /sdcard/wattson-voice.log 2>&1 &'"
```

After confirming wake word works, proceed to **Phase 2: Screen Intelligence** (Task 2.1 — screenshot + OCR).

## Phone Status (last checked 2026-03-13 ~19:00)
- Ollama: running
- watson-core.js: running (PID 23103)
- watson-dashboard: running (PID 13714, restarted)
- watson-voice-daemon.js: running
- Voice plugin: hot-loaded, 68 categories
- Phone temp: **33.8°C (93°F) — COOL** ✓
- Battery: 100% (charging via USB)
- USB ADB: 4359534a49413498 ← prefer this over WiFi (192.168.4.32:5555)

## Key Paths on Phone
- Plugins (hot-reload dir): `/data/data/com.termux/files/home/watson-plugins/`
- Watson-core: `/data/data/com.termux/files/home/watson-core.js`
- Dashboard: `/data/data/com.termux/files/home/watson-dashboard/server.js`
- Voice daemon: `/data/data/com.termux/files/home/watson-voice-daemon.js`
- Finance log: `/sdcard/wattson-finance.jsonl`
- Portfolio: `/sdcard/wattson-portfolio.json`
- Thoughts log: `/sdcard/watson-thoughts.log`
- Voice log: `/sdcard/wattson-voice.log`

## Critical Facts
- `termux-microphone-record` flag: `-f FILE` (not `-o`)
- `termux-speech-to-text` does NOT work in background (opens Android dialog) — use Groq Whisper
- Plugin handler signature: `handler(state, CONFIG, logFn, brainCall)` — 3rd param is logFn, NOT text
- ADB USB ID: `4359534a49413498`
- Phone IP: `192.168.4.32`
- Groq API key: in dashboard/server.js env var GROQ_API_KEY
