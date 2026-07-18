/**
 * WakePhraseSetup.tsx — v5.0 Voice-Guided Wake Phrase Setup
 *
 * Upgrades in v5.0:
 *  - Clear tap-first choice: "Use Hey Vox" vs "Custom Phrase" buttons shown immediately
 *  - Voice choice also works: say "yes" / "no" after TTS
 *  - Custom phrase: user records their own sentence, app transcribes it
 *  - Auth mode stored: "default" (keyword match) vs "custom" (voice ID only)
 *  - All navigation only after TTS completes
 *  - Microphone fully stopped before navigation
 *  - 600ms gap after TTS before mic opens
 *  - recDoneRef prevents double-processing
 *  - mountedRef guards all async callbacks
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Check, Volume2, Loader2, Zap, Star } from "lucide-react";
import { useNavigate } from "react-router-dom";

type Phase = "choose" | "listening" | "confirm" | "done";

const DEFAULT_WAKE_PHRASE = "Hey Vox";
const RECORD_MS  = 5000;
const MIN_BYTES  = 4000;
const MIN_RMS    = 0.008;

function WaveBar({ h }: { h: number }) {
  return (
    <motion.span
      initial={{ height: 4 }}
      animate={{ height: Math.max(4, Math.min(h, 36)) }}
      transition={{ duration: 0.07 }}
      className="inline-block rounded-full bg-primary"
      style={{ width: 4, margin: "0 2px" }}
    />
  );
}

export default function WakePhraseSetup() {
  const [phase, setPhase]           = useState<Phase>("choose");
  const [detected, setDetected]     = useState("");
  const [isRec, setIsRec]           = useState(false);
  const [progress, setProgress]     = useState(0);
  const [waveH, setWaveH]           = useState<number[]>(Array(16).fill(4));
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isProc, setIsProc]         = useState(false);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText]   = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const alreadyDone = localStorage.getItem("vox_setup_complete") === "1"
        && !!localStorage.getItem("vox_wake_phrase");
      if (!alreadyDone) return;
      try {
        const res = await import("@/lib/api").then(m => m.checkUser());
        if (cancelled) return;
        if (res.registered) {
          navigate("/locked", { replace: true });
        } else {
          // DB reset — clear stale flags and stay here for setup
          localStorage.removeItem("vox_setup_complete");
          localStorage.removeItem("vox_wake_phrase");
          localStorage.removeItem("vox_auth_mode");
        }
      } catch {
        navigate("/locked", { replace: true });
      }
    };
    check();
    return () => { cancelled = true; };
  }, [navigate]);

  const ttsRef     = useRef<HTMLAudioElement | null>(null);
  const mrRef      = useRef<MediaRecorder | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const chunksRef  = useRef<Blob[]>([]);
  const mimeRef    = useRef("audio/webm");
  const ctxRef     = useRef<AudioContext | null>(null);
  const anTimeRef  = useRef<AnalyserNode | null>(null);
  const waveRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const progRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxRmsRef  = useRef(0);
  const phaseRef   = useRef<Phase>("choose");
  const srRef      = useRef<any>(null);
  const mountedRef = useRef(true);
  const recDoneRef = useRef(false);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => () => { mountedRef.current = false; }, []);

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

  const stopSR = useCallback(() => {
    if (srRef.current) { try { srRef.current.stop(); } catch (_) {} srRef.current = null; }
  }, []);

  const listenYesNo = useCallback((onYes: () => void, onNo: () => void) => {
    stopSR();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setTimeout(onYes, 6000); return; }
    let resolved = false;
    const fallback = setTimeout(() => {
      if (!resolved && mountedRef.current) { resolved = true; stopSR(); onYes(); }
    }, 10000);
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
        r.continuous = false; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 3;
        srRef.current = r;
        r.onresult = (e: any) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            for (let a = 0; a < (e.results[i].length || 1); a++) {
              const t = String(e.results[i][a]?.transcript || "").toLowerCase().trim();
              if (/\b(yes|yeah|correct|right|ok(ay)?|sure|use|default|go ahead|hey vox|sounds good)\b/.test(t)) { resolve(onYes); return; }
              if (/\b(no|nope|custom|own|different|change|my own|other)\b/.test(t)) { resolve(onNo); return; }
            }
          }
        };
        r.onerror = (e: any) => {
          const err = e?.error || "";
          if (err === "aborted" || err === "not-allowed" || resolved) { srRef.current = null; return; }
          srRef.current = null;
          setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 400);
        };
        r.onend = () => {
          if (!resolved && srRef.current === r && mountedRef.current) {
            srRef.current = null;
            setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 300);
          }
        };
        r.start();
      } catch (_) { setTimeout(() => { if (!resolved && mountedRef.current) startSR(); }, 500); }
    };
    startSR();
  }, [stopSR]);

  const stopStream = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (mrRef.current) { try { if (mrRef.current.state !== "inactive") mrRef.current.stop(); } catch (_) {} mrRef.current = null; }
  }, []);

  const stopWave = useCallback(() => {
    if (waveRef.current) { clearInterval(waveRef.current); waveRef.current = null; }
    if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
    if (ctxRef.current)  { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }
    anTimeRef.current = null;
    setWaveH(Array(16).fill(4));
  }, []);

  const startRec = useCallback(async () => {
    stopStream();
    chunksRef.current = [];
    maxRmsRef.current = 0;
    recDoneRef.current = false;
    setProgress(0);
    setErrorText("");
    setIsRec(true);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      setIsRec(false);
      setErrorText("Microphone access denied. Please allow microphone and retry.");
      return;
    }
    streamRef.current = stream;

    try {
      const ctx = new AudioContext(); ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 256;
      src.connect(an); anTimeRef.current = an;
      const buf = new Uint8Array(an.frequencyBinCount);
      waveRef.current = setInterval(() => {
        an.getByteTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / buf.length);
        if (rms > maxRmsRef.current) maxRmsRef.current = rms;
        const scale = Math.min(rms * 300, 32);
        setWaveH(Array(16).fill(0).map(() => rms > MIN_RMS ? Math.round(scale + Math.random() * 8 + 4) : 4));
      }, 80);
    } catch (_) {}

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    mimeRef.current = mime;
    const mr = new MediaRecorder(stream, { mimeType: mime });
    mrRef.current = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.start(200);

    const t0 = Date.now();
    progRef.current = setInterval(() => setProgress(Math.min(100, (Date.now() - t0) / RECORD_MS * 100)), 100);

    setTimeout(() => {
      if (!mountedRef.current) return;
      if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
      stopWave();
      setIsRec(false);
      recDoneRef.current = true;
      const m = mrRef.current;
      if (m && m.state !== "inactive") {
        m.onstop = () => { stream.getTracks().forEach(t => t.stop()); streamRef.current = null; };
        try { m.stop(); } catch (_) {}
      } else { stream.getTracks().forEach(t => t.stop()); streamRef.current = null; }
      mrRef.current = null;
    }, RECORD_MS);
  }, [stopWave, stopStream]);

  useEffect(() => {
    if (isRec || chunksRef.current.length === 0 || phaseRef.current !== "listening") return;
    if (!recDoneRef.current) return;
    recDoneRef.current = false;
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    processWakeBlob(blob);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRec]);

  const processWakeBlob = async (blob: Blob) => {
    if (blob.size < MIN_BYTES || maxRmsRef.current < MIN_RMS) {
      speak("I couldn't hear that clearly. Please speak your phrase again more loudly.", () => {
        if (!mountedRef.current) return;
        chunksRef.current = [];
        setTimeout(() => startRec(), 600);
      });
      return;
    }
    setIsProc(true);
    setStatusText("Transcribing your phrase…");
    try {
      const fd = new FormData();
      fd.append("audio", blob, "wake.webm");
      fd.append("language", "en");
      const res = await fetch("/voice/check-wake-phrase", { method: "POST", body: fd });
      const data = await res.json();
      const phrase = (data.transcribed_text || "").trim();
      if (phrase && phrase.length >= 2) {
        setDetected(phrase);
        setPhase("confirm");
        speak(
          `I heard: ${phrase}. Say yes to save this as your wake phrase, or no to try again.`,
          () => {
            if (!mountedRef.current) return;
            setStatusText("Say yes to confirm or no to retry");
            listenYesNo(
              () => saveAndContinue(phrase, "custom"),
              () => {
                setDetected("");
                speak("Okay. Please say your preferred wake phrase.", () => {
                  if (!mountedRef.current) return;
                  setPhase("listening");
                  chunksRef.current = [];
                  setTimeout(() => startRec(), 600);
                });
              }
            );
          }
        );
      } else {
        speak("I didn't catch that clearly. Please say your wake phrase again.", () => {
          if (!mountedRef.current) return;
          setPhase("listening");
          chunksRef.current = [];
          setTimeout(() => startRec(), 600);
        });
      }
    } catch {
      speak("Having trouble. Using the default wake phrase Hey Vox.", () => saveAndContinue(DEFAULT_WAKE_PHRASE));
    }
    setIsProc(false);
  };

  const saveAndContinue = (phrase: string, mode: "default" | "custom" = "default") => {
    stopSR();
    localStorage.setItem("vox_wake_phrase", phrase.toLowerCase());
    localStorage.setItem("vox_setup_complete", "1");
    localStorage.setItem("vox_auth_mode", mode);
    setPhase("done");
    const modeMsg = mode === "custom"
      ? "You can say any sentence to unlock — I'll recognise your unique voice."
      : `Just say "${phrase}" to unlock.`;
    speak(
      `Wake phrase saved! ${modeMsg} Setup complete. Heading to lock screen now.`,
      () => {
        stopStream(); stopSR();
        setTimeout(() => { if (!mountedRef.current) return; navigate("/locked"); }, 500);
      }
    );
  };

  // Boot — speak intro, then listen for yes/no
  useEffect(() => {
    const t = setTimeout(() => {
      speak(
        `Wake phrase setup! Say yes to use the default phrase Hey Vox, or no to record your own custom phrase.`,
        () => {
          if (!mountedRef.current) return;
          setStatusText("Say yes for Hey Vox, or no for a custom phrase");
          listenYesNo(
            () => { stopSR(); saveAndContinue(DEFAULT_WAKE_PHRASE, "default"); },
            () => {
              stopSR();
              speak("Great! Please say your custom wake phrase clearly.", () => {
                if (!mountedRef.current) return;
                setPhase("listening");
                setStatusText("Recording your wake phrase…");
                setTimeout(() => startRec(), 600);
              });
            }
          );
        }
      );
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    stopWave(); stopSR(); stopStream();
    if (ttsRef.current) {
      ttsRef.current.onended = null; ttsRef.current.onerror = null;
      ttsRef.current.pause(); ttsRef.current = null;
    }
  }, [stopWave, stopSR, stopStream]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/20 px-4">
      <motion.div className="w-full max-w-sm" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}>

        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary shadow-lg mb-3">
            <Zap className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold">Wake Phrase Setup</h1>
          <p className="text-xs text-muted-foreground mt-1">Activate VoxLedger hands-free</p>
        </div>

        <div className="rounded-3xl bg-card border border-border shadow-2xl px-6 py-8">
          <AnimatePresence mode="wait">

            {/* CHOOSE — tap-first default vs custom */}
            {phase === "choose" && (
              <motion.div key="choose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-5">
                <div className="relative inline-flex">
                  {isSpeaking && (
                    <motion.div className="absolute inset-0 rounded-full bg-primary/20"
                      animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }} />
                  )}
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                    <Volume2 className="h-9 w-9 text-primary" />
                  </div>
                </div>
                <div>
                  <p className="font-bold text-lg">Choose Your Wake Phrase</p>
                  <p className="text-sm text-muted-foreground mt-1">How will you activate VoxLedger?</p>
                </div>

                {/* Two clear tap buttons */}
                <div className="space-y-3">
                  <button
                    onClick={() => { stopSR(); saveAndContinue(DEFAULT_WAKE_PHRASE, "default"); }}
                    className="w-full rounded-2xl bg-primary text-white font-semibold py-4 px-5 hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-3"
                  >
                    <Star className="h-5 w-5 shrink-0" />
                    <div className="text-left">
                      <p className="text-sm font-bold">Use "Hey Vox" (Default)</p>
                      <p className="text-xs opacity-80">Say "Hey Vox" to unlock</p>
                    </div>
                  </button>
                  <button
                    onClick={() => {
                      stopSR();
                      speak("Great! Please say your custom wake phrase clearly and loudly.", () => {
                        if (!mountedRef.current) return;
                        setPhase("listening");
                        setStatusText("Recording your wake phrase…");
                        setTimeout(() => startRec(), 600);
                      });
                    }}
                    className="w-full rounded-2xl bg-secondary text-foreground font-semibold py-4 px-5 hover:bg-secondary/80 active:scale-95 transition-all flex items-center gap-3 border border-border"
                  >
                    <Mic className="h-5 w-5 shrink-0 text-primary" />
                    <div className="text-left">
                      <p className="text-sm font-bold">Custom Phrase</p>
                      <p className="text-xs text-muted-foreground">Record your own unlock phrase</p>
                    </div>
                  </button>
                </div>

                {isSpeaking && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="h-3.5 w-3.5 animate-pulse" /> Speaking…
                  </div>
                )}
                {statusText && !isSpeaking && (
                  <p className="text-xs text-muted-foreground">{statusText}</p>
                )}
              </motion.div>
            )}

            {/* LISTENING — recording custom phrase */}
            {phase === "listening" && (
              <motion.div key="listening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-5">
                <div className="relative inline-flex">
                  {isRec && (
                    <motion.div className="absolute inset-0 rounded-full bg-primary/20"
                      animate={{ scale: [1, 1.6], opacity: [0.3, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                      style={{ width: 96, height: 96, left: "-8px", top: "-8px" }} />
                  )}
                  <div className={`w-20 h-20 rounded-full ${isRec ? "bg-primary" : "bg-primary/15"} flex items-center justify-center shadow-lg`}>
                    <motion.div animate={isRec ? { scale: [1, 1.1, 1] } : {}} transition={{ duration: 0.8, repeat: Infinity }}>
                      <Mic className={`h-9 w-9 ${isRec ? "text-white" : "text-primary"}`} />
                    </motion.div>
                  </div>
                </div>
                <div>
                  <p className="font-bold text-base">
                    {isProc ? "Saving phrase…" : isRec ? "Listening…" : "Preparing…"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Say your custom wake phrase <span className="font-semibold">clearly and loudly</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">e.g. "Open my wallet" or any phrase you like</p>
                </div>
                {isRec && (
                  <>
                    <div className="flex items-end justify-center gap-0 h-12">
                      {waveH.map((h, i) => <WaveBar key={i} h={h} />)}
                    </div>
                    <div className="w-full bg-secondary rounded-full h-1.5">
                      <motion.div className="bg-primary h-1.5 rounded-full" style={{ width: `${progress}%` }} />
                    </div>
                  </>
                )}
                {isProc && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Processing…
                  </div>
                )}
                {errorText && (
                  <p className="text-xs text-destructive">{errorText}</p>
                )}
                <button onClick={() => { stopSR(); saveAndContinue(DEFAULT_WAKE_PHRASE, "default"); }}
                  className="text-xs text-primary underline">
                  Skip — use "Hey Vox" instead
                </button>
              </motion.div>
            )}

            {/* CONFIRM — heard phrase, ask to save */}
            {phase === "confirm" && (
              <motion.div key="confirm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center space-y-5">
                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
                  <Check className="h-8 w-8 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">I heard your phrase as:</p>
                  <p className="text-2xl font-extrabold text-primary mt-1">"{detected}"</p>
                </div>
                {isSpeaking ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="h-3.5 w-3.5 animate-pulse" /> Speaking…
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="rounded-xl bg-primary/5 border border-primary/20 px-4 py-2">
                      <p className="text-sm">Say <span className="font-bold text-primary">"yes"</span> to save this phrase</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { stopSR(); saveAndContinue(detected, "custom"); }}
                        className="flex-1 rounded-xl bg-primary text-white text-sm font-semibold py-2.5 hover:bg-primary/90 active:scale-95 transition-all">
                        ✓ Save This Phrase
                      </button>
                      <button onClick={() => {
                          stopSR();
                          setDetected("");
                          speak("Okay. Please say your preferred wake phrase again.", () => {
                            if (!mountedRef.current) return;
                            setPhase("listening"); chunksRef.current = [];
                            setTimeout(() => startRec(), 600);
                          });
                        }}
                        className="flex-1 rounded-xl bg-secondary text-foreground text-sm font-semibold py-2.5 hover:bg-secondary/80 active:scale-95 transition-all">
                        ✗ Retry
                      </button>
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{statusText}</p>
              </motion.div>
            )}

            {/* DONE */}
            {phase === "done" && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="text-center space-y-5 py-4">
                <motion.div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto"
                  animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 0.6, repeat: 2 }}>
                  <Check className="h-10 w-10 text-emerald-600" />
                </motion.div>
                <div>
                  <p className="text-lg font-bold">Wake Phrase Saved!</p>
                  <p className="text-sm text-muted-foreground mt-1">Taking you to the lock screen…</p>
                </div>
                {isSpeaking && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="h-3 w-3 animate-pulse" /> Speaking…
                  </div>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
