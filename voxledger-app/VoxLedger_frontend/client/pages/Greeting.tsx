import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { Bot, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/context/AppContext";
import { getTtsUrl, getUser } from "@/lib/api";

export default function Greeting() {
  const { user, userId, registerUser } = useApp();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<0 | 1 | 2>(0);
  const [resolvedName, setResolvedName] = useState<string>(user?.name?.split(" ")[0] || "there");
  const [displayedText, setDisplayedText] = useState("");
  const [charIdx, setCharIdx] = useState(0);
  const [showContinue, setShowContinue] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const navigatedRef = useRef(false);
  const ttsStartedRef = useRef(false);

  useEffect(() => {
    if (user?.name) {
      setResolvedName(user.name.split(" ")[0]);
    } else if (userId) {
      getUser(userId)
        .then(d => {
          setResolvedName(d.name.split(" ")[0]);
          registerUser({ id: d.id, name: d.name, pin: "", voiceSamples: [], registeredAt: d.created_at });
        })
        .catch(() => {});
    }
  }, [userId]);

  const greeting = `Hi ${resolvedName}, I am your finance assistant. How can I help you today?`;

  const goToDashboard = () => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    navigate("/");
  };

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 400);
    const t2 = setTimeout(() => setPhase(2), 1200);

    const t3 = setTimeout(() => {
      try {
        const audio = new Audio(getTtsUrl(greeting));
        audioRef.current = audio;
        audio.onended = () => goToDashboard();
        audio.onerror = () => { setShowContinue(true); };
        audio.play()
          .then(() => {
            ttsStartedRef.current = true;
            const maxWait = Math.max(10000, greeting.length * 110);
            setTimeout(() => { if (!navigatedRef.current) goToDashboard(); }, maxWait);
          })
          .catch(() => {
            ttsStartedRef.current = false;
            setShowContinue(true);
          });
      } catch {
        setShowContinue(true);
      }
    }, 1400);

    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      if (audioRef.current) {
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, [greeting]);

  // Typewriter effect
  useEffect(() => {
    if (phase < 2) return;
    if (charIdx < greeting.length) {
      const t = setTimeout(() => {
        setDisplayedText(greeting.slice(0, charIdx + 1));
        setCharIdx(c => c + 1);
      }, 38);
      return () => clearTimeout(t);
    }
  }, [phase, charIdx, greeting]);

  const handleTap = () => {
    if (!ttsStartedRef.current && audioRef.current) {
      audioRef.current.play()
        .then(() => { ttsStartedRef.current = true; setShowContinue(false); })
        .catch(() => goToDashboard());
    } else {
      goToDashboard();
    }
  };

  return (
    <div className="min-h-screen bg-primary flex flex-col items-center justify-center px-8 relative overflow-hidden">
      {[1, 2, 3].map(i => (
        <motion.div
          key={i}
          className="absolute rounded-full border border-white/10"
          animate={{ scale: [1, 1.4, 1], opacity: [0.08, 0.2, 0.08] }}
          transition={{ duration: 3 + i, repeat: Infinity, ease: "easeInOut" }}
          style={{ width: 80 + i * 130, height: 80 + i * 130 }}
        />
      ))}

      <motion.div
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: phase >= 1 ? 1 : 0, scale: phase >= 1 ? 1 : 0.7 }}
        transition={{ type: "spring", bounce: 0.5, duration: 0.7 }}
        className="flex flex-col items-center gap-8 z-10"
      >
        <motion.div
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className="h-28 w-28 rounded-full bg-white/20 backdrop-blur-sm border-2 border-white/40 flex items-center justify-center shadow-2xl"
        >
          <Bot className="h-14 w-14 text-white" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: phase >= 1 ? 1 : 0, y: phase >= 1 ? 0 : 10 }}
          transition={{ delay: 0.3 }}
          className="bg-white/15 backdrop-blur-sm rounded-2xl px-5 py-2 border border-white/20"
        >
          <p className="text-white/90 text-sm font-bold tracking-wide">Vox Assistant</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: phase >= 2 ? 1 : 0 }}
          className="max-w-xs text-center"
        >
          <p className="text-white text-xl font-semibold leading-relaxed">
            {displayedText}
            {charIdx < greeting.length && (
              <motion.span
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 0.5, repeat: Infinity }}
                className="inline-block w-0.5 h-5 bg-white ml-0.5 align-middle"
              />
            )}
          </p>
        </motion.div>

        {charIdx === greeting.length && !showContinue && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-2">
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
                transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.2 }}
                className="h-2 w-2 rounded-full bg-white/60"
              />
            ))}
          </motion.div>
        )}

        {showContinue && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={handleTap}
            className="flex items-center gap-2 bg-white/20 hover:bg-white/30 border border-white/30 text-white font-semibold px-6 py-3 rounded-2xl transition-colors"
          >
            Tap to continue <ArrowRight className="h-4 w-4" />
          </motion.button>
        )}
      </motion.div>
    </div>
  );
}
