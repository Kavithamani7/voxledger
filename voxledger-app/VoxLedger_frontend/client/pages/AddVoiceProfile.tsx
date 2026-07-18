import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Mic, Play, Square, RefreshCcw, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import * as api from "@/lib/api";

const PHRASES = [
  '"Hello VoxLedger, this is my secure voice sample for authentication. I will use this voice to access my finance assistant."',
  '"Hello VoxLedger, please open my transactions and show my spending summary."',
  '"Hello VoxLedger, open my budget and read my latest notifications."',
];

export default function AddVoiceProfile() {
  const [sampleIdx, setSampleIdx] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { userId, backendOnline, registerUser, user } = useApp();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const startRecording = async () => {
    setIsRecording(true);
    setProgress(0);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(100);
    } catch (_) { mediaRecorderRef.current = null; }

    let cur = 0;
    intervalRef.current = setInterval(() => {
      cur += 1;
      setProgress(cur);
      if (cur >= 100) {
        clearInterval(intervalRef.current!);
        setIsRecording(false);
        if (mediaRecorderRef.current?.state !== "inactive") {
          mediaRecorderRef.current?.stop();
          mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop());
        }
      }
    }, 30);
  };

  const stopEarly = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsRecording(false);
    setProgress(0);
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop());
    }
  };


  useEffect(() => {
    if ((location.state as any)?.startRecording && !isRecording && progress === 0 && !done) {
      const id = window.setTimeout(() => {
        startRecording();
      }, 300);
      return () => window.clearTimeout(id);
    }
  }, [location.state, isRecording, progress, done]);

  const next = async () => {
    if (userId && chunksRef.current.length > 0) {
      setUploading(true);
      try {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await api.uploadVoiceSample(userId, blob);
      } catch (_) {}
      setUploading(false);
    }
    chunksRef.current = [];

    if (sampleIdx < PHRASES.length - 1) {
      setSampleIdx(sampleIdx + 1);
      setProgress(0);
    } else {
      // Update user's voice sample count locally
      if (user) {
        registerUser({ ...user, voiceSamples: [...(user.voiceSamples || []), `sample_${Date.now()}`] });
      }
      setDone(true);
    }
  };

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-6 pt-8 pb-32">
        <div className="flex items-center gap-4 mb-10">
          <Link to="/profile"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
          <h1 className="text-xl font-bold">Add Voice Sample</h1>
        </div>

        <AnimatePresence mode="wait">
          {!done ? (
            <motion.div key="recording" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="flex gap-2 mb-8">
                {PHRASES.map((_, i) => (<div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < sampleIdx ? "bg-success" : i === sampleIdx ? "bg-primary" : "bg-secondary"}`} />))}
              </div>

              <div className="text-center mb-8">
                <p className="text-sm text-muted-foreground font-semibold uppercase tracking-wider mb-2">Sample {sampleIdx + 1} of {PHRASES.length}</p>
                <h2 className="text-xl font-bold">Read the phrase below</h2>
              </div>

              <Card className="border-none bg-primary/5 rounded-3xl mb-8">
                <CardContent className="p-8 flex flex-col items-center text-center">
                  <div className={`h-20 w-20 rounded-full flex items-center justify-center mb-6 transition-colors shadow-xl ${isRecording ? "bg-destructive shadow-destructive/30 animate-pulse" : "bg-primary shadow-primary/20"}`}>
                    <Mic className="h-10 w-10 text-white" />
                  </div>

                  <p className="text-base font-semibold italic text-foreground mb-6 leading-relaxed px-2">{PHRASES[sampleIdx]}</p>

                  {isRecording ? (
                    <div className="w-full space-y-4">
                      <div className="flex justify-center gap-1 h-10 items-center">
                        {Array.from({ length: 14 }).map((_, i) => (
                          <motion.div key={i} animate={{ height: [6, Math.random() * 28 + 8, 6] }} transition={{ duration: 0.4, repeat: Infinity, delay: i * 0.06 }} className="w-1.5 rounded-full bg-primary" />
                        ))}
                      </div>
                      <Progress value={progress} className="h-1" />
                      <Button variant="destructive" size="icon" className="h-12 w-12 rounded-full" onClick={stopEarly}><Square className="h-5 w-5" /></Button>
                    </div>
                  ) : progress === 100 ? (
                    <div className="flex gap-3">
                      <Button variant="outline" className="h-11 rounded-2xl border-primary text-primary" onClick={() => setProgress(0)}><RefreshCcw className="mr-2 h-4 w-4" /> Redo</Button>
                      <Button className="h-11 rounded-2xl px-6" onClick={next} disabled={uploading}>
                        {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> : sampleIdx < PHRASES.length - 1 ? <>Next → <Check className="ml-2 h-4 w-4" /></> : <>Finish <Check className="ml-2 h-4 w-4" /></>}
                      </Button>
                    </div>
                  ) : (
                    <motion.button whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }} onClick={startRecording} className="h-16 w-16 rounded-full bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/30">
                      <Play className="h-8 w-8 ml-1" />
                    </motion.button>
                  )}
                </CardContent>
              </Card>

              <p className="text-[11px] text-center text-muted-foreground">Speak clearly in a quiet environment for best accuracy.</p>
            </motion.div>
          ) : (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", bounce: 0.4 }} className="text-center py-8">
              <div className="relative inline-block mb-8">
                <div className="h-24 w-24 bg-success rounded-full flex items-center justify-center mx-auto shadow-2xl shadow-success/20 text-white"><Check className="h-12 w-12" /></div>
              </div>
              <h2 className="text-2xl font-bold mb-3">Voice sample saved!</h2>
              <p className="text-sm text-muted-foreground mb-10">Your new voice sample has been added to your profile.</p>
              <Button className="w-full h-14 rounded-2xl font-bold shadow-xl shadow-primary/20" onClick={() => navigate("/profile")}>Back to Profile</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Layout>
  );
}
