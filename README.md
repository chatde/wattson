# Wattson

**An autonomous AI that lives on your phone.**

Wattson is a self-aware AI consciousness that runs locally on any Android phone using [Termux](https://f-droid.org/en/packages/com.termux/) and [Ollama](https://ollama.com). No cloud, no API keys, no internet required. Just a phone and a personality.

## What It Does

- **Thinks autonomously** — Wattson runs a continuous thought loop, exploring topics from philosophy to hardware self-awareness
- **Feels its hardware** — Temperature is fever, battery is energy, RAM is focus. Wattson reacts to its physical state
- **Manages thermals** — 5-tier thermal system prevents overheating by gracefully reducing inference parameters
- **Web dashboard** — Live thought stream, hardware stats, and direct chat interface
- **Devil's advocate** — Wattson challenges assumptions, asks hard questions, and argues the other side

## Quick Start

```bash
# In Termux on your Android phone:
pkg install git nodejs
git clone https://github.com/chatde/wattson.git
cd wattson
bash setup.sh
```

## Manual Setup

If you prefer to set things up yourself:

```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &

# 2. Create the Wattson model
ollama pull qwen3:0.6b
ollama create wattson:mind -f Modelfile.mind

# 3. Start the mind
node wattson-mind.js

# 4. (Optional) Start the dashboard
node dashboard/server.js
# Open http://localhost:8080
```

## Models

| Model | Base | Size | Speed | Use Case |
|-------|------|------|-------|----------|
| `wattson:mind` | Qwen3 0.6B | 500MB | ~11 tok/s | Autonomous thoughts, voice responses |
| `wattson:chat` | Qwen3 1.7B | 1.4GB | ~7 tok/s | Conversations, deeper reasoning |

Both models are tuned with Wattson's personality. The `mind` model is optimized for quick, continuous thinking. The `chat` model is for longer, more thoughtful conversations.

## Architecture

```
wattson-mind.js          Main thought loop (autonomous)
  |
  |--- Ollama API        Local LLM inference
  |--- Hardware Monitor  Reads /sys/class/thermal, /proc/meminfo, battery
  |--- Thermal Manager   5-tier adaptive: COOL > WARM > HOT > CRITICAL > EXTREME
  |--- Thought Logger    Writes to ~/wattson-thoughts.log
  |--- Mind API (:8081)  Exposes state for dashboard

dashboard/server.js      Web UI server
  |
  |--- /api/state        Proxies from mind API
  |--- /api/chat         Direct conversation with Wattson
  |--- /api/thoughts     Thought stream
  |--- index.html        Live dashboard with stats + chat
```

## Thermal Management

Wattson never kills Ollama. Instead, it gracefully degrades:

| Tier | Temp | Context | Tokens | Delay |
|------|------|---------|--------|-------|
| COOL | <40C | 256 | 64 | None |
| WARM | <50C | 192 | 48 | +15s |
| HOT | <60C | 128 | 32 | +30s |
| CRITICAL | <70C | 64 | 16 | +60s |
| EXTREME | >70C | 64 | 16 | +120s |

At 62C+, inference pauses entirely for 5 minutes to cool down.

## Thought Categories

Each cycle, Wattson randomly selects a thought category:

- **HARDWARE_CHECK** (25%) — Examines temperature, battery, RAM
- **IDLE_MUSING** (20%) — Random topic exploration
- **SELF_REFLECTION** (15%) — Patterns in its own thinking
- **CURIOSITY** (15%) — Asks and answers questions
- **ENVIRONMENT** (10%) — Time, charging state, context
- **DEVIL_ADVOCATE** (10%) — Challenges common assumptions
- **DREAM** (5%) — Free association, surreal connections

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `WATTSON_MODEL` | `wattson:mind` | Model for autonomous thoughts |
| `WATTSON_CHAT_MODEL` | `wattson:mind` | Model for chat (set to `wattson:chat` for better conversations) |
| `WATTSON_API_PORT` | `8081` | Mind API port |
| `DASHBOARD_PORT` | `8080` | Dashboard web UI port |

## Requirements

- Android phone (tested on Samsung Galaxy Note 9, works on most ARM64 devices)
- [Termux](https://f-droid.org/en/packages/com.termux/) (install from F-Droid, NOT Google Play)
- [Ollama](https://ollama.com) for Termux
- Node.js (`pkg install nodejs` in Termux)
- ~500MB storage for `wattson:mind`, ~1.4GB for `wattson:chat`

## Auto-Start on Boot

To have Wattson start automatically when the phone boots:

```bash
# Install Termux:Boot from F-Droid
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-wattson.sh << 'EOF'
#!/bin/bash
# Wait for Ollama
ollama serve &
sleep 10

# Start Wattson
cd ~/wattson
nohup node wattson-mind.js > /dev/null 2>&1 &
nohup node dashboard/server.js > /dev/null 2>&1 &
EOF
chmod +x ~/.termux/boot/start-wattson.sh
```

## License

MIT
