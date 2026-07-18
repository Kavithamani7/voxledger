import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, Pencil, Check, Utensils, Car, ShoppingBag, Tv, Zap, Target, Loader2, RefreshCw, Home, Heart, BookOpen, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Link } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

const categoryConfig: Record<string, { icon: any; color: string; bg: string }> = {
  Food: { icon: Utensils, color: "text-orange-500", bg: "bg-orange-100" },
  Transport: { icon: Car, color: "text-blue-500", bg: "bg-blue-100" },
  Shopping: { icon: ShoppingBag, color: "text-purple-500", bg: "bg-purple-100" },
  Utilities: { icon: Zap, color: "text-yellow-500", bg: "bg-yellow-100" },
  Entertainment: { icon: Tv, color: "text-pink-500", bg: "bg-pink-100" },
  Housing: { icon: Home, color: "text-green-500", bg: "bg-green-100" },
  Healthcare: { icon: Heart, color: "text-red-500", bg: "bg-red-100" },
  Education: { icon: BookOpen, color: "text-indigo-500", bg: "bg-indigo-100" },
  Others: { icon: MoreHorizontal, color: "text-slate-500", bg: "bg-slate-100" },
};

const stagger = { animate: { transition: { staggerChildren: 0.07 } } };
const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } };

export default function Budget() {
  const { userId, monthlyBudget, setMonthlyBudget, backendOnline } = useApp();
  const [editBudget, setEditBudget] = useState(false);
  const [tempBudget, setTempBudget] = useState(String(monthlyBudget));
  const [editCat, setEditCat] = useState<string | null>(null);
  const [tempCatBudget, setTempCatBudget] = useState("");
  const [budgetData, setBudgetData] = useState<api.BudgetSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchBudget = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const data = await api.getBudget(userId);
      setBudgetData(data);
    } catch (e) {
      console.warn("Failed to fetch budget:", e);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { fetchBudget(); }, [fetchBudget]);

  // Auto-refresh when voice assistant updates data
  useEffect(() => {
    const h = () => fetchBudget();
    window.addEventListener("vox:data-updated", h);
    return () => window.removeEventListener("vox:data-updated", h);
  }, [fetchBudget]);

  const totalSpent = budgetData?.total_spent ?? 0;
  const budget = budgetData?.monthly_budget ?? monthlyBudget;
  const budgetPct = budgetData?.used_pct ?? Math.min(100, Math.round((totalSpent / budget) * 100));
  const remaining = budgetData?.remaining ?? (budget - totalSpent);

  const saveBudget = async () => {
    const v = parseFloat(tempBudget);
    if (!isNaN(v) && v > 0) {
      setSaving(true);
      await setMonthlyBudget(v);
      await fetchBudget();
      setSaving(false);
    }
    setEditBudget(false);
  };

  const saveCatBudget = async () => {
    if (!editCat || !userId) return;
    const v = parseFloat(tempCatBudget);
    if (!isNaN(v) && v > 0 && backendOnline) {
      setSaving(true);
      try {
        await api.setBudget(userId, editCat, v);
        await fetchBudget();
      } catch (_) {}
      setSaving(false);
    }
    setEditCat(null);
  };

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-5 pt-8 pb-4">
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-5">
          <motion.div variants={fadeUp} className="flex items-center gap-4">
            <Link to="/"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
            <div className="flex-1"><h1 className="text-xl font-bold">Budget</h1><p className="text-xs text-muted-foreground">Manage your spending limits</p></div>
            <button onClick={fetchBudget} disabled={loading} className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/70 transition-colors">
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            </button>
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-xl shadow-primary/10 rounded-3xl overflow-hidden">
              <div className="bg-primary p-6">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-white/70 text-xs font-semibold uppercase tracking-wider">Monthly Budget</p>
                  <button onClick={() => { setTempBudget(String(budget)); setEditBudget(true); }} className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors">
                    <Pencil className="h-3.5 w-3.5 text-white" />
                  </button>
                </div>
                <h2 className="text-4xl font-extrabold text-white mb-5">₹{budget.toLocaleString("en-IN")}</h2>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-white/70">
                    <span>Spent: ₹{totalSpent.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                    <span>{budgetPct}% used</span>
                  </div>
                  <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${budgetPct}%` }} transition={{ duration: 0.8, ease: "easeOut" }}
                      className={cn("h-full rounded-full", budgetPct >= 90 ? "bg-red-400" : budgetPct >= 70 ? "bg-amber-400" : "bg-emerald-400")} />
                  </div>
                  <p className="text-white/80 text-sm font-semibold">
                    {remaining > 0 ? `₹${remaining.toLocaleString("en-IN", { maximumFractionDigits: 0 })} remaining` : `₹${Math.abs(remaining).toLocaleString("en-IN", { maximumFractionDigits: 0 })} over budget`}
                  </p>
                </div>
              </div>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp} className="grid grid-cols-3 gap-3">
            {[{ label: "Spent", value: totalSpent, color: "text-red-500" }, { label: "Remaining", value: Math.max(0, remaining), color: "text-emerald-600" }, { label: "Budget", value: budget, color: "text-primary" }].map(s => (
              <Card key={s.label} className="border-none shadow-md shadow-slate-200/40 rounded-2xl">
                <CardContent className="p-3 text-center">
                  <p className={cn("font-extrabold text-base", s.color)}>₹{s.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
                  <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide mt-0.5">{s.label}</p>
                </CardContent>
              </Card>
            ))}
          </motion.div>

          <motion.div variants={fadeUp}>
            <h3 className="font-bold text-sm mb-3">Category Budgets</h3>
            {loading && !budgetData ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
            ) : (
              <div className="space-y-3">
                {(budgetData?.categories.filter(c => c.category !== "monthly") ?? Object.keys(categoryConfig).map(cat => ({ category: cat, amount: cat === "Food" ? 600 : cat === "Transport" ? 300 : cat === "Shopping" ? 400 : 200, spent: 0, remaining: 0, used_pct: 0 }))).map(cat => {
                  const key = cat.category;
                  const cfg = categoryConfig[key] || categoryConfig["Food"];
                  const Icon = cfg?.icon || Utensils;
                  const pct = Math.min(100, cat.used_pct ?? 0);
                  const isOver = (cat.spent ?? 0) > cat.amount;
                  return (
                    <Card key={key} className="border-none shadow-md shadow-slate-200/40 rounded-2xl">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center flex-shrink-0", cfg?.bg || "bg-slate-100")}><Icon className={cn("h-5 w-5", cfg?.color || "text-slate-500")} /></div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-0.5">
                              <p className="font-semibold text-sm">{key}</p>
                              <button onClick={() => { setEditCat(key); setTempCatBudget(String(cat.amount)); }} className="h-6 w-6 rounded-lg bg-secondary hover:bg-primary/10 flex items-center justify-center transition-colors"><Pencil className="h-3 w-3 text-muted-foreground" /></button>
                            </div>
                            <p className="text-xs text-muted-foreground">₹{(cat.spent ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} / ₹{cat.amount.toLocaleString("en-IN")}</p>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Progress value={pct} className={cn("h-2 rounded-full", isOver ? "[&>div]:bg-red-500" : pct >= 70 ? "[&>div]:bg-amber-500" : "[&>div]:bg-emerald-500")} />
                          <div className="flex justify-between">
                            <p className={cn("text-[10px] font-semibold", isOver ? "text-red-500" : pct >= 70 ? "text-amber-600" : "text-emerald-600")}>{isOver ? "Over budget" : `${pct}% used`}</p>
                            <p className="text-[10px] text-muted-foreground">{isOver ? `-₹${((cat.spent ?? 0) - cat.amount).toFixed(0)} over` : `₹${(cat.amount - (cat.spent ?? 0)).toFixed(0)} left`}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card className="border-none shadow-md bg-primary/5 rounded-3xl">
              <CardContent className="p-5 flex gap-4 items-start">
                <div className="h-10 w-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0"><Target className="h-5 w-5 text-primary" /></div>
                <div>
                  <p className="font-bold text-sm mb-1">Budget Tip</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">Keep spending under 80% of each category budget to build savings and handle unexpected expenses.</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </motion.div>
      </div>

      <Dialog open={editBudget} onOpenChange={setEditBudget}>
        <DialogContent className="rounded-3xl max-w-sm mx-auto">
          <h2 className="font-bold text-lg mb-5">Edit Monthly Budget</h2>
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Amount (₹)</Label>
            <Input type="number" value={tempBudget} onChange={e => setTempBudget(e.target.value)} className="h-12 rounded-2xl text-lg font-bold" placeholder="e.g. 5000" />
          </div>
          <div className="flex gap-3 mt-5">
            <Button variant="outline" className="flex-1 rounded-2xl" onClick={() => setEditBudget(false)}>Cancel</Button>
            <Button className="flex-1 rounded-2xl" onClick={saveBudget} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-2 h-4 w-4" /> Save</>}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editCat} onOpenChange={() => setEditCat(null)}>
        <DialogContent className="rounded-3xl max-w-sm mx-auto">
          <h2 className="font-bold text-lg mb-5">Edit {editCat} Budget</h2>
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Limit (₹)</Label>
            <Input type="number" value={tempCatBudget} onChange={e => setTempCatBudget(e.target.value)} className="h-12 rounded-2xl text-lg font-bold" />
          </div>
          <div className="flex gap-3 mt-5">
            <Button variant="outline" className="flex-1 rounded-2xl" onClick={() => setEditCat(null)}>Cancel</Button>
            <Button className="flex-1 rounded-2xl" onClick={saveCatBudget} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-2 h-4 w-4" /> Save</>}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
