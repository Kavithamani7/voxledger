"""
Whisper STT service — v8.0 Intelligence Upgrade

Key improvements:
  - Expanded _NOISE_PATTERNS: rejects more hallucinated/noise transcriptions
  - Additional _STT_CORRECTIONS for imperfect English + Indian English
  - More aggressive hallucination detection (repeated phrases, nonsense chars)
  - initial_prompt updated to guide AI assistant context
  - no_speech_threshold lowered further for better silence rejection
  - Added word-count sanity check: single-word transcripts are validated
"""
import os
import re
import tempfile
from typing import Optional

_whisper_model = None
_whisper_available = False
_load_attempted = False


def preload_model(model_size: str = "tiny"):
    """Called once at startup. Non-blocking on failure."""
    global _whisper_model, _whisper_available, _load_attempted
    if _load_attempted:
        return
    _load_attempted = True
    try:
        import whisper
        print(f"[whisper] Pre-loading model '{model_size}' at startup ...")
        _whisper_model = whisper.load_model(model_size)
        _whisper_available = True
        print("[whisper] Model ready ✅")
    except Exception as e:
        print(f"[whisper] Whisper not available: {e}")
        _whisper_available = False


def _detect_audio_ext(audio_bytes: bytes) -> str:
    if len(audio_bytes) >= 4:
        if audio_bytes[:4] == b'RIFF':
            return '.wav'
        if audio_bytes[:3] == b'ID3' or audio_bytes[:2] == b'\xff\xfb':
            return '.mp3'
        if audio_bytes[:4] == b'OggS':
            return '.ogg'
    return '.webm'


def _normalize_audio_bytes(audio_bytes: bytes, ext: str) -> bytes:
    """Convert audio bytes to 16kHz mono WAV for Whisper. Tries ffmpeg strategies."""
    import subprocess
    import tempfile as tf

    out_tmp = tf.NamedTemporaryFile(suffix=".wav", delete=False)
    out_tmp.close()

    def _run_ffmpeg(extra_input_args: list, input_path: str) -> bool:
        try:
            cmd = [
                "ffmpeg", "-y",
                "-threads", "0",
                *extra_input_args,
                "-i", input_path,
                "-ac", "1", "-ar", "16000",
                "-acodec", "pcm_s16le",
                "-f", "wav",
                out_tmp.name,
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=8)
            return r.returncode == 0 and os.path.getsize(out_tmp.name) > 100
        except Exception:
            return False

    in_tmp = tf.NamedTemporaryFile(suffix=ext, delete=False)
    try:
        in_tmp.write(audio_bytes)
        in_tmp.flush()
        in_tmp_path = in_tmp.name
    finally:
        in_tmp.close()

    try:
        strategies = [
            ([],),
            (["-f", "webm"],),
            (["-f", "ogg"],),
        ]
        for (extra,) in strategies:
            if _run_ffmpeg(extra, in_tmp_path):
                with open(out_tmp.name, "rb") as f:
                    result = f.read()
                if result:
                    return result
    except Exception:
        pass
    finally:
        try:
            os.unlink(in_tmp_path)
        except Exception:
            pass
        try:
            os.unlink(out_tmp.name)
        except Exception:
            pass

    return audio_bytes


# ── Common STT corrections for Indian English ─────────────────────────────────
_STT_CORRECTIONS = [
    # Wake phrase variants
    (r'\bhey vox\b',        'Hey Vox'),
    (r'\bhi vox\b',         'Hey Vox'),
    (r'\bokay vox\b',       'Hey Vox'),
    (r'\bhello vox\b',      'Hey Vox'),
    (r'\bvox ledger\b',     'VoxLedger'),
    (r'\bvox ledge\b',      'VoxLedger'),
    (r'\bfox ledger\b',     'VoxLedger'),     # common mishear
    (r'\bbox ledger\b',     'VoxLedger'),
    # Currency
    (r'\brupees?\b',        'rupees'),
    (r'\brs\.?\s*(\d)',     r'₹\1'),
    (r'\b(one|1)\s*lakh\b', '100000'),
    (r'\blakh\b',           'lakh'),
    (r'\bcrore\b',          'crore'),
    # Common finance terms
    (r'\btransaction\b',    'transaction'),
    (r'\bnotification\b',   'notification'),
    (r'\bexpense\b',        'expense'),
    (r'\bbudget\b',         'budget'),
    # Indian English number variants
    (r'\bfifty\b',          'fifty'),
    (r'\bthousand\b',       'thousand'),
    # Common misheard words
    (r'\bbalance\b',        'balance'),
    (r'\bsavings?\b',       'savings'),
    (r'\bincome\b',         'income'),
    # v8: additional Indian English corrections
    (r'\bfooding\b',        'food'),
    (r'\btransportation\b', 'transport'),
    (r'\bpharmacy\b',       'pharmacy'),
    (r'\belectricity bill\b', 'electricity bill'),
    (r'\bemi\b',            'EMI'),
    (r'\bnet banking\b',    'net banking'),
    (r'\bupi\b',            'UPI'),
    # Number word corrections (common Whisper errors)
    (r'\bto\s+hundred\b',   'two hundred'),
    (r'\bfore\b(?=\s+hundred|\s+thousand)', 'four'),
    (r'\btre\b(?=\s+hundred)', 'three'),
    # Imperfect pronunciation corrections
    (r'\bspend on\b',       'spent on'),
    (r'\bshow me\s+my\b',   'show my'),
    (r'\bopening\b(?=\s+budget|\s+transaction)', 'open'),
    (r'\bwhat is my\b',     "what's my"),
]

_NOISE_PATTERNS = [
    r'^\s*(thank you|thanks|thank you so much)\s*\.?\s*$',
    r'^\s*(subscribe|like and subscribe|please subscribe)\s*',
    r'^\s*\.\s*$',
    r'^\s*(music playing|background music|applause|laughter)\s*$',
    r'^\s*(um+|uh+|ah+|hmm+|huh)\s*\.?\s*$',       # pure filler
    r'^\s*[\W\d]+\s*$',                               # only symbols/numbers
    r'^\s*(you|yeah|yes|no|okay|ok)\s*\.?\s*$',
    r'^\s*(bye|goodbye|see you)\s*\.?\s*$',
    # v8: additional hallucination patterns
    r'^\s*\[.*?\]\s*$',                               # [Music] [Applause] etc
    r'^\s*\(.*?\)\s*$',                               # (mumbling) (inaudible)
    r'^\s*(the end|end of|credits|subtitles?)\s*',
    r'^\s*(foreign|hindi|tamil|telugu|language)\s*$', # language labels
    r'^\s*[.!?,;:]+\s*$',                             # only punctuation
    r'^\s*(one|two|three|four|five)\s*\.?\s*$',       # lone numbers — likely noise
    r'^\s*www\.|http|\.com|\.in|@\s*',                # URLs / emails
    r'^\s*(welcome|welcome back|hello everyone|good morning everyone)\s*',
    r'^(.{2,20})\1{2,}$',                             # exact repetition 3+ times
]


def _clean_repetition(text: str) -> str:
    words = text.split()
    if len(words) < 6:
        return text
    half = len(words) // 2
    if words[:half] == words[half:half * 2]:
        return " ".join(words[:half])
    return text


def _post_process(text: str) -> str:
    if not text:
        return ""
    stripped = text.strip()
    for _npat in _NOISE_PATTERNS:
        if re.search(_npat, stripped, re.IGNORECASE):
            return ""
    result = text
    for pattern, replacement in _STT_CORRECTIONS:
        result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)
    result = re.sub(r'^(um+|uh+|ah+|hmm+|okay\s+so|so\s+like|like)\s+', '', result, flags=re.IGNORECASE)
    result = re.sub(r'\s+', ' ', result).strip()
    result = _clean_repetition(result)
    return result


def transcribe_audio(audio_bytes: bytes, language: str = "en") -> Optional[str]:
    """
    Transcribe audio bytes to text using OpenAI Whisper tiny.
    Optimised for speed: beam=1 greedy decode, fp16=False (CPU safe).
    """
    from config import settings
    if not _load_attempted:
        preload_model(settings.WHISPER_MODEL)

    if not _whisper_available or _whisper_model is None:
        return None

    tmp_path = None
    try:
        ext = _detect_audio_ext(audio_bytes)
        processed_bytes = _normalize_audio_bytes(audio_bytes, ext)
        final_ext = '.wav' if processed_bytes != audio_bytes else ext

        with tempfile.NamedTemporaryFile(suffix=final_ext, delete=False) as tmp:
            tmp.write(processed_bytes)
            tmp_path = tmp.name

        result = _whisper_model.transcribe(
            tmp_path,
            language=language,
            fp16=False,
            task="transcribe",
            temperature=0.0,       # greedy — fastest, most deterministic
            beam_size=1,           # no beam search — ~3x faster on CPU
            best_of=1,
            compression_ratio_threshold=2.0,   # v8: tightened 2.2→2.0 — more aggressive repetition rejection
            logprob_threshold=-1.0,
            no_speech_threshold=0.45,          # v8: lowered 0.50→0.45 — stricter silence rejection
            condition_on_previous_text=False,  # prevents hallucinated follow-on phrases
            initial_prompt=(
                "VoxLedger intelligent finance assistant. Indian English speaker controlling an app. "
                "Commands include: add expense, add income, show balance, open budget, show transactions, "
                "set budget, what did I spend, show notifications, delete transaction, create category, "
                "mark as read, dark mode. "
                "Amounts: two hundred, five hundred rupees, one thousand, fifty, three fifty. "
                "Categories: Food, Transport, Shopping, Entertainment, Utilities, Healthcare, Housing, Education. "
                "Wake phrase: Hey Vox. Stop commands: stop, mute, be quiet."
            ),
        )

        segments = result.get("segments", [])
        if segments:
            avg_no_speech = sum(s.get("no_speech_prob", 0) for s in segments) / len(segments)
            if avg_no_speech > 0.45:  # v8: tightened from 0.55 — stricter no-speech rejection
                print(f"[whisper] Rejected: avg no_speech_prob={avg_no_speech:.2f}")
                return None

        raw_text = result.get("text", "").strip()
        text = _post_process(raw_text)

        # v8: sanity check — single non-finance words are likely noise
        if text and len(text.split()) == 1:
            single = text.lower().strip(".,!?")
            finance_singles = {
                "stop", "mute", "unmute", "balance", "budget", "expenses",
                "transactions", "notifications", "alerts", "profile", "help",
                "dashboard", "summary", "income", "spending", "history",
            }
            if single not in finance_singles:
                print(f"[whisper] Rejected single-word non-finance transcript: {text!r}")
                return None

        print(f"[whisper] Raw: '{raw_text}' → Processed: '{text}'")
        return text if text else None

    except Exception as e:
        print(f"[whisper] Transcription error: {e}")
        return None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def is_available() -> bool:
    return _whisper_available
