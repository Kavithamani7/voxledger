# VoxLedger v9 — Flow Fix & Authentication Hardening

## Changes in this version

### Problem
The app flow was not enforced correctly. Users could:
- Land on `/locked` without completing wake-phrase setup (if voice profile existed but `vox_wake_phrase` was absent)
- Navigate directly to `/wake-phrase-setup` or `/locked` via the URL bar, bypassing registration
- Hit the "already exists" branch during registration and get sent to `/locked` with no wake phrase set, breaking unlock
- Reopen the app after a partial registration (user row but no voice embeddings) and be sent to `/locked` instead of resuming registration

### Correct enforced flow
```
Splash → Registration → Wake Phrase Setup → Locked Screen → Dashboard
```
Each page now guards itself and redirects to the correct step if reached out of order.

---

## Files changed

### `client/components/SplashScreen.tsx`
- **Prop type** updated: `onComplete` now accepts `"registration" | "locked" | "wake-phrase-setup"`
- **Three-way routing logic:**
  - `registered=true` + `vox_wake_phrase` present → `/locked` ✅
  - `registered=true` + `vox_wake_phrase` missing → `/wake-phrase-setup` (resume interrupted setup)
  - `has_user=true, has_voice_profile=false` → `/registration` (resume partial registration)
  - No user → `/registration`

### `client/App.tsx`
- **`handleSplashComplete`** updated to handle new `"wake-phrase-setup"` destination
- **`SetupGuard`** component added: wraps `/wake-phrase-setup` route, redirects to `/registration` if no user is in context (prevents direct URL access)
- `/wake-phrase-setup` route now wrapped in `<SetupGuard>` instead of being fully public

### `client/pages/Registration.tsx`
- **Mount guard**: if `vox_setup_complete === "1"` and `vox_wake_phrase` is set, redirect to `/locked` immediately — prevents re-registering over an existing complete setup
- **"Already exists" branch**: now checks `vox_setup_complete` flag — routes to `/wake-phrase-setup` if setup is incomplete, `/locked` if fully done

### `client/pages/WakePhraseSetup.tsx`
- **Mount guard**: if `vox_setup_complete === "1"` and `vox_wake_phrase` is set, redirect to `/locked` (idempotent — safe to call again)
- **`saveAndContinue`**: now writes `localStorage.setItem("vox_setup_complete", "1")` alongside the wake phrase — this flag gates all downstream guards

### `client/pages/Locked.tsx`
- **Mount guard**: if `vox_setup_complete !== "1"` or `vox_wake_phrase` is absent, redirects to `/wake-phrase-setup` (if user ID present) or `/registration` (if no user at all) — prevents accessing lock screen before setup is complete

### `client/context/AppContext.tsx`
- **`logout()`**: now clears `vox_setup_complete` and `vox_wake_phrase` from localStorage — ensures a fresh registration flow after logout rather than being stuck in a broken state

---

## localStorage flags used by the flow guards

| Key | Set by | Cleared by | Meaning |
|-----|--------|------------|---------|
| `vox_wake_phrase` | `WakePhraseSetup.saveAndContinue` | `AppContext.logout` | The chosen wake phrase (lowercase) |
| `vox_setup_complete` | `WakePhraseSetup.saveAndContinue` | `AppContext.logout` | Full first-run setup was completed |
| `voxledger_user_id` | `AppContext.registerUser` / `setUserId` | `AppContext.logout` | Numeric DB user ID |
| `voxledger_user` | `AppContext.registerUser` | `AppContext.logout` | Serialised user profile object |

---

## Backend — no changes
The backend (voice_auth_service, auth_routes, voice_routes) was already correctly implemented in v8. No backend files were modified.

---

## Testing the flow

**Fresh install (no data):**
1. Splash → Registration ✓
2. Complete name recording + wake phrase recording → Wake Phrase Setup ✓
3. Choose / confirm wake phrase → Locked ✓
4. Say wake phrase → Dashboard ✓

**App reopen after completing setup:**
1. Splash checks backend (`registered=true`) + localStorage (`vox_wake_phrase` set) → Locked ✓

**App reopen after partial registration (voice recorded, no wake phrase):**
1. Splash checks backend (`registered=true`) + localStorage (`vox_wake_phrase` absent) → Wake Phrase Setup ✓

**App reopen after incomplete registration (user row, no voice):**
1. Splash checks backend (`has_user=true, has_voice_profile=false`) → Registration ✓

**Direct URL navigation attempt (e.g. `/locked` before setup):**
1. Locked mount guard detects missing `vox_setup_complete` → redirects to `/wake-phrase-setup` or `/registration` ✓

**Direct URL to `/wake-phrase-setup` with no user:**
1. `SetupGuard` in App.tsx detects no user in context → redirects to `/registration` ✓
