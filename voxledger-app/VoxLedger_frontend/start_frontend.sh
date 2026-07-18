#!/usr/bin/env bash
# ── VoxLedger Frontend Startup Script (v3.0) ─────────────────────────────────
set -e
cd "$(dirname "$0")"

echo "🌐  VoxLedger Frontend v3.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -d "node_modules" ]; then
    echo "📦 Installing npm packages..."
    npm install
fi

echo "🚀 Starting Vite dev server on http://localhost:5173 ..."
npm run dev
