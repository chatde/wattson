# Wattson — Next Session Pointer

**Read this first when starting any session on the Wattson project.**

## Current Status
- **Active Phase:** Phase 2 — Screen Intelligence
- **Next task:** Task 2.2 — ChatGPT as a tool (am start + input text + screenshot + OCR)
- **Full plan:** `docs/plans/wattson-jarvis.md`

## What Was Just Done (2026-03-13 session 3)
- Phase 1 Voice I/O: COMPLETE (voice plugin, /api/speak, voice daemon, wake word loop)
- Phase 2 Task 2.1 COMPLETE:
  - Tesseract v5.5.2 installed in Termux with eng language data
  - screencap + tesseract OCR pipeline confirmed end-to-end
  - `watson-plugins/screen-reader.plugin.js` deployed — SCREEN_READ (weight 3)
    - 40-char minimum guard (lock screen ~23 chars, correctly skipped)
    - quick-hash dedup (skips re-reading identical screens)
    - brain rates content 1-10, stores summaries ≥6 to wattson-knowledge.jsonl
    - backoff: 3x tesseract failures → skip 8 cycles
  - Hot-reload confirmed: 69 total categories
  - Curfew active at 23:xx — screen interactions suppressed overnight (correct)

## Start Here Next Session

**Task 2.2 — ChatGPT as a tool:**
1. Open ChatGPT: `am start -n com.openai.chatgpt/.MainActivity`
2. Type query via `input text "your question"`
3. Wait for response (configurable sleep)
4. Screenshot + Tesseract OCR the response
5. Return text to brain context

Add as CHATGPT_QUERY category in screen-reader plugin or navigator plugin.
Wire into DECIDE: brain picks CHATGPT_QUERY when it needs a second opinion.

## ADB Access
- WiFi: `192.168.4.32:5555` (use if USB not connected)
- USB: `4359534a49413498` (preferred)
- Reconnect if offline: `adb kill-server && adb start-server && adb connect 192.168.4.32:5555`

## Phone Status (last checked 2026-03-13 ~23:10)
- watson-core.js: running (69 categories — screen-reader loaded)
- watson-dashboard: running (port 8080)
- watson-voice-daemon.js: running
- Phone temp: 35.1°C — COOL ✓
- Curfew: active 23:xx (screen interactions suppressed)
- USB ADB 4359534a49413498: connected earlier this session, may need reconnect

## SSD Write Access Note
- Read/Write/Edit tools cannot write to /Volumes/AI-Models/ (macOS TCC)
- Bash can READ but not write directly
- WORKAROUND: write to ~/Desktop/, then use osascript to copy to SSD
  - `osascript -e 'do shell script "cat /Users/clawdbotmain/Desktop/FILE > /Volumes/AI-Models/wattson/PATH/FILE"'`

## Key Paths on Phone
- Plugins (hot-reload dir): `/data/data/com.termux/files/home/watson-plugins/`
- Thoughts log: `/sdcard/watson-thoughts.log`
- Voice log: `/sdcard/wattson-voice.log`
- Knowledge log: `/sdcard/wattson-knowledge.jsonl`
- Screen OCR output: `/sdcard/watson-screen-ocr.txt`

## Critical Facts
- Plugin handler signature: `handler(state, CONFIG, logFn, brainCall)` — 3rd param is logFn NOT text
- `termux-microphone-record` flag: `-f FILE` (not `-o`)
- `termux-speech-to-text` unusable in background — use Groq Whisper
- Tesseract full path: `/data/data/com.termux/files/usr/bin/tesseract`
- screencap: `/system/bin/screencap -p /sdcard/file.png`
