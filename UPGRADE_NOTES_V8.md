# VoxLedger v8.0 — Intelligent Assistant Upgrade

## Summary
This release transforms VoxLedger's voice assistant from a fixed-command system into
a truly intelligent, natural-language assistant — similar to Google Assistant or Siri,
but focused entirely on your personal finance app.

---

## What Changed

### 1. AI-Powered Intent Understanding (NEW — `utils/ai_intent.py`)

**Before:** Rigid keyword matching. "Hey Vox, I paid two hundred bucks for food" might
not be understood. Only exact or near-exact phrases worked.

**After:** Claude Haiku AI understands natural speech variations:
- Imperfect English: "I spend two fifty on grocery today"
- Varied phrasing: "what money I have left", "how much did I use this month"
- Follow-up context: If you asked about food spending, "and what about transport?" works
- Graceful fallback: If Claude API is unavailable, keyword parser runs as before — zero downtime

**How it works:**
- Keyword parser runs first (fast, no API call)
- If result is "unknown" or "off_topic", Claude Haiku is called with recent conversation history
- Response parsed as structured JSON intent, mapped to existing executor
- Total added latency: ~300–600ms only when keyword parser fails

---

### 2. Voice Authentication Improvements (`services/voice_auth_service.py`)

**Before:** Could sometimes authenticate background voices or TV audio.

**After:**
- **Spectral entropy check**: TV/music has high spectral entropy (many simultaneous frequencies). Live human voice has lower, more focused spectral entropy. Audio above threshold 0.85 is rejected.
- **Quality gate before embedding comparison**: `analyze_audio_quality()` now runs before `_extract_embedding()` during verification — not just registration.
- **Adaptive threshold**: Users with 1 sample get a slightly more lenient threshold (−0.02) since single samples have higher natural variability. Users with multiple samples use the standard threshold.
- **Better rejection messages**: Specific guidance when similarity is low vs very low.

---

### 3. Stop vs Mute — Properly Differentiated (`routes/voice_routes.py`, `Layout.tsx`)

**Before:** "stop" and "mute" had overlapping behaviour and inconsistent effects.

**After — clear separation:**

| Command | Effect on Speech | Effect on Actions | Persistent? |
|---|---|---|---|
| **"stop"** | Cancels current speech immediately | Actions keep running | ❌ No — next response speaks |
| **"mute assistant"** / **"mute Vox"** | Silences current + all future speech | Actions keep running | ✅ Yes — until "unmute assistant" |
| **"unmute assistant"** | Resumes speech for future responses | N/A | Clears mute |

- Mute patterns now require more specific phrases to avoid accidental muting:
  - "mute assistant", "mute Vox", "go silent", "be quiet", "quiet please"
- Stop patterns are simpler: "stop", "enough", "no more", "shush"

---

### 4. Whisper STT Improvements (`services/whisper_service.py`)

- Expanded noise rejection patterns: `[Music]`, `(inaudible)`, lone number words, exact repetitions
- Expanded STT corrections: "fox ledger" → VoxLedger, "fooding" → food, number word edge cases
- Tightened `no_speech_threshold` 0.50 → 0.45
- Tightened `compression_ratio_threshold` 2.2 → 2.0
- Single-word sanity check: lone words that aren't finance commands are rejected as noise
- Updated `initial_prompt` includes stop/mute vocabulary for better recognition

---

### 5. VAD Improvements (`Layout.tsx`)

| Parameter | v7 | v8 | Effect |
|---|---|---|---|
| `SPEECH_ON_TICKS` | 3 (~210ms) | 4 (~280ms) | Fewer false triggers from short sounds |
| `SILENCE_OFF_TICKS` | 4 (~280ms) | 5 (~350ms) | Less likely to cut off slow speakers |
| `MIN_SEND_BYTES` | 2000 | 3000 | Rejects very short noise bursts |
| `CALIBRATION_TICKS` | 10 (~700ms) | 14 (~1s) | Better ambient noise floor measurement |
| `NOISE_HEADROOM` | 2.0 (100%) | 2.3 (130%) | More separation from ambient noise |
| `MIN_THRESHOLD` | 14 | 18 | Harder minimum floor for quiet environments |

---

### 6. UI/UX Improvements (`Layout.tsx`)

- Modal now shows **"AI Thinking…"** during processing (not "Processing…")
- Status pill shows **"AI processing…"** during API calls
- Full response text shown (not truncated at 90 chars)
- Mute button label changed to **"Mute Assistant"** / **"Unmute Assistant"**
- Mute state description: "Say 'unmute assistant' or tap below to resume voice responses. Actions continue silently."
- Muted state title: "Muted — Actions Still Running"

---

## Files Changed

| File | Change |
|---|---|
| `utils/ai_intent.py` | **NEW** — AI-powered intent resolver using Claude Haiku |
| `routes/voice_routes.py` | AI fallback integration, stop/mute separation, mute action result |
| `services/voice_auth_service.py` | Spectral entropy check, quality gate on verify, adaptive threshold |
| `services/whisper_service.py` | Better noise rejection, STT corrections, single-word sanity check |
| `config.py` | Version bump 7.0.0 → 8.0.0 |
| `client/components/Layout.tsx` | VAD constants, stop/mute separation, AI UI states |

---

## Nothing Removed

All existing features remain intact:
- Voice authentication and registration
- All intent types (add expense, set budget, navigate, etc.)
- Pending intent slot-filling (multi-turn conversations)
- Wake phrase detection
- TTS playback
- Conversation history
- All navigation and data operations

---

## Running the App

No changes to startup procedure. Same commands as v7:

```bash
# Backend
cd voxledger-app/VoxLedger_backend
./start_backend.sh

# Frontend
cd voxledger-app/VoxLedger_frontend
./start_frontend.sh
```

The AI intent resolver (`utils/ai_intent.py`) calls the Anthropic API at
`https://api.anthropic.com/v1/messages`. It only triggers when the keyword parser
returns "unknown" — so it does not increase latency for normal well-formed commands.
If the API is unreachable, it silently falls back to the keyword parser.
