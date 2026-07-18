import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, User, Shield, Mic, Plus, LogOut, ChevronRight, ShieldCheck, Bell, HelpCircle, Moon, Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link, useNavigate } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

const stagger = { animate: { transition: { staggerChildren: 0.07 } } };
const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } };

export default function Profile() {
  const { user, userId, lockApp, logout, transactions, monthlyBudget, backendOnline } = useApp();
  const navigate = useNavigate();
  const [darkMode, setDarkMode] = useState(() => {
    return document.documentElement.classList.contains("dark");
  });
  const [notifications, setNotifications] = useState(true);
  const [profileData, setProfileData] = useState<{ voice_samples: number; created_at?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (userId) {
      setLoading(true);
      api.getUser(userId)
        .then(d => setProfileData({ voice_samples: d.voice_samples, created_at: d.created_at }))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [userId]);

  const totalTxs = transactions.length;
  const totalSpent = transactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const voiceSampleCount = profileData?.voice_samples ?? user?.voiceSamples?.length ?? 0;

  const menuSections = [
    {
      title: "Security",
      items: [
        { icon: Shield, label: "Voice Authentication", sublabel: `${voiceSampleCount} sample${voiceSampleCount !== 1 ? "s" : ""} registered`, action: () => navigate("/add-voice-profile"), hasChevron: true, iconBg: "bg-blue-100", iconColor: "text-blue-600" },
        { icon: Lock, label: "Lock App", sublabel: "Lock & return to wake screen", action: () => { lockApp(); navigate("/locked"); }, hasChevron: false, iconBg: "bg-amber-100", iconColor: "text-amber-600" },
      ],
    },
    {
      title: "Preferences",
      items: [
        { icon: Bell, label: "Notifications", sublabel: notifications ? "Enabled" : "Disabled", action: () => setNotifications(p => !p), hasChevron: false, hasToggle: true, toggleValue: notifications, iconBg: "bg-purple-100", iconColor: "text-purple-600" },
        { icon: Moon, label: "Dark Mode", sublabel: darkMode ? "On" : "Off", action: () => {
            setDarkMode(p => {
              const next = !p;
              if (next) {
                document.documentElement.classList.add("dark");
                localStorage.setItem("vox_dark_mode", "1");
              } else {
                document.documentElement.classList.remove("dark");
                localStorage.setItem("vox_dark_mode", "0");
              }
              return next;
            });
          }, hasChevron: false, hasToggle: true, toggleValue: darkMode, iconBg: "bg-slate-100", iconColor: "text-slate-600" },
      ],
    },
    {
      title: "Support",
      items: [
        { icon: HelpCircle, label: "Help & FAQ", sublabel: "Get answers to common questions", action: () => {}, hasChevron: true, iconBg: "bg-teal-100", iconColor: "text-teal-600" },
      ],
    },
  ];

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-5 pt-8 pb-4">
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-5">

          <motion.div variants={fadeUp} className="flex items-center gap-4">
            <Link to="/"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
            <h1 className="text-xl font-bold">Profile</h1>
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-xl shadow-primary/10 rounded-3xl overflow-hidden">
              <div className="bg-primary px-6 pt-7 pb-8">
                <div className="flex items-center gap-5">
                  <div className="h-20 w-20 rounded-3xl bg-white/20 backdrop-blur-sm border-2 border-white/40 flex items-center justify-center shadow-xl flex-shrink-0">
                    <User className="h-10 w-10 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-2xl font-extrabold text-white truncate">{user?.name || "User"}</h2>
                    <p className="text-white/70 text-sm mt-0.5">VoxLedger Member</p>
                    {profileData?.created_at && (
                      <p className="text-white/50 text-xs mt-0.5">Joined {new Date(profileData.created_at).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-2">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                      <span className="text-xs text-emerald-300 font-semibold">Voice Verified</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 divide-x divide-border/40">
                {[
                  { label: "Transactions", value: loading ? "..." : totalTxs },
                  { label: "Budget", value: `₹${(monthlyBudget / 1000).toFixed(1)}k` },
                  { label: "Total Spent", value: `₹${(totalSpent / 1000).toFixed(1)}k` },
                ].map(s => (
                  <div key={s.label} className="p-4 text-center">
                    <p className="font-extrabold text-base">{s.value}</p>
                    <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mt-0.5">{s.label}</p>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-md shadow-slate-200/40 rounded-3xl">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-blue-100 flex items-center justify-center"><Mic className="h-5 w-5 text-blue-600" /></div>
                    <div>
                      <p className="font-bold text-sm">Voice Samples</p>
                      <p className="text-xs text-muted-foreground">{loading ? <Loader2 className="h-3 w-3 animate-spin inline" /> : voiceSampleCount} registered</p>
                    </div>
                  </div>
                  <button onClick={() => navigate("/add-voice-profile")} className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors">
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
                {voiceSampleCount > 0 ? (
                  <div className="space-y-2">
                    {Array.from({ length: Math.min(voiceSampleCount, 3) }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-secondary/40">
                        <div className="h-8 w-8 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0"><Mic className="h-4 w-4 text-blue-500" /></div>
                        <div><p className="text-sm font-semibold">Voice Sample {i + 1}</p><p className="text-xs text-muted-foreground">Registered</p></div>
                        <div className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <p className="text-sm text-muted-foreground">No voice samples yet.</p>
                    <button onClick={() => navigate("/add-voice-profile")} className="text-xs text-primary font-bold mt-1 hover:underline">Record your first sample</button>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {menuSections.map(section => (
            <motion.div key={section.title} variants={fadeUp}>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-1">{section.title}</p>
              <Card className="border-none shadow-md shadow-slate-200/40 rounded-3xl">
                <CardContent className="p-2">
                  {section.items.map((item, i) => {
                    const Icon = item.icon;
                    return (
                      <button key={item.label} onClick={item.action} className={cn("flex items-center gap-4 w-full px-4 py-3.5 rounded-2xl hover:bg-secondary/40 transition-colors text-left", i < section.items.length - 1 && "border-b border-border/40 rounded-none")}>
                        <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center flex-shrink-0", item.iconBg)}><Icon className={cn("h-4.5 w-4.5", item.iconColor)} /></div>
                        <div className="flex-1 min-w-0"><p className="font-semibold text-sm">{item.label}</p><p className="text-xs text-muted-foreground">{item.sublabel}</p></div>
                        {(item as any).hasToggle ? (
                          <div className={cn("h-6 w-11 rounded-full transition-colors relative", (item as any).toggleValue ? "bg-primary" : "bg-secondary")}>
                            <div className={cn("h-5 w-5 rounded-full bg-white shadow absolute top-0.5 transition-transform", (item as any).toggleValue ? "translate-x-5" : "translate-x-0.5")} />
                          </div>
                        ) : item.hasChevron ? (<ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />) : null}
                      </button>
                    );
                  })}
                </CardContent>
              </Card>
            </motion.div>
          ))}

          <motion.div variants={fadeUp}>
            <Button variant="outline" className="w-full h-13 rounded-2xl border-destructive/30 text-destructive hover:bg-destructive/5 font-bold" onClick={() => { logout(); navigate("/registration"); }}>
              <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
          </motion.div>

          <motion.div variants={fadeUp} className="text-center pb-4">
            <p className="text-[10px] text-muted-foreground">VoxLedger v2.0 · Voice-First Finance</p>
          </motion.div>

        </motion.div>
      </div>
    </Layout>
  );
}
