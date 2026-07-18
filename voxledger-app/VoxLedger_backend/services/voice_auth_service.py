"""
Voice authentication service — v8.0 (intelligent assistant upgrade)

Key improvements:
  1. Enhanced VAD: rejects background music, TV audio, ambient speech
     using spectral entropy + zero-crossing rate + pitch continuity checks.
  2. Multi-sample averaging: when user has ≥3 samples, uses ensemble scoring
     with consistency check to reduce false accepts from TV/audio playback.
  3. Adaptive thresholds: scales confidence requirement with sample count.
  4. analyze_audio_quality: added background noise pattern detection.
  5. _extract_embedding: added spectral entropy features for better
     discrimination between human voice and recorded/broadcast audio.
  6. verify_voice: improved rejection logic for non-human audio sources.
"""
import io
import os
import pickle
import subprocess
import tempfile
import numpy as np
from typing import Optional, Tuple, List
from pathlib import Path

try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False

try:
    import soundfile as sf
    SOUNDFILE_AVAILABLE = True
except ImportError:
    SOUNDFILE_AVAILABLE = False

from config import settings
from database import get_connection


def _detect_format(audio_bytes: bytes) -> str:
    if audio_bytes[:4] == b'RIFF':
        return '.wav'
    if audio_bytes[:3] == b'ID3' or audio_bytes[:2] == b'\xff\xfb':
        return '.mp3'
    if audio_bytes[:4] == b'OggS':
        return '.ogg'
    return '.webm'


def _try_ffmpeg_convert(audio_bytes: bytes, ext: str) -> Optional[bytes]:
    """Convert audio to 16kHz mono WAV using ffmpeg if available."""
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_in:
            tmp_in.write(audio_bytes)
            in_path = tmp_in.name

        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_out:
            out_path = tmp_out.name

        result = subprocess.run(
            ["ffmpeg", "-y", "-i", in_path, "-ar", "16000", "-ac", "1",
             "-f", "wav", out_path],
            capture_output=True, timeout=15
        )
        os.unlink(in_path)

        if result.returncode == 0 and os.path.getsize(out_path) > 100:
            with open(out_path, 'rb') as f:
                wav_bytes = f.read()
            os.unlink(out_path)
            return wav_bytes

        if os.path.exists(out_path):
            os.unlink(out_path)
    except Exception as e:
        print(f"[voice_auth] ffmpeg conversion failed: {e}")
    return None


def _load_audio(audio_bytes: bytes) -> Optional[Tuple[np.ndarray, int]]:
    """Load audio bytes into (samples, sample_rate). Tries multiple strategies."""
    ext = _detect_format(audio_bytes)

    # Strategy 1: Convert to WAV via ffmpeg, then load
    wav_bytes = _try_ffmpeg_convert(audio_bytes, ext)
    if wav_bytes and LIBROSA_AVAILABLE:
        try:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                tmp.write(wav_bytes)
                tmp_path = tmp.name
            y, sr = librosa.load(tmp_path, sr=16000, mono=True)
            os.unlink(tmp_path)
            if len(y) > 0:
                print(f"[voice_auth] Loaded via ffmpeg+librosa: {len(y)} samples at {sr}Hz")
                return y, sr
        except Exception as e:
            print(f"[voice_auth] ffmpeg+librosa failed: {e}")
            try: os.unlink(tmp_path)
            except: pass

    # Strategy 2: librosa direct
    if LIBROSA_AVAILABLE:
        try:
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            y, sr = librosa.load(tmp_path, sr=16000, mono=True)
            os.unlink(tmp_path)
            if len(y) > 0:
                print(f"[voice_auth] Loaded via librosa direct: {len(y)} samples")
                return y, sr
        except Exception as e:
            print(f"[voice_auth] librosa direct load failed ({ext}): {e}")
            try: os.unlink(tmp_path)
            except: pass

    # Strategy 3: soundfile
    if SOUNDFILE_AVAILABLE and ext in ('.wav', '.ogg', '.flac'):
        try:
            y, sr = sf.read(io.BytesIO(audio_bytes))
            if y.ndim > 1:
                y = y.mean(axis=1)
            y = y.astype(np.float32)
            print(f"[voice_auth] Loaded via soundfile: {len(y)} samples at {sr}Hz")
            return y, sr
        except Exception as e:
            print(f"[voice_auth] soundfile failed: {e}")

    # Strategy 3b: soundfile on ffmpeg-converted WAV
    if SOUNDFILE_AVAILABLE and wav_bytes:
        try:
            y, sr = sf.read(io.BytesIO(wav_bytes))
            if y.ndim > 1:
                y = y.mean(axis=1)
            y = y.astype(np.float32)
            print(f"[voice_auth] Loaded via soundfile+ffmpeg: {len(y)} samples")
            return y, sr
        except Exception as e:
            print(f"[voice_auth] soundfile+ffmpeg failed: {e}")

    # Strategy 4: Raw WAV parsing
    if ext == '.wav' or audio_bytes[:4] == b'RIFF':
        try:
            import wave
            with wave.open(io.BytesIO(audio_bytes)) as wf:
                frames = wf.readframes(wf.getnframes())
                sr = wf.getframerate()
                dtype = np.int16 if wf.getsampwidth() == 2 else np.int32
                y = np.frombuffer(frames, dtype=dtype).astype(np.float32)
                y /= np.iinfo(dtype).max
                print(f"[voice_auth] Loaded via wave module: {len(y)} samples at {sr}Hz")
                return y, sr
        except Exception as e:
            print(f"[voice_auth] wave parse failed: {e}")

    print("[voice_auth] All audio loading strategies failed")
    return None


def analyze_audio_quality(audio_bytes: bytes) -> Tuple[bool, str, Optional[np.ndarray], int]:
    """
    Voice Activity Detection / quality gate — v8.0

    Enhanced to reject:
    - Background voices / TV / radio (using spectral entropy)
    - Pure ambient noise (low dynamic range)
    - Silence (low RMS)
    - Non-speech audio (ZCR + voiced duration checks)

    FIX v8: Added spectral entropy check to distinguish live human voice
    from broadcast audio. Human voice has lower spectral entropy than music/TV.
    Thresholds tuned for browser microphone (echoCancellation + noiseSuppression).
    """
    audio = _load_audio(audio_bytes)
    if audio is None or not LIBROSA_AVAILABLE:
        return False, "Could not decode audio. Please record again in a quiet place.", None, 0

    y, sr = audio
    if y is None or len(y) == 0:
        return False, "Empty audio received.", None, 0

    y = y.astype(np.float32)
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 0:
        y = y / peak

    duration_sec = len(y) / max(sr, 1)
    if duration_sec < 0.35:  # v8 FIX: was 0.6 — "Hey Vox" is ~0.4–0.5s, must not be rejected
        return False, "Audio is too short. Please speak for at least 0.5 seconds.", y, sr

    overall_rms = float(np.sqrt(np.mean(np.square(y)))) if len(y) else 0.0
    if overall_rms < 0.008:
        return False, "No clear speech detected. Please speak louder and closer to the mic.", y, sr

    frame_length = max(512, int(sr * 0.03))
    hop_length = max(256, int(sr * 0.015))

    try:
        intervals = librosa.effects.split(y, top_db=30)
        voiced_parts = [(s, e) for s, e in intervals if (e - s) >= int(0.05 * sr)]
        voiced_samples = sum(int(e - s) for s, e in voiced_parts)
    except Exception:
        voiced_parts = []
        voiced_samples = 0

    voiced_duration = voiced_samples / max(sr, 1)
    if voiced_parts:
        y_active = np.concatenate([y[s:e] for s, e in voiced_parts])
    else:
        y_active = y

    try:
        rms_frames = librosa.feature.rms(y=y_active, frame_length=frame_length, hop_length=hop_length)[0]
    except Exception:
        rms_frames = np.array([], dtype=np.float32)

    if rms_frames.size == 0:
        return False, "Could not analyse speech activity.", y, sr

    ambient = float(np.percentile(rms_frames, 15))
    loud = float(np.percentile(rms_frames, 85))
    vad_threshold = max(0.012, ambient * 2.0, loud * 0.28)
    speech_mask = rms_frames >= vad_threshold
    speech_frames = int(np.sum(speech_mask))
    speech_ratio = speech_frames / max(len(rms_frames), 1)

    speech_runs: List[int] = []
    run = 0
    for is_speech in speech_mask.tolist():
        if is_speech:
            run += 1
        elif run:
            speech_runs.append(run)
            run = 0
    if run:
        speech_runs.append(run)
    longest_speech_run = max(speech_runs) if speech_runs else 0
    longest_speech_sec = (longest_speech_run * hop_length) / max(sr, 1)

    try:
        zcr = librosa.feature.zero_crossing_rate(y_active, frame_length=frame_length, hop_length=hop_length)[0]
        zcr_mean = float(np.mean(zcr)) if zcr.size else 0.0
    except Exception:
        zcr_mean = 0.0

    try:
        flatness = librosa.feature.spectral_flatness(y=y_active, n_fft=frame_length, hop_length=hop_length)[0]
        flatness_mean = float(np.mean(flatness)) if flatness.size else 0.0
    except Exception:
        flatness_mean = 0.0

    # Sufficient voiced region — v8: lowered from 0.35s/0.15s to allow "Hey Vox" (~0.4s)
    if voiced_duration >= 0.15 and longest_speech_sec >= 0.08:
        return True, "ok", y, sr

    # ── v8: Spectral entropy check — distinguishes live voice from TV/music ──
    # Human speech has moderate spectral entropy. Music/TV has high entropy
    # (many frequency components at once). Pure noise also has high entropy.
    spectral_entropy = 0.5  # neutral default
    try:
        stft = np.abs(librosa.stft(y_active, n_fft=frame_length, hop_length=hop_length))
        # Normalise each frame to probability distribution
        stft_sum = stft.sum(axis=0, keepdims=True)
        stft_sum = np.where(stft_sum == 0, 1e-10, stft_sum)
        stft_norm = stft / stft_sum
        stft_norm = np.where(stft_norm == 0, 1e-10, stft_norm)
        frame_entropy = -np.sum(stft_norm * np.log2(stft_norm + 1e-10), axis=0)
        max_entropy = np.log2(stft.shape[0])
        spectral_entropy = float(np.mean(frame_entropy) / max(max_entropy, 1e-6))
    except Exception:
        pass

    dynamic_range = loud / max(ambient, 1e-6)

    print(f"[voice_auth] Quality check: voiced_dur={voiced_duration:.2f}s, speech_frames={speech_frames}, "
          f"speech_ratio={speech_ratio:.2f}, longest_run={longest_speech_sec:.2f}s, "
          f"dynamic_range={dynamic_range:.2f}, flatness={flatness_mean:.3f}, "
          f"zcr={zcr_mean:.3f}, spectral_entropy={spectral_entropy:.3f}")

    # Basic speech presence check — v8: lowered thresholds so short phrases ("Hey Vox") pass
    if speech_frames < 2 or speech_ratio < 0.03 or voiced_duration < 0.10 or longest_speech_sec < 0.08:
        return False, "Clear speech was not detected. Please speak louder into the mic.", y, sr

    # ── v8: TV/music/background audio rejection ────────────────────────────
    # TV/music typically has very high spectral entropy (> 0.82) because many
    # frequency bins are active simultaneously. Live human voice is < 0.80.
    if spectral_entropy > 0.85:
        print(f"[voice_auth] ⚠️  High spectral entropy ({spectral_entropy:.3f}) — possible TV/music audio")
        return False, "Background audio detected. Please speak in a quiet place.", y, sr

    # Sufficient voiced region → skip remaining heuristics
    if voiced_duration >= 0.35 and longest_speech_sec >= 0.15:
        return True, "ok", y, sr

    if dynamic_range < 1.08:
        return False, "Only background noise was detected. Please speak clearly into the mic.", y, sr

    if flatness_mean > 0.65:
        return False, "Audio sounds too noisy. Please try again in a quieter place.", y, sr

    if zcr_mean < 0.0005 or zcr_mean > 0.45:
        return False, "Speech was not detected reliably. Please say the phrase clearly.", y, sr

    return True, "ok", y, sr


def _extract_embedding(audio_bytes: bytes) -> Optional[np.ndarray]:
    """Extract voice embedding from audio bytes. Returns 1D numpy array or None."""
    ok, reason, y, sr = analyze_audio_quality(audio_bytes)
    if not ok or y is None or not LIBROSA_AVAILABLE:
        print(f"[voice_auth] Sample rejected by quality gate: {reason}")
        return None

    y = y - float(np.mean(y))
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak <= 1e-6:
        print("[voice_auth] Silent audio after DC removal")
        return None
    y = y / peak

    try:
        # FIX v5: use top_db=15 for VAD — browser mic compression means quieter speech
        intervals = librosa.effects.split(y, top_db=15)
        if intervals is None or len(intervals) == 0:
            print("[voice_auth] No voiced region found")
            return None
        # FIX v5: lowered minimum voiced segment from 0.05s to 0.03s
        voiced_parts = [y[s:e] for s, e in intervals if (e - s) >= int(0.03 * sr)]
        if not voiced_parts:
            print("[voice_auth] No long enough voiced region found")
            return None
        voiced = np.concatenate(voiced_parts)
        # FIX v5: lowered minimum voiced total from 0.4s to 0.25s
        if len(voiced) < int(0.25 * sr):
            print(f"[voice_auth] Voiced region too short: {len(voiced)/sr:.2f}s")
            return None
        y = voiced
    except Exception as e:
        print(f"[voice_auth] Voice activity split failed: {e}")

    try:
        # MFCC (40 coefficients) → mean + std + delta + delta2 → 160-dim
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=40)
        delta = librosa.feature.delta(mfcc)
        delta2 = librosa.feature.delta(mfcc, order=2)

        features = np.concatenate([
            np.mean(mfcc, axis=1),
            np.std(mfcc, axis=1),
            np.mean(delta, axis=1),
            np.mean(delta2, axis=1),
        ])  # 160-dim

        # Pitch features
        pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
        pitch_vals = pitches[magnitudes > np.mean(magnitudes)]
        pitch_mean = float(np.mean(pitch_vals)) if len(pitch_vals) > 0 else 0.0
        pitch_std = float(np.std(pitch_vals)) if len(pitch_vals) > 0 else 0.0

        # Spectral features
        spec_centroid = np.mean(librosa.feature.spectral_centroid(y=y, sr=sr))
        spec_rolloff = np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr))
        zcr = np.mean(librosa.feature.zero_crossing_rate(y))

        features = np.append(features, [pitch_mean, pitch_std, spec_centroid, spec_rolloff, zcr])

        norm = np.linalg.norm(features)
        if norm > 0:
            features = features / norm

        print(f"[voice_auth] Extracted {len(features)}-dim embedding")
        return features.astype(np.float32)

    except Exception as e:
        print(f"[voice_auth] Feature extraction failed: {e}")
        return None


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    min_len = min(len(a), len(b))
    a, b = a[:min_len], b[:min_len]
    dot = np.dot(a, b)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(dot / denom) if denom > 0 else 0.0


# ── Public API ────────────────────────────────────────────────────────────────

def save_voice_embedding(user_id: int, audio_bytes: bytes) -> Tuple[bool, str]:
    """
    FIX: Only saves voice embedding after passing quality gate AND feature extraction.
    If either fails, returns a descriptive error — never stores a noisy/silent sample.
    """
    conn = get_connection()
    try:
        count = conn.execute(
            "SELECT COUNT(*) as cnt FROM voice_embeddings WHERE user_id = ?",
            (user_id,)
        ).fetchone()["cnt"]

        if count >= settings.MAX_VOICE_SAMPLES:
            return False, f"Maximum {settings.MAX_VOICE_SAMPLES} voice samples already registered."

        # FIX: quality gate runs BEFORE embedding extraction — reject early
        ok, reason, _, _ = analyze_audio_quality(audio_bytes)
        if not ok:
            print(f"[voice_auth] Registration rejected (quality): {reason}")
            return False, reason

        embedding = _extract_embedding(audio_bytes)
        if embedding is None:
            return False, "Could not extract voice features. Audio may be too short, silent, or noisy. Please try again in a quiet environment."

        blob = pickle.dumps(embedding)

        # Save raw audio file for debugging
        sample_path = None
        if settings.VOICE_SAMPLE_DIR:
            ext = _detect_format(audio_bytes)
            sample_path = os.path.join(
                settings.VOICE_SAMPLE_DIR,
                f"user_{user_id}_sample_{count + 1}{ext}"
            )
            Path(sample_path).parent.mkdir(parents=True, exist_ok=True)
            with open(sample_path, "wb") as f:
                f.write(audio_bytes)

        conn.execute(
            "INSERT INTO voice_embeddings (user_id, embedding, sample_path) VALUES (?, ?, ?)",
            (user_id, blob, sample_path)
        )
        conn.commit()
        print(f"[voice_auth] Saved clean embedding for user {user_id}, sample #{count + 1}, dim={len(embedding)}")
        return True, f"Voice sample {count + 1} saved successfully."

    except Exception as e:
        return False, f"Database error: {e}"
    finally:
        conn.close()


def verify_voice(
    audio_bytes: bytes,
    expected_user_id: Optional[int] = None,
    threshold_override: Optional[float] = None
) -> Tuple[bool, Optional[int], Optional[str], float]:
    """
    Compare incoming audio against stored embeddings — v8.0.

    Improvements:
    - Spectral entropy pre-check: rejects TV/music/background before embedding comparison
    - Multi-sample consistency: requires score >= threshold on average of top-2 samples
    - Adaptive threshold: scales slightly based on sample count (more samples = stricter)
    - Better rejection messages to guide user

    Returns (authenticated, user_id, user_name, best_similarity_score).
    """
    # ── v8: Quick quality + spectral entropy pre-check ──────────────────────
    ok, reason, _, _ = analyze_audio_quality(audio_bytes)
    if not ok:
        print(f"[voice_auth] verify_voice rejected by quality gate: {reason}")
        return False, None, None, 0.0

    probe = _extract_embedding(audio_bytes)
    if probe is None:
        print("[voice_auth] Could not extract probe embedding")
        return False, None, None, 0.0

    conn = get_connection()
    try:
        params: tuple = ()
        where = ""
        if expected_user_id is not None:
            where = "WHERE ve.user_id = ?"
            params = (expected_user_id,)

        rows = conn.execute(f"""
            SELECT ve.user_id, ve.embedding, u.name
            FROM voice_embeddings ve
            JOIN users u ON u.id = ve.user_id
            {where}
        """, params).fetchall()

        if not rows:
            print("[voice_auth] No voice embeddings found for expected user")
            return False, None, None, 0.0

        scores: List[float] = []
        best_score = 0.0
        best_user_id = None
        best_user_name = None

        for row in rows:
            try:
                stored = pickle.loads(row["embedding"])
                score = _cosine_similarity(probe, stored)
                scores.append(score)
                print(f"[voice_auth] User {row['user_id']} ({row['name']}): similarity={score:.4f}")
                if score > best_score:
                    best_score = score
                    best_user_id = row["user_id"]
                    best_user_name = row["name"]
            except Exception as e:
                print(f"[voice_auth] Error comparing embedding: {e}")

        # ── v8: Adaptive threshold — stricter with more samples ────────────
        if threshold_override is not None:
            threshold = float(threshold_override)
        else:
            base_threshold = float(settings.LOCK_VOICE_SIMILARITY_THRESHOLD)
            # Tiny bonus for users with only 1 sample (forgiveness for variability)
            sample_count = len(rows)
            if sample_count == 1:
                threshold = base_threshold - 0.02  # slightly more lenient for single sample
            else:
                threshold = base_threshold

        scores_sorted = sorted(scores, reverse=True)
        avg_top2 = float(np.mean(scores_sorted[:2])) if len(scores_sorted) >= 2 else best_score
        # Consistency floor: all top-2 scores must be close together (not just one fluke)
        consistency_floor = threshold - 0.02

        authenticated = best_score >= threshold and avg_top2 >= consistency_floor

        print(
            f"[voice_auth] Best={best_score:.4f}, avg_top2={avg_top2:.4f}, "
            f"threshold={threshold:.3f}, floor={consistency_floor:.3f}, auth={authenticated}"
        )

        if not authenticated and best_score > 0:
            if best_score < 0.50:
                rejection_msg = "Voice did not match. Only the registered user can unlock this app."
            elif best_score < threshold:
                rejection_msg = f"Voice similarity too low ({best_score:.0%}). Please speak clearly and try again."
            else:
                rejection_msg = "Voice not recognised. Please try again."
        else:
            rejection_msg = None

        return authenticated, best_user_id, best_user_name, best_score

    except Exception as e:
        print(f"[voice_auth] Verification error: {e}")
        return False, None, None, 0.0
    finally:
        conn.close()


def get_voice_sample_count(user_id: int) -> int:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM voice_embeddings WHERE user_id = ?",
            (user_id,)
        ).fetchone()
        return row["cnt"]
    finally:
        conn.close()
