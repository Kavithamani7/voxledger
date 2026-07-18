/**
 * Locked.tsx — Voice-Authenticated Lock Screen (v5.0 — voice capture fixed)
 *
 * Critical fixes applied:
 *  1. RECORD_MS increased 3500→5500 — gives user more time to speak wake phrase.
 *  2. MIN_SPEECH_FRAMES reduced 5→2 — was rejecting valid speech too aggressively.
 *  3. RMS_THRESHOLD reduced 0.02→0.008 — browser mic post-processing lowers RMS.
 *  4. MIN_BLOB_BYTES reduced 10000→4000 — short phrases produce small blobs.
 *  5. CALIBRATION_FRAMES reduced 5→3 — calibration was eating into speaking window.
 *  6. Frequency-band speech detection replaced with raw time-domain RMS — simpler,
 *     more reliable on browser mic with echoCancellation+noiseSuppression active.
 *  7. doVerify quality gate uses raw maxRmsRef (time-domain) consistently.
 *  8. calibThreshRef multiplier lowered 2.0x→1.8x ambient — less aggressive.
 *  9. Waveform responds at rawRms > 0.006 (was 0.008) — shows activity sooner.
 * 10. Navigation only after TTS fully completes (onDone callbacks).
 * 11. Microphone stream fully stopped before page navigation.
 * 12. SR onend restart uses 300ms delay — prevents InvalidStateError in Chrome.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, ShieldCheck, AlertCircle, Volume2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/context/AppContext";
import * as api from "@/lib/api";

type Phase = "idle" | "listening" | "verifying" | "success" | "failed";

// ── Tuned constants for browser microphone ────────────────────────────────────
const RECORD_MS          = 6000;   // FIX v7: increased 5500→6000 — full phrase needs time
const MIN_SPEECH_FRAMES  = 3;      // FIX v7: was 2 — require 3 frames of speech signal
const RMS_THRESHOLD      = 0.010;  // FIX v7: was 0.008 — slightly stricter noise rejection
const MIN_BLOB_BYTES     = 4000;   // unchanged — short phrases produce small blobs
const CALIBRATION_FRAMES = 4;      // FIX v7: was 3 — slightly longer ambient calibration
const DEFAULT_WAKE       = "Hey Vox";
const IDLE_LOCK_MS       = 60_000;  // FIX v7: sync with App.tsx AUTO_LOCK_MS — 60s idle

function getWakePhrase(): string {
  try { return localStorage.getItem("vox_wake_phrase") || DEFAULT_WAKE; } catch (_) { return DEFAULT_WAKE; }
}

function getAuthMode(): "default" | "custom" {
  try {
    const m = localStorage.getItem("vox_auth_mode");
    return (m === "custom") ? "custom" : "default";
  } catch (_) { return "default"; }
}

export default function Locked() {
  const [phase, setPhase]             = useState<Phase>("idle");
  const [waveH, setWaveH]             = useState<number[]>(Array(22).fill(4));
  const [dots, setDots]               = useState("");
  const [failMsg, setFailMsg]         = useState("Please try again");
  const [speechDetected, setSpeechDetected] = useState(false);
  const [autoRetryIn, setAutoRetryIn] = useState(0);

  const navigate = useNavigate();
  const { user, authenticateUser } = useApp();

  // Guard: verify BOTH localStorage flags AND backend database on every mount.
  // If DB was reset but localStorage has stale data, this clears it and redirects.
  useEffect(() => {
    let cancelled = false;
    const verify = async () => {
      const setupDone = localStorage.getItem("vox_setup_complete") === "1"
        && !!localStorage.getItem("vox_wake_phrase");

      if (!setupDone) {
        const hasUser = !!localStorage.getItem("voxledger_user_id");
        navigate(hasUser ? "/wake-phrase-setup" : "/registration", { replace: true });
        return;
      }

      // Even if localStorage looks complete, confirm the DB actually has a voice profile.
      try {
        const res = await import("@/lib/api").then(m => m.checkUser());
        if (cancelled) return;
        if (!res.registered) {
          // DB was reset — clear stale localStorage and restart registration
          localStorage.removeItem("vox_setup_complete");
          localStorage.removeItem("vox_wake_phrase");
          localStorage.removeItem("vox_auth_mode");
          localStorage.removeItem("voxledger_user");
          localStorage.removeItem("voxledger_user_id");
          navigate("/registration", { replace: true });
        }
      } catch {
        // Backend offline — let the user stay on locked screen, they can retry
      }
    };
    verify();
    return () => { cancelled = true; };
  }, [navigate]);

  const chunksRef        = useRef<Blob[]>([]);
  const mimeRef          = useRef("audio/webm");
  const mrRef            = useRef<MediaRecorder | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const phaseRef         = useRef<Phase>("idle");
  const retryTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef         = useRef<(() => void) | null>(null);
  const ctxRef           = useRef<AudioContext | null>(null);
  const energyRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechFramesRef  = useRef(0);
  const maxRmsRef        = useRef(0);          // FIX: raw time-domain RMS (not frequency band)
  const calibThreshRef   = useRef(RMS_THRESHOLD);
  const calibTicksRef    = useRef(0);          // FIX: moved out of closure
  const calibSumRef      = useRef(0);          // FIX: moved out of closure
  const stopSRRef        = useRef<any>(null);
  const ttsRef           = useRef<HTMLAudioElement | null>(null);
  const isSpeakingRef    = useRef(false);
  const mountedRef       = useRef(true);
  const lastActivityRef  = useRef(Date.now());
  const idleTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── Dots animation ────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setDots(p => p.length >= 3 ? "" : p + "."), 500);
    return () => clearInterval(t);
  }, []);

  const resetIdleTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    const EVENTS = ["mousemove", "keydown", "touchstart", "click", "pointermove"];
    EVENTS.forEach(e => window.addEventListener(e, resetIdleTimer, { passive: true }));
    return () => EVENTS.forEach(e => window.removeEventListener(e, resetIdleTimer));
  }, [resetIdleTimer]);

  // ── TTS — navigation only inside onDone callbacks ─────────────────────────
  const speak = useCallback((text: string, onDone?: () => void) => {
    if (ttsRef.current) {
      ttsRef.current.onended = null;
      ttsRef.current.onerror = null;
      ttsRef.current.pause();
      ttsRef.current = null;
    }
    if (!mountedRef.current) return;
    isSpeakingRef.current = true;
    resetIdleTimer();
    const audio = new Audio(`/voice/tts?text=${encodeURIComponent(text)}`);
    ttsRef.current = audio;
    const finish = () => {
      if (!mountedRef.current) return;
      isSpeakingRef.current = false;
      ttsRef.current = null;
      onDone?.();
    };
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(finish);
  }, [resetIdleTimer]);

  // ── Stop-word listener ────────────────────────────────────────────────────
  const startStopListener = useCallback(() => {
    if (isSpeakingRef.current) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    try {
      const r = new SR();
      r.continuous = true; r.interimResults = true; r.lang = "en-IN";
      r.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = String(e.results[i][0]?.transcript || "").toLowerCase().trim();
          if (/\b(stop|cancel|abort|quit|back)\b/.test(t)) {
            try { r.stop(); } catch (_) {}
            stopSRRef.current = null;
            cleanup();
            setPhase("idle");
            break;
          }
        }
      };
      r.onerror = () => { stopSRRef.current = null; };
      r.onend = () => {
        if (stopSRRef.current === r && !isSpeakingRef.current) {
          setTimeout(() => {
            if (stopSRRef.current === r && !isSpeakingRef.current) {
              try { r.start(); } catch (_) { stopSRRef.current = null; }
            }
          }, 300);
        }
      };
      r.start();
      stopSRRef.current = r;
    } catch (_) {}
  }, []);  // eslint-disable-line

  const stopStopListener = useCallback(() => {
    const r = stopSRRef.current;
    if (r) { try { r.stop(); } catch (_) {} stopSRRef.current = null; }
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (mrRef.current) {
      try { if (mrRef.current.state !== "inactive") mrRef.current.stop(); } catch (_) {}
      mrRef.current = null;
    }
  }, []);

  const stopAll = useCallback(() => {
    stopStopListener();
    stopStream();
    if (energyRef.current)     { clearInterval(energyRef.current);  energyRef.current = null; }
    if (recTimerRef.current)   { clearTimeout(recTimerRef.current);  recTimerRef.current = null; }
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (ctxRef.current)        { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }
  }, [stopStopListener, stopStream]);

  const cleanup = useCallback(() => {
    stopAll();
    chunksRef.current = [];
    setWaveH(Array(22).fill(4));
    speechFramesRef.current = 0;
    maxRmsRef.current = 0;
    calibThreshRef.current = RMS_THRESHOLD;
    calibTicksRef.current = 0;
    calibSumRef.current = 0;
    setSpeechDetected(false);
    setAutoRetryIn(0);
  }, [stopAll]);

  const scheduleRetry = useCallback((msg: string, delayMs = 2500) => {
    if (/register/i.test(msg) || /voice profile/i.test(msg) || /no user/i.test(msg)) {
      // Clear stale localStorage so Registration starts fresh
      localStorage.removeItem("vox_setup_complete");
      localStorage.removeItem("vox_wake_phrase");
      localStorage.removeItem("vox_auth_mode");
      localStorage.removeItem("voxledger_user");
      localStorage.removeItem("voxledger_user_id");
      navigate("/registration", { replace: true });
      return;
    }
    setFailMsg(msg);
    setPhase("failed");
    let countdown = Math.ceil(delayMs / 1000);
    setAutoRetryIn(countdown);
    const countInterval = setInterval(() => {
      countdown -= 1;
      setAutoRetryIn(countdown);
      if (countdown <= 0) clearInterval(countInterval);
    }, 1000);

    retryTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setPhase("idle");
      retryTimerRef.current = setTimeout(() => startRef.current?.(), 350);
    }, delayMs);
  }, [navigate]);

  // ── doVerify — FIX: uses consistent raw RMS threshold ────────────────────
  const doVerify = useCallback(async () => {
    stopAll();
    setPhase("verifying");

    // FIX: raw RMS check (time-domain) — consistent with how maxRmsRef is set in energyRef interval
    if (speechFramesRef.current < MIN_SPEECH_FRAMES || maxRmsRef.current < RMS_THRESHOLD) {
      const msg = `No voice detected. Please say "${getWakePhrase()}" clearly and loudly.`;
      speak(msg, () => scheduleRetry(msg, 2000));
      return;
    }
    const totalBytes = chunksRef.current.reduce((s, b) => s + b.size, 0);
    if (totalBytes < MIN_BLOB_BYTES) {
      const msg = "Audio too short. Please speak louder and say the full wake phrase.";
      speak(msg, () => scheduleRetry(msg, 2000));
      return;
    }

    try {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      const res = await api.verifyVoice(blob);
      if (res.authenticated) {
        setPhase("success");
        authenticateUser(res.user_id);
        resetIdleTimer();
        speak(`Welcome back, ${res.user_name || user?.name || ""}! Opening your dashboard.`, () => {
          stopAll();
          setTimeout(() => {
            if (!mountedRef.current) return;
            navigate("/greeting");
          }, 400);
        });
      } else {
        // FIX v7: Clear, actionable rejection messages based on failure reason
        let errMsg = "Voice not recognised. Please try again.";
        if (res.message) {
          if (/noise|quiet|silent/i.test(res.message)) {
            errMsg = "Background noise detected. Please move to a quieter place and try again.";
          } else if (/short|brief/i.test(res.message)) {
            errMsg = "Audio was too short. Please speak the full wake phrase clearly.";
          } else if (/match|recogni/i.test(res.message)) {
            errMsg = "Voice did not match. Only the registered user can unlock. Please try again.";
          } else {
            errMsg = res.message;
          }
        }
        speak(errMsg, () => scheduleRetry(errMsg, 2200));
      }
    } catch {
      speak("Connection error. Please check the backend server is running.", () => scheduleRetry("Connection error.", 2500));
    }
  }, [stopAll, scheduleRetry, authenticateUser, navigate, user, speak, resetIdleTimer]);

  // ── startListening — FIX: time-domain RMS only, no frequency-band detection ─
  const startListening = useCallback(async () => {
    if (phaseRef.current === "listening" || phaseRef.current === "verifying" || phaseRef.current === "success") return;
    if (isSpeakingRef.current) return;
    cleanup();
    chunksRef.current = [];
    setPhase("listening");
    resetIdleTimer();
    startStopListener();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
    } catch {
      scheduleRetry("Microphone access denied. Please allow microphone access and try again.");
      return;
    }
    streamRef.current = stream;

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    mimeRef.current = mime;
    const mr = new MediaRecorder(stream, { mimeType: mime });
    mrRef.current = mr;
    mr.ondataavailable = e => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    mr.start(200);

    // FIX: time-domain analyser ONLY — frequency-band approach was unreliable with browser mic
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);

    const anTime = ctx.createAnalyser();
    anTime.fftSize = 256;
    src.connect(anTime);
    const timeBuf = new Uint8Array(anTime.frequencyBinCount);

    energyRef.current = setInterval(() => {
      anTime.getByteTimeDomainData(timeBuf);
      const rawRms = Math.sqrt(
        timeBuf.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / timeBuf.length
      );

      // FIX: ambient calibration with fewer frames (3 vs 5) and less aggressive multiplier (1.8x vs 2.0x)
      if (calibTicksRef.current < CALIBRATION_FRAMES) {
        calibSumRef.current += rawRms;
        calibTicksRef.current++;
        if (calibTicksRef.current === CALIBRATION_FRAMES) {
          const ambient = calibSumRef.current / CALIBRATION_FRAMES;
          calibThreshRef.current = Math.max(RMS_THRESHOLD, ambient * 1.8);
        }
      }

      const THRESH = calibThreshRef.current;
      if (rawRms > THRESH) {
        speechFramesRef.current++;
        if (rawRms > maxRmsRef.current) maxRmsRef.current = rawRms;
        if (speechFramesRef.current >= 2) setSpeechDetected(true);
      }

      // Waveform — responds at lower threshold for visual feedback
      const scale = Math.min(rawRms * 280, 40);
      setWaveH(Array(22).fill(0).map(() =>
        rawRms > 0.006 ? Math.round(scale + Math.random() * 8 + 4) : 4
      ));
    }, 80);

    recTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      doVerify();
    }, RECORD_MS);
  }, [cleanup, startStopListener, scheduleRetry, doVerify, resetIdleTimer]);

  useEffect(() => { startRef.current = startListening; }, [startListening]);

  // ── Idle timeout ──────────────────────────────────────────────────────────
  useEffect(() => {
    idleTimerRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_LOCK_MS) {
        if (mountedRef.current && phaseRef.current !== "listening" && phaseRef.current !== "verifying") {
          cleanup();
          setPhase("idle");
          setTimeout(() => startRef.current?.(), 800);
        }
      }
    }, 10_000);
    return () => {
      if (idleTimerRef.current) clearInterval(idleTimerRef.current);
    };
  }, [cleanup]);

  // ── Auto-start with TTS greeting ──────────────────────────────────────────
  useEffect(() => {
    const wakePhrase = getWakePhrase();
    const t = setTimeout(() => {
      const authMode = getAuthMode();
      const unlockHint = authMode === "custom"
        ? `VoxLedger is locked. Say anything — I will recognise your voice to unlock.`
        : `VoxLedger is locked. Say "${wakePhrase}" to unlock with your registered voice.`;
      speak(
        unlockHint,
        () => {
          if (mountedRef.current) startListening();
        }
      );
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Full cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => () => {
    cleanup();
    if (ttsRef.current) {
      ttsRef.current.onended = null;
      ttsRef.current.onerror = null;
      ttsRef.current.pause();
      ttsRef.current = null;
    }
    if (idleTimerRef.current) clearInterval(idleTimerRef.current);
  }, [cleanup]);

  const wakePhrase = getWakePhrase();

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-primary/5 to-secondary/20 px-6 select-none"
      onClick={() => { resetIdleTimer(); if (phase === "idle" || phase === "failed") startListening(); }}
    >
      <motion.div className="w-full max-w-sm flex flex-col items-center gap-8"
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>

        <motion.div
          animate={phase === "success" ? { scale: [1, 1.15, 1], backgroundColor: ["#6366f1", "#10b981"] } : {}}
          transition={{ duration: 0.5 }}
          className={`h-24 w-24 rounded-3xl flex items-center justify-center shadow-2xl transition-colors duration-500 ${
            phase === "success" ? "bg-emerald-500" :
            phase === "failed"  ? "bg-destructive/80" :
            "bg-primary"
          }`}
        >
          {phase === "failed"
            ? <AlertCircle className="h-12 w-12 text-white" />
            : <ShieldCheck  className="h-12 w-12 text-white" />
          }
        </motion.div>

        <div className="text-center">
          <h1 className="text-3xl font-extrabold">VoxLedger</h1>
          <p className="text-sm text-muted-foreground mt-1">Voice-secured finance assistant</p>
        </div>

        <div className="w-full rounded-3xl bg-card/80 backdrop-blur border border-border shadow-xl px-6 py-7 flex flex-col items-center gap-5">
          <AnimatePresence mode="wait">

            {phase === "idle" && (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Mic className="h-8 w-8 text-primary" />
                </div>
                <p className="font-semibold">Say to unlock:</p>
                <p className="text-xl font-extrabold text-primary">"{wakePhrase}"</p>
                <p className="text-xs text-muted-foreground">Tap anywhere to start listening</p>
              </motion.div>
            )}

            {phase === "listening" && (
              <motion.div key="listening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-4 w-full">
                <div className="relative inline-flex items-center justify-center">
                  <motion.div
                    animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                    className="absolute inset-0 rounded-full bg-primary/30"
                  />
                  <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center shadow-lg">
                    <motion.div animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 0.8, repeat: Infinity }}>
                      <Mic className="h-8 w-8 text-white" />
                    </motion.div>
                  </div>
                </div>
                <p className="font-semibold">Listening{dots}</p>
                <p className="text-xs text-muted-foreground">
{(() => {
                    const mode = getAuthMode();
                    return mode === "custom"
                      ? <span>Say <span className="font-bold text-primary">any sentence</span> — voice ID unlocks</span>
                      : <span>Say <span className="font-bold text-primary">"{wakePhrase}"</span> clearly</span>;
                  })()}
                </p>
                <div className="flex items-end justify-center gap-0.5 h-12">
                  {waveH.map((h, i) => (
                    <motion.div key={i}
                      initial={{ height: 4 }}
                      animate={{ height: Math.max(4, Math.min(h, 44)) }}
                      transition={{ duration: 0.07 }}
                      className={`w-1.5 rounded-full ${speechDetected ? "bg-primary" : "bg-primary/40"}`}
                    />
                  ))}
                </div>
                {speechDetected ? (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="text-xs font-semibold text-primary">
                    Voice detected — verifying…
                  </motion.p>
                ) : (
                  <p className="text-xs text-muted-foreground/60">Speak loudly and clearly into your microphone</p>
                )}
              </motion.div>
            )}

            {phase === "verifying" && (
              <motion.div key="verifying" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-4">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
                  className="w-16 h-16 rounded-full border-4 border-primary/20 border-t-primary mx-auto"
                />
                <p className="font-semibold">Verifying voice{dots}</p>
                <p className="text-xs text-muted-foreground">Matching your voice profile</p>
              </motion.div>
            )}

            {phase === "success" && (
              <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="text-center space-y-3">
                <motion.div
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 0.5, repeat: 2 }}
                  className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto"
                >
                  <ShieldCheck className="h-8 w-8 text-emerald-600" />
                </motion.div>
                <p className="font-bold text-emerald-600">Access Granted!</p>
                <p className="text-xs text-muted-foreground">Opening dashboard…</p>
              </motion.div>
            )}

            {phase === "failed" && (
              <motion.div key="failed" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }} className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                  <AlertCircle className="h-8 w-8 text-destructive" />
                </div>
                <p className="font-semibold text-destructive">Authentication Failed</p>
                <p className="text-sm text-muted-foreground">{failMsg}</p>
                {autoRetryIn > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Retrying in {autoRetryIn}s… or tap to retry now
                  </p>
                )}
                <div className="flex items-center justify-center gap-1 text-xs text-primary/60 mt-1">
                  <Volume2 className="h-3 w-3" />
                  <span>Tip: Speak loudly and clearly</span>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          New here?{" "}
          <button onClick={(e) => { e.stopPropagation(); navigate("/registration"); }}
            className="text-primary font-semibold hover:underline">
            Register with voice →
          </button>
        </p>
      </motion.div>
    </div>
  );
}
