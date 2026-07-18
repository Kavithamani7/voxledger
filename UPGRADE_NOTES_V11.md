# VoxLedger v11.0 — Full Intelligent Assistant Upgrade

## Summary of All Changes

---

## 1. Correct App Flow (Cleaned Up)

**File:** `VoxLedger_frontend/client/App.tsx`

- Enforced the exact required flow: **Splash → Registration → Wake Phrase Setup → Locked → Dashboard**
- Removed `AddVoiceProfile` from the onboarding flow (it remains accessible from Profile page)
- `SetupGuard` ensures `/wake-phrase-setup` is only reachable after registration completes
- `ProtectedRoute` enforces authentication for all dashboard routes
- `AutoLockManager` locks the app after 60s of inactivity and redirects to `/locked`

---

## 2. User Registration (Voice-First)

**File:** `VoxLedger_frontend/client/pages/Registration.tsx` (already v6.0, preserved)

Flow:
1. TTS asks user to say: *"My name is [Name], I will use this voice to access this app"*
2. Audio recorded (7s), quality-gated (MIN_RMS + MIN_BYTES)
3. Sent to `/auth/extract-name-from-voice` → name extracted
4. User confirms via voice ("yes"/"no") or tap buttons
5. Backend user created, name-phrase saved as **voice embedding #1**
6. Wake-phrase recording step: user says "Hey Vox" → saved as **voice embedding #2**
7. Navigates to Wake Phrase Setup

Both embeddings are critical — without the wake-phrase embedding, lock screen would always fail because it compares "Hey Vox" against a name-phrase embedding (acoustic mismatch).

---

## 3. Wake Phrase Setup

**File:** `VoxLedger_frontend/client/pages/WakePhraseSetup.tsx`

- **Option A (Default):** User says "yes" → uses "Hey Vox" as fixed phrase
  - Stored: `vox_wake_phrase = "hey vox"`, `vox_auth_mode = "default"`
- **Option B (Custom):** User says "no" → records any sentence as phrase
  - Stored: `vox_wake_phrase = <custom>`, `vox_auth_mode = "custom"`
  - Authentication on locked screen relies on **voice identity**, not exact phrase matching

Both choices trigger voice confirmation before saving.

---

## 4. Locked Screen Authentication

**File:** `VoxLedger_frontend/client/pages/Locked.tsx`

Improvements:
- Reads `vox_auth_mode` from localStorage to show correct unlock hint:
  - Default mode: *"Say 'Hey Vox' to unlock"*
  - Custom mode: *"Say any sentence — I will recognise your voice to unlock"*
- All rejection cases handled with specific messages:
  - Noise / silence → "Audio too short, please try again"
  - Voice mismatch → "Voice did not match. Only the registered user can unlock"
  - Low confidence → "Voice similarity too low, please speak clearly"

Access rules:
- ✅ Registered voice = unlock
- ❌ Noise, silence, background voice, TV audio, other person = denied

---

## 5. Intelligent Assistant — AI-First Intent Parsing

**Files:** `VoxLedger_backend/routes/voice_routes.py`, `VoxLedger_backend/utils/ai_intent.py`

### v11 Change: AI-First for All Commands

Previously, AI was only called as a fallback when keyword parser returned `"unknown"`. Now:

- **All commands go through AI first** (Claude Haiku via Anthropic API)
- Fast-path exception: if keyword parser finds a high-confidence match (amount + clear intent like `add_expense`), keyword result is used directly to avoid extra latency
- AI confidence threshold lowered 0.50 → 0.45 for better recall on imperfect English

### Supported Natural Language Queries

The assistant understands all of these (and many more variations):

**Balance / Spending:**
- "What is my balance?" / "How much do I have?"
- "Show my insights" / "Tell me about my spending"
- "What did I spend on Monday?" / "What happened yesterday?"
- "How much did I spend last week on food?"

**Transactions:**
- "Tell my latest transaction" / "Show last transaction"
- "Show transactions from yesterday" / "What did I spend last week?"
- "What is my transaction on 5th June?"

**Alerts / Notifications:**
- "Read first alert" / "Read the second alert"
- "Read latest alert" / "Read earlier alerts"

**Delete Actions:**
- "Delete first transaction" / "Delete last transaction"
- "Delete third transaction" / "Delete last food transaction"

**Navigation:**
- "Open budget" / "Go to transactions" / "Show alerts"

---

## 6. Stop / Mute / Unmute Behaviour

### Stop
- Phrase: "stop", "stop it", "pause", "hold on", "enough", "shush"
- Effect: Immediately cancels current voice response
- Resumes listening for next instruction
- Does NOT mute future responses
- In-flight actions (API calls) still complete

### Mute Assistant
- Phrase: "mute assistant", "mute vox", "go silent", "be quiet", "silence", "quiet please"
- Effect: Mutes ALL future voice output
- Actions still execute silently
- UI shows "Muted" state with grey FAB and VolumeX icon
- Persists until user unmutes

### Unmute Assistant
- Phrase: "unmute", "unmute assistant", "speak again", "resume", "voice on"
- Effect: Restores voice output
- Backend returns confirmation text, spoken immediately after unmuting
- UI returns to normal ready state

---

## 7. Live Assistant State Indicator

**File:** `VoxLedger_frontend/client/components/Layout.tsx`

New animated state label appears below the microphone FAB button, always visible while authenticated:

| State | Label | Colour | Animation |
|-------|-------|--------|-----------|
| ready | Ready | Green | Pulse dot |
| speech | Listening | Primary | Ping dot |
| processing | Thinking | Amber | Pulse dot |
| speaking | Speaking | Green | Pulse dot |
| muted | Muted | Grey | Static dot |

The label transitions smoothly with `AnimatePresence` / `motion.div`.

---

## 8. Voice Interaction Timing & State Flow

**File:** `VoxLedger_frontend/client/components/Layout.tsx`

```
Idle → (auth) → Ready
Ready → (speech detected for ~280ms) → Listening
Listening → (silence for ~210ms) → Processing  ← faster in v11 (was 350ms)
Processing → (API response) → Speaking/Ready
Speaking → (TTS ends or Stop command) → Ready
```

- **Faster response:** `SILENCE_OFF_TICKS` reduced 5→3, saves ~140ms per command
- **Double-send prevention:** VAD is suppressed during Processing state
- **No overlapping states:** Each state transition is guarded by `isSending.current`

---

## 9. Performance & Accuracy Improvements

| Area | v9 | v11 |
|------|----|-----|
| Intent understanding | Keyword-first, AI only on unknown | AI-first for all commands |
| Silence detection delay | ~350ms | ~210ms (SILENCE_OFF_TICKS 5→3) |
| Unmute support | Frontend only | Full frontend + backend |
| Auth mode awareness | None | Default vs Custom mode stored |
| Voice similarity threshold | 0.82 | 0.80 (better unlock reliability) |
| Max voice embeddings | 5 | 10 |
| TTS speed | 1.4x | 1.35x (more natural) |
| AI confidence threshold | 0.50 | 0.45 (better recall) |

---

## 10. UI Constraints — No Visual Changes

All UI changes in v11 are additive only:

- ✅ State label added **below** the FAB (new element, no existing UI moved)
- ✅ Modal interior text updated to reflect real-time state names
- ✅ Locked screen unlock hint updates based on auth mode (text change only)
- ✅ All existing gradients, colours, animations, components preserved
- ✅ Navigation bar unchanged
- ✅ All dashboard pages (Index, Transactions, Budget, Alerts, Profile, Notifications) unchanged

---

## Files Changed in v11

### Frontend
| File | Change |
|------|--------|
| `client/App.tsx` | Cleaned flow, removed AddVoiceProfile from onboarding |
| `client/components/Layout.tsx` | Live state indicator, unmute handling, faster VAD |
| `client/pages/Locked.tsx` | Auth mode awareness (default vs custom hint) |
| `client/pages/WakePhraseSetup.tsx` | Saves `vox_auth_mode` preference |

### Backend
| File | Change |
|------|--------|
| `config.py` | Version 11.0, threshold 0.82→0.80, max samples 5→10, TTS speed 1.4→1.35 |
| `routes/voice_routes.py` | AI-first parsing, unmute intent, BREAKING_INTENTS expanded |
| `utils/ai_intent.py` | More examples, confidence 0.50→0.45, unmute/mute intents |

---

## How to Run

### Backend
```bash
cd VoxLedger_backend
pip install -r requirements.txt
./start_backend.sh        # Linux/Mac
# OR
./start_backend.ps1       # Windows PowerShell
```

### Frontend
```bash
cd VoxLedger_frontend
npm install
./start_frontend.sh       # Linux/Mac
# OR
./start.ps1               # Windows PowerShell
```

### First Time Setup
1. Open app → Splash screen
2. Speak your name when prompted
3. Choose wake phrase (default "Hey Vox" or custom)
4. Say your wake phrase to unlock
5. Speak naturally to Vox — no button needed
