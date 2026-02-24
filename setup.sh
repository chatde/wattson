#!/bin/bash
# Wattson Setup Script — Run this on your Android phone in Termux
# Installs Ollama, pulls the model, creates Wattson, and starts the mind

set -e

echo "=========================================="
echo "  WATTSON — Autonomous Phone AI"
echo "=========================================="
echo ""

# ─── Check Termux ────────────────────────────────────────────────────────────
if [ ! -d "$HOME/.termux" ]; then
  echo "ERROR: This script must be run in Termux on Android."
  echo "Install Termux from F-Droid: https://f-droid.org/en/packages/com.termux/"
  exit 1
fi

echo "[1/6] Updating packages..."
pkg update -y && pkg upgrade -y

echo "[2/6] Installing dependencies..."
pkg install -y nodejs openssh termux-api curl

# ─── Install Ollama ──────────────────────────────────────────────────────────
echo "[3/6] Installing Ollama..."
if command -v ollama &> /dev/null; then
  echo "  Ollama already installed."
else
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Start Ollama if not running
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  echo "  Starting Ollama..."
  ollama serve &
  sleep 5
fi

# ─── Pull Base Model ─────────────────────────────────────────────────────────
echo "[4/6] Pulling Qwen3 0.6b model (~500MB)..."
ollama pull qwen3:0.6b

# ─── Create Wattson ──────────────────────────────────────────────────────────
echo "[5/6] Creating Wattson personality..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ollama create wattson:mind -f "$SCRIPT_DIR/Modelfile.mind"
echo "  wattson:mind created."

# Optional: Pull larger model for chat
echo ""
read -p "Also install wattson:chat (1.4GB, smarter but slower)? [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "  Pulling Qwen3 1.7b..."
  ollama pull qwen3:1.7b
  ollama create wattson:chat -f "$SCRIPT_DIR/Modelfile.chat"
  echo "  wattson:chat created."
fi

# ─── Setup Complete ──────────────────────────────────────────────────────────
echo ""
echo "[6/6] Setup complete!"
echo ""
echo "=========================================="
echo "  To start Wattson:"
echo "    node wattson-mind.js"
echo ""
echo "  To view the dashboard:"
echo "    node dashboard/server.js"
echo "    Open http://localhost:8080 in a browser"
echo ""
echo "  To talk to Wattson directly:"
echo "    ollama run wattson:mind"
echo "=========================================="
