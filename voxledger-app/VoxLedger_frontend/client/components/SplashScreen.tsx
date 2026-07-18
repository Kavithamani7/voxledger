import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic } from "lucide-react";
import { checkUser } from "@/lib/api";

interface SplashScreenProps {
  onComplete: (dest: "registration" | "locked" | "wake-phrase-setup") => void;
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const [phase, setPhase] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 400);
    const t2 = setTimeout(() => setPhase(2), 1800);

    // Check backend for existing user, then route accordingly
    const t3 = setTimeout(async () => {
      try {
        const res = await checkUser();
        if (res.registered) {
          // User has a voice profile — both flags must be set for setup to be complete
          const setupComplete =
            localStorage.getItem("vox_setup_complete") === "1" &&
            !!localStorage.getItem("vox_wake_phrase");
          onComplete(setupComplete ? "locked" : "wake-phrase-setup");
        } else if (res.has_user && !res.has_voice_profile) {
          // Partial registration — clear any stale setup flags, resume registration
          localStorage.removeItem("vox_setup_complete");
          localStorage.removeItem("vox_wake_phrase");
          localStorage.removeItem("vox_auth_mode");
          onComplete("registration");
        } else {
          // No user at all — clear everything and start fresh
          localStorage.removeItem("vox_setup_complete");
          localStorage.removeItem("vox_wake_phrase");
          localStorage.removeItem("vox_auth_mode");
          localStorage.removeItem("voxledger_user");
          localStorage.removeItem("voxledger_user_id");
          onComplete("registration");
        }
      } catch {
        // Backend offline – safest fallback is registration so auth is never attempted blindly.
        onComplete("registration");
      }
    }, 2800);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-primary overflow-hidden"
      exit={{ opacity: 0, scale: 1.1 }}
      transition={{ duration: 0.5 }}
    >
      {[1, 2, 3].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full border border-white/10"
          initial={{ width: 80, height: 80, opacity: 0 }}
          animate={{ width: 80 + i * 120, height: 80 + i * 120, opacity: [0, 0.3, 0] }}
          transition={{ duration: 2.5, repeat: Infinity, delay: i * 0.4, ease: "easeOut" }}
        />
      ))}

      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: phase >= 1 ? 1 : 0, opacity: phase >= 1 ? 1 : 0 }}
        transition={{ type: "spring", bounce: 0.5, duration: 0.8 }}
        className="flex flex-col items-center gap-6"
      >
        <div className="h-24 w-24 rounded-3xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center shadow-2xl">
          <Mic className="h-12 w-12 text-white" />
        </div>

        <AnimatePresence>
          {phase >= 1 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="text-center"
            >
              <h1 className="text-4xl font-extrabold text-white tracking-tight">VoxLedger</h1>
              <p className="text-white/70 text-sm font-medium mt-2 tracking-wide">
                Voice-First Personal Finance Assistant
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {phase >= 2 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute bottom-16 flex gap-2"
          >
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="h-2 w-2 rounded-full bg-white/60"
                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
                transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
