"""
Voice command processing routes — v12.0 TRUE VOICE-FIRST ASSISTANT

Key changes in v12.0:
  - Positional alert reading: first/second/last/latest alert
  - Context-aware greeting: includes today's spend summary
  - Comprehensive help response covering all features
  - Working state support for frontend action execution feedback
  - All v11.0 features preserved and enhanced
"""
from fastapi import APIRouter, UploadFile, File, Form, Query, HTTPException
from fastapi.responses import StreamingResponse
from typing import Optional
from urllib.parse import quote
from services.voice_auth_service import analyze_audio_quality, _extract_embedding, _cosine_similarity, get_voice_sample_count
import io
import re
import time
from datetime import datetime

# ── Terminal colour helpers ───────────────────────────────────────────────────
_R  = "\033[0m"
_BD = "\033[1m"
_CY = "\033[96m"
_GN = "\033[92m"
_YL = "\033[93m"
_MG = "\033[95m"
_RD = "\033[91m"
_DM = "\033[2m"
_BL = "\033[94m"
_WH = "\033[97m"

def _sep():
    print(f"\n{_DM}{'─' * 70}{_R}")

def _log(label: str, value: str, colour: str = _WH):
    pad = max(1, 14 - len(label))
    print(f"{colour}{_BD}  {label}{_R}{' ' * pad}: {value}")

def _log_timing(label: str, ms: float, warn_ms: float = 1500):
    c = _RD if ms > warn_ms else _YL
    _log(label, f"{ms:.0f} ms", c)

# ── Service imports ───────────────────────────────────────────────────────────
from services.whisper_service import transcribe_audio
from services.tts_service import text_to_speech
from services.finance_service import (
    add_transaction, get_transactions, get_financial_summary, get_notifications,
    get_conversation_history, save_conversation, set_budget, set_monthly_income,
    get_monthly_income, delete_transaction as svc_delete_transaction,
    delete_budget as svc_delete_budget,
    update_transaction as svc_update_transaction, get_budgets,
    mark_notifications_read,
)
from services.conversation_service import (
    get_pending, save_pending, clear_pending, extract_category_from_reply,
)
from utils.intent_parser import parse_intent, detect_category
from utils.ai_intent import ai_parse_intent
from utils.date_parser import current_month, get_date_range

router = APIRouter(tags=["Voice"])

# ── Wake-phrase patterns ──────────────────────────────────────────────────────
WAKE_PHRASE_PATTERNS = [
    r'\bhey\s*vox\b', r'\bhi\s*vox\b', r'\bok\s*vox\b',
    r'\bokay\s*vox\b', r'\bhello\s*vox\b', r'\bvox\b',
]
STOP_PATTERNS = [
    # "stop" = cancel current speech ONLY, returns to listening
    r'\b(stop|enough|that\'s enough|thats enough|no more|shush|shhh)\b',
]
MUTE_PATTERNS = [
    # "mute" = silence ALL future speech until "unmute" — actions still run
    r'\b(mute\s+assistant|mute\s+vox|go\s+silent|be\s+quiet|quiet\s+please|mute\s+yourself|please\s+be\s+quiet)\b',
]

def _is_mute(text: str) -> bool:
    """True if the text is a mute command (silence future TTS, keep processing)."""
    lower = text.lower().strip()
    return any(re.search(p, lower, re.IGNORECASE) for p in MUTE_PATTERNS)

UNMUTE_PATTERNS = [
    r'\b(unmute|un-mute|unmute\s+assistant|unmute\s+vox|resume\s+speaking|speak\s+again|voice\s+on|start\s+speaking)\b',
]

def _is_unmute(text: str) -> bool:
    """True if the text is an unmute command."""
    lower = text.lower().strip()
    return any(re.search(p, lower, re.IGNORECASE) for p in UNMUTE_PATTERNS)

def _looks_like_valid_app_command(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t or len(t) < 3:
        return False
    if _is_stop(t) or _is_mute(t) or _has_wake(t):
        return True

    app_keywords = {
        "expense", "expenses", "spent", "spend", "income", "budget", "transaction", "transactions",
        "notification", "notifications", "alert", "alerts", "profile", "finance", "money", "balance",
        "summary", "history", "today", "week", "month", "year", "category", "categories", "add",
        "set", "show", "open", "go", "navigate", "delete", "remove", "read", "how much", "spent on",
        "budget for", "monthly", "salary", "income", "save", "create category", "dark", "theme",
        "voice sample", "voice profile", "voice authentication", "mark all read", "mark as read",
        "unread", "conversation", "dashboard",
        # v8: additional natural language phrases
        "what did i", "what have i", "how many", "give me", "tell me", "check my",
        "my balance", "my budget", "my expenses", "my transactions", "my income",
        "last month", "last week", "this month", "this week", "yesterday",
        "rupees", "rupee", "inr", "₹", "lakh", "thousand",
    }
    return any(k in t for k in app_keywords)


BREAKING_INTENTS = {
    "navigate", "delete_transaction", "query_spending", "stop", "help",
    "greeting", "set_budget", "set_income", "show_transactions",
    "read_notifications", "read_alerts", "off_topic", "create_category",
    "dark_mode", "user_info", "query_transaction", "query_transactions_datetime", "delete_budget",
    "add_voice_sample", "query_transaction_count", "mark_notification_read", "query_insights",
    # v11: mute/unmute as breaking intents so they always fire
    "mute", "unmute",
}


def _has_wake(text: str) -> bool:
    lower = text.lower().strip()
    return any(re.search(p, lower, re.IGNORECASE) for p in WAKE_PHRASE_PATTERNS)

def _is_stop(text: str) -> bool:
    lower = text.lower().strip()
    return any(re.search(p, lower, re.IGNORECASE) for p in STOP_PATTERNS)

def _strip_wake(text: str) -> str:
    cleaned = re.sub(
        r'^(hey\s*vox[,.]?\s*|hi\s*vox[,.]?\s*|ok\s*vox[,.]?\s*|okay\s*vox[,.]?\s*|hello\s*vox[,.]?\s*|vox[,.]?\s+)',
        '', text, flags=re.IGNORECASE
    ).strip()
    return cleaned if cleaned else text


# ── Pending-intent slot resolver ──────────────────────────────────────────────

def _resolve_pending(user_id: int, user_text: str) -> Optional[dict]:
    pending = get_pending(user_id)
    if not pending:
        return None

    step   = pending["step"]
    intent = pending["intent"]

    if step == "awaiting_category":
        category = extract_category_from_reply(user_text)
        if not category:
            category = _resolve_category_from_text(user_id, user_text)
        if not category:
            # Build hint including custom categories
            _extra_hint = []
            try:
                _budgets_hint = get_budgets(user_id)
                _builtin_h    = {"food","transport","shopping","entertainment",
                                 "utilities","healthcare","housing","education","income","others","monthly"}
                _extra_hint   = [b["category"] for b in _budgets_hint
                                  if b["category"].lower() not in _builtin_h]
            except Exception:
                pass
            _base = "Food, Transport, Shopping, Entertainment, Utilities, Healthcare, Housing, or Education"
            _hint = _base + (", or " + ", ".join(_extra_hint) if _extra_hint else "")
            return {
                "intent": intent,
                "response_text": f"I didn't catch that category. Please say one of: {_hint}.",
                "action_result": {},
                "keep_pending": True,
            }
        amount      = pending["amount"]
        description = pending.get("description") or category.lower()
        clear_pending(user_id)

        if intent == "add_expense":
            result = add_transaction(user_id=user_id, title=description.capitalize(),
                                     amount=-abs(amount), category=category, description=description)
            s = result["summary"]
            return {"intent": "add_expense",
                    "response_text": f"Done! ₹{amount:.0f} added under {category}. {_format_remaining_budget(s)}",
                    "action_result": {"transaction": result["transaction"], "summary": s}}
        elif intent == "add_income":
            result = add_transaction(user_id=user_id, title=description.capitalize(),
                                     amount=abs(amount), category=category, description=description)
            s = result["summary"]
            return {"intent": "add_income",
                    "response_text": f"Income of ₹{amount:.0f} recorded under {category}. Balance: ₹{s['net_balance']:.0f}.",
                    "action_result": {"transaction": result["transaction"], "summary": s}}

    elif step == "awaiting_amount":
        from utils.intent_parser import extract_amount
        amount = extract_amount(user_text)
        if not amount:
            return {
                "intent": intent,
                "response_text": "I didn't catch the amount. Please say the amount, like '200 rupees' or 'three hundred'.",
                "action_result": {},
                "keep_pending": True,
            }
        category    = pending.get("category") or "Others"
        description = pending.get("description") or category.lower()
        clear_pending(user_id)

        if intent == "add_expense":
            result = add_transaction(user_id=user_id, title=description.capitalize(),
                                     amount=-abs(amount), category=category, description=description)
            s = result["summary"]
            return {"intent": "add_expense",
                    "response_text": f"Done! ₹{amount:.0f} added under {category}. {_format_remaining_budget(s)}",
                    "action_result": {"transaction": result["transaction"], "summary": s}}
        elif intent == "add_income":
            result = add_transaction(user_id=user_id, title=description.capitalize(),
                                     amount=abs(amount), category=category, description=description)
            s = result["summary"]
            return {"intent": "add_income",
                    "response_text": f"Income of ₹{amount:.0f} recorded. Balance: ₹{s['net_balance']:.0f}.",
                    "action_result": {"transaction": result["transaction"], "summary": s}}
        elif intent == "set_budget":
            set_budget(user_id, "monthly", amount)
            return {"intent": "set_budget",
                    "response_text": f"Monthly budget set to ₹{amount:.0f}.",
                    "action_result": {"budget_set": amount, "refresh": True}}
        elif intent == "set_income":
            set_monthly_income(user_id, amount)
            s = get_financial_summary(user_id, "month")
            return {"intent": "set_income",
                    "response_text": f"Income set to ₹{amount:.0f}. Balance: ₹{s['net_balance']:.0f}.",
                    "action_result": {"summary": s, "refresh": True}}

    elif step == "awaiting_category_name":
        # User is responding with the new category name
        raw_name = user_text.strip()
        # Strip filler words that Whisper might prepend
        import re as _re_cn
        raw_name = _re_cn.sub(
            r'^(its?|call it|name it|called|name is|name|'
            r'please call it|ok|okay|sure|yes|yeah)\s+',
            '', raw_name, flags=_re_cn.IGNORECASE
        ).strip()
        raw_name = _re_cn.sub(r'[.!?]+$', '', raw_name).strip()
        if not raw_name or len(raw_name) < 2:
            return {
                "intent": "create_category",
                "response_text": "I didn't catch the name. Please say the category name, like 'Skincare' or 'Gym'.",
                "action_result": {},
                "keep_pending": True,
            }
        cat_name = raw_name.title()
        clear_pending(user_id)
        set_budget(user_id, cat_name, 0.0)
        return {
            "intent": "create_category",
            "response_text": (
                f"Category '{cat_name}' has been created successfully. "
                f"You can now log expenses under it by saying 'Add [amount] for {cat_name}'."
            ),
            "action_result": {"refresh": True, "category_created": cat_name},
        }

    clear_pending(user_id)
    return None


# ── Period label helper ───────────────────────────────────────────────────────

def _period_label(period: str) -> str:
    labels = {
        "today": "today", "yesterday": "yesterday",
        "week": "this week", "this_week": "this week", "last_week": "last week",
        "month": "this month", "this_month": "this month", "last_month": "last month",
        "year": "this year", "this_year": "this year", "last_year": "last year",
    }
    return labels.get(period, period)


# ── Custom-category matcher ──────────────────────────────────────────────────

def _match_custom_category(user_id: int, text: str) -> Optional[str]:
    """
    Check if any word/phrase in 'text' matches a user-defined budget category.
    Returns the canonical category name if found, else None.
    Built-in categories are already handled by detect_category(); this only
    checks categories the user created themselves (i.e. not in CATEGORY_KEYWORDS).
    """
    BUILTIN = {
        "food", "transport", "shopping", "entertainment",
        "utilities", "healthcare", "housing", "education", "income", "others",
    }
    try:
        budgets = get_budgets(user_id)
        text_lower = text.lower()
        for b in budgets:
            cat = b["category"]
            if cat.lower() in BUILTIN:
                continue  # already handled by static detect_category
            if cat.lower() in text_lower:
                return cat
            # Also check plural / minor variants (e.g. "skincare" matches "Skincare")
            import re as _re_cc
            if _re_cc.search(r'\b' + re.escape(cat.lower()) + r'\b', text_lower):
                return cat
    except Exception as _e:
        print(f"[custom_category] lookup error: {_e}")
    return None


def _match_known_category_exact(user_id: int, text: str) -> Optional[str]:
    """Case-insensitive exact category matcher across default + user-created categories."""
    raw = (text or "").strip().lower()
    if not raw:
        return None

    candidates = []
    builtins = [
        "Food", "Transport", "Shopping", "Entertainment",
        "Utilities", "Healthcare", "Housing", "Education", "Income", "Others"
    ]
    candidates.extend(builtins)
    try:
        for b in get_budgets(user_id):
            cat = b.get("category")
            if cat and cat not in candidates:
                candidates.append(cat)
    except Exception:
        pass

    for cat in candidates:
        if raw == cat.lower():
            return cat

    for cat in candidates:
        if re.search(r'\b' + re.escape(cat.lower()) + r'\b', raw):
            return cat

    return None


def _transactions_oldest_first(user_id: int, category: Optional[str] = None, limit: int = 500):
    """Return transactions in chronological order: oldest first."""
    txs = get_transactions(user_id, period="all", category=category, limit=limit)
    txs.sort(key=lambda t: ((t.get("tx_date") or ""), (t.get("created_at") or ""), t.get("id") or 0))
    return txs


def _resolve_category_from_text(user_id: int, text: str) -> Optional[str]:
    text = (text or "").strip()
    if not text:
        return None

    exact = _match_known_category_exact(user_id, text)
    if exact:
        return exact

    lower = text.lower()
    phrase_patterns = [
        r'\b(?:for|on|in|under|towards?)\s+([a-z][a-z ]{1,40})\b',
        r'\bcategory\s+([a-z][a-z ]{1,40})\b',
    ]
    for pat in phrase_patterns:
        for m in re.finditer(pat, lower, re.IGNORECASE):
            phrase = m.group(1).strip(' .!?')
            exact = _match_known_category_exact(user_id, phrase)
            if exact:
                return exact

    exact = _match_custom_category(user_id, text)
    if exact:
        return exact

    builtin = detect_category(lower)
    return builtin if builtin != "Others" else None




def _requires_strict_voice_auth(intent_name: str) -> bool:
    return intent_name in {
        "delete_transaction", "delete_budget", "set_budget", "set_income",
        "add_expense", "add_income", "update_transaction",
        "mark_notification_read", "create_category", "add_voice_sample",
    }


def _pending_delete_target(user_id: int, intent_data: dict):
    tx_id    = intent_data.get("tx_id")
    raw      = intent_data.get("raw_text", "").lower()
    del_cat  = intent_data.get("category")
    tx_pos   = intent_data.get("tx_pos")
    if not del_cat:
        del_cat = _match_custom_category(user_id, raw)

    if tx_id:
        all_txs = get_transactions(user_id, period="all", limit=500)
        target = next((t for t in all_txs if t.get("id") == tx_id), None)
        return target

    if del_cat:
        cat_txs = _transactions_oldest_first(user_id, category=del_cat, limit=500)
        if not cat_txs:
            return None
        if tx_pos == -1:
            return cat_txs[-1]
        target_index = 0 if tx_pos is None else tx_pos
        return cat_txs[target_index] if 0 <= target_index < len(cat_txs) else None

    txs_display = _transactions_oldest_first(user_id, limit=500)
    if not txs_display:
        return None
    if tx_pos is None:
        _fallback = [
            ("first",  0), ("second", 1), ("third",  2), ("fourth", 3), ("fifth",  4),
            ("1st",    0), ("2nd",    1), ("3rd",    2), ("4th",    3), ("5th",    4),
            ("one",    0), ("two",    1), ("three",  2), ("four",   3), ("five",   4),
            ("last",  -1), ("latest", -1), ("recent", -1), ("newest", -1),
            ("oldest",  0),
        ]
        for _fw, _fi in _fallback:
            if re.search(r'\b' + re.escape(_fw) + r'\b', raw):
                tx_pos = _fi
                break
    if tx_pos == -1:
        return txs_display[-1]
    target_index = 0 if tx_pos is None else tx_pos
    return txs_display[target_index] if 0 <= target_index < len(txs_display) else None


def _format_remaining_budget(summary: dict) -> str:
    remaining = float((summary or {}).get("remaining_budget", 0) or 0)
    if remaining >= 0:
        return f"You have ₹{remaining:.0f} left in your budget."
    return f"You are over budget by ₹{abs(remaining):.0f}."

def _describe_transaction(tx: dict) -> str:
    if not tx:
        return "that transaction"
    amt = abs(tx.get("amount", 0))
    title = tx.get("title") or tx.get("category") or "transaction"
    cat = tx.get("category") or ""
    cat_part = f" under {cat}" if cat and cat.lower() not in (title or "").lower() else ""
    return f"₹{amt:.0f} for {title}{cat_part}"

# ── Intent executor ───────────────────────────────────────────────────────────

def _execute_intent(user_id: int, intent_data: dict) -> dict:
    intent        = intent_data.get("intent", "unknown")
    response_text = ""
    action_result = {}

    # ── Stop ────────────────────────────────────────────────
    if intent == "stop":
        clear_pending(user_id)
        response_text = ""
        action_result = {"stop_tts": True}

    # ── Off-topic — FIX v7: respond politely instead of silently ignoring ────
    elif intent == "off_topic":
        clear_pending(user_id)
        import random
        off_topic_replies = [
            "I'm VoxLedger, your finance assistant. I can help you track expenses, check your balance, manage budgets, or view transactions. Try saying 'What's my balance' or 'Add expense'.",
            "That's outside what I can help with. I specialise in personal finance — try asking about your spending, budget, or transactions.",
            "I'm not able to help with that, but I can assist with your finances. Say 'Show my transactions', 'What did I spend today', or 'Set budget' to get started.",
            "I didn't quite understand that. I can help you add expenses, check your balance, view budgets, or navigate the app. What would you like to do?",
        ]
        response_text = random.choice(off_topic_replies)
        action_result = {"ignored": True}

    # ── Create category ──────────────────────────────────────
    elif intent == "create_category":
        clear_pending(user_id)
        cat_name = intent_data.get("description")
        if cat_name:
            # Capitalise properly
            cat_name = cat_name.strip().title()
            # Insert as a ₹0 budget category so it shows up immediately in DB/UI
            set_budget(user_id, cat_name, 0.0)
            response_text = (
                f"'{cat_name}' has been added as a new category. "
                f"You can log expenses under it or set its budget by saying "
                f"'Set {cat_name} budget to [amount]'."
            )
            action_result = {"refresh": True, "category_created": cat_name}
        else:
            response_text = "What should I name the new category? Just say the name."
            save_pending(user_id, "create_category", None, None, None, step="awaiting_category_name")

    # ── Add voice sample / voice profile ─────────────────────
    elif intent == "add_voice_sample":
        clear_pending(user_id)
        response_text = "Opening Add Voice Sample. You can record another secure voice sample there."
        action_result = {"navigate_to": "/add-voice-profile", "start_voice_recording": True}

    # ── Add expense ──────────────────────────────────────────
    elif intent == "add_expense":
        from utils.intent_parser import extract_amount as _extract_amt_again
        amount      = intent_data.get("amount")
        raw_text    = intent_data.get("raw_text", "")
        reparsed_amount = _extract_amt_again(raw_text) if raw_text else None
        if reparsed_amount and (amount is None or reparsed_amount > amount):
            amount = reparsed_amount
        category    = intent_data.get("category")
        description = intent_data.get("description", "expense")

        if not amount:
            cat_hint = f" for {description}" if description and description not in ("expense", "Others") else ""
            response_text = f"Sure! How much did you spend{cat_hint}?"
            save_pending(user_id, "add_expense", None, category, description, step="awaiting_amount")
        elif not category or category == "Others":
            # Try to match against user-created custom categories before asking
            raw_text = intent_data.get("raw_text", "")
            resolved_category = _resolve_category_from_text(user_id, raw_text) or _resolve_category_from_text(user_id, description)
            if resolved_category:
                category = resolved_category
                clear_pending(user_id)
                result = add_transaction(
                    user_id=user_id,
                    title=intent_data.get("title", description.capitalize()),
                    amount=-abs(amount),
                    category=category,
                    description=description,
                )
                s = result["summary"]
                response_text = f"Got it! ₹{amount:.0f} logged under {category}. {_format_remaining_budget(s)}"
                action_result = {"transaction": result["transaction"], "summary": s,
                                 "updated_balance": s["net_balance"]}
            else:
                # Build category list including user's custom categories
                _extra_cats = []
                try:
                    _all_budgets = get_budgets(user_id)
                    _builtin     = {"food","transport","shopping","entertainment",
                                    "utilities","healthcare","housing","education","income","others","monthly"}
                    _extra_cats  = [b["category"] for b in _all_budgets
                                    if b["category"].lower() not in _builtin]
                except Exception:
                    pass
                _cat_list = "Food, Transport, Shopping, Entertainment, Utilities, Healthcare, Housing, or Education"
                if _extra_cats:
                    _cat_list += ", or " + ", ".join(_extra_cats)
                response_text = (
                    f"Got it, ₹{amount:.0f}. Which category should I file that under? "
                    f"{_cat_list}?"
                )
                save_pending(user_id, "add_expense", amount, None, description, step="awaiting_category")
        else:
            clear_pending(user_id)
            result = add_transaction(
                user_id=user_id,
                title=intent_data.get("title", description.capitalize()),
                amount=-abs(amount),
                category=category,
                description=description,
            )
            s = result["summary"]
            response_text = f"Got it! ₹{amount:.0f} logged under {category}. {_format_remaining_budget(s)}"
            action_result = {"transaction": result["transaction"], "summary": s,
                             "updated_balance": s["net_balance"]}

    # ── Add income ───────────────────────────────────────────
    elif intent == "add_income":
        amount      = intent_data.get("amount")
        category    = intent_data.get("category", "Income")
        description = intent_data.get("description", "income")

        if not amount:
            response_text = "How much did you receive? Just say the amount."
            save_pending(user_id, "add_income", None, category, description, step="awaiting_amount")
        else:
            clear_pending(user_id)
            result = add_transaction(
                user_id=user_id,
                title=intent_data.get("title", description.capitalize()),
                amount=abs(amount),
                category=category,
                description=description,
            )
            s = result["summary"]
            response_text = (
                f"₹{amount:.0f} has been recorded as income. "
                f"Your current balance is ₹{s['net_balance']:.0f}."
            )
            action_result = {"transaction": result["transaction"], "summary": s,
                             "updated_balance": s["net_balance"]}

    # ── Delete transaction ───────────────────────────────────
    elif intent == "delete_transaction":
        raw = intent_data.get("raw_text", "").lower()

        # Step 1: explicit confirmation for destructive actions
        if not re.search(r"\b(confirm|yes|delete it|confirm delete)\b", raw):
            target = _pending_delete_target(user_id, intent_data)
            if not target:
                clear_pending(user_id)
                response_text = "I couldn't identify which transaction to delete. Please say something like 'Delete first transaction' or 'Delete transaction number 3'."
            else:
                clear_pending(user_id)
                save_pending(user_id, "delete_transaction", float(target.get("id", 0)), target.get("category"), target.get("title"), step="awaiting_delete_confirmation")
                response_text = f"Please confirm deletion of {_describe_transaction(target)}. Say 'confirm delete' to continue."
                action_result = {"navigate_to": "/transactions"}
        else:
            pending = get_pending(user_id)
            if not pending or pending.get("intent") != "delete_transaction" or pending.get("step") != "awaiting_delete_confirmation":
                clear_pending(user_id)
                response_text = "There is no pending delete request to confirm."
            else:
                tx_id = int(float(pending.get("amount") or 0))
                title = pending.get("description") or "transaction"
                ok = svc_delete_transaction(tx_id, user_id) if tx_id else False
                clear_pending(user_id)
                if ok:
                    response_text = f"Confirmed. Your transaction for {title} has been deleted."
                    action_result = {"deleted_id": tx_id, "refresh": True}
                else:
                    response_text = "I wasn't able to delete that transaction. Please try again."

    # ── Update transaction ───────────────────────────────────
    elif intent == "update_transaction":
        clear_pending(user_id)
        tx_id        = intent_data.get("tx_id")
        new_amount   = intent_data.get("amount")
        new_category = intent_data.get("category")

        if tx_id and (new_amount or new_category):
            fields = {}
            if new_amount:   fields["amount"]   = -abs(new_amount)
            if new_category: fields["category"] = new_category
            updated = svc_update_transaction(tx_id, user_id, fields)
            if updated:
                response_text = f"Transaction {tx_id} has been updated."
                action_result = {"transaction": updated, "refresh": True}
            else:
                response_text = f"I couldn't find transaction {tx_id}. Could you check the number?"
        else:
            response_text = (
                "To update a transaction, try something like "
                "'Update transaction 5 to 300 rupees' or 'Change last expense to food'."
            )

    # ── Query transactions by time / date ───────────────────
    elif intent == "query_transactions_datetime":
        clear_pending(user_id)
        time_str = intent_data.get("time_str")  # e.g. "9:36 pm"
        date_str = intent_data.get("date_str")  # e.g. "march 5"
        period   = intent_data.get("period", "all")

        # Fetch all transactions in a broad window
        txs_all = get_transactions(user_id, period="all", limit=500)

        matched = []

        if time_str:
            # Parse the time (12-hour or 24-hour) and find transactions with matching created_at
            import re as _re
            _clean_t = time_str.strip().lower().replace(" ", "")
            # Normalise to HH:MM 24h for comparison
            _am_pm = "am" if "am" in _clean_t else ("pm" if "pm" in _clean_t else None)
            _digits = _re.sub(r"[apm]", "", _clean_t).strip().replace('.', ':')  # e.g. "9:36" or "9.36"
            try:
                _parts = _digits.split(":")
                _h, _m = int(_parts[0]), (int(_parts[1]) if len(_parts) > 1 else 0)
                if _am_pm == "pm" and _h != 12:
                    _h += 12
                elif _am_pm == "am" and _h == 12:
                    _h = 0
                _time_match = f"{_h:02d}:{_m:02d}"
                for tx in txs_all:
                    ca = tx.get("created_at", "")
                    # created_at format: "YYYY-MM-DDTHH:MM:SS"
                    if "T" in ca:
                        _tx_time = ca.split("T")[1][:5]  # "HH:MM"
                        if _tx_time == _time_match:
                            matched.append(tx)
            except Exception as _te:
                print(f"[datetime_query] time parse error: {_te}")

        elif date_str:
            # Map month names to numbers
            _MONTH_MAP = {
                "jan": 1, "january": 1, "feb": 2, "february": 2,
                "mar": 3, "march": 3,  "apr": 4, "april": 4,
                "may": 5, "jun": 6,    "june": 6,
                "jul": 7, "july": 7,   "aug": 8, "august": 8,
                "sep": 9, "september": 9, "oct": 10, "october": 10,
                "nov": 11, "november": 11, "dec": 12, "december": 12,
            }
            import re as _re2
            from datetime import datetime as _dt2
            _ds = date_str.lower().strip()
            _month_num = None
            _day_num   = None
            # Try "Month Day" (march 5) or "Day Month" (5th march)
            _m1 = _re2.search(
                r'(january|february|march|april|may|june|july|august|september|october|november|december|'
                r'jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})', _ds)
            _m2 = _re2.search(
                r'(\d{1,2})(?:st|nd|rd|th)?\s+'
                r'(january|february|march|april|may|june|july|august|september|october|november|december|'
                r'jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)', _ds)
            # Numeric: dd/mm or mm/dd
            _m3 = _re2.search(r'(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?', _ds)
            if _m1:
                _month_num = _MONTH_MAP.get(_m1.group(1).lower())
                _day_num   = int(_m1.group(2))
            elif _m2:
                _day_num   = int(_m2.group(1))
                _month_num = _MONTH_MAP.get(_m2.group(2).lower())
            elif _m3:
                # Assume DD/MM for Indian users
                _day_num   = int(_m3.group(1))
                _month_num = int(_m3.group(2))

            if _month_num and _day_num:
                _year = _dt2.now().year
                _target_date = f"{_year}-{_month_num:02d}-{_day_num:02d}"
                matched = [tx for tx in txs_all if tx.get("tx_date", "") == _target_date]

        # Use period-based filtering if no time/date, or as fallback
        if not time_str and not date_str:
            matched = get_transactions(user_id, period=period, limit=100)

        if not matched:
            if time_str:
                response_text = f"I couldn't find any transaction recorded at {time_str}."
            elif date_str:
                response_text = f"I couldn't find any transactions on {date_str.title()}."
            else:
                response_text = "No transactions found for that time period."
        elif len(matched) == 1:
            tx  = matched[0]
            amt = abs(tx["amount"])
            cat = tx.get("category", "")
            dt  = tx.get("tx_date_friendly") or tx.get("tx_date", "")
            ca  = tx.get("created_at", "")
            time_part = ""
            if "T" in ca:
                _raw_time = ca.split("T")[1][:5]
                _hh, _mm  = int(_raw_time[:2]), int(_raw_time[3:5])
                _suffix   = "AM" if _hh < 12 else "PM"
                _hh12     = _hh % 12 or 12
                time_part = f" at {_hh12}:{_mm:02d} {_suffix}"
            response_text = (
                f"On {dt}{time_part}: ₹{amt:.0f} for {tx['title']} under {cat}."
            )
        else:
            total = sum(abs(t["amount"]) for t in matched if t["amount"] < 0)
            label = date_str.title() if date_str else (time_str or period)
            details = "; ".join(
                f"₹{abs(t['amount']):.0f} for {t['title']}"
                for t in matched[:5]
            )
            more = f" (and {len(matched)-5} more)" if len(matched) > 5 else ""
            response_text = (
                f"Found {len(matched)} transactions on {label} — "
                f"total spent: ₹{total:.0f}. {details}{more}."
            )
        action_result = {"transactions": matched}

    # ── Query transaction by position ───────────────────────
    elif intent == "query_transaction":
        clear_pending(user_id)
        tx_pos     = intent_data.get("tx_pos")        # 0-based oldest-first; -1 = newest
        raw_lower  = intent_data.get("raw_text", "").lower()
        is_expense = bool(re.search(r"\bexpense[s]?\b", raw_lower))

        # Fetch all, reverse to oldest-first for natural positional indexing
        txs_desc = get_transactions(user_id, period="all", limit=500)
        txs_asc  = list(reversed(txs_desc))

        # Filter to expenses-only if the user said "expense", else all transactions
        if is_expense:
            pool = [t for t in txs_asc if t["amount"] < 0]
            noun = "expense"
        else:
            pool = txs_asc
            noun = "transaction"

        if not pool:
            response_text = f"You do not have any recorded {noun}s yet."
        else:
            _pos_labels = {0: "first", 1: "second", 2: "third", 3: "fourth", 4: "fifth", -1: "most recent"}
            idx = tx_pos if tx_pos is not None else -1   # default to most recent
            try:
                target    = pool[idx]
                label     = _pos_labels.get(idx, f"#{idx + 1}")
                amt       = abs(target["amount"])
                title     = target.get("title", noun.capitalize())
                cat       = target.get("category", "")
                date_str  = target.get("tx_date_friendly", target.get("tx_date", ""))
                cat_part  = f" under {cat}" if cat and cat not in ("Others", title) else ""
                date_part = f", recorded on {date_str}" if date_str else ""
                response_text = f"Your {label} {noun} was ₹{amt:.0f} for {title}{cat_part}{date_part}."
            except IndexError:
                count = len(pool)
                response_text = (
                    f"You only have {count} {noun}{'s' if count != 1 else ''}, "
                    f"so that position doesn't exist."
                )
        action_result = {}

    # ── Query transaction count ─────────────────────────────
    elif intent == "query_transaction_count":
        clear_pending(user_id)
        period = intent_data.get("period", "month")
        period_lbl = _period_label(period)
        txs = get_transactions(user_id, period=period, limit=500)
        count = len(txs)
        response_text = f"You have {count} transaction{'s' if count != 1 else ''} {period_lbl}."
        action_result = {"transactions": txs, "navigate_to": "/transactions"}

    # ── Query spending ───────────────────────────────────────
    elif intent == "query_spending":
        clear_pending(user_id)
        period   = intent_data.get("period", "month")
        category = intent_data.get("category")  # may be None for overall

        query_kind = intent_data.get("query_kind")

        if category and query_kind not in ("category_remaining_budget",):
            # Category-specific spending query
            txs = get_transactions(user_id, period=period, category=category, limit=200)
            total = sum(abs(t["amount"]) for t in txs if t["amount"] < 0)
            period_lbl = _period_label(period)
            if total == 0:
                response_text = f"You haven't spent anything on {category} {period_lbl}."
            else:
                tx_count = len([t for t in txs if t["amount"] < 0])
                response_text = f"You have spent ₹{total:.0f} on {category} {period_lbl}."
            action_result = {"transactions": txs}
        else:
            summary     = get_financial_summary(user_id, period)
            spent       = summary["total_expenses"]
            budget      = summary["monthly_budget"]
            remaining   = summary["remaining_budget"]
            pct         = summary["budget_used_pct"]
            top_cat     = summary.get("top_category") or ""
            income      = summary.get("monthly_income", 0)
            net_balance = summary.get("net_balance", income - spent)
            period_lbl  = _period_label(period)

            if query_kind in ("remaining_balance", "remaining_income"):
                response_text = f"Your remaining balance is ₹{net_balance:.0f}."
            elif query_kind == "remaining_budget":
                response_text = f"Your remaining budget is ₹{remaining:.0f}."
            elif query_kind == "category_remaining_budget":
                resolved_category = category or _resolve_category_from_text(user_id, intent_data.get("raw_text", ""))
                if resolved_category:
                    budgets = get_budgets(user_id)
                    match = next((b for b in budgets if b.get("category", "").lower() == resolved_category.lower()), None)
                    if match:
                        response_text = f"Your remaining budget for {match['category']} is ₹{match['remaining']:.0f}."
                    else:
                        response_text = f"You don't have a budget set for {resolved_category}."
                else:
                    response_text = "Please tell me which category budget you want to check."
            elif query_kind == "total_spending":
                response_text = f"You have spent ₹{spent:.0f} {period_lbl}."
            else:
                response_text = (
                    f"{period_lbl.capitalize()}, you earned ₹{income:.0f} and spent ₹{spent:.0f}. "
                )
                if budget > 0:
                    response_text += f"That's {pct:.0f}% of your ₹{budget:.0f} budget, with ₹{remaining:.0f} still available. "
                if top_cat:
                    response_text += f"Your biggest spend is in {top_cat}."
            action_result = {"summary": summary}

    # ── Show transactions ────────────────────────────────────
    elif intent == "show_transactions":
        clear_pending(user_id)
        period     = intent_data.get("period", "month")
        period_lbl = _period_label(period)
        txs        = get_transactions(user_id, period=period, limit=5)
        if not txs:
            response_text = f"No transactions found {period_lbl}."
        else:
            total_txs = get_transactions(user_id, period=period, limit=500)
            response_text = f"You have {len(total_txs)} transaction{'s' if len(total_txs) != 1 else ''} {period_lbl}. "
            for tx in txs[:3]:
                amt  = abs(tx["amount"])
                sign = "+" if tx["amount"] > 0 else "-"
                response_text += f"{sign}₹{amt:.0f} for {tx['title']} under {tx.get('category', 'Others')}. "
            if len(total_txs) > 3:
                response_text += f"And {len(total_txs) - 3} more."
        action_result = {"transactions": txs, "navigate_to": "/transactions"}

    # ── Mark notifications as read ────────────────────────────
    elif intent == "mark_notification_read":
        clear_pending(user_id)
        mark_notifications_read(user_id)
        response_text = "All notifications have been marked as read."
        action_result = {"refresh": True, "notifications_marked_read": True, "navigate_to": "/notifications"}

    # ── Read alerts ──────────────────────────────────────────
    elif intent == "read_alerts":
        clear_pending(user_id)
        alerts = get_notifications(user_id, unread_only=False)
        raw = intent_data.get("raw_text", "").lower()

        # Filter by type if requested
        if re.search(r"\bcritical\b", raw):
            alerts = [a for a in alerts if (a.get("type") or a.get("notif_type") or "info").lower() == "critical"]
            bucket = "critical alerts"
        elif re.search(r"\bwarning|warnings\b", raw):
            alerts = [a for a in alerts if (a.get("type") or a.get("notif_type") or "info").lower() == "warning"]
            bucket = "warning alerts"
        elif re.search(r"\b(info|informational)\b", raw):
            alerts = [a for a in alerts if (a.get("type") or a.get("notif_type") or "info").lower() == "info"]
            bucket = "informational alerts"
        else:
            alerts = [a for a in alerts if (a.get("type") or a.get("notif_type") or "info").lower() in {"critical", "warning", "info"}]
            bucket = "alerts"

        # Positional reading: first / second / third / last / latest
        ordinal_map = {
            "first": 0, "1st": 0, "one": 0,
            "second": 1, "2nd": 1, "two": 1,
            "third": 2, "3rd": 2, "three": 2,
            "fourth": 3, "4th": 3, "four": 3,
            "fifth": 4, "5th": 4, "five": 4,
            "last": -1, "latest": -1, "recent": -1, "newest": -1,
            "earliest": 0, "oldest": 0,
        }
        specific_idx = None
        for word, idx in ordinal_map.items():
            if re.search(r'\b' + re.escape(word) + r'\b', raw):
                specific_idx = idx
                break

        alert_count = len(alerts)
        if alert_count == 0:
            response_text = f"You have no {bucket} right now."
        elif specific_idx is not None:
            try:
                a = alerts[specific_idx]
                ordinal_label = {0: "first", 1: "second", 2: "third", 3: "fourth", 4: "fifth", -1: "latest"}.get(specific_idx, "selected")
                kind = (a.get("type") or a.get("notif_type") or "info").capitalize()
                response_text = f"Your {ordinal_label} {bucket[:-1] if bucket.endswith('s') else bucket}: {kind}. {a['title']}. {a['message']}"
            except IndexError:
                response_text = f"You only have {alert_count} {bucket}."
        else:
            response_text = f"You have {alert_count} {bucket[:-1] if alert_count == 1 else bucket}. "
            for a in alerts[:3]:
                kind = (a.get("type") or a.get("notif_type") or "info").capitalize()
                response_text += f"{kind}: {a['title']}. {a['message']} "
            if alert_count > 3:
                response_text += f"And {alert_count - 3} more. Say 'read second alert' for a specific one."
        action_result = {"navigate_to": "/alerts", "notifications": alerts}

    # ── Read notifications ───────────────────────────────────
    elif intent == "read_notifications":
        clear_pending(user_id)
        raw = intent_data.get("raw_text", "").lower()
        notifs = get_notifications(user_id, unread_only=False)
        unread = [n for n in notifs if not n.get("is_read", False)]
        unread_only_requested = bool(re.search(r"\bunread\b", raw))
        source = unread if unread_only_requested else (unread if unread else notifs)
        unread_count = len(unread)

        ordinal_map = {
            "first": 0, "1st": 0, "one": 0,
            "second": 1, "2nd": 1, "two": 1,
            "third": 2, "3rd": 2, "three": 2,
            "fourth": 3, "4th": 3, "four": 3,
            "fifth": 4, "5th": 4, "five": 4,
            "last": -1,
        }
        specific_idx = None
        for word, idx in ordinal_map.items():
            if re.search(r'\b' + re.escape(word) + r'\b', raw):
                specific_idx = idx
                break

        if not notifs:
            response_text = "You have no notifications at the moment."
        elif specific_idx is not None:
            try:
                n = source[specific_idx]
                ordinal_label = {0: "first", 1: "second", 2: "third", 3: "fourth", 4: "fifth", -1: "last"}.get(specific_idx, "selected")
                response_text = f"Your {ordinal_label} notification. {n['title']}. {n['message']}"
            except IndexError:
                response_text = f"You only have {len(source)} notification{'s' if len(source) != 1 else ''} available to read."
        else:
            parts = []
            if unread_count > 0:
                parts.append(f"You have {unread_count} unread notification{'s' if unread_count != 1 else ''}.")
            else:
                parts.append(f"You have {len(notifs)} notification{'s' if len(notifs) != 1 else ''}.")

            for i, n in enumerate(source, start=1):
                parts.append(f"Notification {i}. {n['title']}. {n['message']}")

            response_text = " ".join(parts)
        action_result = {"notifications": notifs, "unread_count": unread_count, "navigate_to": "/notifications"}

    # ── Dark mode ────────────────────────────────────────────
    elif intent == "dark_mode":
        clear_pending(user_id)
        value = intent_data.get("value", "on")
        if value == "on":
            response_text = "Dark mode is on. Easy on the eyes!"
            action_result = {"dark_mode": True, "refresh": False}
        else:
            response_text = "Switched to light mode."
            action_result = {"dark_mode": False, "refresh": False}

    # ── Insights ─────────────────────────────────────────────
    elif intent == "query_insights":
        clear_pending(user_id)
        period = intent_data.get("period") or "month"
        s = get_financial_summary(user_id, period)
        top = s.get("top_category") or "no category yet"
        spent = float(s.get("total_expenses", 0) or 0)
        income = float(s.get("total_income", 0) or 0)
        budget = float(s.get("monthly_budget", 0) or 0)
        tx_count = int(s.get("transaction_count", 0) or 0)
        if tx_count == 0:
            response_text = f"I don't have enough data for insights {period}. Start by logging a few expenses."
        else:
            if budget > 0:
                response_text = f"Your insight for {period}: you made {tx_count} transactions, spent ₹{spent:.0f}, earned ₹{income:.0f}, and your biggest spending category is {top}. {_format_remaining_budget(s)}"
            else:
                response_text = f"Your insight for {period}: you made {tx_count} transactions, spent ₹{spent:.0f}, earned ₹{income:.0f}, and your biggest spending category is {top}."
        action_result = {"summary": s, "navigate_to": "/"}

    # ── User info ────────────────────────────────────────────
    elif intent == "user_info":
        clear_pending(user_id)
        from database import get_connection
        conn = get_connection()
        try:
            row = conn.execute("SELECT id, name, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
        finally:
            conn.close()
        field = intent_data.get("field", "name")
        name = row["name"] if row else "unknown"
        if field == "income":
            income = get_monthly_income(user_id)
            response_text = f"Your monthly income is ₹{income:.0f}."
            action_result = {"monthly_income": income}
        elif field == "voice_samples":
            samples = get_voice_sample_count(user_id)
            response_text = f"You currently have {samples} voice sample{'s' if samples != 1 else ''} registered."
            action_result = {"voice_samples": samples}
        elif field == "profile":
            samples = get_voice_sample_count(user_id)
            created = row["created_at"] if row and row.get("created_at") else ""
            response_text = f"You're logged in as {name}. You have {samples} registered voice sample{'s' if samples != 1 else ''}."
            action_result = {"voice_samples": samples, "name": name, "created_at": created}
        else:
            response_text = f"You're logged in as {name}."
            action_result = {"name": name}

    # ── Navigate ─────────────────────────────────────────────
    elif intent == "navigate":
        clear_pending(user_id)
        page       = intent_data.get("page", "/")
        page_names = {
            "/": "Dashboard", "/budget": "Budget",
            "/transactions": "Transactions", "/notifications": "Notifications",
            "/alerts": "Alerts", "/profile": "Profile", "/conversation": "Conversation",
            "/locked": "the lock screen",
        }
        name          = page_names.get(page, page)
        response_text = f"Opening {name} now."
        action_result = {"navigate_to": page}

    # ── Set income ───────────────────────────────────────────
    elif intent == "set_income":
        clear_pending(user_id)
        amount = intent_data.get("amount")
        if amount:
            set_monthly_income(user_id, amount)
            s             = get_financial_summary(user_id, "month")
            response_text = (
                f"Monthly income set to ₹{amount:.0f}. "
                f"Your current balance stands at ₹{s['net_balance']:.0f}."
            )
            action_result = {"summary": s, "refresh": True}
        else:
            response_text = "What's your monthly income? Just say the amount."
            save_pending(user_id, "set_income", None, None, None, step="awaiting_amount")

    # ── Set budget ───────────────────────────────────────────
    # ── Delete budget ────────────────────────────────────────
    elif intent == "delete_budget":
        clear_pending(user_id)
        category = intent_data.get("category") or "monthly"

        # Try to match custom categories if not found by static parser
        if category == "monthly":
            raw_text = intent_data.get("raw_text", "")
            custom = _match_custom_category(user_id, raw_text)
            if custom:
                category = custom

        if category == "monthly":
            response_text = (
                "To remove your monthly budget limit, say 'Set monthly budget to zero' "
                "or specify which category budget to remove, like 'Delete skincare budget'."
            )
        else:
            deleted = svc_delete_budget(user_id, category)
            if deleted:
                response_text = f"Your {category} budget has been removed."
                action_result = {"budget_deleted": category, "refresh": True}
            else:
                response_text = f"I couldn't find a {category} budget to remove. It may not have been set yet."

    elif intent == "set_budget":
        clear_pending(user_id)
        amount   = intent_data.get("amount")
        category = intent_data.get("category") or "monthly"

        # If raw text contains a category name, always prefer that category over monthly budget
        _raw_sb = intent_data.get("raw_text", "")
        _resolved_budget_category = _resolve_category_from_text(user_id, _raw_sb)
        if _resolved_budget_category and _resolved_budget_category.lower() != "income":
            category = _resolved_budget_category
        elif category == "monthly":
            _custom_sb = _match_custom_category(user_id, _raw_sb)
            if _custom_sb:
                category = _custom_sb

        if amount:
            if category != "monthly":
                # Validate headroom
                s                  = get_financial_summary(user_id, "month")
                monthly_budget     = s["monthly_budget"]
                existing_cats      = get_budgets(user_id, current_month())
                already_allocated  = sum(
                    b["amount"] for b in existing_cats
                    if b["category"] not in ("monthly", category)
                )
                headroom = monthly_budget - already_allocated

                if monthly_budget > 0 and amount > headroom:
                    if headroom <= 0:
                        response_text = (
                            f"There's no budget headroom left to allocate ₹{amount:.0f} to {category}. "
                            f"You can increase your monthly budget by saying 'Set monthly budget to [amount]'."
                        )
                        action_result = {}
                    else:
                        # Clamp to available headroom
                        set_budget(user_id, category, headroom)
                        response_text = (
                            f"You only have ₹{headroom:.0f} unallocated, so I've set your {category} budget to ₹{headroom:.0f}. "
                            f"Increase your monthly budget to allocate more."
                        )
                        action_result = {"budget_set": headroom, "category": category, "refresh": True}
                else:
                    set_budget(user_id, category, amount)
                    response_text = f"Your {category} budget has been set to ₹{amount:.0f}."
                    action_result = {"budget_set": amount, "category": category, "refresh": True}
            else:
                set_budget(user_id, "monthly", amount)
                response_text = f"Your monthly budget is now set to ₹{amount:.0f}."
                action_result = {"budget_set": amount, "category": "monthly", "refresh": True}
        else:
            if category == "monthly":
                response_text = "What amount would you like for your total monthly budget?"
            else:
                response_text = f"How much would you like to allocate for {category}?"
            save_pending(user_id, "set_budget", None, category, None, step="awaiting_amount")

    # ── Greeting ─────────────────────────────────────────────
    elif intent == "greeting":
        clear_pending(user_id)
        from database import get_connection
        conn = get_connection()
        try:
            row  = conn.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
            name = row["name"] if row else "there"
        finally:
            conn.close()
        # Context-aware greeting: include today's quick summary
        try:
            s = get_financial_summary(user_id, "today")
            spent_today = float(s.get("total_expenses", 0) or 0)
            balance     = float(s.get("net_balance", 0) or 0)
            if spent_today > 0:
                context_hint = f"You've spent ₹{spent_today:.0f} today and your balance is ₹{balance:.0f}. "
            else:
                context_hint = "No expenses logged today yet. "
        except Exception:
            context_hint = ""
        response_text = (
            f"Hey {name}! I'm Vox, your personal finance assistant. "
            f"{context_hint}"
            "I can add expenses, check your balance, manage budgets, read alerts, or open any page. "
            "What can I help you with?"
        )

    # ── Help ─────────────────────────────────────────────────
    elif intent == "help":
        clear_pending(user_id)
        response_text = (
            "Here's everything I can do: "
            "Log expenses — say 'Add 300 for food' or 'I spent 150 on transport'. "
            "Log income — say 'I received 50,000 salary'. "
            "Check balance — say 'What's my balance' or 'How much did I spend this month'. "
            "Budget — say 'Set food budget to 3,000' or 'What's my remaining budget'. "
            "Alerts — say 'Read my alerts' or 'Read the latest alert'. "
            "Navigate — say 'Open transactions' or 'Go to profile'. "
            "Delete — say 'Delete last transaction' then confirm. "
            "Insights — say 'Show my spending insights'. "
            "Voice controls — say 'Stop' to stop speaking, 'Mute' to silence me, 'Unmute' to resume. "
            "What would you like to do?"
        )

    # ── Unknown — politely ask to repeat ─────────────────────
    else:
        existing_pending = get_pending(user_id)
        if existing_pending:
            step = existing_pending["step"]
            if step == "awaiting_category":
                response_text = "Which category? Food, Transport, Shopping, Entertainment, Utilities, Healthcare, Housing, or Education?"
            elif step == "awaiting_amount":
                response_text = "Just say the amount, like '200 rupees' or 'five hundred'."
            elif step == "awaiting_category_name":
                response_text = "Just say the name you'd like for the new category, like 'Skincare' or 'Gym'."
            else:
                clear_pending(user_id)
                response_text = "I didn't quite catch that — could you say it again?"
        else:
            response_text = (
                "I am your finance assistant for this app. "
                "I can help with budgeting, expenses, and transactions. "
                "Try saying: 'Add 200 for food', 'What\'s my balance', or 'Open budget'."
            )

    return {"intent": intent, "response_text": response_text, "action_result": action_result}


# ── Shared text pipeline ──────────────────────────────────────────────────────

def _process_text(user_id: int, text: str, require_wake_phrase: bool = False) -> dict:
    """Full pipeline: text → wake-phrase check → pending → intent → execute → result."""
    text = text.strip()

    if _is_stop(text):
        save_conversation(user_id, "user", text)
        save_conversation(user_id, "assistant", "")
        return {"intent": "stop", "response_text": "", "action_result": {"stop_tts": True}}

    # ── Mute: silence future TTS, actions still execute ──────────────────────
    if _is_mute(text):
        save_conversation(user_id, "user", text)
        return {"intent": "mute", "response_text": "", "action_result": {"mute_tts": True}}

    # ── Unmute: resume TTS speech output ─────────────────────────────────────
    if _is_unmute(text):
        save_conversation(user_id, "user", text)
        return {"intent": "unmute", "response_text": "Got it, I\'ll speak again.", "action_result": {"unmute_tts": True}}

    if require_wake_phrase and not _has_wake(text):
        return {"intent": "no_wake_phrase", "response_text": "", "action_result": {"ignored": True}}

    command_text = _strip_wake(text) if _has_wake(text) else text
    save_conversation(user_id, "user", text)

    # ── Intent parsing: AI-first for all natural language, keyword as fast-path ──
    # v11: Always try AI first for any command. Keyword parser is the fallback.
    # This ensures natural language, imperfect English, and varied phrasing all work.
    keyword_result = parse_intent(command_text)
    keyword_intent = keyword_result["intent"]

    # Fast-path: keyword parser handles clear, well-structured commands quickly
    # Only bypass AI for high-confidence keyword matches to keep latency low
    HIGH_CONFIDENCE_INTENTS = {
        "add_expense", "add_income", "navigate", "stop", "greeting",
        "dark_mode", "set_budget", "set_income",
    }
    use_ai = True
    if keyword_intent in HIGH_CONFIDENCE_INTENTS and keyword_result.get("amount") is not None:
        # Amount + clear intent = high confidence keyword result, skip AI
        use_ai = False
        print(f"[intent] ⚡ Fast-path keyword: {keyword_intent} (amount={keyword_result.get('amount')})")

    fresh_intent = keyword_result
    fresh_intent_name = keyword_intent

    if use_ai:
        try:
            history = get_conversation_history(user_id, limit=6)
            context = [{"role": r["role"], "content": r["content"]} for r in history]
            ai_result = ai_parse_intent(command_text, context_history=context, fallback_parser=parse_intent)
            if ai_result and ai_result.get("confidence", 0) >= 0.45:
                fresh_intent = ai_result
                fresh_intent_name = ai_result["intent"]
                print(f"[ai_intent] ✅ AI parsed: {fresh_intent_name} (conf={ai_result.get('_ai_confidence', '?')})")
            else:
                print(f"[ai_intent] Using keyword result: {keyword_intent}")
        except Exception as _ai_err:
            print(f"[ai_intent] AI error (using keyword): {_ai_err}")
            fresh_intent = keyword_result
            fresh_intent_name = keyword_intent

    # Escape valve — recognised non-slot-fill intent clears pending trap
    if get_pending(user_id) and fresh_intent_name not in ("unknown",):
        non_slot = {
            "set_budget", "set_income", "navigate",
            "query_spending", "query_insights", "stop", "help", "greeting", "show_transactions",
            "read_notifications", "read_alerts", "off_topic", "create_category", "mark_notification_read",
        }
        if fresh_intent_name in non_slot:
            clear_pending(user_id)

    if fresh_intent_name in BREAKING_INTENTS:
        if not (fresh_intent_name == "delete_transaction" and re.search(r"\b(confirm|yes|delete it|confirm delete)\b", command_text.lower())):
            if fresh_intent_name != "mark_notification_read":
                clear_pending(user_id)
        execution     = _execute_intent(user_id, fresh_intent)
        response_text = execution["response_text"]
        if response_text:
            save_conversation(user_id, "assistant", response_text)
        return {
            "intent": execution["intent"],
            "response_text": response_text,
            "action_result": execution["action_result"],
            "target_section": fresh_intent.get("target_section"),
        }

    pending_result = _resolve_pending(user_id, command_text)
    if pending_result:
        response_text = pending_result["response_text"]
        save_conversation(user_id, "assistant", response_text)
        return {
            "intent": pending_result["intent"],
            "response_text": response_text,
            "action_result": pending_result.get("action_result", {}),
        }

    execution     = _execute_intent(user_id, fresh_intent)
    response_text = execution["response_text"]
    if response_text:
        save_conversation(user_id, "assistant", response_text)

    return {
        "intent": execution["intent"],
        "response_text": response_text,
        "action_result": execution["action_result"],
    }


# ── Terminal logging for voice pipeline ──────────────────────────────────────

def _log_pipeline(
    raw_audio_bytes: int,
    raw_whisper: str,
    processed_text: str,
    intent_name: str,
    target_section: str,
    action_desc: str,
    db_action: str,
    response: str,
    stt_ms: float,
    proc_ms: float,
    total_ms: float,
):
    _sep()
    _log("🎤 Voice input",  f"{raw_audio_bytes:,} bytes",  _BL)
    _log("📝 Whisper raw",  repr(raw_whisper),              _YL)
    _log("✏️  Corrected",   repr(processed_text),           _CY)
    _log("🧠 Intent",       intent_name.upper().replace("_", " "), _MG)
    if target_section:
        _log("📍 Target",   target_section,                 _YL)
    if action_desc:
        _log("⚡ Action",   action_desc,                    _CY)
    if db_action:
        _log("💾 DB",       db_action,                      _GN)
    if response:
        _log("🤖 Response", response[:120] + ("…" if len(response) > 120 else ""), _GN)
    else:
        _log("🤖 Response", "(silent / stop)",               _DM)
    _log_timing("⏱  STT",   stt_ms,  1500)
    _log_timing("⏱  Proc",  proc_ms, 300)
    _log_timing("⏱  Total", total_ms, 2000)


def _log_text_pipeline(
    input_text: str,
    intent_name: str,
    target_section: str,
    action_desc: str,
    response: str,
    proc_ms: float,
):
    _sep()
    _log("⌨️  Text input",  repr(input_text),               _BL)
    _log("🧠 Intent",       intent_name.upper().replace("_", " "), _MG)
    if target_section:
        _log("📍 Target",   target_section,                 _YL)
    if action_desc:
        _log("⚡ Action",   action_desc,                    _CY)
    if response:
        _log("🤖 Response", response[:120] + ("…" if len(response) > 120 else ""), _GN)
    _log_timing("⏱  Proc",  proc_ms, 300)


def _build_action_desc(intent_name: str, action_result: dict) -> tuple[str, str]:
    """Return (action_description, db_confirmation) strings for terminal log."""
    action_desc = ""
    db_action   = ""

    if intent_name == "set_budget":
        cat = action_result.get("category", "monthly")
        amt = action_result.get("budget_set")
        if amt:
            label       = "Monthly Budget" if cat == "monthly" else f"{cat} Budget"
            action_desc = f"{label} → ₹{amt:.0f}"
            db_action   = "budgets table updated ✓"
        else:
            action_desc = "Awaiting budget amount"

    elif intent_name == "set_income":
        s           = action_result.get("summary") or {}
        amt         = s.get("monthly_income") if isinstance(s, dict) else None
        action_desc = f"Monthly income → ₹{amt:.0f}" if amt else "Awaiting income amount"
        if amt:
            db_action = "user_settings table updated ✓"

    elif intent_name == "add_expense":
        tx  = action_result.get("transaction") or {}
        amt = abs(tx.get("amount", 0)) if isinstance(tx, dict) else 0
        cat = tx.get("category", "") if isinstance(tx, dict) else ""
        action_desc = f"Expense ₹{amt:.0f} under {cat}" if amt else "Awaiting expense details"
        if amt:
            db_action = "transactions table updated ✓"

    elif intent_name == "add_income":
        tx          = action_result.get("transaction") or {}
        amt         = abs(tx.get("amount", 0)) if isinstance(tx, dict) else 0
        action_desc = f"Income ₹{amt:.0f} recorded" if amt else "Awaiting income details"
        if amt:
            db_action = "transactions table updated ✓"

    elif intent_name == "delete_transaction":
        did         = action_result.get("deleted_id")
        action_desc = f"Transaction #{did} deleted" if did else "Transaction not found"
        if did:
            db_action = "transactions table updated ✓"

    elif intent_name == "navigate":
        action_desc = f"Navigate → {action_result.get('navigate_to', '')}"

    elif intent_name == "create_category":
        cat         = action_result.get("category_created", "")
        action_desc = f"Category '{cat}' created" if cat else "Awaiting category name"
        if cat:
            db_action = "budgets table updated ✓"

    elif intent_name == "add_voice_sample":
        action_desc = "Navigate → /add-voice-profile"

    elif intent_name == "query_transaction_count":
        _txs = action_result.get("transactions") or []
        action_desc = f"Transaction count → {len(_txs)}"

    elif intent_name in ("silence", "no_wake_phrase"):
        action_desc = "Ignored — no speech / no wake phrase"

    return action_desc, db_action


# ── Voice command endpoint ────────────────────────────────────────────────────

@router.post("/voice-command")
async def voice_command(
    user_id: int           = Form(...),
    audio: UploadFile      = File(...),
    language: str          = Form(default="en"),
    tts: bool              = Form(default=False),
    require_wake_phrase: bool = Form(default=False),
):
    t_start     = time.time()
    audio_bytes = await audio.read()

    if not audio_bytes:
        raise HTTPException(400, "Empty audio file.")

    if len(audio_bytes) < 4000:  # FIX v7: was 3000 — reject smaller noise bursts
        _sep()
        print(f"{_DM}  [voice] audio too small ({len(audio_bytes)}B) — treated as silence{_R}")
        return {"success": False, "transcribed_text": "", "response_text": "",
                "intent": "silence", "action_result": {"ignored": True}}

    # ── Backend VAD / speech-quality gate ────────
    try:
        _ok, _reason, _y, _sr = analyze_audio_quality(audio_bytes)
        if not _ok:
            print(f"[voice_cmd] Rejected before STT: {_reason}")
            return {"success": False, "transcribed_text": "", "response_text": "",
                    "intent": "silence", "action_result": {"ignored": True}}
    except Exception as _eg:
        print(f"[voice_cmd] quality gate error (skipped): {_eg}")

    # ── STT ──────────────────────────────────────────────────
    t_stt      = time.time()
    raw_text   = ""  # raw Whisper output before post-processing
    transcribed = None

    # Monkey-patch to capture raw Whisper output for logging
    import services.whisper_service as _ws
    _orig_pp = _ws._post_process
    _raw_captures: list = []
    def _capture_pp(text: str) -> str:
        _raw_captures.append(text)
        return _orig_pp(text)
    _ws._post_process = _capture_pp
    try:
        transcribed = _ws.transcribe_audio(audio_bytes, language=language)
    finally:
        _ws._post_process = _orig_pp

    raw_text  = _raw_captures[0] if _raw_captures else (transcribed or "")
    stt_ms    = (time.time() - t_stt) * 1000

    if not transcribed:
        _sep()
        _log("📝 Whisper raw", repr(raw_text), _YL)
        _log("⚡ Action",  "Silence / noise — ignored", _DM)
        _log_timing("⏱  STT", stt_ms, 1500)
        return {"success": False, "transcribed_text": "", "response_text": "",
                "intent": "silence", "action_result": {"ignored": True}}

    if not _looks_like_valid_app_command(transcribed):
        print(f"[voice_cmd] Ignored non-app / hallucinated transcript: {transcribed!r}")
        return {
            "success": False,
            "transcribed_text": transcribed,
            "response_text": "",
            "intent": "silence",
            "action_result": {"ignored": True},
        }

    # ── Voice identity verification ──────────────────────────
    # Only run if the user has a stored voice profile.
    # Extract an MFCC embedding from the command audio and compare it
    # against the registered profile. Reject if similarity is too low.
    # Users without a voice profile bypass this check (backward compat).
    try:
        profile_count = get_voice_sample_count(user_id)
        parsed_intent = parse_intent(transcribed)
        strict_auth = _requires_strict_voice_auth(parsed_intent.get("intent", ""))
        if profile_count <= 0 and strict_auth:
            _rej_msg = "Voice commands for this action require a registered voice sample."
            return {
                "success": False,
                "transcribed_text": transcribed,
                "response_text": _rej_msg,
                "intent": "unauthorized",
                "action_result": {"ignored": True},
                "tts_audio_url": f"/voice/tts?text={quote(_rej_msg)}",
            }
        if profile_count > 0:
            from config import settings as _cfg
            probe_emb = _extract_embedding(audio_bytes)
            if probe_emb is None and strict_auth:
                _rej_msg = "Clear registered-user speech was not detected, so I ignored that command."
                return {
                    "success": False,
                    "transcribed_text": transcribed,
                    "response_text": _rej_msg,
                    "intent": "unauthorized",
                    "action_result": {"ignored": True},
                    "tts_audio_url": f"/voice/tts?text={quote(_rej_msg)}",
                }
            if probe_emb is not None:
                from database import get_connection as _gc
                import pickle as _pk
                _conn = _gc()
                try:
                    _rows = _conn.execute(
                        "SELECT embedding FROM voice_embeddings WHERE user_id = ?", (user_id,)
                    ).fetchall()
                finally:
                    _conn.close()
                best_sim = 0.0
                for _row in _rows:
                    try:
                        _stored = _pk.loads(_row["embedding"])
                        _sim = _cosine_similarity(probe_emb, _stored)
                        if _sim > best_sim:
                            best_sim = _sim
                    except Exception:
                        pass
                _threshold = _cfg.VOICE_SIMILARITY_THRESHOLD
                print(f"[voice_cmd] identity check: sim={best_sim:.4f}, threshold={_threshold}")
                if strict_auth and best_sim < _threshold:
                    print("[voice_cmd] ⛔ Voice identity mismatch — command rejected")
                    _rej_msg = "Sorry, I don't recognise your voice. Only the registered user can give commands."
                    return {
                        "success": False,
                        "transcribed_text": transcribed,
                        "response_text": _rej_msg,
                        "intent": "unauthorized",
                        "action_result": {"ignored": True},
                        "tts_audio_url": f"/voice/tts?text={quote(_rej_msg)}",
                    }
    except Exception as _ve:
        print(f"[voice_cmd] voice identity check error (skipped): {_ve}")

    # ── Pipeline ─────────────────────────────────────────────
    t_proc = time.time()
    result = _process_text(user_id, transcribed, require_wake_phrase=require_wake_phrase)
    proc_ms = (time.time() - t_proc) * 1000

    intent_name    = result["intent"]
    target_section = result.get("target_section") or ""
    response       = result["response_text"]
    action         = result.get("action_result", {})
    action_desc, db_action = _build_action_desc(intent_name, action)

    _log_pipeline(
        raw_audio_bytes=len(audio_bytes),
        raw_whisper=raw_text,
        processed_text=transcribed,
        intent_name=intent_name,
        target_section=target_section,
        action_desc=action_desc,
        db_action=db_action,
        response=response,
        stt_ms=stt_ms,
        proc_ms=proc_ms,
        total_ms=(time.time() - t_start) * 1000,
    )

    tts_audio_url = None
    if tts and response:
        tts_audio_url = f"/voice/tts?text={quote(response[:800])}"

    return {
        "success": True,
        "transcribed_text": transcribed,
        "intent": intent_name,
        "response_text": response,
        "action_result": action,
        "tts_audio_url": tts_audio_url,
    }


# ── Text command endpoint ─────────────────────────────────────────────────────

@router.post("/text-command")
def text_command(
    user_id: int               = Form(...),
    text: str                  = Form(...),
    require_wake_phrase: bool  = Form(default=False),
):
    if not text.strip():
        raise HTTPException(400, "Empty command text.")

    t0     = time.time()
    result = _process_text(user_id, text.strip(), require_wake_phrase=require_wake_phrase)
    proc_ms = (time.time() - t0) * 1000

    intent_name    = result["intent"]
    target_section = result.get("target_section") or ""
    response       = result["response_text"]
    action         = result.get("action_result", {})
    action_desc, _ = _build_action_desc(intent_name, action)

    _log_text_pipeline(
        input_text=text.strip(),
        intent_name=intent_name,
        target_section=target_section,
        action_desc=action_desc,
        response=response,
        proc_ms=proc_ms,
    )

    return {
        "success": True,
        "input_text": text.strip(),
        "intent": intent_name,
        "response_text": response,
        "action_result": action,
    }


# ── TTS endpoint ──────────────────────────────────────────────────────────────

@router.get("/tts")
def tts_endpoint(text: str = Query(..., max_length=1000)):
    audio_bytes = text_to_speech(text)
    if not audio_bytes:
        raise HTTPException(500, "TTS generation failed.")
    return StreamingResponse(
        io.BytesIO(audio_bytes),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline; filename=response.mp3"},
    )


# ── Conversation history ──────────────────────────────────────────────────────

@router.get("/conversation-history")
def conversation_history(
    user_id: int = Query(...),
    limit: int   = Query(default=50, le=200),
):
    history = get_conversation_history(user_id, limit=limit)
    return {"conversation": history, "count": len(history)}


# ── Wake phrase check endpoint ────────────────────────────────────────────────

@router.post("/check-wake-phrase")
async def check_wake_phrase(
    audio: UploadFile = File(...),
    language: str     = Form(default="en"),
):
    audio_bytes = await audio.read()
    if not audio_bytes or len(audio_bytes) < 3000:
        return {"detected": False, "transcribed_text": ""}
    transcribed = transcribe_audio(audio_bytes, language=language)
    if not transcribed:
        return {"detected": False, "transcribed_text": ""}
    detected = _has_wake(transcribed)
    return {
        "detected": detected,
        "transcribed_text": transcribed,
        "stripped_command": _strip_wake(transcribed) if detected else "",
    }


# ── Income helper endpoints ───────────────────────────────────────────────────

@router.post("/set-income")
def set_income_endpoint(user_id: int = Form(...), amount: float = Form(...)):
    set_monthly_income(user_id, amount)
    summary = get_financial_summary(user_id, "month")
    return {"success": True, "monthly_income": amount, "summary": summary}


@router.get("/monthly-income")
def get_income_endpoint(user_id: int = Query(...)):
    income = get_monthly_income(user_id)
    return {"user_id": user_id, "monthly_income": income}
