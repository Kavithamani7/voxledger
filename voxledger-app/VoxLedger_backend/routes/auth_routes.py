from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
import hashlib
import re

from database import get_connection
from config import settings
from models.user_model import UserRegisterRequest, CheckUserResponse, UserResponse
from services.voice_auth_service import save_voice_embedding, verify_voice, get_voice_sample_count, analyze_audio_quality
from services.finance_service import create_notification

router = APIRouter(tags=["Authentication"])


def _hash_password(password: str) -> str:
    """Simple SHA-256 password hash — no bcrypt dependency issues."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _verify_password(password: str, hashed: str) -> bool:
    return _hash_password(password) == hashed


def _extract_name_from_text(text: str) -> Optional[str]:
    """
    Extract a person's name from the voice registration phrase.

    Primary target phrase (v5):
      "My name is [Name], I will use this voice to access this app"

    The name extraction stops at clause-terminating words/punctuation so we
    never accidentally capture the rest of the sentence as part of the name.
    Also handles shorter patterns like 'I am X', 'I'm X', 'call me X'.
    """
    if not text:
        return None
    text = text.strip()

    # ── Step 1: name-bounding patterns (stop at clause boundary) ─────────────
    # These catch "My name is Alice," or "My name is Alice I will..."
    bounded_patterns = [
        # Stops at comma, period, or clause-starting words
        r"my name(?:'?s)?\s+is\s+([A-Za-z][A-Za-z\s]{0,25?}?)(?:\s*[,.]|\s+i\s+will|\s+i\s+am|\s+will\s+use|\s+and\b|$)",
        r"i am\s+([A-Za-z][A-Za-z\s]{0,25?}?)(?:\s*[,.]|\s+i\s+will|\s+and\b|$)",
        r"i'm\s+([A-Za-z][A-Za-z\s]{0,25?}?)(?:\s*[,.]|\s+i\s+will|\s+and\b|$)",
        r"call me\s+([A-Za-z][A-Za-z\s]{0,25?}?)(?:\s*[,.]|\s+i\s+will|\s+and\b|$)",
        r"this is\s+([A-Za-z][A-Za-z\s]{0,25?}?)(?:\s*[,.]|\s+i\s+will|\s+and\b|$)",
    ]
    for pat in bounded_patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            name = m.group(1).strip().title().rstrip(",. ")
            # Strip residual stop-words that leaked past the boundary
            name = re.sub(
                r'\b(i\s+will|i\s+am|will\s+use|to\s+access|to\s+use|speaking|'
                r'here|registering|register|please|ok|okay|um|uh|and)\b.*',
                '', name, flags=re.IGNORECASE
            ).strip().rstrip(",. ")
            if 2 <= len(name) <= 30 and re.match(r'^[A-Za-z][A-Za-z\s]*$', name):
                return name

    # ── Step 2: fallback — greedy patterns (no stop-word boundary) ───────────
    greedy_patterns = [
        r"my name(?:'?s)?\s+is\s+([A-Za-z][A-Za-z\s]{1,28})",
        r"i am\s+([A-Za-z][A-Za-z\s]{1,28})",
        r"i'm\s+([A-Za-z][A-Za-z\s]{1,28})",
        r"call me\s+([A-Za-z][A-Za-z\s]{1,28})",
        r"this is\s+([A-Za-z][A-Za-z\s]{1,28})",
        r"\bname\s+([A-Za-z][A-Za-z\s]{1,28})",
    ]
    for pat in greedy_patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            name = m.group(1).strip().title()
            name = re.sub(
                r'\b(i\s+will|i\s+am|will\s+use|to\s+access|to\s+use|speaking|'
                r'here|registering|register|please|ok|okay|um|uh|and)\b.*',
                '', name, flags=re.IGNORECASE
            ).strip().rstrip(",. ")
            if 2 <= len(name) <= 30 and re.match(r'^[A-Za-z][A-Za-z\s]*$', name):
                return name

    # ── Step 3: last resort — treat the transcription as a name if it's short ─
    words = [w for w in text.split() if w.isalpha() and len(w) >= 2]
    if words and len(words) <= 3:
        name = " ".join(words[:2]).title()
        if 2 <= len(name) <= 30:
            return name
    return None


# ── Check if any user is registered ──────────────────────────────────────────
@router.get("/check-user", response_model=CheckUserResponse)
def check_user():
    """Splash screen check.

    The app is considered fully registered only when at least one user has
    a stored voice profile. Incomplete user rows without embeddings are treated
    as unfinished registration, so the frontend can go back to Registration.
    """
    conn = get_connection()
    try:
        any_user = conn.execute(
            "SELECT id, name FROM users ORDER BY id LIMIT 1"
        ).fetchone()
        registered_user = conn.execute(
            """
            SELECT u.id, u.name
            FROM users u
            WHERE EXISTS (
                SELECT 1 FROM voice_embeddings ve WHERE ve.user_id = u.id
            )
            ORDER BY u.id
            LIMIT 1
            """
        ).fetchone()

        if not any_user:
            return CheckUserResponse(
                registered=False,
                has_user=False,
                has_voice_profile=False,
            )

        if not registered_user:
            return CheckUserResponse(
                registered=False,
                user_id=any_user["id"],
                user_name=any_user["name"],
                has_user=True,
                has_voice_profile=False,
            )

        return CheckUserResponse(
            registered=True,
            user_id=registered_user["id"],
            user_name=registered_user["name"],
            has_user=True,
            has_voice_profile=True,
        )
    finally:
        conn.close()


# ── Register user ─────────────────────────────────────────────────────────────
@router.post("/register")
def register_user(name: str = Form(...), password: str = Form(default="voice_auth_user")):
    if len(name.strip()) < 2:
        raise HTTPException(400, "Name must be at least 2 characters.")

    conn = get_connection()
    try:
        # If the DB only contains unfinished users with no voice profile,
        # clean them up so we can start fresh.
        incomplete_users = conn.execute(
            """
            SELECT u.id FROM users u
            WHERE NOT EXISTS (
                SELECT 1 FROM voice_embeddings ve WHERE ve.user_id = u.id
            )
            """
        ).fetchall()
        completed_user = conn.execute(
            """
            SELECT u.id FROM users u
            WHERE EXISTS (
                SELECT 1 FROM voice_embeddings ve WHERE ve.user_id = u.id
            )
            LIMIT 1
            """
        ).fetchone()

        if completed_user is None and incomplete_users:
            conn.execute("DELETE FROM users")
            conn.commit()

        existing = conn.execute(
            "SELECT id FROM users WHERE LOWER(name) = LOWER(?)", (name.strip(),)
        ).fetchone()
        if existing:
            raise HTTPException(409, "A user with this name already exists.")

        hashed_pw = _hash_password(password)
        cur = conn.execute(
            "INSERT INTO users (name, password) VALUES (?, ?)",
            (name.strip(), hashed_pw)
        )
        conn.commit()
        user_id = cur.lastrowid

        # Initialise all default budget categories at ₹0 on the SAME connection
        # so the FK to the just-committed user row is guaranteed visible in WAL mode.
        from datetime import datetime as _dt
        _month = _dt.now().strftime("%Y-%m")
        _budget_cats = [
            "monthly", "Food", "Transport", "Shopping", "Utilities",
            "Entertainment", "Healthcare", "Housing", "Education", "Others",
        ]
        for _cat in _budget_cats:
            conn.execute(
                """INSERT INTO budgets (user_id, category, amount, month)
                   VALUES (?, ?, 0.0, ?)
                   ON CONFLICT(user_id, category, month) DO NOTHING""",
                (user_id, _cat, _month),
            )

        # Welcome notification — also on the same connection to avoid FK issues
        conn.execute(
            """INSERT INTO notifications (user_id, title, message, notif_type, created_at)
               VALUES (?, ?, ?, 'success', ?)""",
            (
                user_id,
                "Welcome to VoxLedger! 🎉",
                f"Hi {name}! Your account is ready. Say \"Set monthly budget to 10000\" to set your budget.",
                _dt.now().strftime("%Y-%m-%dT%H:%M:%S"),
            ),
        )
        conn.commit()

        return {
            "success": True,
            "message": f"Account created for {name}.",
            "user_id": user_id,
            "user_name": name.strip(),
        }
    finally:
        conn.close()


# ── Extract name from voice audio ─────────────────────────────────────────────
@router.post("/extract-name-from-voice")
async def extract_name_from_voice(voice_sample: UploadFile = File(...)):
    """
    Transcribes a voice sample and extracts the user's name from it.
    Used during voice-only registration.
    """
    from services.whisper_service import transcribe_audio
    audio_bytes = await voice_sample.read()
    if not audio_bytes or len(audio_bytes) < 3000:
        return {"success": False, "name": None, "transcribed_text": "", "message": "Audio too short. Please speak clearly."}

    transcribed = transcribe_audio(audio_bytes, language="en")
    if not transcribed:
        return {"success": False, "name": None, "transcribed_text": "", "message": "Could not understand speech. Please try again."}

    name = _extract_name_from_text(transcribed)
    if not name:
        return {
            "success": False,
            "name": None,
            "transcribed_text": transcribed,
            "message": "Could not extract name. Please say 'My name is [your name]'.",
        }

    return {
        "success": True,
        "name": name,
        "transcribed_text": transcribed,
        "message": f"Name detected: {name}",
    }


# ── Upload voice sample ───────────────────────────────────────────────────────
@router.post("/register/voice-sample")
async def upload_voice_sample(
    user_id: int = Form(...),
    voice_sample: UploadFile = File(...),
):
    audio_bytes = await voice_sample.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file.")

    success, message = save_voice_embedding(user_id, audio_bytes)
    if not success:
        raise HTTPException(400, message)

    sample_count = get_voice_sample_count(user_id)
    from config import settings

    return {
        "success": True,
        "message": message,
        "samples_registered": sample_count,
        "max_samples": settings.MAX_VOICE_SAMPLES,
        "registration_complete": sample_count >= settings.MAX_VOICE_SAMPLES,
    }


# ── Verify voice (lock screen) ────────────────────────────────────────────────
@router.post("/verify-voice")
async def verify_voice_endpoint(voice_sample: UploadFile = File(...)):
    import time
    t0 = time.time()
    audio_bytes = await voice_sample.read()

    # Hard reject: too small to contain real speech
    # v8 FIX: lowered 8KB → 4KB — "Hey Vox" produces ~4,000–6,000 bytes at webm/opus
    # The old 8KB threshold was silently rejecting valid wake-phrase recordings.
    MIN_AUDIO_BYTES = 4_000
    if not audio_bytes or len(audio_bytes) < MIN_AUDIO_BYTES:
        print(f"\n[auth] ❌  REJECT — audio too small ({len(audio_bytes) if audio_bytes else 0}B < {MIN_AUDIO_BYTES}B). Silence rejected.")
        return {
            "authenticated": False,
            "user_id": None,
            "user_name": None,
            "similarity_score": 0.0,
            "message": "No voice detected. Please say the wake phrase clearly to unlock.",
        }

    # Never attempt authentication unless both a user and a stored voice profile exist.
    conn = get_connection()
    try:
        user_row = conn.execute(
            """
            SELECT u.id, u.name
            FROM users u
            WHERE EXISTS (SELECT 1 FROM voice_embeddings ve WHERE ve.user_id = u.id)
            ORDER BY u.id
            LIMIT 1
            """
        ).fetchone()
        if not user_row:
            print("[auth] ❌  REJECT — no user registered yet.")
            return {
                "authenticated": False,
                "user_id": None,
                "user_name": None,
                "similarity_score": 0.0,
                "message": "No user found. Please complete registration first.",
            }

        total_embeddings = conn.execute(
            "SELECT COUNT(*) as cnt FROM voice_embeddings WHERE user_id = ?",
            (user_row["id"],),
        ).fetchone()["cnt"]

        if total_embeddings == 0:
            print(f"[auth] ❌  REJECT — user exists but no voice profile is stored.")
            return {
                "authenticated": False,
                "user_id": user_row["id"],
                "user_name": user_row["name"],
                "similarity_score": 0.0,
                "message": "Voice profile missing. Please register your voice again.",
            }
    finally:
        conn.close()

    # Stricter pre-check for lock-screen authentication than for in-app commands.
    quality_ok, quality_msg, _, _ = analyze_audio_quality(audio_bytes)
    if not quality_ok:
        print(f"[auth] ❌  REJECT — quality gate: {quality_msg}")
        return {
            "authenticated": False,
            "user_id": None,
            "user_name": None,
            "similarity_score": 0.0,
            "message": quality_msg,
        }

    authenticated, user_id, user_name, score = verify_voice(
        audio_bytes,
        expected_user_id=user_row["id"],
        threshold_override=settings.LOCK_VOICE_SIMILARITY_THRESHOLD,
    )
    elapsed = (time.time() - t0) * 1000

    status = "✅  GRANTED" if authenticated else "❌  DENIED"
    print(f"\n[auth] {status} — user={user_name!r}  score={score:.4f}  ({elapsed:.0f} ms)")

    # FIX v7: specific rejection messages based on similarity score
    if authenticated:
        reject_msg = f"Welcome back, {user_name}!"
    elif score < 0.40:
        reject_msg = "Voice did not match. Only the registered user can unlock. Please try again."
    elif score < settings.LOCK_VOICE_SIMILARITY_THRESHOLD:
        reject_msg = "Voice similarity too low. Please speak the wake phrase clearly and try again."
    else:
        reject_msg = "Voice not recognised. Please try again."

    return {
        "authenticated": authenticated,
        "user_id": user_id,
        "user_name": user_name,
        "similarity_score": round(score, 4),
        "message": reject_msg,
    }


# ── Simple password login (fallback) ─────────────────────────────────────────
@router.post("/login")
def login(user_id: int = Form(...), password: str = Form(...)):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "User not found.")
        if not _verify_password(password, row["password"]):
            raise HTTPException(401, "Incorrect password.")
        return {
            "success": True,
            "user_id": row["id"],
            "user_name": row["name"],
        }
    finally:
        conn.close()


# ── Get user profile ──────────────────────────────────────────────────────────
@router.get("/user/{user_id}")
def get_user(user_id: int):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "User not found.")
        voice_count = get_voice_sample_count(user_id)
        return {
            "id": row["id"],
            "name": row["name"],
            "created_at": row["created_at"],
            "voice_samples": voice_count,
        }
    finally:
        conn.close()
