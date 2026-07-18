# VoxLedger v12 — True Voice-First Intelligent Assistant Upgrade Notes

## Summary

v12 upgrades VoxLedger into a true voice-first intelligent assistant without breaking any existing UI design or working features.

---

## Mandatory App Flow (Confirmed Working)

```
Splash Screen
  ├── User registered? → Locked Screen
  └── Not registered? → Registration → Wake Phrase Setup → Locked Screen → Dashboard
```

---

## Changes by File

### `VoxLedger_frontend/client/pages/WakePhraseSetup.tsx` (v5.0)

**Tap-first Default vs Custom choice:**
- Two large tap buttons shown immediately: **"Use Hey Vox (Default)"** and **"Custom Phrase"**
- Voice confirmation also works in parallel — say "yes" or "no" after TTS
- Custom flow: records phrase → transcribes → confirms → saves
- Skipping: "Skip — use Hey Vox instead" link always visible during recording
- Auth mode stored: `"default"` (keyword match) vs `"custom"` (voice identity only)
- All navigation only after TTS completes (onended callbacks)
- Microphone fully stopped before navigation
- 600ms gap after TTS before mic opens
- recDoneRef prevents double-processing

### `VoxLedger_frontend/client/components/Layout.tsx` (v12.0)

**5-state voice machine with complete state coverage:**

| State | Label | Color | Trigger |
|-------|-------|-------|---------|
| `idle` | — | — | Not authenticated |
| `ready` | Ready | Emerald | Mic on, waiting |
| `speech` | Listening | Primary/Blue | Voice activity detected |
| `processing` | Thinking | Amber | AI parsing intent |
| `working` | Processing | Violet | Action executing |
| `speaking` | Speaking | Emerald | TTS playing |

- `"Working"` (violet) is a brand-new state shown when the assistant has understood the command and is now executing the action (e.g. saving a transaction, navigating)
- State label always visible below FAB mic button with animated dot
- Modal updated with all 5 state labels, colours, and descriptions
- `Muted` shown when assistant is silenced

### `VoxLedger_frontend/client/pages/Registration.tsx` (v12.0)

**Real-time voice quality feedback during name recording:**
- Waveform interval now shows live quality hint:
  - `✓ Good voice detected — keep speaking` (green) when RMS > 0.05
  - `Voice detected — speak a bit louder` when RMS > 0.015
  - `Too quiet — please speak louder` when RMS > 0.005
- Quality text shown below the waveform bars during active recording
- Helps users self-correct before submitting poor audio

### `VoxLedger_backend/routes/voice_routes.py` (v12.0)

**Positional alert reading:**
- `read_alerts` now supports: `"read first alert"`, `"read second alert"`, `"read latest alert"`, `"read last alert"`, etc.
- Ordinal map covers: first/1st, second/2nd, third/3rd, fourth/4th, fifth/5th, last/latest/recent/newest, earliest/oldest
- Falls back to listing all alerts if no ordinal specified
- Shows count hint: "And 2 more. Say 'read second alert' for a specific one."

**Context-aware greeting:**
- `greeting` intent now includes today's spending snapshot: "You've spent ₹X today and your balance is ₹Y."
- If no expenses today: "No expenses logged today yet."

**Comprehensive help response:**
- `help` intent now covers all features: expenses, income, balance, budget, alerts, navigation, delete, insights, voice controls (stop/mute/unmute)

---

## Features Already Working (Unchanged)

All of the following were already fully implemented and are preserved:

- ✅ Voice authentication on lock screen (MFCC cosine similarity)
- ✅ Noise / silence / background audio rejection
- ✅ AI-powered NLP via Claude Haiku (natural language, imperfect English)
- ✅ Keyword parser fallback when AI unavailable
- ✅ Mute (silence future TTS, actions continue) vs Stop (cancel current speech)
- ✅ Add / update / delete transactions by voice
- ✅ Set / delete budgets and income
- ✅ Query spending by date, category, period
- ✅ Navigate to any page by voice
- ✅ Read notifications by position (first/second/last)
- ✅ Delete transactions with confirmation step
- ✅ Create custom categories
- ✅ Toggle dark/light mode
- ✅ Always-on VAD (no button press needed)
- ✅ Auto-lock after inactivity
- ✅ Wake phrase detection (Hey Vox or custom)
- ✅ Full conversation history

---

## How to Run

### Backend
```bash
cd VoxLedger_backend
pip install -r requirements.txt
python main.py
```

### Frontend
```bash
cd VoxLedger_frontend
npm install
npm run dev
```

The frontend proxies `/voice/*` to `http://localhost:8000` via Vite config.

---

## Environment Variables

Backend reads from `.env` or environment:
- `ANTHROPIC_API_KEY` — for Claude Haiku intent parsing
- `VOICE_SIMILARITY_THRESHOLD` — cosine similarity cutoff (default: 0.72)
- `WHISPER_MODEL` — Whisper model size (default: tiny)
