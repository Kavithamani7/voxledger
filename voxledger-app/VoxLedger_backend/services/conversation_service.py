"""
Conversational session manager for multi-turn voice interactions.
Handles pending intents (e.g., "add 300" → ask category → confirm).
"""
from typing import Optional, Dict, Any
import re
from datetime import datetime
from database import get_connection


def get_pending(user_id: int) -> Optional[Dict[str, Any]]:
    """Return the current pending intent for this user, or None."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM pending_intents WHERE user_id = ?", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_pending(user_id: int, intent: str, amount: Optional[float],
                 category: Optional[str], description: Optional[str],
                 step: str = "awaiting_category") -> None:
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    conn = get_connection()
    try:
        conn.execute("""
            INSERT INTO pending_intents (user_id, intent, amount, category, description, step, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                intent=excluded.intent,
                amount=excluded.amount,
                category=excluded.category,
                description=excluded.description,
                step=excluded.step,
                updated_at=excluded.updated_at
        """, (user_id, intent, amount, category, description, step, now))
        conn.commit()
    finally:
        conn.close()


def clear_pending(user_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM pending_intents WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()


# ── Category slot-filling ──────────────────────────────────────────────────────

CATEGORY_ALIASES: Dict[str, str] = {
    # Food
    "food": "Food", "groceries": "Food", "grocery": "Food", "eating": "Food",
    "restaurant": "Food", "cafe": "Food", "coffee": "Food", "lunch": "Food",
    "dinner": "Food", "breakfast": "Food", "snack": "Food", "meals": "Food",
    # Transport
    "transport": "Transport", "travel": "Transport", "cab": "Transport",
    "auto": "Transport", "bus": "Transport", "petrol": "Transport",
    "fuel": "Transport", "train": "Transport", "uber": "Transport",
    "ola": "Transport", "metro": "Transport", "bike": "Transport",
    # Shopping
    "shopping": "Shopping", "clothes": "Shopping", "clothing": "Shopping",
    "amazon": "Shopping", "flipkart": "Shopping", "purchase": "Shopping",
    "buy": "Shopping",
    # Entertainment
    "entertainment": "Entertainment", "movie": "Entertainment",
    "cinema": "Entertainment", "netflix": "Entertainment", "game": "Entertainment",
    "gaming": "Entertainment", "concert": "Entertainment",
    # Utilities
    "utilities": "Utilities", "utility": "Utilities", "electricity": "Utilities",
    "internet": "Utilities", "wifi": "Utilities", "bill": "Utilities",
    "recharge": "Utilities", "phone": "Utilities",
    # Healthcare
    "health": "Healthcare", "healthcare": "Healthcare", "doctor": "Healthcare",
    "medicine": "Healthcare", "medical": "Healthcare", "pharmacy": "Healthcare",
    "hospital": "Healthcare", "tablet": "Healthcare",
    # Housing
    "rent": "Housing", "house": "Housing", "housing": "Housing",
    "maintenance": "Housing", "repair": "Housing",
    # Education
    "education": "Education", "course": "Education", "book": "Education",
    "tuition": "Education", "school": "Education", "college": "Education",
    "fees": "Education",
    # Others
    "others": "Others", "other": "Others", "misc": "Others",
    "miscellaneous": "Others", "general": "Others",
}

CATEGORY_NAMES = [
    "Food", "Transport", "Shopping", "Entertainment",
    "Utilities", "Healthcare", "Housing", "Education", "Others"
]


def extract_category_from_reply(text: str) -> Optional[str]:
    """Try to extract a category from a short user reply like 'food' or 'for groceries'."""
    lower = text.lower().strip()
    for alias, cat in CATEGORY_ALIASES.items():
        if re.search(r'\b' + re.escape(alias.lower()) + r'\b', lower):
            return cat
    for cat in CATEGORY_NAMES:
        if re.search(r'\b' + re.escape(cat.lower()) + r'\b', lower):
            return cat
    return None
