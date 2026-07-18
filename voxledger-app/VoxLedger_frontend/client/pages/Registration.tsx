/**
 * Registration.tsx — Fully Voice-Guided (v12.0 — real-time voice quality feedback)
 *
 * Upgrades in v12.0:
 *  1. Real-time voice quality indicator during recording:
 *     "✓ Good voice detected" / "Speak louder" / "Too quiet"
 *  2. All v6.0 fixes retained:
 *     - Navigation only after TTS completes
 *     - STT starts only after TTS ends — no voice leakage
 *     - Quality gate: MIN_RMS, MIN_BYTES before sending to backend
 *     - 700ms gap after TTS before mic opens
 *     - recEndedRef prevents double-processing
 *     - mountedRef guards all async callbacks
 *     - Wake phrase recording step for auth matching
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Check, AlertCircle, Loader2, Volume2, Bot } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/context/AppContext";
import * as api from "@/lib/api";

// v6.0: "voice_auth" step re-added — records the wake phrase for authentication matching
type Step = "intro" | "listening_name" | "confirm_name" | "voice_auth" | "done";

const RECORD_MS     = 7000;   // 7s — enough time to speak the full name phrase
const WAKE_RECORD_MS = 4000;  // 4s — shorter for "Hey Vox" wake phrase
const MIN_BYTES     = 6000;
const MIN_RMS       = 0.012;  // reject truly silent or very quiet recordings

const NAME_PHRASE   = '"My name is [your name], I will use this voice to access this app."';
// Wake phrase instruction shown during voice_auth step
function getWakePhrase(): string {
  try { return localStorage.getItem("vox_wake_phrase") || "Hey Vox"; } catch { return "Hey Vox"; }
}

function WaveBar({ h, color = "bg-primary" }: { h: number; color?: string }) {
  return (
    <motion.span
      initial={{ height: 4 }}
      animate={{ height: Math.max(4, Math.min(h, 40)) }}
      transition={{ duration: 0.07 }}
      className={`inline-block rounded-full ${color}`}
      style={{ width: 4, margin: "0 2px" }}
    />
  );
}

export default function Registration() {
  const [step, setStep]                 = useState<Step>("intro");
  const [detectedName, setDetectedName] = useState("");
  const [isRecording, setIsRecording]   = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [waveH, setWaveH]               = useState<number[]>(Array(16).fill(5));
  const [apiError, setApiError]         = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking]     = useState(false);
  const [statusText, setStatusText]     = useState("Initialising…");
  const [userId, setUserId2]            = useState<number | null>(null);
  const [retryCount, setRetryCount]     = useState(0);

  const navigate = useNavigate();
  const { registerUser, setUserId } = useApp();

  // Guard: only skip registration if BOTH localStorage AND backend DB confirm registration
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const setupDone = localStorage.getItem("vox_setup_complete") === "1"
        && !!localStorage.getItem("vox_wake_phrase");
      if (!setupDone) return; // not done — stay on registration
      try {
        const res = await import("@/lib/api").then(m => m.checkUser());
        if (cancelled) return;
        if (res.registered) {
          navigate("/locked", { replace: true });
        } else {
          // DB doesn't match localStorage — clear stale flags and stay here
          localStorage.removeItem("vox_setup_complete");
          localStorage.removeItem("vox_wake_phrase");
          localStorage.removeItem("vox_auth_mode");
          localStorage.removeItem("voxledger_user");
          localStorage.removeItem("voxledger_user_id");
        }
      } catch {
        // Backend offline — if localStorage says done, tentatively allow through
        navigate("/locked", { replace: true });
      }
    };
    check();
    return () => { cancelled = true; };
  }, [navigate]);

  const mrRef       = useRef<MediaRecorder | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const mimeRef     = useRef("audio/webm");
  const ctxRef      = useRef<AudioContext | null>(null);
  const anRef       = useRef<AnalyserNode | null>(null);
  const waveRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const progRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxRmsRef   = useRef(0);
  const ttsRef      = useRef<HTMLAudioElement | null>(null);
  const stepRef     = useRef<Step>("intro");
  const srRef       = useRef<any>(null);
  const retryRef    = useRef(0);
  const mountedRef  = useRef(true);
  const recEndedRef = useRef(false);
  // Store the name-phrase audio blob to save as voice embedding #1
  const nameAudioBlobRef = useRef<Blob | null>(null);

  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { retryRef.current = retryCount; }, [retryCount]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── TTS — navigation only happens inside onDone callbacks ─────────────────
  const speak = useCallback((text: string, onDone?: () => void) => {
    if (ttsRef.current) {
      ttsRef.current.onended = null;
      ttsRef.current.onerror = null;
      ttsRef.current.pause();
      ttsRef.current = null;
    }
    if (!mountedRef.current) return;
    setIsSpeaking(true);
    setStatusText(text.slice(0, 120));

    const audio = new Audio(`/voice/tts?text=${encodeURIComponent(text)}`);
    ttsRef.current = audio;

    const finish = () => {
      if (!mountedRef.current) return;
      setIsSpeaking(false);
      ttsRef.current = null;
      onDone?.();
    };
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(finish);
  }, []);

  // ── Stop all active microphone streams ────────────────────────────────────
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (mrRef.current) {
      try {
        if (mrRef.current.state !== "inactive") mrRef.current.stop();
      } catch (_) {}
      mrRef.current = null;
    }
  }, []);

  // ── Web Speech API for yes/no — SR disabled while TTS is playing ──────────
  const stopSR = useCallback(() => {
    if (srRef.current) { try { srRef.current.stop(); } catch (_) {} srRef.current = null; }
  }, []);

  const listenYesNo = useCallback((onYes: () => void, onNo: () => void) => {
    stopSR();
    chunksRef.current = [];

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setTimeout(onYes, 4500); return; }

    // Auto-confirm fallback: 12 seconds — long enough for user to respond
    const fallback = setTimeout(() => {
      if (srRef.current) { stopSR(); onYes(); }
    }, 12000);

    // FIX: track whether this SR instance is still active to prevent zombie restarts
    let resolved = false;
    const resolve = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(fallback);
      stopSR();
      fn();
    };

    const startSR = () => {
      if (resolved || !mountedRef.current) return;
      try {
        const r = new SR();
        // FIX: use 'en-US' — broader support than 'en-IN'; avoids no-speech errors on more browsers
        r.continuous = false;     // FIX: false = one utterance at a time, auto-stops cleanly
        r.interimResults = true;
        r.lang = "en-US";
        r.maxAlternatives = 3;    // FIX: check all alternatives for yes/no
        srRef.current = r;

        r.onresult = (e: any) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            // FIX: check all alternatives, not just index 0
            for (let a = 0; a < (e.results[i].length || 1); a++) {
              const t = String(e.results[i][a]?.transcript || "").toLowerCase().trim();
              if (/\b(yes|yeah|correct|right|confirm|ok(ay)?|sure|yep|that'?s? (right|correct)|looks good|go ahead)\b/.test(t)) {
                resolve(onYes); return;
              }
              if (/\b(no|nope|wrong|incorrect|retry|again|redo|change|not right)\b/.test(t)) {
                resolve(onNo); return;
              }
            }
          }
        };

        // FIX: onerror restarts SR instead of nulling ref — "no-speech" is not fatal
        r.onerror = (e: any) => {
          const errType = e?.error || "";
          if (errType === "aborted" || errType === "not-allowed" || resolved) {
            srRef.current = null;
            return;
          }
          // For no-speech, network, audio-capture errors — restart after delay
          srRef.current = null;
          setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 400);
        };

        // FIX: onend restarts for another utterance (continuous=false ends after each result)
        r.onend = () => {
          if (!resolved && srRef.current === r && mountedRef.current) {
            srRef.current = null;
            setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 300);
          }
        };

        r.start();
      } catch (_) {
        // If SR constructor throws, restart after delay
        setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 500);
      }
    };

    startSR();
  }, [stopSR]);

  // ── Stop waveform ─────────────────────────────────────────────────────────
  const stopWave = useCallback(() => {
    if (waveRef.current) { clearInterval(waveRef.current); waveRef.current = null; }
    if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
    if (ctxRef.current)  { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }
    anRef.current = null;
    setWaveH(Array(16).fill(5));
  }, []);

  // ── Start recording ───────────────────────────────────────────────────────
  const startRec = useCallback(async (durationMs = RECORD_MS) => {
    setApiError("");
    stopStream();
    chunksRef.current = [];
    maxRmsRef.current = 0;
    recEndedRef.current = false;
    setRecordProgress(0);
    setIsRecording(true);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
    } catch {
      setApiError("Microphone permission denied. Please allow microphone access.");
      setIsRecording(false);
      return;
    }
    streamRef.current = stream;

    try {
      const ctx = new AudioContext(); ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser(); an.fftSize = 256; src.connect(an); anRef.current = an;
      const buf = new Uint8Array(an.frequencyBinCount);
      waveRef.current = setInterval(() => {
        an.getByteTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / buf.length);
        if (rms > maxRmsRef.current) maxRmsRef.current = rms;
        const scale = Math.min(rms * 280, 35);
        setWaveH(Array(16).fill(0).map(() =>
          rms > 0.008 ? Math.round(scale + Math.random() * 8 + 4) : 5
        ));
        // Real-time quality hint
        if (rms > 0.05) setStatusText("✓ Good voice detected — keep speaking");
        else if (rms > 0.015) setStatusText("Voice detected — speak a bit louder");
        else if (rms > 0.005) setStatusText("Too quiet — please speak louder");
      }, 80);
    } catch (_) {}

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    mimeRef.current = mime;
    const mr = new MediaRecorder(stream, { mimeType: mime });
    mrRef.current = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.start(200);

    const t0 = Date.now();
    progRef.current = setInterval(() => setRecordProgress(Math.min(100, (Date.now() - t0) / durationMs * 100)), 100);

    setTimeout(() => {
      if (!mountedRef.current) return;
      if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
      stopWave();
      setIsRecording(false);
      recEndedRef.current = true;
      const m = mrRef.current;
      if (m && m.state !== "inactive") {
        m.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        };
        try { m.stop(); } catch (_) {}
      } else {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      mrRef.current = null;
    }, durationMs);
  }, [stopWave, stopStream]);

  // ── After recording finishes ──────────────────────────────────────────────
  useEffect(() => {
    if (isRecording || chunksRef.current.length === 0) return;
    if (!recEndedRef.current) return;
    recEndedRef.current = false;
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    if (stepRef.current === "listening_name") processNameBlob(blob);
    // FIX v7: voice_sample step removed — no second recording needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  // ── Process name blob ─────────────────────────────────────────────────────
  const processNameBlob = async (blob: Blob) => {
    if (blob.size < MIN_BYTES || maxRmsRef.current < MIN_RMS) {
      speak(
        "I couldn't hear you clearly. Please speak louder and say the full phrase: My name is, followed by your name, I will use this voice to access this app.",
        () => {
          if (!mountedRef.current) return;
          setStep("listening_name");
          chunksRef.current = [];
          setTimeout(() => startRec(), 700);
        }
      );
      return;
    }
    // Store this high-quality blob — will be saved as voice embedding #1 after registration
    nameAudioBlobRef.current = blob;
    setIsProcessing(true);
    setStatusText("Recognising your name…");
    try {
      const data = await api.extractNameFromVoice(blob);
      if (data.success && data.name) {
        setDetectedName(data.name);
        setStep("confirm_name");
        // STT only starts AFTER TTS finishes speaking
        speak(
          `I heard your name as ${data.name}. Say yes to confirm, or no to try again.`,
          () => {
            if (!mountedRef.current) return;
            setStatusText("Listening… say yes or no");
            listenYesNo(
              () => registerAndProceed(data.name!),
              () => speak(
                "Okay, let's try again. Please say: My name is, followed by your name, I will use this voice to access this app.",
                () => {
                  if (!mountedRef.current) return;
                  setStep("listening_name");
                  chunksRef.current = [];
                  setTimeout(() => startRec(), 700);
                }
              )
            );
          }
        );
      } else {
        const retry = retryRef.current;
        setRetryCount(c => c + 1);
        const msg = retry < 2
          ? "I didn't catch your name. Say: My name is Alice, I will use this voice to access this app."
          : "Having trouble hearing you. Please speak clearly: My name is Alice, I will use this voice to access this app.";
        speak(msg, () => {
          if (!mountedRef.current) return;
          setStep("listening_name");
          chunksRef.current = [];
          setTimeout(() => startRec(), 700);
        });
      }
    } catch {
      speak("Backend error. Please ensure the server is running.", () => {
        if (!mountedRef.current) return;
        setStep("intro");
      });
    }
    setIsProcessing(false);
  };

  // ── Record "Hey Vox" for authentication matching ──────────────────────────
  // This is the critical fix: the lock screen compares "Hey Vox" audio against
  // stored embeddings. We must save a "Hey Vox" embedding during registration
  // so the comparison succeeds. The name-phrase alone never matches "Hey Vox".
  const recordWakePhrase = useCallback(async (registeredUserId: number, userName: string, attempt: number = 1) => {
    if (!mountedRef.current) return;
    const wakePhrase = getWakePhrase();
    setStep("voice_auth");
    chunksRef.current = [];
    maxRmsRef.current = 0;
    recEndedRef.current = false;

    const prompt = attempt === 1
      ? `Almost done, ${userName}! Now I need to learn your unlock voice. Please say: ${wakePhrase}`
      : `Please say ${wakePhrase} once more clearly.`;

    speak(prompt, async () => {
      if (!mountedRef.current) return;
      setStatusText(`Say "${wakePhrase}" clearly…`);
      await new Promise(r => setTimeout(r, 700));
      if (!mountedRef.current) return;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        speak("Microphone unavailable. Proceeding to wake phrase setup.", () => {
          if (!mountedRef.current) return;
          setStep("done");
          setTimeout(() => navigate("/wake-phrase-setup"), 500);
        });
        return;
      }
      streamRef.current = stream;
      setIsRecording(true);
      setRecordProgress(0);

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      mimeRef.current = mime;
      const mr = new MediaRecorder(stream, { mimeType: mime });
      mrRef.current = mr;
      mr.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      // Waveform visualiser
      try {
        const ctx2 = new AudioContext(); ctxRef.current = ctx2;
        const src2 = ctx2.createMediaStreamSource(stream);
        const an2 = ctx2.createAnalyser(); an2.fftSize = 256;
        src2.connect(an2); anRef.current = an2;
        const buf2 = new Uint8Array(an2.frequencyBinCount);
        waveRef.current = setInterval(() => {
          an2.getByteTimeDomainData(buf2);
          const rms = Math.sqrt(buf2.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / buf2.length);
          if (rms > maxRmsRef.current) maxRmsRef.current = rms;
          const sc = Math.min(rms * 280, 32);
          setWaveH(Array(16).fill(0).map(() => rms > MIN_RMS ? Math.round(sc + Math.random() * 8 + 4) : 4));
        }, 80);
      } catch (_) {}

      const t0 = Date.now();
      progRef.current = setInterval(() => setRecordProgress(Math.min(100, (Date.now() - t0) / WAKE_RECORD_MS * 100)), 100);
      mr.start(200);

      setTimeout(async () => {
        if (!mountedRef.current) return;
        if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
        if (waveRef.current) { clearInterval(waveRef.current); waveRef.current = null; }
        setIsRecording(false);
        setWaveH(Array(16).fill(4));

        await new Promise<void>(resolve => {
          const m = mrRef.current;
          if (m && m.state !== "inactive") { m.onstop = () => resolve(); try { m.stop(); } catch { resolve(); } }
          else resolve();
        });
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (ctxRef.current) { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }

        const totalBytes = chunksRef.current.reduce((s, b) => s + b.size, 0);
        if (totalBytes < 3000 || maxRmsRef.current < MIN_RMS) {
          if (attempt < 3) {
            speak(`Couldn't hear that. Please say ${wakePhrase} again.`, () => {
              if (!mountedRef.current) return;
              recordWakePhrase(registeredUserId, userName, attempt + 1);
            });
          } else {
            speak("Moving on. You can add more voice samples from your profile later.", () => {
              if (!mountedRef.current) return;
              setStep("done");
              setTimeout(() => navigate("/wake-phrase-setup"), 500);
            });
          }
          return;
        }

        setIsProcessing(true);
        setStatusText("Saving voice authentication profile…");
        try {
          const blob = new Blob(chunksRef.current, { type: mimeRef.current });
          await api.uploadVoiceSample(registeredUserId, blob);
          console.log("[reg] ✅ Saved wake-phrase audio as voice embedding #2");
        } catch (e) {
          console.warn("[reg] Could not save wake-phrase embedding:", e);
        }
        setIsProcessing(false);
        chunksRef.current = [];
        setStep("done");
        speak(
          `Your voice profile is complete! Let's set up your wake phrase now.`,
          () => {
            if (!mountedRef.current) return;
            stopStream();
            stopSR();
            setTimeout(() => navigate("/wake-phrase-setup"), 500);
          }
        );
      }, WAKE_RECORD_MS);
    });
  }, [speak, navigate, stopStream, stopSR]);

  // ── Register name and proceed ─────────────────────────────────────────────
  const registerAndProceed = useCallback(async (name: string) => {
    stopSR();
    setIsProcessing(true);
    setStatusText("Creating your account…");
    try {
      const res = await api.registerUser(name, "voice_auth_user");
      setUserId2(res.user_id);
      registerUser({ id: res.user_id, name: res.user_name, pin: "voice", voiceSamples: [], registeredAt: new Date().toISOString() });
      setUserId(res.user_id);

      // Save the name-phrase recording as voice embedding #1
      if (nameAudioBlobRef.current) {
        try {
          await api.uploadVoiceSample(res.user_id, nameAudioBlobRef.current);
          console.log("[reg] Saved name-phrase audio as voice embedding #1");
        } catch (e) {
          console.warn("[reg] Could not save name-phrase audio as embedding, continuing:", e);
        }
        nameAudioBlobRef.current = null;
      }

      setIsProcessing(false);
      chunksRef.current = [];

      // v6.0 FIX: Record wake phrase ("Hey Vox") as embedding #2.
      // The lock screen sends "Hey Vox" audio for authentication.
      // Without a "Hey Vox" embedding, the name-phrase embedding never matches.
      recordWakePhrase(res.user_id, res.user_name);

    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("exist")) {
        // User row already exists — if setup is complete send to locked, else resume setup
        const setupDone = localStorage.getItem("vox_setup_complete") === "1"
          && !!localStorage.getItem("vox_wake_phrase");
        speak("An account already exists. Resuming your session.", () => {
          if (!mountedRef.current) return;
          navigate(setupDone ? "/locked" : "/wake-phrase-setup");
        });
      } else {
        speak("Registration failed. Please check the backend server is running.", () => {
          if (!mountedRef.current) return;
          setStep("intro");
        });
      }
      setIsProcessing(false);
    }
  }, [registerUser, setUserId, speak, stopSR, navigate, recordWakePhrase]);

  // ── Auto-start on mount ───────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      speak(
        "Welcome to VoxLedger! Let's set up your account by voice. Please say the following phrase: My name is, then your name, then: I will use this voice to access this app.",
        () => {
          if (!mountedRef.current) return;
          setStep("listening_name");
          setStatusText('Listening — say: "My name is Alice, I will use this voice to access this app."');
          setTimeout(() => startRec(), 700);
        }
      );
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full cleanup on unmount — stop mic, TTS, SR to prevent voice leakage
  useEffect(() => () => {
    stopWave();
    stopSR();
    stopStream();
    if (ttsRef.current) {
      ttsRef.current.onended = null;
      ttsRef.current.onerror = null;
      ttsRef.current.pause();
      ttsRef.current = null;
    }
  }, [stopWave, stopSR, stopStream]);

  // FIX v7: "voice_sample" step removed — flow is now intro → listening_name → confirm_name → done
  const stepIdx  = ["intro","listening_name","confirm_name","done"].indexOf(step);
  const waveColor = "bg-primary";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-primary/5 to-secondary/20 px-4">
      <motion.div className="w-full max-w-sm" initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }}>

        {/* Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary shadow-lg mb-3">
            <Volume2 className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold">VoxLedger</h1>
          <p className="text-xs text-muted-foreground mt-1">Voice-First Finance Assistant</p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-5">
          {[0,1,2,3,4].map(i => (
            <div key={i} className={`rounded-full transition-all duration-300 ${
              i === stepIdx ? "w-6 h-1.5 bg-primary" :
              i < stepIdx  ? "w-3 h-1.5 bg-primary/40" : "w-3 h-1.5 bg-secondary"
            }`} />
          ))}
        </div>

        {/* Card */}
        <div className="rounded-3xl bg-card border border-border shadow-2xl px-6 py-8 overflow-hidden">
          <AnimatePresence mode="wait">

            {/* INTRO */}
            {step === "intro" && (
              <motion.div key="intro" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-4">
                <div className="relative inline-flex items-center justify-center">
                  {isSpeaking && (
                    <motion.div className="absolute rounded-full bg-primary opacity-15"
                      animate={{ scale: [1, 1.5], opacity: [0.2, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                      style={{ width: 96, height: 96 }} />
                  )}
                  <div className="w-20 h-20 rounded-full bg-primary/15 flex items-center justify-center">
                    <Bot className="h-10 w-10 text-primary" />
                  </div>
                </div>
                <p className="font-bold text-lg">Setting up VoxLedger…</p>
                {isSpeaking && (
                  <div className="flex items-center justify-center gap-2 text-sm text-primary">
                    <Volume2 className="h-4 w-4 animate-pulse" /> Speaking instructions…
                  </div>
                )}
              </motion.div>
            )}

            {/* LISTENING FOR NAME */}
            {step === "listening_name" && (
              <motion.div key="listening_name" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }} className="text-center space-y-5">
                <div className="relative inline-flex items-center justify-center">
                  {isRecording && (
                    <motion.div className="absolute rounded-full bg-primary opacity-20"
                      animate={{ scale: [1, 1.6], opacity: [0.3, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                      style={{ width: 96, height: 96 }} />
                  )}
                  <div className={`w-20 h-20 rounded-full ${isRecording ? "bg-primary" : "bg-primary/20"} flex items-center justify-center shadow-lg`}>
                    {isRecording ? (
                      <motion.div animate={{ scale: [1, 1.12, 1] }} transition={{ duration: 0.8, repeat: Infinity }}>
                        <Mic className="h-9 w-9 text-white" />
                      </motion.div>
                    ) : (
                      <Mic className="h-9 w-9 text-primary" />
                    )}
                  </div>
                </div>
                <div>
                  <p className="font-bold text-foreground">
                    {isProcessing ? "Processing…" : isRecording ? "Listening…" : "Preparing…"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    Say: <span className="font-semibold text-primary italic">{NAME_PHRASE}</span>
                  </p>
                </div>
                {isRecording && (
                  <>
                    <div className="flex items-end justify-center gap-0 h-12">
                      {waveH.map((h, i) => <WaveBar key={i} h={h} color={waveColor} />)}
                    </div>
                    <div className="w-full bg-secondary rounded-full h-1.5">
                      <motion.div className="bg-primary h-1.5 rounded-full" style={{ width: `${recordProgress}%` }} />
                    </div>
                    {statusText && (
                      <p className={`text-xs font-medium ${statusText.startsWith("✓") ? "text-emerald-600" : "text-muted-foreground"}`}>
                        {statusText}
                      </p>
                    )}
                  </>
                )}
                {isProcessing && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Recognising your name…
                  </div>
                )}
                {apiError && (
                  <div className="flex items-start gap-2 rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                    <p className="text-xs text-destructive">{apiError}</p>
                  </div>
                )}
              </motion.div>
            )}

            {/* CONFIRM NAME */}
            {step === "confirm_name" && (
              <motion.div key="confirm_name" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }} className="text-center space-y-5">
                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
                  <Check className="h-8 w-8 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">I heard your name as:</p>
                  <p className="text-3xl font-extrabold text-primary mt-1">{detectedName}</p>
                </div>
                {isSpeaking ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="h-3.5 w-3.5 animate-pulse" /> Speaking…
                  </div>
                ) : isProcessing ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Creating account…
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-2xl bg-primary/5 border border-primary/20 px-4 py-3">
                      <p className="text-sm font-semibold text-foreground">
                        🎙 Say <span className="text-primary">"yes"</span> to confirm
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        or say <span className="font-semibold">"no"</span> to retry
                      </p>
                    </div>
                    {/* Tap fallback — always visible so user can proceed if SR fails */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => { stopSR(); registerAndProceed(detectedName); }}
                        className="flex-1 rounded-xl bg-primary text-white text-sm font-semibold py-2.5 hover:bg-primary/90 active:scale-95 transition-all"
                      >
                        ✓ Yes, that's me
                      </button>
                      <button
                        onClick={() => {
                          stopSR();
                          speak(
                            "Okay, let's try again. Please say: My name is, followed by your name, I will use this voice to access this app.",
                            () => {
                              if (!mountedRef.current) return;
                              setStep("listening_name");
                              chunksRef.current = [];
                              setTimeout(() => startRec(), 700);
                            }
                          );
                        }}
                        className="flex-1 rounded-xl bg-secondary text-foreground text-sm font-semibold py-2.5 hover:bg-secondary/80 active:scale-95 transition-all"
                      >
                        ✗ Retry
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* VOICE AUTH — record "Hey Vox" for lock screen matching */}
            {step === "voice_auth" && (
              <motion.div key="voice_auth" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-5">
                <div className="relative inline-flex">
                  {isRecording && (
                    <motion.div className="absolute inset-0 rounded-full bg-primary/20"
                      animate={{ scale: [1, 1.6], opacity: [0.3, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                      style={{ width: 96, height: 96, left: "-8px", top: "-8px" }} />
                  )}
                  <div className={`w-20 h-20 rounded-full ${isRecording ? "bg-primary" : "bg-primary/15"} flex items-center justify-center shadow-lg`}>
                    <motion.div animate={isRecording ? { scale: [1, 1.1, 1] } : {}} transition={{ duration: 0.8, repeat: Infinity }}>
                      <Mic className={`h-9 w-9 ${isRecording ? "text-white" : "text-primary"}`} />
                    </motion.div>
                  </div>
                </div>
                <div>
                  <p className="font-bold text-base">
                    {isProcessing ? "Saving voice profile…" : isRecording ? "Recording unlock phrase…" : "Preparing…"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Say <span className="font-bold text-primary">"{getWakePhrase()}"</span> clearly
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">This teaches the app your unlock voice</p>
                </div>
                {isRecording && (
                  <>
                    <div className="flex items-end justify-center gap-0 h-10">
                      {waveH.map((h, i) => <WaveBar key={i} h={h} />)}
                    </div>
                    <div className="w-full bg-secondary rounded-full h-1.5">
                      <motion.div className="bg-primary h-1.5 rounded-full" style={{ width: `${recordProgress}%` }} />
                    </div>
                  </>
                )}
                {isProcessing && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                  </div>
                )}
                {isSpeaking && !isRecording && !isProcessing && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Volume2 className="h-4 w-4 animate-pulse" /> Listen…
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{statusText}</p>
              </motion.div>
            )}

            {/* DONE */}
            {step === "done" && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="text-center space-y-5 py-4">
                <motion.div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto"
                  animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 0.6, repeat: 2 }}>
                  <Check className="h-10 w-10 text-emerald-600" />
                </motion.div>
                <div>
                  <p className="text-lg font-bold">Registration Complete!</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Welcome, <span className="font-bold text-primary">{detectedName}</span>!
                  </p>
                </div>
                {isSpeaking && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="h-3 w-3 animate-pulse" /> Speaking…
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Setting up wake phrase…</p>
              </motion.div>
            )}

          </AnimatePresence>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          Already registered?{" "}
          <button onClick={() => navigate("/locked")} className="text-primary font-semibold hover:underline">
            Use voice to unlock →
          </button>
        </p>
      </motion.div>
    </div>
  );
}
