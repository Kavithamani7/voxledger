/**
 * VoxLedger API Service
 * All calls to the FastAPI backend (http://localhost:8000)
 */

export const BASE_URL = "";  // Vite proxies all backend routes to localhost:8000

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Network error" }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface CheckUserResponse {
  registered: boolean;
  user_id?: number;
  user_name?: string;
  has_user?: boolean;
  has_voice_profile?: boolean;
}

export async function checkUser(): Promise<CheckUserResponse> {
  return request("/check-user");
}

export async function registerUser(name: string, password: string) {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("password", password);
  return request<{ success: boolean; user_id: number; user_name: string }>("/register", {
    method: "POST",
    body: fd,
  });
}

export async function uploadVoiceSample(userId: number, audioBlob: Blob) {
  const fd = new FormData();
  fd.append("user_id", String(userId));
  fd.append("voice_sample", audioBlob, "sample.wav");
  return request<{
    success: boolean;
    message: string;
    samples_registered: number;
    max_samples: number;
    registration_complete: boolean;
  }>("/register/voice-sample", { method: "POST", body: fd });
}

export async function verifyVoice(audioBlob: Blob) {
  const fd = new FormData();
  fd.append("voice_sample", audioBlob, "verify.wav");
  return request<{
    authenticated: boolean;
    user_id: number;
    user_name: string;
    similarity_score: number;
    message: string;
  }>("/verify-voice", { method: "POST", body: fd });
}

export async function login(userId: number, password: string) {
  const fd = new FormData();
  fd.append("user_id", String(userId));
  fd.append("password", password);
  return request<{ success: boolean; user_id: number; user_name: string }>("/login", {
    method: "POST",
    body: fd,
  });
}

export async function getUser(userId: number) {
  return request<{ id: number; name: string; created_at: string; voice_samples: number }>(
    `/user/${userId}`
  );
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export interface ApiTransaction {
  id: number;
  user_id: number;
  title: string;
  amount: number;
  category: string;
  description: string;
  tx_date: string;
  created_at: string;
}

export interface FinancialSummary {
  total_income: number;
  total_expenses: number;
  net_balance: number;
  monthly_budget: number;
  remaining_budget: number;
  budget_used_pct: number;
  top_category: string;
  transaction_count: number;
  period: string;
  monthly_income?: number;
  category_spending?: Record<string, number>;
}

export async function addExpense(
  userId: number,
  amount: number,
  category: string,
  description: string,
  title?: string
) {
  return request<{ success: boolean; transaction: ApiTransaction; summary: FinancialSummary }>(
    "/transactions/add-expense",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, amount, category, description, title }),
    }
  );
}

export async function addIncome(
  userId: number,
  amount: number,
  category: string,
  description: string,
  title?: string
) {
  return request<{ success: boolean; transaction: ApiTransaction; summary: FinancialSummary }>(
    "/transactions/add-income",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, amount, category: category || "Income", description, title }),
    }
  );
}

export async function getTransactions(
  userId: number,
  period = "month",
  category?: string,
  search?: string,
  limit = 100
) {
  const params = new URLSearchParams({ user_id: String(userId), period, limit: String(limit) });
  if (category) params.append("category", category);
  if (search) params.append("search", search);
  return request<{ transactions: ApiTransaction[]; count: number; period: string }>(
    `/transactions?${params}`
  );
}

export async function getFinancialSummary(userId: number, period = "month") {
  return request<FinancialSummary>(
    `/transactions/summary?user_id=${userId}&period=${period}`
  );
}

export async function updateTransaction(
  txId: number,
  userId: number,
  data: Partial<ApiTransaction>
) {
  return request<{ success: boolean; transaction: ApiTransaction }>(
    `/transactions/${txId}?user_id=${userId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
}

export async function deleteTransaction(txId: number, userId: number) {
  return request<{ success: boolean }>(`/transactions/${txId}?user_id=${userId}`, {
    method: "DELETE",
  });
}

// ─── Budget ───────────────────────────────────────────────────────────────────

export interface BudgetCategory {
  id: number;
  user_id: number;
  category: string;
  amount: number;
  month: string;
  spent: number;
  remaining: number;
  used_pct: number;
}

export interface BudgetSummary {
  month: string;
  monthly_budget: number;
  total_spent: number;
  remaining: number;
  used_pct: number;
  categories: BudgetCategory[];
}

export async function getBudget(userId: number, month?: string) {
  const params = new URLSearchParams({ user_id: String(userId) });
  if (month) params.append("month", month);
  return request<BudgetSummary>(`/budget?${params}`);
}

export async function setBudget(userId: number, category: string, amount: number, month?: string) {
  return request<{ success: boolean }>("/budget/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, category, amount, month }),
  });
}

export async function initDefaultBudgets(userId: number, monthlyTotal = 2500) {
  return request<{ success: boolean }>(`/budget/init-defaults?user_id=${userId}&monthly_total=${monthlyTotal}`, {
    method: "POST",
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────

export interface ApiNotification {
  id: number;
  user_id: number;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
}

export async function getNotifications(userId: number, unreadOnly = false) {
  return request<{ notifications: ApiNotification[]; count: number; unread_count: number }>(
    `/notifications?user_id=${userId}&unread_only=${unreadOnly}`
  );
}

export async function markNotificationsRead(userId: number, ids?: number[]) {
  if (!ids || ids.length === 0) {
    return request<{ success: boolean }>(`/notifications/mark-all-read?user_id=${userId}`, {
      method: "POST",
    });
  }
  return request<{ success: boolean }>(`/notifications/mark-read?user_id=${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notification_ids: ids }),
  });
}

// ─── Voice ────────────────────────────────────────────────────────────────────

export interface VoiceCommandResponse {
  success: boolean;
  transcribed_text?: string;
  input_text?: string;
  tts_audio_url?: string;
  intent: string;
  response_text: string;
  action_result: {
    navigate_to?: string;
    transaction?: ApiTransaction;
    summary?: FinancialSummary;
    transactions?: ApiTransaction[];
    notifications?: ApiNotification[];
    budget_set?: number;
    updated_balance?: number;
    stop_tts?: boolean;
    refresh?: boolean;
    ignored?: boolean;
    deleted_id?: number;
    unread_count?: number;
    dark_mode?: boolean;
  };
}

export async function sendTextCommand(userId: number, text: string): Promise<VoiceCommandResponse> {
  const fd = new FormData();
  fd.append("user_id", String(userId));
  fd.append("text", text);
  return request("/voice/text-command", { method: "POST", body: fd });
}

export async function sendVoiceCommand(
  userId: number,
  audioBlob: Blob,
  language = "en",
  requireWakePhrase = false
): Promise<VoiceCommandResponse> {
  const fd = new FormData();
  fd.append("user_id", String(userId));
  fd.append("audio", audioBlob, "command.wav");
  fd.append("language", language);
  fd.append("tts", "true");   // always request TTS URL from backend
  fd.append("require_wake_phrase", String(requireWakePhrase));
  return request("/voice/voice-command", { method: "POST", body: fd });
}

export async function getConversationHistory(userId: number, limit = 50) {
  return request<{ conversation: Array<{ id: number; role: string; content: string; created_at: string }>; count: number }>(
    `/voice/conversation-history?user_id=${userId}&limit=${limit}`
  );
}

export function getTtsUrl(text: string) {
  return `${BASE_URL}/voice/tts?text=${encodeURIComponent(text.slice(0, 800))}`;
}

// ─── Voice Registration ───────────────────────────────────────────────────────

export async function extractNameFromVoice(audioBlob: Blob): Promise<{
  success: boolean;
  name: string | null;
  transcribed_text: string;
  message: string;
}> {
  const fd = new FormData();
  fd.append("voice_sample", audioBlob, "name.webm");
  return request("/extract-name-from-voice", { method: "POST", body: fd });
}

// ─── Income ───────────────────────────────────────────────────────────────────

export async function setMonthlyIncome(userId: number, amount: number) {
  const fd = new FormData();
  fd.append("user_id", String(userId));
  fd.append("amount", String(amount));
  return request<{ success: boolean; monthly_income: number; summary: FinancialSummary }>(
    "/voice/set-income", { method: "POST", body: fd }
  );
}

export async function getMonthlyIncome(userId: number) {
  return request<{ user_id: number; monthly_income: number }>(
    `/voice/monthly-income?user_id=${userId}`
  );
}
