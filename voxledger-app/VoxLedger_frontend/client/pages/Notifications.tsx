import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Bell, Wallet, TrendingUp, ShieldCheck, CreditCard, Star, CheckCheck, Trash2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link, useLocation } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

interface UINotification {
  id: string;
  icon: any;
  iconBg: string;
  iconColor: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

function apiNotifToUI(n: api.ApiNotification): UINotification {
  const typeMap: Record<string, { icon: any; iconBg: string; iconColor: string }> = {
    success: { icon: CheckCheck, iconBg: "bg-emerald-100", iconColor: "text-emerald-600" },
    warning: { icon: TrendingUp, iconBg: "bg-red-100", iconColor: "text-red-500" },
    error: { icon: ShieldCheck, iconBg: "bg-red-100", iconColor: "text-red-500" },
    info: { icon: Bell, iconBg: "bg-blue-100", iconColor: "text-blue-500" },
  };
  const cfg = typeMap[n.type] || typeMap["info"];
  // Pick icon based on title keywords
  let icon = cfg.icon;
  let iconBg = cfg.iconBg;
  let iconColor = cfg.iconColor;
  const t = n.title.toLowerCase();
  if (t.includes("salary") || t.includes("income") || t.includes("credit")) { icon = Wallet; iconBg = "bg-blue-100"; iconColor = "text-blue-500"; }
  else if (t.includes("budget") || t.includes("alert") || t.includes("exceed")) { icon = TrendingUp; iconBg = "bg-red-100"; iconColor = "text-red-500"; }
  else if (t.includes("transaction") || t.includes("payment")) { icon = CreditCard; iconBg = "bg-purple-100"; iconColor = "text-purple-500"; }
  else if (t.includes("security") || t.includes("login")) { icon = ShieldCheck; iconBg = "bg-emerald-100"; iconColor = "text-emerald-600"; }
  else if (t.includes("saving") || t.includes("milestone") || t.includes("goal")) { icon = Star; iconBg = "bg-amber-100"; iconColor = "text-amber-500"; }
  else if (t.includes("summary") || t.includes("weekly") || t.includes("daily")) { icon = CheckCheck; iconBg = "bg-teal-100"; iconColor = "text-teal-600"; }
  else if (t.includes("welcome")) { icon = Star; iconBg = "bg-amber-100"; iconColor = "text-amber-500"; }

  let timestamp = "Recent";
  if (n.created_at) {
    // SQLite stores without timezone — treat as local time
    const normalized = n.created_at.replace(" ", "T");
    const d = new Date(normalized);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMin / 60);
    const diffD = Math.floor(diffH / 24);
    if (diffMin < 1) timestamp = "Just now";
    else if (diffMin < 60) timestamp = `${diffMin} min ago`;
    else if (diffH < 24) timestamp = `${diffH} hour${diffH > 1 ? "s" : ""} ago`;
    else if (diffD === 1) timestamp = "Yesterday";
    else timestamp = `${diffD} days ago`;
  }

  return { id: String(n.id), icon, iconBg, iconColor, title: n.title, message: n.message, timestamp, read: n.is_read };
}

export default function Notifications() {
  const { userId, backendOnline } = useApp();
  const location = useLocation();
  const [notifications, setNotifications] = useState<UINotification[]>([]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [loading, setLoading] = useState(false);
  const prefetchedAppliedRef = useRef(false);

  const fetchNotifications = useCallback(async (force = false) => {
    if (!userId) return;

    const prefetched = (location.state as any)?.prefetchedNotifications as api.ApiNotification[] | undefined;
    if (!force && prefetched && Array.isArray(prefetched) && !prefetchedAppliedRef.current) {
      prefetchedAppliedRef.current = true;
      setNotifications(prefetched.map(apiNotifToUI));
      return;
    }

    setLoading(true);
    try {
      const data = await api.getNotifications(userId);
      setNotifications(data.notifications.map(apiNotifToUI));
    } catch (e) {
      console.warn("Failed to fetch notifications:", e);
    }
    setLoading(false);
  }, [userId, location.state]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const markAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    if (userId) {
      try { await api.markNotificationsRead(userId); } catch (_) {}
    }
  };

  const markRead = async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    if (userId) {
      try { await api.markNotificationsRead(userId, [parseInt(id)]); } catch (_) {}
    }
  };

  const dismiss = (id: string) => setNotifications(prev => prev.filter(n => n.id !== id));

  const unreadCount = notifications.filter(n => !n.read).length;
  const filtered = filter === "unread" ? notifications.filter(n => !n.read) : notifications;

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-5 pt-8 pb-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link to="/"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
            <div>
              <h1 className="text-xl font-bold">Notifications</h1>
              {unreadCount > 0 && <p className="text-xs text-primary font-semibold">{unreadCount} unread</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => fetchNotifications(true)} disabled={loading} className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/70 transition-colors">
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            </button>
            {unreadCount > 0 && (<button onClick={markAllRead} className="text-xs text-primary font-semibold hover:underline">Mark all read</button>)}
          </div>
        </div>

        <div className="flex gap-2 mb-5">
          {(["all", "unread"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={cn("px-5 py-2 rounded-full text-xs font-bold transition-all capitalize", filter === f ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>
              {f} {f === "unread" && unreadCount > 0 && `(${unreadCount})`}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <AnimatePresence>
            {loading && notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                <p className="text-sm text-muted-foreground">Loading notifications...</p>
              </div>
            ) : filtered.length === 0 ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-20 text-center">
                <div className="h-20 w-20 bg-secondary rounded-full flex items-center justify-center mb-6"><Bell className="h-10 w-10 text-muted-foreground/40" /></div>
                <h2 className="text-lg font-bold">All caught up!</h2>
                <p className="text-xs text-muted-foreground mt-2">No notifications here.</p>
              </motion.div>
            ) : (
              filtered.map((n, i) => {
                const Icon = n.icon;
                return (
                  <motion.div key={n.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }} transition={{ delay: i * 0.04 }}>
                    <Card className={cn("border-none shadow-md shadow-slate-200/40 rounded-2xl cursor-pointer hover:shadow-lg transition-shadow", !n.read && "ring-1 ring-primary/20 bg-primary/[0.02]")} onClick={() => markRead(n.id)}>
                      <CardContent className="p-4 flex items-start gap-4">
                        <div className="relative flex-shrink-0">
                          <div className={cn("h-11 w-11 rounded-2xl flex items-center justify-center", n.iconBg)}><Icon className={cn("h-5 w-5", n.iconColor)} /></div>
                          {!n.read && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-primary border-2 border-background" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm font-semibold", !n.read && "font-bold")}>{n.title}</p>
                            <button onClick={e => { e.stopPropagation(); dismiss(n.id); }} className="flex-shrink-0 h-6 w-6 rounded-lg hover:bg-secondary flex items-center justify-center transition-colors"><Trash2 className="h-3.5 w-3.5 text-muted-foreground/50" /></button>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed mt-0.5 mb-2">{n.message}</p>
                          <p className="text-[10px] text-muted-foreground font-medium">{n.timestamp}</p>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </div>
      </div>
    </Layout>
  );
}
