"""
AI-powered intent resolver — v8.0

Replaces the rigid keyword-based parser with Claude AI for natural language understanding.
Handles:
  - Varied sentence structures and imperfect English
  - Indian English idioms and phrasing
  - Context-aware follow-up questions
  - Graceful fallback to keyword parser if API is unavailable

Only called when the keyword parser returns "unknown" or low-confidence results.
This keeps latency minimal for common well-formed commands.
"""
import json
import re
from typing import Optional, Dict, Any
import urllib.request
import urllib.error

# ── App-aware system prompt ───────────────────────────────────────────────────
SYSTEM_PROMPT = """You are Vox, an intelligent in-app voice assistant for VoxLedger — a personal finance application.

## App Features You Can Control
1. **Transactions**: Add income/expense, delete, update, show history
2. **Budget**: Set monthly budget, set per-category budgets, show remaining budget, delete a budget
3. **Spending Queries**: How much spent today/this week/this month/last month, per-category queries
4. **Navigation**: Open Dashboard, Transactions, Budget, Notifications, Alerts, Profile pages
5. **Notifications & Alerts**: Read, mark as read, list unread
6. **Settings**: Toggle dark mode
7. **Voice Profile**: Add voice sample, check voice sample count
8. **App Help**: Explain features, guide user

## Supported Categories
Food, Transport, Shopping, Entertainment, Utilities, Healthcare, Housing, Education, Income, Others
(Users can also create custom categories)

## Response Format
ALWAYS respond with valid JSON only. No extra text. Schema:
{
  "intent": "<intent_name>",
  "amount": <number or null>,
  "category": "<string or null>",
  "description": "<string or null>",
  "period": "<today|yesterday|week|last_week|month|last_month|year|all or null>",
  "page": "<route or null>",
  "query_kind": "<remaining_balance|remaining_budget|total_spending|category_remaining_budget or null>",
  "field": "<name|income|profile|voice_samples or null>",
  "value": "<on|off or null>",
  "tx_id": <number or null>,
  "tx_pos": <0-based index or -1 for last, or null>,
  "confidence": <0.0-1.0>,
  "response_hint": "<optional short friendly reply if intent cannot be fulfilled>"
}

## Valid Intents
- add_expense: User spent money
- add_income: User received money
- set_budget: Set a budget limit
- delete_budget: Remove a budget
- set_income: Set monthly income
- query_spending: Ask about spending/balance/budget
- show_transactions: Show transaction list
- query_transaction: Ask about a specific transaction by position
- query_transaction_count: How many transactions
- query_transactions_datetime: Find transaction by time/date
- query_insights: Overall financial insights
- navigate: Go to a page
- read_notifications: Read/list notifications
- read_alerts: Read/list alerts
- mark_notification_read: Mark notifications as read
- delete_transaction: Delete a transaction
- update_transaction: Update a transaction
- create_category: Create a new spending category
- add_voice_sample: Add voice profile sample
- dark_mode: Toggle dark/light mode
- greeting: Hello/hi
- help: Ask for help or what can the app do
- user_info: Ask about user profile
- stop: Stop speaking
- mute: Silence assistant output
- unmute: Resume assistant speaking
- off_topic: Not related to this app

## Examples
"I spent 500 on dinner" → add_expense, amount=500, category="Food"
"add three fifty for petrol" → add_expense, amount=350, category="Transport"
"what's my balance" → query_spending, query_kind="remaining_balance"
"how much did i spend this month" → query_spending, period="month"
"show last month food expenses" → query_spending, period="last_month", category="Food"
"go to budget page" → navigate, page="/budget"
"set food budget 2000" → set_budget, amount=2000, category="Food"
"delete my last transaction" → delete_transaction, tx_pos=-1
"mark all notifications read" → mark_notification_read
"what did I spend on medicines last week" → query_spending, category="Healthcare", period="last_week"
"tell me about my spending habits" → query_insights
"hey i got my salary" → add_income, category="Income"
"create a new category called gym" → create_category, description="Gym"
"turn on dark mode" → dark_mode, value="on"
"what is my balance" → query_spending, query_kind="remaining_balance"
"show my latest transaction" → query_transaction, tx_pos=-1
"read first alert" → read_alerts
"delete last transaction" → delete_transaction, tx_pos=-1
"what did I spend Monday" → query_transactions_datetime, period="yesterday"
"transactions from last week" → show_transactions, period="last_week"
"read second notification" → read_notifications
"mute yourself" → mute
"unmute" → unmute

## Important Rules
1. "stop" or "be quiet" → intent=stop
2. Anything unrelated to finance/app → intent=off_topic
3. Numbers in words: two hundred=200, five thousand=5000, one lakh=100000
4. If amount unclear, set amount=null (system will ask)
5. If category unclear, set category=null (system will ask)
6. period defaults: "today/yesterday/week/month/last week/last month" etc.
"""


def _call_claude_api(user_text: str, context_history: Optional[list] = None) -> Optional[Dict[str, Any]]:
    """Call Claude API to parse intent. Returns parsed dict or None on failure."""
    messages = []

    # Include up to 3 recent turns for context (without audio/embedding data)
    if context_history:
        for entry in context_history[-6:]:  # last 3 turns = 6 messages
            role = "user" if entry.get("role") == "user" else "assistant"
            content = entry.get("content", "")
            if content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_text})

    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",  # v11: uses Claude Haiku for fast intent parsing
        "max_tokens": 300,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            # API key injected by proxy layer in Claude artifacts environment
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            text = body.get("content", [{}])[0].get("text", "")
            # Strip markdown fences if present
            text = re.sub(r"^```json\s*|\s*```$", "", text.strip())
            parsed = json.loads(text)
            return parsed
    except Exception as e:
        print(f"[ai_intent] Claude API call failed: {e}")
        return None


def _normalize_amount(raw) -> Optional[float]:
    """Safely convert amount to float."""
    if raw is None:
        return None
    try:
        val = float(raw)
        return val if val > 0 else None
    except Exception:
        return None


def ai_parse_intent(
    user_text: str,
    context_history: Optional[list] = None,
    fallback_parser=None,
) -> Dict[str, Any]:
    """
    Try Claude AI intent parsing first.
    If unavailable or returns low confidence, fallback to keyword parser.

    Returns a dict compatible with parse_intent() output from intent_parser.py
    """
    if not user_text or not user_text.strip():
        return {"intent": "unknown", "raw_text": user_text}

    # Always try Claude API first
    ai_result = _call_claude_api(user_text, context_history)

    if ai_result and ai_result.get("confidence", 0) >= 0.45:
        intent = ai_result.get("intent", "unknown")
        amount = _normalize_amount(ai_result.get("amount"))

        result = {
            "intent": intent,
            "raw_text": user_text,
            "amount": amount,
            "category": ai_result.get("category"),
            "description": ai_result.get("description"),
            "period": ai_result.get("period") or "month",
            "query_kind": ai_result.get("query_kind"),
            "field": ai_result.get("field"),
            "value": ai_result.get("value"),
            "tx_id": ai_result.get("tx_id"),
            "tx_pos": ai_result.get("tx_pos"),
            "page": ai_result.get("page"),
            "_ai_confidence": ai_result.get("confidence", 1.0),
            "_ai_powered": True,
        }

        # Map page route correctly
        if intent == "navigate" and ai_result.get("page"):
            result["page"] = ai_result["page"]

        print(f"[ai_intent] AI parsed: intent={intent}, confidence={ai_result.get('confidence'):.2f}")
        return result

    # Fallback to keyword parser
    if fallback_parser:
        print(f"[ai_intent] Falling back to keyword parser for: {user_text!r}")
        return fallback_parser(user_text)

    return {"intent": "unknown", "raw_text": user_text}
