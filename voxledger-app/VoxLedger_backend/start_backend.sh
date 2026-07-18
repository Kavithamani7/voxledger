#!/usr/bin/env bash
# ── VoxLedger Backend Startup Script (v3.0) ──────────────────────────────────
# Performance: Whisper tiny model pre-loaded at startup for <400ms STT
# Run this from the VoxLedger_backend directory.

set -e
cd "$(dirname "$0")"

echo "🎙  VoxLedger Backend v3.0 — Voice-First Finance Assistant"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Create required directories
mkdir -p database/voice_samples database/tts_cache

# Install dependencies if missing
if ! python -c "import fastapi" 2>/dev/null; then
    echo "📦 Installing Python dependencies..."
    pip install -r requirements.txt
fi

echo "🚀 Starting server on port 8000..."
echo "   Whisper model: tiny  (optimised for <2s response)"
echo "   TTS speed:     1.35x (fast, natural delivery)"
echo ""

uvicorn main:app --reload --port 8000 --host 0.0.0.0
