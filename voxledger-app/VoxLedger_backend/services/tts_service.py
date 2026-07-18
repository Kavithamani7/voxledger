"""
Text-to-Speech service using gTTS + ffmpeg tempo boost.
Returns audio bytes (MP3) for a given text string.

Speed strategy:
  1. gTTS generates natural-speed MP3
  2. ffmpeg atempo=1.35 speeds it up to feel faster & more natural
  3. Cached by MD5 so repeated phrases cost nothing
"""
import io
import os
import hashlib
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

# ── Amount-to-words converter ────────────────────────────────────────────────

def _amount_to_words(n: float) -> str:
    """
    Convert a rupee amount to natural spoken English using Indian number system.
    Examples:
        1       → "one rupee"
        10      → "ten rupees"
        100     → "one hundred rupees"
        1000    → "one thousand rupees"
        10000   → "ten thousand rupees"
        100000  → "one lakh rupees"
        1500    → "one thousand five hundred rupees"
        15000   → "fifteen thousand rupees"
        150000  → "one lakh fifty thousand rupees"
    """
    import re as _re

    n = int(round(n))
    suffix = "rupee" if n == 1 else "rupees"

    if n == 0:
        return "zero rupees"

    # Sub-word helpers
    _ones = [
        "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
        "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
        "sixteen", "seventeen", "eighteen", "nineteen",
    ]
    _tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

    def _below_hundred(x: int) -> str:
        if x < 20:
            return _ones[x]
        t = _tens[x // 10]
        o = _ones[x % 10]
        return t + (" " + o if o else "")

    def _below_thousand(x: int) -> str:
        if x < 100:
            return _below_hundred(x)
        h = x // 100
        r = x % 100
        return _ones[h] + " hundred" + (" " + _below_hundred(r) if r else "")

    # Indian system: ones, thousands, lakhs, crores
    parts = []

    crores = n // 10_000_000
    n %= 10_000_000
    lakhs = n // 100_000
    n %= 100_000
    thousands = n // 1_000
    remainder = n % 1_000

    if crores:
        parts.append(_below_thousand(crores) + " crore")
    if lakhs:
        parts.append(_below_thousand(lakhs) + " lakh")
    if thousands:
        parts.append(_below_thousand(thousands) + " thousand")
    if remainder:
        parts.append(_below_thousand(remainder))

    words = " ".join(p for p in parts if p)
    return words + " " + suffix


def preprocess_tts_text(text: str) -> str:
    """
    Convert monetary amounts in a response string to spoken-word form
    so that gTTS pronounces them naturally.

    Handles:
      ₹2000       → "two thousand rupees"
      ₹2,000      → "two thousand rupees"
      2000 rupees → "two thousand rupees"
    """
    import re as _re

    def _replace_amount(m: "re.Match") -> str:
        # Strip commas from the digit string
        digits = m.group(1).replace(",", "")
        try:
            val = float(digits)
            return _amount_to_words(val)
        except ValueError:
            return m.group(0)

    # Pattern 1: ₹NNN or ₹N,NNN,NNN (rupee symbol + digits, optional commas)
    text = _re.sub(r"₹\s*([\d,]+(?:\.\d+)?)", _replace_amount, text)

    # Pattern 2: NNN rupees / NNN rupee (digit followed by rupee word)
    def _replace_plain(m: "re.Match") -> str:
        digits = m.group(1).replace(",", "")
        try:
            val = float(digits)
            return _amount_to_words(val)
        except ValueError:
            return m.group(0)

    text = _re.sub(r"([\d,]+(?:\.\d+)?)\s+rupees?\b", _replace_plain, text, flags=_re.IGNORECASE)

    return text


# Speed multiplier — 1.20 = 20% faster than gTTS default.
# Lower than the old 1.35 reduces ffmpeg processing time while keeping delivery crisp.
_TEMPO = 1.35  # v3.0: increased from 1.20 for faster assistant delivery


def _speed_up_mp3(mp3_bytes: bytes, tempo: float = _TEMPO) -> bytes:
    """
    Use ffmpeg atempo filter to speed up MP3 audio.
    Returns original bytes if ffmpeg not available.
    """
    if tempo == 1.0:
        return mp3_bytes
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fin:
            fin.write(mp3_bytes)
            in_path = fin.name
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fout:
            out_path = fout.name

        # atempo must be in [0.5, 2.0]; chain filters for >2x if needed
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-threads", "0", "-i", in_path,
                "-filter:a", f"atempo={tempo}",
                "-vn", out_path,
            ],
            capture_output=True,
            timeout=8,
        )
        os.unlink(in_path)
        if result.returncode == 0 and os.path.getsize(out_path) > 100:
            with open(out_path, "rb") as f:
                sped = f.read()
            os.unlink(out_path)
            print(f"[tts] Speed-up applied (tempo={tempo}x), {len(mp3_bytes)}B → {len(sped)}B")
            return sped
        if os.path.exists(out_path):
            os.unlink(out_path)
    except Exception as e:
        print(f"[tts] ffmpeg speed-up failed (using original): {e}")
    return mp3_bytes


def text_to_speech(text: str, language: str = "en") -> Optional[bytes]:
    """
    Convert text to MP3 audio bytes using gTTS + ffmpeg tempo boost.
    Caches the final (sped-up) audio on disk.
    Returns bytes or None on failure.
    """
    from config import settings

    # Preprocess FIRST so cache key is based on spoken form (₹2,000 and ₹2000 share cache)
    text = preprocess_tts_text(text)

    # Cache key includes tempo so changing speed invalidates old cache
    cache_key = hashlib.md5(f"{language}:{_TEMPO}:{text}".encode()).hexdigest()
    cache_path = Path(settings.TTS_DIR) / f"{cache_key}.mp3"

    if cache_path.exists():
        return cache_path.read_bytes()

    try:
        from gtts import gTTS
        tts = gTTS(text=text, lang=language, slow=False)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        raw_bytes = buf.getvalue()

        # Speed up with ffmpeg
        audio_bytes = _speed_up_mp3(raw_bytes, _TEMPO)

        # Cache to disk
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(audio_bytes)

        return audio_bytes

    except Exception as e:
        print(f"[tts] gTTS failed: {e}")
        return None


def build_greeting(user_name: str) -> str:
    return (
        f"Hi {user_name}, I am your finance assistant. "
        "How can I help you today?"
    )


def build_expense_confirmation(amount: float, category: str, description: str) -> str:
    return (
        f"Got it! I have added {amount:.0f} rupees for {description} "
        f"under {category}."
    )


def build_summary_response(
    total_spent: float,
    monthly_budget: float,
    remaining: float,
    top_category: Optional[str] = None,
) -> str:
    pct = int((total_spent / monthly_budget * 100)) if monthly_budget > 0 else 0
    msg = (
        f"This month you have spent {total_spent:.0f} rupees, "
        f"which is {pct} percent of your {monthly_budget:.0f} rupee budget. "
        f"You have {remaining:.0f} rupees remaining."
    )
    if top_category:
        msg += f" Your highest spending is in {top_category}."
    return msg
