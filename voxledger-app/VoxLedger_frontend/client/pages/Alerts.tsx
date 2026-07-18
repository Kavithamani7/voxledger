import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, AlertTriangle, TrendingDown, ShieldAlert, CheckCircle, XCircle, Bell, ChevronRight, DollarSign, Target, Clock, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

type AlertSeverity = "critical" | "warning" | "info" | "success";

interface FinancialAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: string;
  amount?: string;
  category?: string;
  actionLabel?: string;
  icon: any;
  dismissed: boolean;
}

const severityConfig: Record<AlertSeverity, { bg: string; icon: string; badge: string; badgeText: string }> = {
  critical: { bg: "bg-red-500", icon: "text-red-500", badge: "bg-red-50", badgeText: "text-red-600" },
  warning: { bg: "bg-amber-500", icon: "text-amber-500", badge: "bg-amber-50", badgeText: "text-amber-600" },
  info: { bg: "bg-blue-500", icon: "text-blue-500", badge: "bg-blue-50", badgeText: "text-blue-600" },
  success: { bg: "bg-emerald-500", icon: "text-emerald-500", badge: "bg-emerald-50", badgeText: "text-emerald-600" },
};

const severityLabels: Record<AlertSeverity, string> = {
  critical: "Critical", warning: "Warning", info: "Info", success: "Good News",
};

const filterTabs = ["All", "Critical", "Warnings", "Info"];

function nowTimestamp(): string {
  return new Date().toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function generateAlertsFromData(budget: api.BudgetSummary | null, summary: api.FinancialSummary | null): FinancialAlert[] {
  const alerts: FinancialAlert[] = [];

  if (!budget && !summary) return [];

  const now = nowTimestamp();
  const usedPct = budget?.used_pct ?? summary?.budget_used_pct ?? 0;
  const totalSpent = budget?.total_spent ?? summary?.total_expenses ?? 0;
  const monthlyBudget = budget?.monthly_budget ?? summary?.monthly_budget ?? 2500;

  // Critical: over budget
  if (usedPct > 100) {
    const over = totalSpent - monthlyBudget;
    alerts.push({
      id: "budget-over", severity: "critical", title: "Over Monthly Budget",
      message: `You've exceeded your monthly budget by ₹${over.toFixed(0)}. Immediate review recommended.`,
      timestamp: now, amount: `₹${over.toFixed(0)} over`, actionLabel: "Adjust Budget",
      icon: XCircle, dismissed: false,
    });
  } else if (usedPct >= 80) {
    // Warning: 80%+ used
    alerts.push({
      id: "budget-high", severity: usedPct >= 90 ? "critical" : "warning",
      title: `${usedPct.toFixed(0)}% Budget Used`,
      message: `Your monthly budget is ${usedPct >= 90 ? "nearly" : "getting"} exhausted. ₹${(monthlyBudget - totalSpent).toFixed(0)} remaining.`,
      timestamp: now, amount: `₹${(monthlyBudget - totalSpent).toFixed(0)} left`,
      actionLabel: "View Budget", icon: AlertTriangle, dismissed: false,
    });
  }

  // Category-level alerts
  if (budget?.categories) {
    budget.categories.forEach(cat => {
      if (cat.category === "monthly") return;
      if (cat.used_pct > 100) {
        alerts.push({
          id: `cat-over-${cat.category}`, severity: "critical",
          title: `Over Budget: ${cat.category}`,
          message: `Your ${cat.category} spending has exceeded the ₹${cat.amount} limit by ₹${(cat.spent - cat.amount).toFixed(0)}.`,
          timestamp: nowTimestamp(), amount: `₹${(cat.spent - cat.amount).toFixed(0)} over`, category: cat.category,
          actionLabel: "Review", icon: XCircle, dismissed: false,
        });
      } else if (cat.used_pct >= 75) {
        alerts.push({
          id: `cat-warn-${cat.category}`, severity: "warning",
          title: `${cat.used_pct.toFixed(0)}% Budget Used: ${cat.category}`,
          message: `Your ${cat.category} budget is getting low. Only ₹${cat.remaining.toFixed(0)} remaining.`,
          timestamp: nowTimestamp(), amount: `₹${cat.remaining.toFixed(0)} left`, category: cat.category,
          actionLabel: "View Details", icon: AlertTriangle, dismissed: false,
        });
      }
    });
  }

  // Success: on track
  if (usedPct < 50 && totalSpent > 0) {
    alerts.push({
      id: "on-track", severity: "success", title: "Great Spending Control!",
      message: `You've only used ${usedPct.toFixed(0)}% of your monthly budget. Keep it up!`,
      timestamp: now, icon: CheckCircle, dismissed: false,
    });
  }

  // Info: top category spending
  if (summary?.top_category && summary.top_category !== "") {
    alerts.push({
      id: "top-cat", severity: "info",
      title: `Top Spending: ${summary.top_category}`,
      message: `${summary.top_category} is your highest spending category this month. Consider setting a specific budget limit.`,
      timestamp: nowTimestamp(), category: summary.top_category,
      actionLabel: "Set Budget", icon: Target, dismissed: false,
    });
  }

  // If no alerts generated, add a good news one
  if (alerts.length === 0) {
    alerts.push({
      id: "all-good", severity: "success", title: "All Clear!",
      message: "Your finances are looking great. No alerts to report at this time.",
      timestamp: now, icon: CheckCircle, dismissed: false,
    });
  }

  return alerts;
}

export default function Alerts() {
  const { userId, backendOnline } = useApp();
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);
  const [activeTab, setActiveTab] = useState("All");
  const [loading, setLoading] = useState(false);

  const fetchAlerts = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [budget, summary] = await Promise.all([
        api.getBudget(userId),
        api.getFinancialSummary(userId, "month"),
      ]);
      setAlerts(generateAlertsFromData(budget, summary));
    } catch (e) {
      console.warn("Failed to fetch alert data:", e);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const dismiss = (id: string) => setAlerts(prev => prev.map(a => a.id === id ? { ...a, dismissed: true } : a));

  const filtered = alerts.filter(alert => {
    if (activeTab === "All") return true;
    if (activeTab === "Critical") return alert.severity === "critical";
    if (activeTab === "Warnings") return alert.severity === "warning";
    if (activeTab === "Info") return alert.severity === "info" || alert.severity === "success";
    return true;
  });

  const activeCount = alerts.filter(a => !a.dismissed && (a.severity === "critical" || a.severity === "warning")).length;

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-6 pt-8 pb-32">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
            <div>
              <h1 className="text-xl font-bold">Spending Alerts</h1>
              {activeCount > 0 && <p className="text-xs text-destructive font-semibold">{activeCount} active alert{activeCount > 1 ? "s" : ""} need attention</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchAlerts} disabled={loading} className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/70 transition-colors">
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            </button>
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border relative">
              <Bell className="h-5 w-5" />
              {activeCount > 0 && <span className="absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-destructive border-2 border-background" />}
            </Button>
          </div>
        </div>

        {/* Summary strip */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-4 gap-3 mb-8">
          {(["critical", "warning", "info", "success"] as AlertSeverity[]).map(sev => {
            const count = alerts.filter(a => a.severity === sev).length;
            const cfg = severityConfig[sev];
            return (
              <Card key={sev} className="border-none shadow-md shadow-slate-200/40">
                <CardContent className="p-3 text-center">
                  <p className={cn("text-xl font-bold", cfg.icon)}>{count}</p>
                  <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide mt-0.5">{severityLabels[sev]}</p>
                </CardContent>
              </Card>
            );
          })}
        </motion.div>

        <div className="flex gap-3 mb-8 overflow-x-auto pb-1 scrollbar-hide">
          {filterTabs.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={cn("flex-shrink-0 px-5 py-2 rounded-full text-xs font-bold transition-all", activeTab === tab ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>{tab}</button>
          ))}
        </div>

        {loading && alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="text-sm text-muted-foreground">Analyzing your finances...</p>
          </div>
        ) : (
          <div className="space-y-4">
            <AnimatePresence>
              {filtered.map((alert, idx) => {
                const Icon = alert.icon;
                const cfg = severityConfig[alert.severity];
                return (
                  <motion.div key={alert.id} layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: alert.dismissed ? 0.55 : 1, y: 0 }} transition={{ delay: idx * 0.05 }}>
                    <Card className={cn("border-none shadow-lg shadow-slate-200/40 overflow-hidden transition-all hover:translate-y-[-2px]", alert.dismissed && "opacity-60")}>
                      <div className={cn("h-1 w-full", cfg.bg)} />
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <div className={cn("h-11 w-11 rounded-2xl flex items-center justify-center flex-shrink-0 text-white", cfg.bg)}><Icon className="h-5 w-5" /></div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h3 className="font-bold text-sm">{alert.title}</h3>
                                  <span className={cn("text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full", cfg.badge, cfg.badgeText)}>{severityLabels[alert.severity]}</span>
                                </div>
                              </div>
                              {!alert.dismissed && (<button onClick={() => dismiss(alert.id)} className="flex-shrink-0 h-6 w-6 rounded-full hover:bg-secondary flex items-center justify-center transition-colors"><XCircle className="h-4 w-4 text-muted-foreground/50" /></button>)}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed mb-3">{alert.message}</p>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {alert.amount && (<div className={cn("flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold", cfg.badge, cfg.badgeText)}><DollarSign className="h-3 w-3" />{alert.amount}</div>)}
                                <span className="text-[10px] text-muted-foreground font-medium">{alert.timestamp}</span>
                              </div>
                              {alert.actionLabel && !alert.dismissed && (<button className="flex items-center gap-1 text-[11px] font-bold text-primary hover:underline">{alert.actionLabel}<ChevronRight className="h-3 w-3" /></button>)}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="h-20 w-20 bg-slate-100 rounded-full flex items-center justify-center mb-6"><CheckCircle className="h-10 w-10 text-slate-300" /></div>
                <h2 className="text-lg font-bold">All clear!</h2>
                <p className="text-xs text-muted-foreground max-w-[200px] mt-2">No alerts in this category right now.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
