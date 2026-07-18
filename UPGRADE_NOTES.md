# VoxLedger v3.0 — Voice Assistant Upgrade Notes

## What Was Upgraded

### 1. Performance Optimization (< 2s Target)

| Component | Before | After |
|---|---|---|
| Whisper model | `small` (~1.5s) | `tiny` (~350ms) |
| TTS speed | 1.20x | 1.35x |
| VAD calibration | 10 ticks (~800ms) | 7 ticks (~490ms) |
| VAD silence cutoff | 4 ticks (~320ms) | 3 ticks (~210ms) |
| VAD poll interval | 80ms | 70ms |
| Pre-speech buffer | 800ms | 600ms |
| Audio timeout | 10s | 8s |

**Total improvement:** Typical voice command round-trip dropped from ~3–4s to **~1.5–2s**.

---

### 2. Fully Voice-Guided Registration (Zero Buttons / Zero Typing)

**File:** `client/pages/Registration.tsx`

- Page auto-starts on load with a TTS welcome instruction
- Recording begins automatically after TTS ends (no tap required)
- Name extracted via Whisper + NLP automatically
- TTS reads back detected name
- User says **"yes"** (confirm) or **"no"** (retry) — detected via Web Speech API
- If unclear, the system asks the user to try again (up to 3 attempts)
- After name confirmed, voice sample recording auto-starts
- Progress through all steps without touching the screen

---

### 3. Wake Phrase Setup Page (New)

**File:** `client/pages/WakePhraseSetup.tsx`

- Appears after successful registration
- Guides user to confirm default wake phrase **"Hey Vox"** or record a custom phrase
- Everything controlled by voice — say "yes" or "no"
- Wake phrase saved to `localStorage` for use in Locked screen and Layout

---

### 4. Upgraded Lock Screen

**File:** `client/pages/Locked.tsx`

- Auto-starts with TTS instruction on load (no tap needed)
- Shows the currently configured wake phrase
- Auto-retry after failed authentication with countdown
- Voice-guided retry instructions via TTS
- Stop listener via Web Speech API (say "stop" or "cancel" to abort)
- Faster loop: 3.5s recording (was 4.5s)

---

### 5. Always-Listening Voice Engine

**File:** `client/components/Layout.tsx`

- Unchanged core architecture (continuous mic + VAD)
- Tuned constants for faster response:
  - Silence detection: 3 ticks instead of 4 (saves ~80ms per command)
  - Calibration: 7 ticks instead of 10 (saves ~240ms startup time)
  - VAD interval: 70ms instead of 80ms (more responsive)
- All existing voice commands and navigation preserved

---

### 6. Voice Commands Preserved

All existing voice commands continue to work:
- `Hey Vox, add 200 for food`
- `Show my balance`
- `Open budget`
- `Set food budget to 3000`
- `Delete last transaction`
- `Show notifications`
- `Mute` / `Unmute`
- `Stop` (interrupt TTS instantly)
- Dark mode toggle
- Navigation to all pages

---

### 7. Mute / Unmute Behavior

- **"Mute"** → stops TTS voice output only; actions still execute silently
- **"Unmute"** → resumes voice responses
- No change from v2.0 — fully preserved

---

### 8. Stop Command

- Saying **"stop"** immediately interrupts any ongoing TTS
- Works via both Web Speech API (real-time) and Whisper pipeline
- No change from v2.0 — fully preserved

---

## App Flow (v3.0)

```
[Splash Screen]
      ↓
  ┌──────────────────────────┐
  │ Registered user?         │
  │  YES → [Lock Screen]     │
  │  NO  → [Registration]    │
  └──────────────────────────┘
         ↓ (new user)
  [Registration — Voice Only]
   • TTS guides every step
   • Whisper extracts name
   • Yes/No via Web Speech API
         ↓
  [Wake Phrase Setup — Voice Only]
   • "Hey Vox" (default) or custom
   • Confirmed by voice
         ↓
  [Greeting Page]
   • TTS welcome message
         ↓
  [Dashboard + Always-Listening Vox]
   • Continuous mic
   • VAD detects speech
   • Whisper tiny STT
   • Intent parsing
   • TTS response
```

---

## Running the App

### Backend
```bash
cd VoxLedger_backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# OR
bash start_backend.sh
```

### Frontend
```bash
cd VoxLedger_frontend
npm install
npm run dev
# OR
bash start_frontend.sh
```

Open http://localhost:5173

---

## Requirements

- Python 3.10+
- Node.js 18+
- `ffmpeg` installed on system (required for audio conversion)
- Microphone permission in browser
- Modern browser (Chrome/Edge recommended for Web Speech API)

---

## Troubleshooting

| Issue | Fix |
|---|---|
| TTS not playing | Allow autoplay in browser; tap screen once to unblock |
| Name not detected | Speak clearly: "My name is Alice" |
| Voice auth fails | Re-register with `/registration` |
| Response slow | Ensure ffmpeg is installed; use Chrome |
| Mic not activating | Check browser mic permissions |
