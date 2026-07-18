import { useState, useMemo, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Search, Utensils, Car, ShoppingBag, Tv, Zap, Home, Wallet, Pencil, Trash2, X, Check, Loader2, RefreshCw, Heart, BookOpen, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Link } from "react-router-dom";
import Layout from "@/components/Layout";
import { useApp, Transaction } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

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

type Filter = "Today" | "Week" | "Month" | "Year";
const filters: Filter[] = ["Today", "Week", "Month", "Year"];
const categories = ["Food", "Transport", "Shopping", "Entertainment", "Utilities", "Housing", "Income", "Healthcare", "Education"];

const periodMap: Record<Filter, string> = { Today: "today", Week: "week", Month: "month", Year: "year" };

export default function Transactions() {
  const { transactions, deleteTransaction, refetchTransactions, userId, backendOnline } = useApp();
  const [activeFilter, setActiveFilter] = useState<Filter>("Month");
  const [search, setSearch] = useState("");
  const [editTx, setEditTx] = useState<Transaction | null>(null);
  const [editForm, setEditForm] = useState({ title: "", amount: "", category: "", description: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ title: "", amount: "", category: "Food", description: "", type: "expense" as "expense" | "income" });
  const [adding, setAdding] = useState(false);

  // Fetch when filter changes (if backend available)
  const fetchForPeriod = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try { await refetchTransactions(); } catch (_) {}
    setLoading(false);
  }, [userId, refetchTransactions]);

  useEffect(() => { fetchForPeriod(); }, [activeFilter]);

  // Immediate refresh when voice assistant adds/deletes a transaction
  useEffect(() => {
    const h = () => fetchForPeriod();
    window.addEventListener("vox:data-updated", h);
    return () => window.removeEventListener("vox:data-updated", h);
  }, [fetchForPeriod]);

  const filtered = useMemo(() => {
    const byFilter = transactions.filter(tx => {
      if (activeFilter === "Today") return tx.filter === "Today";
      if (activeFilter === "Week") return tx.filter === "Today" || tx.filter === "Week";
      if (activeFilter === "Month") return tx.filter === "Today" || tx.filter === "Week" || tx.filter === "Month";
      return true;
    });
    if (!search.trim()) return byFilter;
    const q = search.toLowerCase();
    return byFilter.filter(tx => tx.title.toLowerCase().includes(q) || tx.category.toLowerCase().includes(q));
  }, [transactions, activeFilter, search]);

  const totalSpent = filtered.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalIncome = filtered.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);

  const openEdit = (tx: Transaction) => {
    setEditTx(tx);
    setEditForm({ title: tx.title, amount: String(Math.abs(tx.amount)), category: tx.category, description: tx.description || "" });
  };

  const saveEdit = async () => {
    if (!editTx) return;
    setSaving(true);
    if (userId) {
      try {
        const isExpense = editTx.amount < 0;
        const newAmount = isExpense ? -Math.abs(parseFloat(editForm.amount)) : Math.abs(parseFloat(editForm.amount));
        await api.updateTransaction(parseInt(editTx.id), userId, {
          title: editForm.title,
          amount: newAmount,
          category: editForm.category,
          description: editForm.description,
        });
        await refetchTransactions();
        setEditTx(null);
        setSaving(false);
        return;
      } catch (_) {}
    }
    // Local fallback
    deleteTransaction(editTx.id);
    setSaving(false);
    setEditTx(null);
  };

  const handleDelete = async (id: string) => {
    await deleteTransaction(id);
  };

  const handleAddTransaction = async () => {
    if (!addForm.title || !addForm.amount || !userId) return;
    setAdding(true);
    try {
      const amount = parseFloat(addForm.amount);
      if (isNaN(amount) || amount <= 0) { setAdding(false); return; }
      if (addForm.type === "expense") {
        await api.addExpense(userId, amount, addForm.category, addForm.description || addForm.title, addForm.title);
      } else {
        await api.addIncome(userId, amount, addForm.category || "Income", addForm.description || addForm.title, addForm.title);
      }
      await refetchTransactions();
      setAddOpen(false);
      setAddForm({ title: "", amount: "", category: "Food", description: "", type: "expense" });
    } catch (_) {}
    setAdding(false);
  };

  return (
    <Layout>
      <div className="mx-auto max-w-lg px-5 pt-8 pb-4">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/"><Button variant="ghost" size="icon" className="h-10 w-10 rounded-full border"><ChevronLeft className="h-6 w-6" /></Button></Link>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Transactions</h1>
            <p className="text-xs text-muted-foreground">{filtered.length} records</p>
          </div>
          <button onClick={fetchForPeriod} disabled={loading} className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/70 transition-colors">
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
          </button>
          <button onClick={() => setAddOpen(true)} className="h-10 w-10 rounded-2xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20 hover:bg-primary/90 transition-colors">
            <Plus className="h-5 w-5 text-white" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <Card className="border-none shadow-md shadow-emerald-100/60 rounded-2xl">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-semibold mb-1">Income</p>
              <p className="font-extrabold text-emerald-600 text-lg">+₹{totalIncome.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-md shadow-red-100/60 rounded-2xl">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-semibold mb-1">Expenses</p>
              <p className="font-extrabold text-red-500 text-lg">-₹{totalSpent.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
            </CardContent>
          </Card>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search transactions..." className="pl-10 h-11 rounded-2xl border-border/60 bg-secondary/30" />
          {search && (<button onClick={() => setSearch("")} className="absolute right-3.5 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>)}
        </div>

        <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
          {filters.map(f => (
            <button key={f} onClick={() => setActiveFilter(f)} className={cn("flex-shrink-0 px-5 py-2 rounded-full text-xs font-bold transition-all", activeFilter === f ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>{f}</button>
          ))}
        </div>

        <Card className="border-none shadow-lg shadow-slate-200/40 rounded-3xl">
          <CardContent className="p-2">
            <AnimatePresence>
              {loading && filtered.length === 0 ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              ) : filtered.length === 0 ? (
                <div className="py-16 text-center text-muted-foreground">
                  <p className="font-semibold">No transactions found</p>
                  <p className="text-xs mt-1">Try changing the filter or search term</p>
                </div>
              ) : (
                filtered.map((tx, i) => {
                  const cfg = categoryConfig[tx.category] || defaultConfig;
                  const Icon = cfg.icon;
                  return (
                    <motion.div key={tx.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ delay: i * 0.03 }} className={cn("flex items-center gap-4 px-4 py-3.5 group", i < filtered.length - 1 && "border-b border-border/40")}>
                      <div className={cn("h-10 w-10 rounded-2xl flex items-center justify-center flex-shrink-0", cfg.bg)}><Icon className={cn("h-5 w-5", cfg.color)} /></div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{tx.title}</p>
                        <p className="text-xs text-muted-foreground">{tx.date} · {tx.category}</p>
                      </div>
                      <p className={cn("font-bold text-sm mr-2", tx.amount > 0 ? "text-emerald-600" : "text-foreground")}>
                        {tx.amount > 0 ? "+" : ""}₹{Math.abs(tx.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </p>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(tx)} className="h-7 w-7 rounded-xl bg-secondary hover:bg-primary/10 flex items-center justify-center transition-colors"><Pencil className="h-3.5 w-3.5 text-muted-foreground" /></button>
                        <button onClick={() => handleDelete(tx.id)} className="h-7 w-7 rounded-xl bg-secondary hover:bg-red-100 flex items-center justify-center transition-colors"><Trash2 className="h-3.5 w-3.5 text-red-500" /></button>
                      </div>
                    </motion.div>
                  );
                })
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!editTx} onOpenChange={() => setEditTx(null)}>
        <DialogContent className="rounded-3xl max-w-sm mx-auto">
          <h2 className="font-bold text-lg mb-5">Edit Transaction</h2>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Title</Label>
              <Input value={editForm.title} onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))} className="h-11 rounded-2xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Amount (₹)</Label>
              <Input type="number" value={editForm.amount} onChange={e => setEditForm(p => ({ ...p, amount: e.target.value }))} className="h-11 rounded-2xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Category</Label>
              <select value={editForm.category} onChange={e => setEditForm(p => ({ ...p, category: e.target.value }))} className="w-full h-11 rounded-2xl border border-input bg-background px-3 text-sm">
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1 rounded-2xl" onClick={() => setEditTx(null)}>Cancel</Button>
            <Button className="flex-1 rounded-2xl" onClick={saveEdit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-2 h-4 w-4" /> Save</>}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="rounded-3xl max-w-sm mx-auto">
          <h2 className="font-bold text-lg mb-5">Add Transaction</h2>
          <div className="space-y-4">
            <div className="flex gap-2">
              {(["expense", "income"] as const).map(t => (
                <button key={t} onClick={() => setAddForm(p => ({ ...p, type: t, category: t === "income" ? "Income" : "Food" }))}
                  className={cn("flex-1 h-10 rounded-2xl text-sm font-bold capitalize transition-all", addForm.type === t ? "bg-primary text-white" : "bg-secondary text-muted-foreground")}>
                  {t}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Title / Description</Label>
              <Input value={addForm.title} onChange={e => setAddForm(p => ({ ...p, title: e.target.value }))} className="h-11 rounded-2xl" placeholder="e.g. Swiggy Order" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Amount (₹)</Label>
              <Input type="number" value={addForm.amount} onChange={e => setAddForm(p => ({ ...p, amount: e.target.value }))} className="h-11 rounded-2xl" placeholder="e.g. 450" />
            </div>
            {addForm.type === "expense" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Category</Label>
                <select value={addForm.category} onChange={e => setAddForm(p => ({ ...p, category: e.target.value }))} className="w-full h-11 rounded-2xl border border-input bg-background px-3 text-sm">
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1 rounded-2xl" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="flex-1 rounded-2xl" onClick={handleAddTransaction} disabled={adding || !addForm.title || !addForm.amount}>
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-2 h-4 w-4" /> Add</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
