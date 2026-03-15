#!/bin/bash
# push-watson.sh — Deploy Watson evolution code from Mac to Note 9 via ADB
# Run from: /Volumes/AI-Models/wattson/
# Requires: adb connected (USB cable, or `adb connect 192.168.4.32:5555` for WiFi)

set -e

PHONE_HOME=/data/data/com.termux/files/home
PHONE_SD=/storage/7000-8000
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[push]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Watson Evolution — Mac → Note 9 Push  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Check ADB ─────────────────────────────────────────────────────────
log "Checking ADB connection..."
if ! adb devices | grep -q "device$"; then
  warn "No ADB device found. Try:"
  warn "  USB: plug in cable, run: adb devices"
  warn "  WiFi: adb connect 192.168.4.32:5555 (if WiFi ADB enabled)"
  exit 1
fi
DEVICE=$(adb devices | grep "device$" | head -1 | cut -f1)
log "Connected to: $DEVICE"

# ── Step 2: Ensure phone directories exist ────────────────────────────────────
log "Creating phone directories..."
adb shell "mkdir -p $PHONE_HOME/watson-plugins"
adb shell "mkdir -p $PHONE_HOME/watson-memory"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/philosophy"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/religion"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/science"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/art"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/history"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/practical"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/music"
adb shell "mkdir -p $PHONE_HOME/watson-knowledge/web"
adb shell "mkdir -p $PHONE_HOME/watson-dashboard"
adb shell "mkdir -p $PHONE_SD/watson-memory"
adb shell "mkdir -p $PHONE_SD/watson-creations/diary"
adb shell "mkdir -p $PHONE_SD/watson-creations/poems"
adb shell "mkdir -p $PHONE_SD/watson-creations/essays"
adb shell "mkdir -p $PHONE_SD/watson-creations/lyrics"
adb shell "mkdir -p $PHONE_SD/watson-creations/dreams"
adb shell "mkdir -p $PHONE_SD/watson-creations/art-prompts"
adb shell "mkdir -p $PHONE_SD/watson-patches"
adb shell "mkdir -p $PHONE_SD/watson-compositions"
adb shell "mkdir -p $PHONE_SD/watson-spaces"

# ── Step 3: Stop Watson processes ─────────────────────────────────────────────
log "Stopping Watson processes on phone..."
adb shell "pkill -f watson-core.js 2>/dev/null || true"
adb shell "pkill -f wattson-mind.js 2>/dev/null || true"
adb shell "pkill -f watson-phone-control.js 2>/dev/null || true"
sleep 1

# ── Phase 1-6 directories ────────────────────────────────────────────────────
log "Creating Phase 1-6 directories..."
adb shell "mkdir -p $PHONE_HOME/watson-tools/tools"
adb shell "mkdir -p $PHONE_HOME/watson-tools/skills"
adb shell "mkdir -p /sdcard/watson-vault/meta"
adb shell "mkdir -p /sdcard/watson-vault/goals"
adb shell "mkdir -p /sdcard/watson-vault/discoveries"
adb shell "mkdir -p /sdcard/watson-vault/experiences"
adb shell "mkdir -p /sdcard/watson-vault/experiments"

# ── Step 4: Push core brain + study daemon ────────────────────────────────────
log "Pushing watson-core.js..."
adb push "$LOCAL_DIR/watson-core.js" "$PHONE_HOME/watson-core.js"

log "Pushing watson-study-daemon.js..."
adb push "$LOCAL_DIR/watson-study-daemon.js" "$PHONE_HOME/watson-study-daemon.js"

# ── Phase 1: Brain module ─────────────────────────────────────────────────────
log "Pushing Phase 1: watson-brain.js..."
adb push "$LOCAL_DIR/watson-brain.js" "$PHONE_HOME/watson-brain.js"

# ── Phase 6: Priority queue ───────────────────────────────────────────────────
log "Pushing Phase 6: watson-priority-queue.js..."
adb push "$LOCAL_DIR/watson-priority-queue.js" "$PHONE_HOME/watson-priority-queue.js"

# ── Step 5: Push plugins ──────────────────────────────────────────────────────
log "Pushing watson-plugins/..."
for plugin in "$LOCAL_DIR/watson-plugins/"*.plugin.js; do
  name=$(basename "$plugin")
  log "  → $name"
  adb push "$plugin" "$PHONE_HOME/watson-plugins/$name"
done

# ── Step 6: Push memory modules ───────────────────────────────────────────────
log "Pushing watson-memory/..."
for f in episodic.js semantic.js emotions.js; do
  if [ -f "$LOCAL_DIR/watson-memory/$f" ]; then
    adb push "$LOCAL_DIR/watson-memory/$f" "$PHONE_HOME/watson-memory/$f"
    log "  → $f"
  fi
done

# ── Step 7: Push knowledge files ─────────────────────────────────────────────
log "Pushing watson-knowledge/..."
for domain in philosophy religion science art history practical music; do
  if [ -d "$LOCAL_DIR/watson-knowledge/$domain" ]; then
    for kfile in "$LOCAL_DIR/watson-knowledge/$domain/"*.md; do
      [ -f "$kfile" ] || continue
      name=$(basename "$kfile")
      adb push "$kfile" "$PHONE_HOME/watson-knowledge/$domain/$name"
      log "  → $domain/$name"
    done
  fi
done

# ── watson-tools/ (all .js and .json files) ──────────────────────────────────
log "Pushing watson-tools/..."
for toolfile in "$LOCAL_DIR/watson-tools/"*.js "$LOCAL_DIR/watson-tools/"*.json; do
  [ -f "$toolfile" ] || continue
  name=$(basename "$toolfile")
  log "  → $name"
  adb push "$toolfile" "$PHONE_HOME/watson-tools/$name"
done
if [ -d "$LOCAL_DIR/watson-tools/tools" ]; then
  for toolfile in "$LOCAL_DIR/watson-tools/tools/"*.tool.js; do
    [ -f "$toolfile" ] || continue
    name=$(basename "$toolfile")
    log "  → tools/$name"
    adb push "$toolfile" "$PHONE_HOME/watson-tools/tools/$name"
  done
fi

# ── Step 8: Push phone control ────────────────────────────────────────────────
log "Pushing watson-phone-control.js..."
adb push "$LOCAL_DIR/watson-phone-control.js" "$PHONE_HOME/watson-phone-control.js"

# ── Step 9: Push dashboard ────────────────────────────────────────────────────
# Note: /data/data/com.termux/ requires staging via /sdcard + run-as cp
log "Pushing dashboard/..."
if [ -f "$LOCAL_DIR/dashboard/server.js" ]; then
  adb push "$LOCAL_DIR/dashboard/server.js" /sdcard/watson-server.js
  adb shell run-as com.termux cp /sdcard/watson-server.js "$PHONE_HOME/watson-dashboard/server.js"
  log "  → server.js"
fi
if [ -f "$LOCAL_DIR/dashboard/index.html" ]; then
  adb push "$LOCAL_DIR/dashboard/index.html" /sdcard/watson-index.html
  adb shell run-as com.termux cp /sdcard/watson-index.html "$PHONE_HOME/watson-dashboard/index.html"
  log "  → index.html"
fi

# ── Step 10: Start Watson core ────────────────────────────────────────────────
log "Starting watson-core.js on phone..."
NODE_BIN=/data/data/com.termux/files/usr/bin/node
adb shell "run-as com.termux $NODE_BIN $PHONE_HOME/watson-core.js > /sdcard/watson-core.log 2>&1 &"
sleep 2

# ── Step 11: Start phone control ──────────────────────────────────────────────
log "Starting watson-phone-control.js on phone..."
adb shell "run-as com.termux $NODE_BIN $PHONE_HOME/watson-phone-control.js > /sdcard/watson-phone-control.log 2>&1 &"
sleep 1

# ── Step 12: Start dashboard ─────────────────────────────────────────────────
log "Starting dashboard on phone..."
adb shell "run-as com.termux $NODE_BIN $PHONE_HOME/watson-dashboard/server.js > /sdcard/watson-dashboard.log 2>&1 &"
sleep 1

# ── Step 13: Verify ───────────────────────────────────────────────────────────
log "Verifying..."
sleep 3

CORE_RUNNING=$(adb shell "pgrep -f watson-core.js 2>/dev/null || echo ''")
CTRL_RUNNING=$(adb shell "pgrep -f watson-phone-control.js 2>/dev/null || echo ''")
DASH_RUNNING=$(adb shell "pgrep -f 'watson-dashboard/server' 2>/dev/null || echo ''")

if [ -n "$CORE_RUNNING" ]; then
  log "watson-core.js running (PID $CORE_RUNNING)"
else
  err "watson-core.js NOT running. Check: adb shell tail -20 ~/watson-core.log"
fi

if [ -n "$CTRL_RUNNING" ]; then
  log "watson-phone-control.js running (PID $CTRL_RUNNING)"
else
  warn "watson-phone-control.js not running (may need Termux:API)"
fi

if [ -n "$DASH_RUNNING" ]; then
  log "Dashboard running (PID $DASH_RUNNING)"
else
  warn "Dashboard not running. Check: adb shell tail -20 ~/watson-dashboard.log"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Watson Evolution DEPLOYED              ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Monitor logs:"
echo "  adb shell tail -f ~/watson-core.log"
echo "  adb shell tail -f ~/watson-phone-control.log"
echo ""
echo "Forward dashboard port:"
echo "  adb forward tcp:8080 tcp:8080"
echo "  open http://127.0.0.1:8080"
echo ""
echo "ADB shell into phone:"
echo "  adb shell"
