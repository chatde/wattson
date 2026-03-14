# Wattson — Next Session Pointer

**Read this first when starting any session on the Wattson project.**

## Current Status
- **Active Phase:** Phase 1 — Voice I/O
- **Next task:** Task 1.1 — Configure deeper voice settings
- **Full plan:** `docs/plans/wattson-jarvis.md`

## What Was Just Done (2026-03-13)
- Finance plugin deployed and hot-loaded on phone (67 categories now)
- wattson:chat model created on phone (qwen2.5-coder:1.5b base)
- Watson-state-poller bridging phone activity to pixel dashboard
- Background market scan timer running every 20 minutes

## Start Here Next Session

Open `docs/plans/wattson-jarvis.md` and find the first unchecked `- [ ]` in Phase 1.

It's Task 1.1, Step 1:
```bash
adb -s 192.168.4.32:5555 shell "settings get secure tts_default_pitch; settings get secure tts_default_rate; settings get secure tts_default_synth"
```

## Phone Status (last checked 2026-03-13 ~18:30)
- Ollama: running
- watson-core.js: running (PID changes on restart, check via ps -A | grep node)
- watson-dashboard: running on port 8080
- finance plugin: hot-loaded, 67 categories active
- wattson:chat model: installed
- Phone temp at last check: 173F (EXTREME) — check before doing Ollama calls

## Key Paths on Phone
- Plugins (hot-reload dir): `/data/data/com.termux/files/home/watson-plugins/`
- Watson-core: `/data/data/com.termux/files/home/watson-core.js`
- Dashboard: `/data/data/com.termux/files/home/watson-dashboard/server.js`
- Finance log: `/sdcard/wattson-finance.jsonl`
- Portfolio: `/sdcard/wattson-portfolio.json`
- Thoughts log: `/sdcard/watson-thoughts.log`
