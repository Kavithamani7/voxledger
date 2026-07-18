import { useMemo, useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { TrendingUp, ShoppingBag, Utensils, Car, Zap, Tv, Home, Bell, ChevronRight, ArrowUpRight, ArrowDownRight, Wallet, Loader2, RefreshCw, Heart, BookOpen, MoreHorizontal, PiggyBank } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

// ── Donut chart colours (vibrant, distinct per category) ─────────────────────
const DONUT_COLORS: Record<string, string> = {
  Food:          "#f97316",   // orange-500
  Transport:     "#3b82f6",   // blue-500
  Shopping:      "#a855f7",   // purple-500
  Entertainment: "#ec4899",   // pink-500
  Utilities:     "#eab308",   // yellow-500
  Housing:       "#22c55e",   // green-500
  Healthcare:    "#ef4444",   // red-500
  Education:     "#6366f1",   // indigo-500
  Income:        "#10b981",   // emerald-500
  Others:        "#94a3b8",   // slate-400
};
const DONUT_FALLBACK_PALETTE = [
  "#f97316","#3b82f6","#a855f7","#ec4899",
  "#eab308","#22c55e","#ef4444","#6366f1",
];

// ── SVG Donut Chart ──────────────────────────────────────────────────────────
function DonutChart({ data, total }: { data: [string, number][]; total: number }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const SIZE   = 200;
  const STROKE = 36;
  const R      = (SIZE - STROKE) / 2;
  const CIRC   = 2 * Math.PI * R;
  const CX     = SIZE / 2;
  const CY     = SIZE / 2;

  // Build arc segments
  const segments = useMemo(() => {
    if (total <= 0) return [];
    let offset = 0; // start from top (stroke-dashoffset rotates)
    return data.map(([cat, amt], i) => {
      const pct  = amt / total;
      const dash = pct * CIRC;
      const seg  = { cat, amt, pct, dash, offset, color: DONUT_COLORS[cat] ?? DONUT_FALLBACK_PALETTE[i % DONUT_FALLBACK_PALETTE.length] };
      offset += dash;
      return seg;
    });
  }, [data, total]);

  // Active segment (hovered or first)
  const active = hovered ? segments.find(s => s.cat === hovered) : segments[0];

  return (
    <div className="flex flex-col items-center gap-5">
      {/* SVG ring */}
      <div className="relative flex items-center justify-center">
        <svg
          width={SIZE} height={SIZE}
          style={{ transform: "rotate(-90deg)" }}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
        >
          {/* Background ring */}
          <circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke="hsl(var(--secondary))"
            strokeWidth={STROKE}
          />
          {/* Segments */}
          {segments.map((seg) => (
            <circle
              key={seg.cat}
              cx={CX} cy={CY} r={R}
              fill="none"
              stroke={seg.color}
              strokeWidth={hovered === seg.cat ? STROKE + 5 : STROKE}
              strokeDasharray={`${seg.dash - 2} ${CIRC - seg.dash + 2}`}
              strokeDashoffset={-seg.offset}
              strokeLinecap="round"
              style={{
                cursor: "pointer",
                transition: "stroke-width 0.15s ease, opacity 0.15s ease",
                opacity: hovered && hovered !== seg.cat ? 0.55 : 1,
              }}
              onMouseEnter={() => setHovered(seg.cat)}
              onMouseLeave={() => setHovered(null)}
              onTouchStart={() => setHovered(seg.cat)}
            />
          ))}
        </svg>
        {/* Centre label */}
        <div className="absolute flex flex-col items-center justify-center select-none pointer-events-none">
          {active ? (
            <>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide leading-tight">
                {active.cat}
              </span>
              <span className="text-lg font-extrabold leading-tight">
                ₹{active.amt.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </span>
              <span className="text-[11px] text-muted-foreground font-medium">
                {Math.round(active.pct * 100)}%
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No data</span>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="w-full grid grid-cols-2 gap-x-4 gap-y-2">
        {segments.map((seg) => (
          <div
            key={seg.cat}
            className="flex items-center gap-2 cursor-pointer group"
            onMouseEnter={() => setHovered(seg.cat)}
            onMouseLeave={() => setHovered(null)}
            onTouchStart={() => setHovered(seg.cat)}
          >
            <span
              className="flex-shrink-0 h-2.5 w-2.5 rounded-full transition-transform group-hover:scale-125"
              style={{ background: seg.color }}
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate leading-tight">{seg.cat}</p>
              <p className="text-[10px] text-muted-foreground leading-tight">
                ₹{seg.amt.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · {Math.round(seg.pct * 100)}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


const categoryConfig: Record<string, { icon: any; color: string; bg: string }> = {
  Food: { icon: Utensils, color: "text-orange-500", bg: "bg-orange-100" },
  Transport: { icon: Car, color: "text-blue-500", bg: "bg-blue-100" },
  Shopping: { icon: ShoppingBag, color: "text-purple-500", bg: "bg-purple-100" },
  Entertainment: { icon: Tv, color: "text-pink-500", bg: "bg-pink-100" },
  Utilities: { icon: Zap, color: "text-yellow-500", bg: "bg-yellow-100" },
  Housing: { icon: Home, color: "text-green-500", bg: "bg-green-100" },
  Healthcare: { icon: Heart, color: "text-red-500", bg: "bg-red-100" },
  Education: { icon: BookOpen, color: "text-indigo-500", bg: "bg-indigo-100" },
  Others: { icon: MoreHorizontal, color: "text-slate-500", bg: "bg-slate-100" },
  Income: { icon: Wallet, color: "text-emerald-500", bg: "bg-emerald-100" },
};
const defaultConfig = { icon: MoreHorizontal, color: "text-slate-500", bg: "bg-slate-100" };

const stagger = { animate: { transition: { staggerChildren: 0.07 } } };
const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } };

export default function Index() {
  const navigate = useNavigate();
  const { user, transactions, monthlyBudget, userId, backendOnline, refetchTransactions } = useApp();
  const firstName = user?.name?.split(" ")[0] || "there";

  const [summary, setSummary] = useState<api.FinancialSummary | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchDashboardData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [summaryData, notifData] = await Promise.all([
        api.getFinancialSummary(userId, "month"),
        api.getNotifications(userId, true),
      ]);
      setSummary(summaryData);
      setUnreadCount(notifData.unread_count);
    } catch (e) {
      console.warn("Failed to fetch dashboard data:", e);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchDashboardData();
    // Auto-refresh every 30s
    const iv = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(iv);
  }, [fetchDashboardData]);

  // Immediate refresh when voice assistant updates data
  useEffect(() => {
    const h = () => fetchDashboardData();
    window.addEventListener("vox:data-updated", h);
    return () => window.removeEventListener("vox:data-updated", h);
  }, [fetchDashboardData]);

  // Use backend summary if available, else compute from local transactions
  const totalSpent = summary?.total_expenses ?? transactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalIncome = summary?.total_income ?? transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const budget = summary?.monthly_budget ?? monthlyBudget;
  const budgetPct = summary?.budget_used_pct ?? Math.min(100, Math.round((totalSpent / budget) * 100));
  const remaining = summary?.remaining_budget ?? (budget - totalSpent);

  const categorySpending = useMemo(() => {
    // Prefer summary category data from backend if available
    if (summary?.category_spending) {
      return Object.entries(summary.category_spending as Record<string, number>)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        ;
    }
    const monthTxs = transactions.filter(t => t.filter === "Month" || t.filter === "Week" || t.filter === "Today");
    const cats: Record<string, number> = {};
    monthTxs.filter(t => t.amount < 0).forEach(t => { cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount); });
    return Object.entries(cats).sort((a, b) => b[1] - a[1]);
  }, [transactions, summary]);

  const recentTxs = transactions.slice(0, 5);

  const now = new Date();
  const hour = now.getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-5 pt-8 pb-4">
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-5">

          {/* Header */}
          <motion.div variants={fadeUp} className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm text-muted-foreground font-medium">{timeGreeting} 👋</p>
              <h1 className="text-2xl font-extrabold tracking-tight">{firstName}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={fetchDashboardData} disabled={loading} className="h-9 w-9 rounded-xl bg-secondary flex items-center justify-center hover:bg-secondary/70 transition-colors">
                {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
              </button>
              <button onClick={() => navigate("/notifications")} className="h-11 w-11 rounded-2xl bg-secondary flex items-center justify-center relative hover:bg-secondary/70 transition-colors">
                <Bell className="h-5 w-5 text-foreground" />
                {unreadCount > 0 && <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-destructive" />}
              </button>
            </div>
          </motion.div>

          {/* Balance card */}
          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-xl shadow-primary/10 rounded-3xl overflow-hidden">
              <div className="bg-primary px-6 pt-6 pb-7">
                <p className="text-white/70 text-xs font-semibold uppercase tracking-wider mb-1">Remaining Balance</p>
                <h2 className="text-4xl font-extrabold text-white mb-4">
                  ₹{Math.max(0, totalIncome - totalSpent).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white/15 backdrop-blur-sm rounded-2xl p-3">
                    <div className="flex items-center gap-1.5 mb-1"><ArrowUpRight className="h-3.5 w-3.5 text-emerald-300" /><span className="text-white/70 text-[10px] font-semibold uppercase tracking-wider">Monthly Income</span></div>
                    <p className="text-white font-bold text-base">₹{totalIncome.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
                  </div>
                  <div className="bg-white/15 backdrop-blur-sm rounded-2xl p-3">
                    <div className="flex items-center gap-1.5 mb-1"><ArrowDownRight className="h-3.5 w-3.5 text-red-300" /><span className="text-white/70 text-[10px] font-semibold uppercase tracking-wider">Total Spent</span></div>
                    <p className="text-white font-bold text-base">₹{totalSpent.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
                  </div>
                </div>
                {/* Savings indicator */}
                {totalIncome > 0 && (
                  <div className="mt-3 bg-white/10 rounded-2xl px-4 py-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <PiggyBank className="h-4 w-4 text-emerald-300" />
                      <span className="text-white/80 text-xs font-semibold">Savings Rate</span>
                    </div>
                    <span className={cn("text-sm font-bold", totalIncome > totalSpent ? "text-emerald-300" : "text-red-300")}>
                      {totalIncome > totalSpent
                        ? `${Math.round(((totalIncome - totalSpent) / totalIncome) * 100)}% saved`
                        : "Over budget"}
                    </span>
                  </div>
                )}
              </div>
            </Card>
          </motion.div>

          {/* Budget progress */}
          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-lg shadow-slate-200/40 rounded-3xl">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Monthly Budget</p>
                    <p className="font-bold text-base mt-0.5">
                      ₹{totalSpent.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      <span className="text-muted-foreground font-normal text-sm"> / ₹{budget.toLocaleString("en-IN")}</span>
                    </p>
                  </div>
                  <div className={cn("h-12 w-12 rounded-2xl flex items-center justify-center", budgetPct >= 90 ? "bg-red-100" : budgetPct >= 70 ? "bg-amber-100" : "bg-emerald-100")}>
                    <p className={cn("text-sm font-extrabold", budgetPct >= 90 ? "text-red-600" : budgetPct >= 70 ? "text-amber-600" : "text-emerald-600")}>{budgetPct}%</p>
                  </div>
                </div>
                <Progress value={budgetPct} className={cn("h-2.5 rounded-full", budgetPct >= 90 ? "[&>div]:bg-red-500" : budgetPct >= 70 ? "[&>div]:bg-amber-500" : "[&>div]:bg-emerald-500")} />
                <p className="text-xs text-muted-foreground mt-2">{remaining > 0 ? `₹${remaining.toLocaleString("en-IN", { maximumFractionDigits: 0 })} remaining` : "Budget exceeded!"}</p>
              </CardContent>
            </Card>
          </motion.div>

          {/* Category Analytics — Donut Chart (replaces the old card grid) */}
          {categorySpending.length > 0 && (
            <motion.div variants={fadeUp}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">Spending Analytics</h3>
                <button onClick={() => navigate("/budget")} className="text-xs text-primary font-semibold flex items-center gap-0.5">Budget <ChevronRight className="h-3.5 w-3.5" /></button>
              </div>
              <Card className="border-none shadow-lg shadow-slate-200/40 rounded-3xl">
                <CardContent className="p-5">
                  <DonutChart data={categorySpending} total={totalSpent} />
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Recent transactions */}
          <motion.div variants={fadeUp}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">Recent Transactions</h3>
              <button onClick={() => navigate("/transactions")} className="text-xs text-primary font-semibold flex items-center gap-0.5">See all <ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
            <Card className="border-none shadow-lg shadow-slate-200/40 rounded-3xl">
              <CardContent className="p-2">
                {recentTxs.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground text-sm">
                    <p>No transactions yet.</p>
                    <p className="text-xs mt-1">Add your first expense via Vox!</p>
                  </div>
                ) : (
                  recentTxs.map((tx, i) => {
                    const cfg = categoryConfig[tx.category] || defaultConfig;
                    const Icon = cfg.icon;
                    return (
                      <div key={tx.id} className={cn("flex items-center gap-4 px-4 py-3.5", i < recentTxs.length - 1 && "border-b border-border/40")}>
                        <div className={cn("h-10 w-10 rounded-2xl flex items-center justify-center flex-shrink-0", cfg.bg)}><Icon className={cn("h-5 w-5", cfg.color)} /></div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate">{tx.title}</p>
                          <p className="text-xs text-muted-foreground">{tx.date}</p>
                        </div>
                        <div className="flex flex-col items-end">
                          <p className={cn("font-bold text-sm", tx.amount > 0 ? "text-emerald-600" : "text-foreground")}>
                            {tx.amount > 0 ? "+" : ""}₹{Math.abs(tx.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </p>
                          <span className="text-[10px] text-muted-foreground">{tx.category}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Budget alert */}
          {budgetPct >= 80 && (
            <motion.div variants={fadeUp}>
              <Card className="border-none shadow-lg shadow-amber-200/40 rounded-3xl overflow-hidden">
                <div className="h-1 bg-amber-500 w-full" />
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-2xl bg-amber-100 flex items-center justify-center flex-shrink-0"><TrendingUp className="h-5 w-5 text-amber-600" /></div>
                  <div className="flex-1">
                    <p className="font-bold text-sm">Budget Alert</p>
                    <p className="text-xs text-muted-foreground">{budgetPct >= 90 ? "Critical: Budget nearly exhausted" : "80% of monthly budget used"}</p>
                  </div>
                  <button onClick={() => navigate("/budget")} className="text-xs text-primary font-bold flex items-center gap-0.5">Review <ChevronRight className="h-3.5 w-3.5" /></button>
                </CardContent>
              </Card>
            </motion.div>
          )}

        </motion.div>
      </div>
    </Layout>
  );
}
