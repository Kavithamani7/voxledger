import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import * as api from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UserProfile {
  id?: number;
  name: string;
  email?: string;
  pin: string;
  voiceSamples: string[];
  registeredAt: string;
  voice_samples?: number;
}

export interface Transaction {
  id: string;
  title: string;
  amount: number;
  category: string;
  description?: string;
  date: string;
  filter: "Today" | "Week" | "Month" | "Year";
}

export interface ConversationMessage {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface AppContextType {
  user: UserProfile | null;
  userId: number | null;
  isAuthenticated: boolean;
  transactions: Transaction[];
  monthlyBudget: number;
  conversations: ConversationMessage[];
  isLoading: boolean;
  backendOnline: boolean;

  registerUser: (profile: UserProfile) => void;
  authenticateUser: (uid?: number) => void;
  lockApp: () => void;
  logout: () => void;
  setUserId: (id: number) => void;

  addTransaction: (tx: Omit<Transaction, "id">) => void;
  deleteTransaction: (id: string) => void;

  setMonthlyBudget: (amount: number) => void;

  addConversation: (msg: ConversationMessage) => void;
  clearConversations: () => void;

  refetchTransactions: () => void;
  refetchBudget: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLocalDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  // SQLite returns "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS" — no timezone.
  // Treat as local time by replacing space with T (if needed) but NOT adding Z.
  const normalized = dateStr.replace(" ", "T");
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function periodLabel(dateStr: string): "Today" | "Week" | "Month" | "Year" {
  if (!dateStr) return "Month";
  const d = parseLocalDate(dateStr);
  if (!d) return "Month";
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 1) return "Today";
  if (diffDays < 7) return "Week";
  if (diffDays < 31) return "Month";
  return "Year";
}

function apiTxToLocal(tx: api.ApiTransaction): Transaction {
  const dateStr = tx.created_at || tx.tx_date || "";
  const d = parseLocalDate(dateStr);
  let formatted = "Recent";
  if (d) {
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    const timeStr = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    if (diffDays < 0.5) {
      formatted = "Today, " + timeStr;
    } else if (diffDays < 1) {
      formatted = "Yesterday, " + timeStr;
    } else {
      formatted = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    }
  }
  return {
    id: String(tx.id),
    title: tx.title,
    amount: tx.amount,
    category: tx.category,
    description: tx.description,
    date: formatted,
    filter: periodLabel(dateStr),
  };
}

const WELCOME_MSG: ConversationMessage = {
  id: "welcome",
  type: "assistant",
  content: "Hi! I'm Vox, your personal finance assistant. How can I help you manage your money today?",
  timestamp: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
};

// ── Context ───────────────────────────────────────────────────────────────────

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(() => {
    try { const s = localStorage.getItem("voxledger_user"); return s ? JSON.parse(s) : null; } catch { return null; }
  });

  const [userId, setUserIdInternal] = useState<number | null>(() => {
    try { const s = localStorage.getItem("voxledger_user_id"); return s ? parseInt(s, 10) : null; } catch { return null; }
  });

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [monthlyBudget, setMonthlyBudgetState] = useState<number>(0);
  const [conversations, setConversations] = useState<ConversationMessage[]>([WELCOME_MSG]);
  const [isLoading, setIsLoading] = useState(false);
  // Start as true — assume backend is online, fail gracefully if not
  const [backendOnline, setBackendOnline] = useState(true);

  // ── Backend health check (non-blocking, optimistic) ────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch("/health", { signal: AbortSignal.timeout(3000) });
        setBackendOnline(r.ok);
      } catch {
        setBackendOnline(false);
      }
    };
    check();
    const iv = setInterval(check, 15000);
    return () => clearInterval(iv);
  }, []);

  // ── Data fetchers ───────────────────────────────────────────────────────────
  const refetchTransactions = useCallback(async () => {
    if (!userId || !isAuthenticated) return;
    try {
      const data = await api.getTransactions(userId, "year", undefined, undefined, 500);
      setTransactions(data.transactions.map(apiTxToLocal));
    } catch (e) {
      console.warn("Failed to fetch transactions:", e);
    }
  }, [userId, isAuthenticated]);

  const refetchBudget = useCallback(async () => {
    if (!userId || !isAuthenticated) return;
    try {
      const data = await api.getBudget(userId);
      setMonthlyBudgetState(data.monthly_budget);
    } catch (e) {
      console.warn("Failed to fetch budget:", e);
    }
  }, [userId, isAuthenticated]);

  const loadConversationHistory = useCallback(async () => {
    if (!userId || !isAuthenticated) return;
    try {
      const data = await api.getConversationHistory(userId);
      if (data.conversation.length > 0) {
        const msgs: ConversationMessage[] = data.conversation.map((m) => {
          const d = m.created_at ? parseLocalDate(m.created_at) : null;
          let timeStr = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
          if (d) {
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            if (isToday) {
              timeStr = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
            } else {
              // Show date + time for older messages
              timeStr = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                + ", " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
            }
          }
          return {
            id: String(m.id),
            type: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
            content: m.content,
            timestamp: timeStr,
          };
        });
        setConversations(msgs);
      }
    } catch (e) {
      console.warn("Failed to load conversation history:", e);
    }
  }, [userId, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && userId) {
      refetchTransactions();
      refetchBudget();
      loadConversationHistory();
    }
  }, [isAuthenticated, userId]);

  // ── Auth ────────────────────────────────────────────────────────────────────

  const registerUser = (profile: UserProfile) => {
    setUser(profile);
    localStorage.setItem("voxledger_user", JSON.stringify(profile));
    if (profile.id) {
      setUserIdInternal(profile.id);
      localStorage.setItem("voxledger_user_id", String(profile.id));
    }
  };

  const setUserId = (id: number) => {
    setUserIdInternal(id);
    localStorage.setItem("voxledger_user_id", String(id));
  };

  const authenticateUser = (uid?: number) => {
    setIsAuthenticated(true);
    if (uid) {
      setUserIdInternal(uid);
      localStorage.setItem("voxledger_user_id", String(uid));
    }
  };

  const lockApp = () => setIsAuthenticated(false);

  const logout = () => {
    setUser(null);
    setIsAuthenticated(false);
    setUserIdInternal(null);
    setTransactions([]);
    setConversations([WELCOME_MSG]);
    localStorage.removeItem("voxledger_user");
    localStorage.removeItem("voxledger_user_id");
    localStorage.removeItem("vox_setup_complete");
    localStorage.removeItem("vox_wake_phrase");
    localStorage.removeItem("vox_auth_mode");
    localStorage.removeItem("vox_dark_mode");
  };

  // ── Transactions ────────────────────────────────────────────────────────────

  const addTransaction = async (tx: Omit<Transaction, "id">) => {
    if (userId) {
      try {
        const isExpense = tx.amount < 0;
        if (isExpense) {
          await api.addExpense(userId, Math.abs(tx.amount), tx.category, tx.title, tx.title);
        } else {
          await api.addIncome(userId, tx.amount, tx.category || "Income", tx.title, tx.title);
        }
        await refetchTransactions();
        await refetchBudget();
        return;
      } catch (e) {
        console.warn("Backend addTransaction failed, using local fallback:", e);
      }
    }
    const newTx: Transaction = { ...tx, id: Date.now().toString() };
    setTransactions((prev) => [newTx, ...prev]);
  };

  const deleteTransaction = async (id: string) => {
    if (userId) {
      try {
        await api.deleteTransaction(parseInt(id), userId);
        setTransactions((prev) => prev.filter((t) => t.id !== id));
        await refetchBudget();
        return;
      } catch (e) {
        console.warn("Backend deleteTransaction failed, using local fallback:", e);
      }
    }
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  };

  // ── Budget ──────────────────────────────────────────────────────────────────

  const setMonthlyBudget = async (amount: number) => {
    setMonthlyBudgetState(amount);
    if (userId) {
      try { await api.setBudget(userId, "monthly", amount); } catch (e) { console.warn("Backend setBudget failed:", e); }
    }
  };

  // ── Conversations ───────────────────────────────────────────────────────────

  const addConversation = (msg: ConversationMessage) => setConversations((prev) => [...prev, msg]);
  const clearConversations = () => setConversations([WELCOME_MSG]);

  return (
    <AppContext.Provider
      value={{
        user, userId, isAuthenticated, transactions, monthlyBudget, conversations,
        isLoading, backendOnline, registerUser, authenticateUser, lockApp, logout, setUserId,
        addTransaction, deleteTransaction, setMonthlyBudget, addConversation, clearConversations,
        refetchTransactions, refetchBudget,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
