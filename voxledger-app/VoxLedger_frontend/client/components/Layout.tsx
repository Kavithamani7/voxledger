/**
 * Layout.tsx — Voice Engine v12.0  (True Voice-First Intelligent Assistant)
 *
 * UPGRADES IN v12.0:
 * ① FIVE-STATE MACHINE: idle → ready → speech → processing → working → speaking
 *    "Processing" = AI understanding intent
 *    "Working"    = action executing (violet indicator, distinct from thinking)
 *    "Speaking"   = TTS playing response
 *
 * ② BELOW-FAB STATE INDICATOR always shows:
 *    Listening | Thinking | Processing | Speaking | Muted
 *    Colour-coded animated dot per state.
 *
 * ③ All v11.0 features preserved:
 *    - Stop vs Mute differentiation
 *    - Improved VAD thresholds
 *    - Processing guard (double-send prevention)
 *    - AI-powered intent with fallback keyword parser
 *    - Live state label + waveform in modal
 */
import { ReactNode, useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Home, CreditCard, Target, Bell, User,
  Mic, X, Volume2, VolumeX, Loader2,
  MessageSquare, PiggyBank, List, AlertCircle, BellRing, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/context/AppContext";
import * as api from "@/lib/api";

const navItems = [
  { icon: Home,       label: "Home",    path: "/" },
  { icon: CreditCard, label: "Finance", path: "/transactions" },
  { icon: Target,     label: "Budget",  path: "/budget" },
  { icon: Bell,       label: "Alerts",  path: "/alerts" },
  { icon: User,       label: "Profile", path: "/profile" },
];

// v12: 'working' = action executing (between intent understood and response spoken)
type VoxState = "idle" | "ready" | "speech" | "processing" | "working" | "speaking";

// ── Recording / VAD constants ─────────────────────────────────────────────────
const CHUNK_MS           = 200;
const VAD_INTERVAL_MS    = 70;
const SPEECH_ON_TICKS    = 4;    // ~280ms sustained voice to confirm speech
const SILENCE_OFF_TICKS  = 3;    // v11: 3 ticks (~210ms) — faster submit after speech
const MAX_SPEECH_CHUNKS  = 35;
const PRE_SPEECH_CHUNKS  = 3;
const MIN_SEND_BYTES     = 3000;
const CALIBRATION_TICKS  = 14;
const NOISE_HEADROOM     = 2.3;
const MIN_THRESHOLD      = 18;
const MAX_THRESHOLD      = 55;

interface LayoutProps { children: ReactNode; }

export default function Layout({ children }: LayoutProps) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { isAuthenticated, userId, backendOnline,
          refetchTransactions, refetchBudget, addConversation, user } = useApp();

  const [voxState,  setVoxState]  = useState<VoxState>("idle");
  const [waveH,     setWaveH]     = useState<number[]>(Array(18).fill(4));
  const [lastReply, setLastReply] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [isMuted,   setIsMuted]   = useState(false);
  const isMutedRef = useRef(false);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  // ── Audio engine refs ─────────────────────────────────────────────────────
  const streamRef    = useRef<MediaStream | null>(null);
  const mrRef        = useRef<MediaRecorder | null>(null);
  const ctxRef       = useRef<AudioContext | null>(null);
  const analyserRef  = useRef<AnalyserNode | null>(null);
  const vadRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsRef       = useRef<AudioBufferSourceNode | HTMLAudioElement | null>(null);
  const stopRecognitionRef = useRef<any>(null);
  const mimeRef      = useRef("audio/webm");
  const startingRef  = useRef(false);
  const ttsSessionRef = useRef(0);
  const ttsStoppedManuallyRef = useRef(false);

  // ── VAD state refs ────────────────────────────────────────────────────────
  const headerChunkRef = useRef<Blob | null>(null);
  const rollingBuf   = useRef<Blob[]>([]);
  const speechBuf    = useRef<Blob[]>([]);
  const isSpeech     = useRef(false);
  const aboveN       = useRef(0);
  const belowN       = useRef(0);
  const isSending    = useRef(false);

  // ── Dynamic VAD threshold ─────────────────────────────────────────────────
  const vadThreshold  = useRef(22);
  const calibTicks    = useRef(0);
  const calibSum      = useRef(0);

  // ── Stale-closure fix ─────────────────────────────────────────────────────
  const sendSnapshotRef = useRef<(chunks: Blob[], mime: string) => void>(() => {});
  const voxRef = useRef<VoxState>("idle");
  useEffect(() => { voxRef.current = voxState; }, [voxState]);

  const ts = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  // ── Stop TTS ──────────────────────────────────────────────────────────────
  const stopTTS = useCallback(() => {
    ttsStoppedManuallyRef.current = true;
    ttsSessionRef.current += 1;
    const stopRecognizer = stopRecognitionRef.current;
    if (stopRecognizer) {
      try { stopRecognizer.onresult = null; stopRecognizer.onerror = null; stopRecognizer.onend = null; stopRecognizer.stop(); } catch (_) {}
      stopRecognitionRef.current = null;
    }
    if (ttsRef.current) {
      try {
        if (typeof (ttsRef.current as unknown as HTMLAudioElement).pause === "function") {
          const audioEl = ttsRef.current as unknown as HTMLAudioElement;
          audioEl.pause(); audioEl.currentTime = 0; audioEl.src = "";
          try { audioEl.load(); } catch (_) {}
        } else {
          (ttsRef.current as unknown as AudioBufferSourceNode).stop();
        }
      } catch (_) {}
      ttsRef.current = null;
    }
  }, []);

  // ── Stop-word listener (runs during TTS playback) ─────────────────────────
  const startStopWordListener = useCallback(() => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;
    const existing = stopRecognitionRef.current;
    if (existing) { try { existing.stop(); } catch (_) {} stopRecognitionRef.current = null; }
    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-IN";

      recognition.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const transcript = String(event.results[i][0]?.transcript || "").toLowerCase().trim();

          // MUTE — silence all future speech, actions still run
          if (/\b(mute\s*assistant|mute\s*vox|go\s+silent|be\s+quiet|quiet\s+please|mute\s+yourself|please\s+be\s+quiet|silence|go\s+quiet|stop\s+talking)\b/.test(transcript)) {
            setIsMuted(true); stopTTS(); setLastReply("");
            setVoxState(voxRef.current === "processing" ? "processing" : "ready");
            try { recognition.abort?.(); } catch (_) {}
            break;
          }
          // UNMUTE
          if (/\b(unmute|un-mute|unmute\s+assistant|unmute\s+vox|resume\s+speaking|speak\s+again|voice\s+on|start\s+speaking)\b/.test(transcript)) {
            setIsMuted(false); break;
          }
          // STOP — cancel current speech only
          if (/\b(stop|stop\s+it|stop\s+talking|stop\s+speaking|enough|that'?s?\s+enough|no\s+more|shush|pause|hold\s+on)\b/.test(transcript)) {
            stopTTS(); setLastReply("");
            setVoxState("ready");
            try { recognition.abort?.(); } catch (_) {}
            break;
          }
        }
      };
      recognition.onerror = () => {
        try { recognition.stop(); } catch (_) {}
        if (stopRecognitionRef.current === recognition) stopRecognitionRef.current = null;
      };
      recognition.onend = () => {
        if (stopRecognitionRef.current === recognition && voxRef.current === "speaking") {
          try { recognition.start(); } catch (_) {}
        } else if (stopRecognitionRef.current === recognition) {
          stopRecognitionRef.current = null;
        }
      };
      recognition.start();
      stopRecognitionRef.current = recognition;
    } catch (_) {}
  }, [stopTTS]);

  // ── Reset VAD ─────────────────────────────────────────────────────────────
  const resetVad = useCallback(() => {
    rollingBuf.current = []; speechBuf.current = [];
    isSpeech.current = false; aboveN.current = 0; belowN.current = 0;
    isSending.current = false;
    setWaveH(Array(18).fill(4));
  }, []);

  // ── Play TTS ──────────────────────────────────────────────────────────────
  const playTTS = useCallback((text: string, url: string, onDone: () => void) => {
    if (isMutedRef.current) {
      isSending.current = false; setVoxState("ready"); onDone(); return;
    }
    const sessionId = ttsSessionRef.current + 1;
    ttsSessionRef.current = sessionId;
    ttsStoppedManuallyRef.current = false;
    setLastReply(text); setVoxState("speaking");
    startStopWordListener();
    window.dispatchEvent(new CustomEvent("vox:tts-start"));

    const done = () => {
      if (sessionId !== ttsSessionRef.current) return;
      ttsRef.current = null; setLastReply(""); isSending.current = false;
      setVoxState("ready");
      window.dispatchEvent(new CustomEvent("vox:tts-end"));
      if (!ttsStoppedManuallyRef.current) onDone();
    };

    const ctx = ctxRef.current;
    if (ctx && ctx.state !== "closed") {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`TTS fetch ${r.status}`); return r.arrayBuffer(); })
        .then(buf => ctx.decodeAudioData(buf))
        .then(decoded => {
          const src = ctx.createBufferSource();
          src.buffer = decoded; src.connect(ctx.destination);
          (ttsRef as React.MutableRefObject<unknown>).current = src;
          src.onended = done; src.start(0);
        })
        .catch(() => setTimeout(done, Math.max(1500, text.split(" ").length * 380)));
      return;
    }
    const audio = new Audio(url);
    ttsRef.current = audio as unknown as AudioBufferSourceNode;
    audio.onended = done; audio.onerror = done;
    audio.play().catch(() => setTimeout(done, Math.max(1500, text.split(" ").length * 380)));
  }, [startStopWordListener]);

  // ── Core send-snapshot ────────────────────────────────────────────────────
  const sendSnapshot = useCallback(async (chunks: Blob[], mime: string) => {
    if (isSending.current) return;
    isSending.current = true;
    const bytes = chunks.reduce((s, b) => s + b.size, 0);
    if (bytes < MIN_SEND_BYTES || !userId || !backendOnline || !isAuthenticated) {
      isSending.current = false; setVoxState("ready"); return;
    }
    setVoxState("processing");   // AI thinking
    window.dispatchEvent(new CustomEvent("vox:speech-end"));

    try {
      const allChunks = headerChunkRef.current ? [headerChunkRef.current, ...chunks] : chunks;
      const blob = new Blob(allChunks, { type: mime });
      const res  = await api.sendVoiceCommand(userId, blob, "en", false);

      if (res.transcribed_text?.trim()) {
        addConversation({ id: `u${Date.now()}`, type: "user", content: res.transcribed_text.trim(), timestamp: ts() });
      }

      if (res.intent === "stop" || res.action_result?.stop_tts) {
        stopTTS(); isSending.current = false; setVoxState("ready"); return;
      }
      if (res.intent === "mute" || res.action_result?.mute_tts) {
        stopTTS(); setIsMuted(true); isSending.current = false; setVoxState("ready"); return;
      }
      if (res.intent === "unmute" || res.action_result?.unmute_tts) {
        setIsMuted(false);
        // Play the unmute confirmation text aloud (since we just unmuted)
        if (res.response_text) {
          addConversation({ id: `a${Date.now()}`, type: "assistant", content: res.response_text, timestamp: ts() });
          const ttsUrl = res.tts_audio_url || api.getTtsUrl(res.response_text);
          playTTS(res.response_text, ttsUrl, () => {});
        } else {
          isSending.current = false; setVoxState("ready");
        }
        return;
      }
      if (!res.response_text || res.intent === "silence" || res.intent === "no_wake_phrase") {
        isSending.current = false; setVoxState("ready"); return;
      }

      addConversation({ id: `a${Date.now()}`, type: "assistant", content: res.response_text, timestamp: ts() });

      // Transition to "working" when we have an action to execute
      if (res.action_result?.transaction || res.action_result?.refresh ||
          res.action_result?.navigate_to || res.action_result?.dark_mode !== undefined) {
        setVoxState("working");
      }

      const ttsUrl    = res.tts_audio_url || api.getTtsUrl(res.response_text);
      const navTarget = res.action_result?.navigate_to;
      const speakBeforeNavigate = res.intent === "navigate" || res.intent === "read_notifications";

      if (speakBeforeNavigate && navTarget) {
        playTTS(res.response_text, ttsUrl, () => {
          navigate(navTarget, {
            state: res.intent === "read_notifications"
              ? { prefetchedNotifications: res.action_result?.notifications || [], unreadCount: res.action_result?.unread_count || 0 }
              : undefined,
          });
        });
      } else {
        if (res.action_result?.transaction || res.action_result?.summary ||
            res.action_result?.refresh      || res.action_result?.budget_set) {
          refetchTransactions(); refetchBudget();
          window.dispatchEvent(new CustomEvent("vox:data-updated"));
        }
        if (res.action_result?.dark_mode === true) {
          document.documentElement.classList.add("dark"); localStorage.setItem("vox_dark_mode", "1");
        } else if (res.action_result?.dark_mode === false) {
          document.documentElement.classList.remove("dark"); localStorage.setItem("vox_dark_mode", "0");
        }
        if (navTarget) navigate(navTarget, { state: res.action_result?.start_voice_recording ? { startRecording: true } : undefined });
        playTTS(res.response_text, ttsUrl, () => {});
      }
    } catch {
      isSending.current = false; setVoxState("ready");
    }
  }, [userId, backendOnline, isAuthenticated, stopTTS, navigate, playTTS,
      refetchTransactions, refetchBudget, addConversation]);

  useEffect(() => { sendSnapshotRef.current = sendSnapshot; }, [sendSnapshot]);

  // ── VAD loop ──────────────────────────────────────────────────────────────
  const startVad = useCallback((actualSampleRate: number) => {
    if (vadRef.current) clearInterval(vadRef.current);
    const an = analyserRef.current;
    if (!an) return;
    const freqBuf = new Uint8Array(an.frequencyBinCount);
    const binHz = actualSampleRate / an.fftSize;
    const LO = Math.max(1, Math.round(85 / binHz));
    const HI = Math.min(an.frequencyBinCount - 1, Math.round(3400 / binHz));
    calibTicks.current = 0; calibSum.current = 0;

    vadRef.current = setInterval(() => {
      const ctx = ctxRef.current;
      if (ctx?.state === "suspended") ctx.resume().catch(() => {});
      const state = voxRef.current;
      an.getByteFrequencyData(freqBuf);
      let sum = 0;
      for (let i = LO; i <= HI; i++) sum += freqBuf[i];
      const avg = sum / (HI - LO + 1);

      if (calibTicks.current < CALIBRATION_TICKS) {
        calibTicks.current += 1; calibSum.current += avg;
        if (calibTicks.current === CALIBRATION_TICKS) {
          const ambient = calibSum.current / CALIBRATION_TICKS;
          const computed = Math.round(ambient * NOISE_HEADROOM + 3);
          vadThreshold.current = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, computed));
        }
        return;
      }

      const THRESH = vadThreshold.current;
      if (avg > THRESH) {
        const s = Math.min((avg - THRESH) / (THRESH * 2), 1);
        setWaveH(Array(18).fill(0).map(() => Math.round(s * 32 + Math.random() * 10 + 4)));
      } else {
        setWaveH(prev => prev.map(h => Math.max(4, Math.round(h * 0.75))));
      }

      if (state !== "ready" && state !== "speech" && state !== "speaking") return;
      if (state === "processing" as VoxState) return;

      if (avg > THRESH) {
        belowN.current = 0; aboveN.current += 1;
        if (!isSpeech.current && aboveN.current >= SPEECH_ON_TICKS) {
          isSpeech.current = true; setVoxState("speech");
          speechBuf.current = [...rollingBuf.current];
          window.dispatchEvent(new CustomEvent("vox:speech-start"));
        }
        if (isSpeech.current && speechBuf.current.length >= MAX_SPEECH_CHUNKS) {
          const snap = [...speechBuf.current]; resetVad(); sendSnapshotRef.current(snap, mimeRef.current);
        }
      } else {
        if (isSpeech.current) {
          belowN.current += 1;
          if (belowN.current >= SILENCE_OFF_TICKS) {
            const snap = [...speechBuf.current]; resetVad(); sendSnapshotRef.current(snap, mimeRef.current);
          }
        } else {
          aboveN.current = Math.max(0, aboveN.current - 1);
        }
      }
    }, VAD_INTERVAL_MS);
  }, [resetVad]);

  // ── Start mic ─────────────────────────────────────────────────────────────
  const startMic = useCallback(async () => {
    if (streamRef.current || startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      mimeRef.current = mime;
      const mr = new MediaRecorder(stream, { mimeType: mime });
      mrRef.current = mr;
      mr.ondataavailable = (e) => {
        if (!e.data || e.data.size < 10) return;
        if (!headerChunkRef.current) { headerChunkRef.current = e.data; return; }
        if (isSpeech.current) { speechBuf.current.push(e.data); }
        else { rollingBuf.current.push(e.data); if (rollingBuf.current.length > PRE_SPEECH_CHUNKS) rollingBuf.current.shift(); }
      };
      mr.onerror = () => { stopMicFn(); setTimeout(startMic, 1500); };
      mr.start(CHUNK_MS);
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser();
      an.fftSize = 2048; an.smoothingTimeConstant = 0.4;
      src.connect(an); analyserRef.current = an;
      startingRef.current = false; setVoxState("ready");
      startVad(ctx.sampleRate);
    } catch (err) {
      startingRef.current = false;
      setTimeout(startMic, 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startVad]);

  // ── Stop mic ──────────────────────────────────────────────────────────────
  const stopMicFn = useCallback(() => {
    if (vadRef.current)    { clearInterval(vadRef.current); vadRef.current = null; }
    if (ctxRef.current)    { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }
    analyserRef.current    = null;
    if (mrRef.current)     { try { if (mrRef.current.state !== "inactive") mrRef.current.stop(); } catch (_) {} mrRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    startingRef.current    = false; headerChunkRef.current = null;
    resetVad();
  }, [resetVad]);

  // ── Auth lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (isAuthenticated && userId) { startMic(); }
    else { stopTTS(); stopMicFn(); setVoxState("idle"); setLastReply(""); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, userId]);

  // ── Force-stop (auto-lock) ────────────────────────────────────────────────
  useEffect(() => {
    const h = () => { stopTTS(); stopMicFn(); setVoxState("idle"); setLastReply(""); setModalOpen(false); };
    window.addEventListener("vox:force-stop", h);
    return () => window.removeEventListener("vox:force-stop", h);
  }, [stopTTS, stopMicFn]);

  useEffect(() => () => { stopTTS(); stopMicFn(); }, []); // eslint-disable-line

  const quickAction = (path: string) => { setModalOpen(false); navigate(path); };

  // ── Derived UI values ─────────────────────────────────────────────────────
  const fabBg =
    isMuted                   ? "bg-slate-500   shadow-slate-300/50"  :
    voxState === "speaking"   ? "bg-emerald-500 shadow-emerald-300/60" :
    voxState === "working"    ? "bg-violet-500  shadow-violet-300/60"  :
    voxState === "processing" ? "bg-amber-500   shadow-amber-300/60"   :
    voxState === "speech"     ? "bg-primary     shadow-primary/60"     :
    voxState === "ready"      ? "bg-primary     shadow-primary/40"     :
                                "bg-slate-400   shadow-slate-300/40";

  const fabIcon =
    isMuted                   ? <VolumeX className="h-6 w-6 text-white" />              :
    voxState === "working"    ? <Loader2  className="h-6 w-6 text-white animate-spin" /> :
    voxState === "processing" ? <Loader2  className="h-6 w-6 text-white animate-spin" /> :
    voxState === "speaking"   ? <Volume2  className="h-6 w-6 text-white" />              :
                                <Mic      className="h-6 w-6 text-white" />;

  // ── State label for the below-FAB indicator ───────────────────────────────
  const stateLabel =
    isMuted                   ? "Muted"      :
    voxState === "speech"     ? "Listening"  :
    voxState === "processing" ? "Thinking"   :
    voxState === "working"    ? "Processing" :
    voxState === "speaking"   ? "Speaking"   :
    voxState === "ready"      ? "Ready"      : "";

  const stateLabelColor =
    isMuted                   ? "text-slate-500"    :
    voxState === "speech"     ? "text-primary"      :
    voxState === "processing" ? "text-amber-600"    :
    voxState === "working"    ? "text-violet-600"   :
    voxState === "speaking"   ? "text-emerald-600"  :
    voxState === "ready"      ? "text-emerald-600"  : "text-transparent";

  const modalTitle =
    isMuted                   ? "Muted — Actions Still Running" :
    voxState === "speech"     ? "Listening…"                    :
    voxState === "processing" ? "AI Thinking…"                  :
    voxState === "working"    ? "Processing Action…"            :
    voxState === "speaking"   ? "Speaking…"                     :
    voxState === "ready"      ? "Vox is Ready"                  : "Vox Assistant";

  const modalStatus =
    isMuted                   ? `Say "unmute assistant" or tap below to resume voice. Actions continue silently.` :
    voxState === "processing" ? "Understanding your request with AI…"                                            :
    voxState === "working"    ? "Executing your request now…"                                                    :
    voxState === "speaking"   ? lastReply                                                                         :
    voxState === "speech"     ? "I'm listening — speak naturally…"                                               :
    voxState === "ready"      ? "Always listening — no button needed. Just speak."                                :
                                "Sign in to activate Vox";

  return (
    <div className="relative min-h-screen bg-background font-sans overflow-x-hidden">
      <main className="pb-28">{children}</main>

      {/* ── Bottom Navigation ──────────────────────────────────────────────── */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 bg-background/90 backdrop-blur-xl border-t border-border/50">
        <div className="flex items-center justify-around px-1 py-3 max-w-lg mx-auto">
          {navItems.map((item) => {
            const Icon     = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <button key={item.path} onClick={() => navigate(item.path)}
                className="flex flex-col items-center gap-1 px-3 py-1 relative">
                <div className={cn("h-10 w-10 rounded-2xl flex items-center justify-center transition-all",
                  isActive ? "bg-primary/10" : "bg-transparent")}>
                  <Icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")} />
                </div>
                <span className={cn("text-[10px] font-semibold",
                  isActive ? "text-primary" : "text-muted-foreground")}>{item.label}</span>
                {isActive && (
                  <motion.div layoutId="nav-dot"
                    className="absolute -bottom-3 left-1/2 -translate-x-1/2 h-1 w-6 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── State Label below FAB ─────────────────────────────────────────── */}
      {isAuthenticated && (
        <div className="fixed bottom-[6.5rem] right-0 left-0 z-30 flex flex-col items-end pr-4 pointer-events-none"
          style={{ width: "fit-content", marginLeft: "auto", right: "1.25rem" }}>
          <AnimatePresence mode="wait">
            {stateLabel && (
              <motion.div
                key={stateLabel}
                initial={{ opacity: 0, y: 4, scale: 0.9 }}
                animate={{ opacity: 1, y: 0,  scale: 1   }}
                exit={{    opacity: 0, y: -4, scale: 0.9  }}
                transition={{ duration: 0.18 }}
                className={cn(
                  "flex items-center gap-1.5 bg-background/90 backdrop-blur-sm shadow-sm border border-border/50 rounded-full px-2.5 py-1 text-[11px] font-bold",
                  stateLabelColor
                )}
              >
                {/* Animated dot */}
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  isMuted                   ? "bg-slate-400"                  :
                  voxState === "speech"     ? "bg-primary animate-ping"       :
                  voxState === "processing" ? "bg-amber-500 animate-pulse"    :
                  voxState === "working"    ? "bg-violet-500 animate-ping"    :
                  voxState === "speaking"   ? "bg-emerald-500 animate-pulse"  :
                                              "bg-emerald-500 animate-pulse"
                )} />
                {stateLabel}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── Floating Mic FAB ──────────────────────────────────────────────── */}
      <motion.button
        whileTap={{ scale: 0.88 }}
        onClick={() => setModalOpen(true)}
        className={cn(
          "fixed bottom-24 right-5 z-30 h-14 w-14 rounded-full flex items-center justify-center shadow-xl transition-colors duration-300",
          fabBg
        )}
      >
        {(voxState === "speech" || voxState === "speaking") && (
          <motion.div
            animate={{ scale: [1, 1.65], opacity: [0.4, 0] }}
            transition={{ duration: 1.3, repeat: Infinity, ease: "easeOut" }}
            className="absolute inset-0 rounded-full bg-white/25"
          />
        )}
        {fabIcon}
      </motion.button>

      {/* ── Vox Modal ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {modalOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setModalOpen(false)}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 60, scale: 0.95 }}
              transition={{ type: "spring", damping: 22, stiffness: 280 }}
              className="fixed bottom-28 left-4 right-4 z-50 bg-white dark:bg-card rounded-3xl shadow-2xl overflow-hidden"
              style={{ maxWidth: 480, margin: "0 auto" }}
            >
              <button onClick={() => setModalOpen(false)}
                className="absolute top-3 right-3 h-8 w-8 rounded-full bg-gray-100 dark:bg-secondary flex items-center justify-center z-10">
                <X className="h-4 w-4 text-gray-500" />
              </button>

              <div className="px-6 pt-8 pb-6 flex flex-col items-center">
                {/* Avatar */}
                <div className="relative mb-4">
                  {(voxState === "speech" || voxState === "speaking") && (
                    <motion.div
                      animate={{ scale: [1, 1.4], opacity: [0.3, 0] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                      className="absolute inset-0 rounded-full bg-primary/40"
                    />
                  )}
                  <div className={cn(
                    "h-20 w-20 rounded-full flex items-center justify-center shadow-lg transition-colors duration-300",
                    voxState === "speaking"   ? "bg-emerald-500" :
                    voxState === "processing" ? "bg-amber-500"   :
                    voxState === "speech"     ? "bg-primary"     : "bg-primary/15"
                  )}>
                    {voxState === "processing"
                      ? <Loader2 className="h-9 w-9 text-white animate-spin" />
                      : voxState === "speaking"
                      ? <Volume2 className="h-9 w-9 text-white" />
                      : <Mic className={cn("h-9 w-9", voxState === "speech" ? "text-white" : "text-primary")} />
                    }
                  </div>
                </div>

                {/* Waveform */}
                {(voxState === "speech" || voxState === "speaking") && (
                  <div className="flex gap-0.5 items-end justify-center h-10 mb-3">
                    {waveH.map((h, i) => (
                      <motion.div key={i}
                        animate={{ height: Math.max(4, Math.min(h, 38)) }}
                        transition={{ duration: 0.08 }}
                        className={cn("w-1.5 rounded-full",
                          voxState === "speaking" ? "bg-emerald-400" : "bg-primary")}
                      />
                    ))}
                  </div>
                )}

                <h2 className="text-lg font-bold text-gray-900 dark:text-foreground mb-1">{modalTitle}</h2>
                <p className="text-sm text-gray-500 dark:text-muted-foreground text-center mb-4 px-2 leading-relaxed min-h-[2.5rem]">
                  {modalStatus}
                </p>

                {/* State pill */}
                <div className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-4",
                  voxState === "idle"       ? "bg-slate-100 text-slate-500"    :
                  voxState === "ready"      ? "bg-emerald-50 text-emerald-700"  :
                  voxState === "speech"     ? "bg-primary/10 text-primary"      :
                  voxState === "processing" ? "bg-amber-50 text-amber-700"      :
                  voxState === "working"    ? "bg-violet-50 text-violet-700"    :
                                             "bg-emerald-50 text-emerald-700"
                )}>
                  <span className={cn("h-2 w-2 rounded-full",
                    isMuted                   ? "bg-slate-500"              :
                    voxState === "idle"       ? "bg-slate-400"              :
                    voxState === "ready"      ? "bg-emerald-500 animate-pulse" :
                    voxState === "speech"     ? "bg-primary animate-ping"   :
                    voxState === "processing" ? "bg-amber-500 animate-pulse":
                    voxState === "working"    ? "bg-violet-500 animate-ping": "bg-emerald-500"
                  )} />
                  {isMuted                   ? `Muted — say "unmute assistant"` :
                   voxState === "idle"       ? "Mic off" :
                   voxState === "ready"      ? "Mic on — always listening" :
                   voxState === "speech"     ? "Your voice detected" :
                   voxState === "processing" ? "AI processing…" :
                   voxState === "working"    ? "Executing action…" : "Speaking response"}
                </div>

                {/* User greeting */}
                {voxState === "ready" && !isMuted && user?.name && (
                  <p className="text-[11px] text-slate-400 mb-2 flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    Hey {user.name.split(" ")[0]}! Speak naturally — I understand you.
                  </p>
                )}

                {/* Mute/Unmute button */}
                <button
                  onClick={() => { setIsMuted(m => { const next = !m; if (!next) stopTTS(); return next; }); }}
                  className={cn(
                    "w-full h-10 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2 mb-3 transition-all",
                    isMuted
                      ? "bg-slate-100 text-slate-700 border-2 border-slate-300 hover:bg-slate-200"
                      : "bg-emerald-50 text-emerald-700 border-2 border-emerald-200 hover:bg-emerald-100"
                  )}>
                  {isMuted ? <><VolumeX className="h-4 w-4" />Unmute Assistant</> : <><Volume2 className="h-4 w-4" />Mute Assistant</>}
                </button>

                <div className="flex gap-3 w-full mb-4">
                  <button onClick={() => quickAction("/conversation")}
                    className="flex-1 h-12 rounded-2xl border-2 border-gray-200 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors flex items-center justify-center gap-2">
                    <MessageSquare className="h-4 w-4" />Open Chat
                  </button>
                  <button onClick={() => setModalOpen(false)}
                    className={cn(
                      "flex-1 h-12 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2",
                      voxState === "speech"     ? "bg-primary text-white"     :
                      voxState === "processing" ? "bg-amber-500 text-white"   :
                      voxState === "speaking"   ? "bg-emerald-500 text-white" :
                                                  "bg-primary text-white"
                    )}>
                    {voxState === "speech"
                      ? <><span className="h-2 w-2 rounded-full bg-white animate-ping mr-1" />Listening…</>
                      : voxState === "processing"
                      ? <><Loader2 className="h-4 w-4 animate-spin" />Processing</>
                      : voxState === "speaking"
                      ? <><Volume2 className="h-4 w-4" />Speaking…</>
                      : <><Mic className="h-4 w-4" />Close</>
                    }
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5 w-full">
                  {[
                    { label: "Open Budget",   icon: PiggyBank,   path: "/budget"        },
                    { label: "Transactions",  icon: List,        path: "/transactions"  },
                    { label: "My Alerts",     icon: AlertCircle, path: "/alerts"        },
                    { label: "Notifications", icon: BellRing,    path: "/notifications" },
                  ].map(({ label, icon: Icon, path }) => (
                    <button key={path} onClick={() => quickAction(path)}
                      className="h-11 rounded-2xl bg-gray-50 hover:bg-gray-100 text-gray-700 text-sm font-medium flex items-center justify-center gap-2 transition-colors border border-gray-100">
                      <Icon className="h-4 w-4 text-gray-500" />{label}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
