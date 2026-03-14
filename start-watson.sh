#!/data/data/com.termux/files/usr/bin/bash
# start-watson.sh — Start Watson Evolution stack on Note 9
# Run from Termux: bash ~/start-watson.sh
# This replaces the old wattson-mind.js boot sequence

TERMUX_HOME=/data/data/com.termux/files/home
NODE=/data/data/com.termux/files/usr/bin/node
PROOT=/data/data/com.termux/files/usr/bin/proot-distro
OLLAMA_IN_PROOT=/usr/local/bin/ollama
OLLAMA_URL=http://127.0.0.1:11434

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Watson Evolution — Starting Up         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Kill stale processes ─────────────────────────────────────────────
echo "[1/6] Stopping any stale Watson processes..."
pkill -f "watson-core.js" 2>/dev/null && echo "  Stopped watson-core.js" || true
pkill -f "wattson-mind.js" 2>/dev/null && echo "  Stopped wattson-mind.js (old)" || true
pkill -f "watson-phone-control.js" 2>/dev/null && echo "  Stopped watson-phone-control.js" || true
pkill -f "watson-dashboard" 2>/dev/null && echo "  Stopped dashboard" || true
sleep 1

# ── Step 2: Start Ollama ──────────────────────────────────────────────────────
echo "[2/6] Starting Ollama..."
if curl -sf $OLLAMA_URL/api/tags > /dev/null 2>&1; then
  echo "  Ollama already running"
else
  OLLAMA_HOST=0.0.0.0:11434 nohup $PROOT login ubuntu -- $OLLAMA_IN_PROOT serve \
    > $TERMUX_HOME/ollama-proot.log 2>&1 &
  echo "  Ollama starting (PID $!)"
  for i in $(seq 1 20); do
    if curl -sf $OLLAMA_URL/api/tags > /dev/null 2>&1; then
      echo "  Ollama ready after ${i}s"
      break
    fi
    sleep 3
  done
fi

# ── Step 3: Start Dashboard ───────────────────────────────────────────────────
echo "[3/6] Starting Dashboard server..."
cd $TERMUX_HOME/watson-dashboard 2>/dev/null || mkdir -p $TERMUX_HOME/watson-dashboard
nohup $NODE $TERMUX_HOME/watson-dashboard/server.js > $TERMUX_HOME/watson-dashboard.log 2>&1 &
DASH_PID=$!
echo "  Dashboard PID: $DASH_PID"
sleep 2

# ── Step 4: Start Watson Core (new plugin brain) ──────────────────────────────
echo "[4/6] Starting watson-core.js (plugin brain)..."
cd $TERMUX_HOME
nohup $NODE $TERMUX_HOME/watson-core.js > $TERMUX_HOME/watson-core.log 2>&1 &
CORE_PID=$!
echo "  Watson Core PID: $CORE_PID"
sleep 2

# ── Step 5: Start Phone Control daemon ────────────────────────────────────────
echo "[5/6] Starting watson-phone-control.js..."
nohup $NODE $TERMUX_HOME/watson-phone-control.js > $TERMUX_HOME/watson-phone-control.log 2>&1 &
CTRL_PID=$!
echo "  Phone Control PID: $CTRL_PID"
sleep 1

# ── Step 5.5: Start Voice Daemon ──────────────────────────────────────────────
echo "[5.5/6] Starting watson-voice-daemon.js (wake word listener)..."
nohup $NODE $TERMUX_HOME/watson-voice-daemon.js >> /sdcard/wattson-voice.log 2>&1 &
VOICE_PID=$!
echo "  Voice Daemon PID: $VOICE_PID"
sleep 1

# ── Step 6: Verify ────────────────────────────────────────────────────────────
echo "[6/6] Verifying..."
sleep 3

if kill -0 $CORE_PID 2>/dev/null; then
  echo "  watson-core.js: RUNNING"
else
  echo "  watson-core.js: FAILED — check ~/watson-core.log"
fi

if kill -0 $DASH_PID 2>/dev/null; then
  echo "  Dashboard: RUNNING at http://127.0.0.1:8080"
else
  echo "  Dashboard: FAILED — check ~/watson-dashboard.log"
fi

if kill -0 $CTRL_PID 2>/dev/null; then
  echo "  Phone Control: RUNNING"
else
  echo "  Phone Control: FAILED (may need Termux:API)"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Watson is ALIVE                        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Logs:"
echo "  tail -f ~/watson-core.log"
echo "  tail -f ~/watson-dashboard.log"
echo "  tail -f ~/watson-phone-control.log"
echo ""
echo "Dashboard: http://127.0.0.1:8080"
