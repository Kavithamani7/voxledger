import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { AppProvider, useApp } from "@/context/AppContext";

// Apply persisted dark mode ASAP before render
if (localStorage.getItem("vox_dark_mode") === "1") {
  document.documentElement.classList.add("dark");
}

import SplashScreen from "@/components/SplashScreen";
import Registration from "./pages/Registration";
import WakePhraseSetup from "./pages/WakePhraseSetup";
import Locked from "./pages/Locked";
import Greeting from "./pages/Greeting";
import Index from "./pages/Index";
import Conversation from "./pages/Conversation";
import Budget from "./pages/Budget";
import Notifications from "./pages/Notifications";
import Transactions from "./pages/Transactions";
import Profile from "./pages/Profile";
import Alerts from "./pages/Alerts";
import AddVoiceProfile from "./pages/AddVoiceProfile";
import NotFound from "./pages/NotFound";

// ── Required flow: Splash → Registration → WakePhraseSetup → Locked → Dashboard
// Remove AddVoiceProfile from pre-dashboard flow — it's accessible from Profile.

const AUTO_LOCK_MS = 60_000;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function stopAllActiveMedia() {
  try { window.dispatchEvent(new CustomEvent("vox:force-stop")); } catch (_) {}
}

// ── Protected route — must be authenticated ───────────────────────────────────
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useApp();
  if (!isAuthenticated) return <Navigate to="/locked" replace />;
  return <>{children}</>;
}

// ── Setup guard — registration must be complete before wake-phrase-setup ──────
function SetupGuard({ children }: { children: ReactNode }) {
  const { user } = useApp();
  if (!user) return <Navigate to="/registration" replace />;
  return <>{children}</>;
}

// ── Auto-lock after inactivity ────────────────────────────────────────────────
function useAutoLock() {
  const { isAuthenticated, lockApp } = useApp();
  const navigate = useNavigate();
  const resetTimer = useCallback(() => {
    sessionStorage.setItem("vox_last_activity", String(Date.now()));
  }, []);
  useEffect(() => {
    if (!isAuthenticated) return;
    resetTimer();
    const EVENTS = ["mousemove", "keydown", "touchstart", "click", "scroll", "pointermove"];
    EVENTS.forEach(e => window.addEventListener(e, resetTimer, { passive: true }));
    const interval = setInterval(() => {
      const last = Number(sessionStorage.getItem("vox_last_activity") || "0");
      if (Date.now() - last >= AUTO_LOCK_MS) {
        stopAllActiveMedia(); lockApp(); navigate("/locked");
      }
    }, 5_000);
    return () => { EVENTS.forEach(e => window.removeEventListener(e, resetTimer)); clearInterval(interval); };
  }, [isAuthenticated, lockApp, navigate, resetTimer]);
}

function AutoLockManager() { useAutoLock(); return null; }

// ── App routes ────────────────────────────────────────────────────────────────
// CORRECT FLOW: Splash → Registration → WakePhraseSetup → Locked → Dashboard
// Unnecessary pages (AddVoiceProfile as pre-dashboard step) are removed from flow.
function AppRoutes() {
  const [splashDone, setSplashDone] = useState(false);
  const navigate = useNavigate();

  const handleSplashComplete = (dest: "registration" | "locked" | "wake-phrase-setup") => {
    setSplashDone(true);
    if (dest === "locked") navigate("/locked");
    else if (dest === "wake-phrase-setup") navigate("/wake-phrase-setup");
    else navigate("/registration");
  };

  return (
    <>
      <AutoLockManager />
      <AnimatePresence>
        {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}
      </AnimatePresence>
      <Routes>
        {/* ── Public / onboarding routes ─────────────────────── */}
        <Route path="/registration"     element={<Registration />} />
        <Route path="/wake-phrase-setup" element={<SetupGuard><WakePhraseSetup /></SetupGuard>} />
        <Route path="/locked"           element={<Locked />} />
        <Route path="/greeting"         element={<Greeting />} />

        {/* ── Protected app routes ───────────────────────────── */}
        <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
        <Route path="/conversation" element={<ProtectedRoute><Conversation /></ProtectedRoute>} />
        <Route path="/transactions" element={<ProtectedRoute><Transactions /></ProtectedRoute>} />
        <Route path="/budget"       element={<ProtectedRoute><Budget /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
        <Route path="/alerts"       element={<ProtectedRoute><Alerts /></ProtectedRoute>} />
        <Route path="/profile"      element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="/add-voice-profile" element={<ProtectedRoute><AddVoiceProfile /></ProtectedRoute>} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AppProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </TooltipProvider>
    </AppProvider>
  </QueryClientProvider>
);

export default App;
