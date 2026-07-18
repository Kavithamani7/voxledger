/**
 * Conversation.tsx — Chat page.
 *
 * This page is the visual front-end for conversations.
 * The actual voice capture + STT + TTS lives ONLY in Layout.tsx (the global FAB).
 * This page:
 *   - Displays conversation history from AppContext (shared with Layout)
 *   - Provides typed text input as an alternative input method
 *   - Shows waveform / status badge reflecting the global VoxState via a custom event
 *   - Does NOT create its own MediaRecorder or duplicate mic button
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, Bot, Send, Wifi, WifiOff, Loader2,
  Mic, Volume2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp, ConversationMessage } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

// ── Quick command chips ───────────────────────────────────────────────────────
const QUICK_CHIPS = [
  { label: "My balance",    cmd: "What is my balance" },
  { label: "Transactions",  cmd: "Show my transactions" },
  { label: "Budget",        cmd: "Open budget" },
  { label: "Add expense",   cmd: "Add expense" },
  { label: "Today's spend", cmd: "What did I spend today" },
];

export default function Conversation() {
  const { conversations, addConversation, userId, backendOnline, refetchTransactions, refetchBudget } = useApp();
  const navigate = useNavigate();

  const [typedCmd,  setTypedCmd]  = useState("");
  const [isTyping,  setIsTyping]  = useState(false);
  const [micActive, setMicActive] = useState(false);   // mirrors global FAB state
  const [speaking,  setSpeaking]  = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, isTyping]);

  const now = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  const addMsg = useCallback((msg: Omit<ConversationMessage, "id">) => {
    addConversation({ ...msg, id: Date.now().toString() + Math.random() });
  }, [addConversation]);

  // ── Listen for global vox state events from Layout ────────────
  useEffect(() => {
    const onSpeech = () => setMicActive(true);
    const onSilent = () => setMicActive(false);
    const onSpeak  = () => setSpeaking(true);
    const onDone   = () => setSpeaking(false);
    window.addEventListener("vox:speech-start",  onSpeech);
    window.addEventListener("vox:speech-end",    onSilent);
    window.addEventListener("vox:tts-start",     onSpeak);
    window.addEventListener("vox:tts-end",       onDone);
    return () => {
      window.removeEventListener("vox:speech-start", onSpeech);
      window.removeEventListener("vox:speech-end",   onSilent);
      window.removeEventListener("vox:tts-start",    onSpeak);
      window.removeEventListener("vox:tts-end",      onDone);
    };
  }, []);

  // ── Send typed command ────────────────────────────────────────
  const sendTyped = useCallback(async (text: string) => {
    const cmd = text.trim();
    if (!cmd || !userId) return;
    setTypedCmd("");
    addMsg({ type: "user", content: cmd, timestamp: now() });
    setIsTyping(true);
    try {
      const res   = await api.sendTextCommand(userId, cmd);
      setIsTyping(false);
      const reply = res.response_text || "";
      if (reply) {
        addMsg({ type: "assistant", content: reply, timestamp: now() });
        if (res.action_result?.transaction || res.action_result?.summary || res.action_result?.refresh) {
          refetchTransactions(); refetchBudget();
        }
        if (res.action_result?.navigate_to) {
          setTimeout(() => navigate(res.action_result!.navigate_to!), 1200);
        }
        // Play TTS via the shared TTS URL (same as global FAB)
        const audio = new Audio(api.getTtsUrl(reply));
        audio.play().catch(() => {});
      }
    } catch {
      setIsTyping(false);
      addMsg({ type: "assistant", content: "Something went wrong. Please try again.", timestamp: now() });
    }
  }, [userId, addMsg, navigate, refetchTransactions, refetchBudget]);

  const micStatusText =
    speaking  ? "Speaking…" :
    micActive ? "Listening…" :
    backendOnline ? "Online — always listening" : "Offline";

  const micStatusColor =
    speaking  ? "text-emerald-600" :
    micActive ? "text-primary" :
    backendOnline ? "text-emerald-600" : "text-amber-500";

  return (
    <Layout>
      <div className="mx-auto max-w-lg flex flex-col" style={{ height: "calc(100vh - 7rem)" }}>

        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 pt-6 pb-3 flex-shrink-0">
          <button onClick={() => navigate("/")}
            className="h-9 w-9 rounded-full border border-border flex items-center justify-center hover:bg-secondary transition-colors flex-shrink-0">
            <ChevronLeft className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-3 flex-1">
            <div className="relative flex-shrink-0">
              <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center shadow">
                <Bot className="h-5 w-5 text-white" />
              </div>
              <span className={cn(
                "absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background",
                backendOnline ? "bg-emerald-500" : "bg-amber-400"
              )} />
            </div>
            <div>
              <p className="font-bold text-sm leading-none">Vox Assistant</p>
              <p className={cn("text-xs font-semibold mt-0.5", micStatusColor)}>
                {micStatusText}
              </p>
            </div>
          </div>

          <div className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold flex-shrink-0",
            backendOnline ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
          )}>
            {backendOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {backendOnline ? "Connected" : "Offline"}
          </div>
        </div>

        {/* ── Chat area ────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 space-y-4 pb-2">
          <AnimatePresence initial={false}>
            {conversations.map((msg) => (
              <motion.div key={msg.id}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={cn("flex gap-2", msg.type === "user" ? "flex-row-reverse" : "flex-row")}
              >
                {msg.type === "assistant" && (
                  <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0 self-end shadow">
                    <Bot className="h-4 w-4 text-white" />
                  </div>
                )}
                <div className={cn("max-w-[78%] space-y-0.5 flex flex-col",
                  msg.type === "user" ? "items-end" : "items-start")}>
                  <div className={cn(
                    "px-4 py-2.5 rounded-2xl text-sm leading-relaxed",
                    msg.type === "user"
                      ? "bg-primary text-white rounded-br-sm"
                      : "bg-white text-foreground rounded-bl-sm shadow-sm border border-border/40"
                  )}>
                    {msg.content}
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">{msg.timestamp}</p>
                </div>
              </motion.div>
            ))}

            {isTyping && (
              <motion.div key="typing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-2">
                <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0 shadow">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5 items-center shadow-sm border border-border/40">
                  {[0, 1, 2].map(i => (
                    <motion.div key={i} animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.18 }}
                      className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>

        {/* ── Mic status banner (passive — not a button) ────────── */}
        <AnimatePresence>
          {micActive && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mx-4 mb-2 rounded-2xl bg-primary/8 border border-primary/15 px-4 py-2.5 flex items-center gap-3">
              <Mic className="h-4 w-4 text-primary animate-pulse flex-shrink-0" />
              <p className="text-xs text-primary font-semibold">Listening… speak now</p>
            </motion.div>
          )}
          {speaking && !micActive && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mx-4 mb-2 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-2.5 flex items-center gap-3">
              <Volume2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
              <p className="text-xs text-emerald-700 font-semibold">Vox is speaking…</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Quick chips ───────────────────────────────────────── */}
        <div className="flex gap-2 px-4 pb-2 overflow-x-auto scrollbar-hide flex-shrink-0">
          {QUICK_CHIPS.map(({ label, cmd }) => (
            <button key={label} onClick={() => sendTyped(cmd)}
              className="flex-shrink-0 px-3.5 py-1.5 rounded-full border border-border bg-background text-xs font-semibold text-foreground hover:bg-secondary transition-colors shadow-sm">
              {label}
            </button>
          ))}
        </div>

        {/* ── Text input ───────────────────────────────────────── */}
        <div className="px-4 pb-4 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 flex items-center bg-secondary/60 rounded-2xl border border-border/60 px-4 h-12">
            <input
              value={typedCmd}
              onChange={e => setTypedCmd(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendTyped(typedCmd)}
              placeholder="Type a command…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {isTyping
              ? <Loader2 className="h-4 w-4 text-muted-foreground animate-spin ml-2 flex-shrink-0" />
              : <button onClick={() => sendTyped(typedCmd)} disabled={!typedCmd.trim()}
                  className="text-primary disabled:opacity-30 ml-2 flex-shrink-0">
                  <Send className="h-4 w-4" />
                </button>
            }
          </div>
        </div>

      </div>
    </Layout>
  );
}
