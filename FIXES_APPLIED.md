# VoxLedger v5 — All Fixes Applied

## Correct App Flow (Enforced)
```
Splash Screen → Voice Registration → Wake Phrase Setup → Wake Phrase Authentication → Greeting → Dashboard
```

---

## Fix 1 — Registration Phrase (Registration.tsx)
**Before:** User spoke a generic sample phrase.  
**After:** User speaks a natural, identity-rich sentence:
> *"My name is [Name], I will use this voice to access this app."*

- This phrase captures the name **and** rich vocal data (intonation, rhythm, timbre) in one utterance.
- Recording duration extended to **7 seconds** to allow full phrase delivery.
- The name-phrase audio is saved as **Voice Embedding #1** (not discarded).

---

## Fix 2 — Two-Sample Voice Registration
**Before:** Only one voice sample was recorded and stored.  
**After:** Two embeddings are registered:
1. **Embedding #1** — The name-phrase recording (`"My name is X, I will use this voice…"`)
2. **Embedding #2** — The secure phrase recording (`"Hello VoxLedger. This is my secure voice sample…"`)

`MAX_VOICE_SAMPLES` set to `2` in `config.py`. Authentication uses the top-2 average similarity for robustness.

---

## Fix 3 — Name Extraction (auth_routes.py)
**Before:** Greedy regex captured the full sentence after "my name is", returning names like "Alice I Will Use This Voice…"  
**After:** New clause-boundary patterns stop at `, I will…` or similar clause starters, extracting only the actual name (e.g. `"Alice"`).

---

## Fix 4 — Navigation Flow (WakePhraseSetup.tsx)
**Before:** After wake-phrase setup, app navigated directly to `/greeting` — **bypassing authentication entirely**.  
**After:** After wake-phrase setup, app navigates to `/locked` (Wake Phrase Authentication Page) — enforcing the correct flow.

---

## Fix 5 — Voice Quality Gate
- **MIN_RMS = 0.012** — rejects silent/very quiet recordings before sending to backend.
- **MIN_BYTES = 6000** — rejects partial or corrupt blobs.
- **700ms gap** after TTS ends before microphone opens — prevents TTS echo from being captured in recordings.
- Backend quality check (`analyze_audio_quality`) runs **before** embedding extraction — no noisy/silent embeddings are ever stored.

---

## Fix 6 — STT / TTS Isolation
- Microphone is **never opened while TTS is playing** (`isSpeakingRef` guard).
- Web Speech API (yes/no listener) starts **only after** TTS finishes.
- `SR.onend` restarts with **300ms delay** to prevent `InvalidStateError` in Chrome.
- All audio chunks are **fully cleared** between recording sessions.
- Mic stream tracks are **explicitly stopped** (`getTracks().forEach(t => t.stop())`) on every page transition.

---

## Fix 7 — Navigation Timing
- Navigation only fires **inside TTS `onended` callbacks** — never before the voice response finishes.
- No `setTimeout` hacks for navigation — all transitions are event-driven.

---

## Fix 8 — Voice Isolation Between Pages
- `cleanup()` called on every page unmount stops all mic streams, audio contexts, and SR instances.
- `chunksRef.current = []` reset on every new listening session.
- `mountedRef` guards all async callbacks — no state updates after component unmount.

---

## Fix 9 — Idle Timeout Security
- **90 seconds** of inactivity on the dashboard locks the app and redirects to `/locked`.
- `AutoLockManager` in `App.tsx` polls every 5s and checks `sessionStorage.vox_last_activity`.
- All activity events (`mousemove`, `keydown`, `touchstart`, `click`, `scroll`) reset the idle timer.

---

## Fix 10 — Whisper Model & Similarity Threshold
- **Whisper model:** upgraded from `tiny` → `small` for significantly better name recognition accuracy.
- **LOCK_VOICE_SIMILARITY_THRESHOLD:** tuned to `0.86` — rejects impostors, accepts the registered user reliably with browser-processed mic audio.

---

## Files Changed
| File | What Changed |
|------|-------------|
| `Registration.tsx` | New phrase, 2-sample flow, 700ms gap, name blob saved as embedding #1 |
| `WakePhraseSetup.tsx` | Navigate to `/locked` after setup (not `/greeting`) |
| `auth_routes.py` | Clause-boundary name extraction regex |
| `config.py` | `MAX_VOICE_SAMPLES=2`, `WHISPER_MODEL=small`, threshold `0.86` |
| `Locked.tsx` | Already fixed in v4 — verified correct (embedding-based auth, no text match) |
| `voice_auth_service.py` | Already fixed in v4 — verified correct (quality gate, cosine similarity) |
