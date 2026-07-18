"""
Core finance operations: transactions, budgets, notifications.
"""
from datetime import datetime
from typing import List, Optional, Dict, Any

from database import get_connection
from utils.date_parser import get_date_range, current_month, friendly_date
from config import settings


# ── Transactions ──────────────────────────────────────────────────────────────

def add_transaction(
    user_id: int,
    title: str,
    amount: float,
    category: str,
    description: str = "",
    tx_date: Optional[str] = None,
) -> Dict[str, Any]:
    """Insert a transaction and return the new row + updated summary."""
    if tx_date is None:
        tx_date = datetime.now().strftime("%Y-%m-%d")
    created_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO transactions (user_id, title, amount, category, description, tx_date, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, title, amount, category, description, tx_date, created_at),
        )
        conn.commit()
        tx_id = cur.lastrowid

        row = conn.execute(
            "SELECT * FROM transactions WHERE id = ?", (tx_id,)
        ).fetchone()

        tx = dict(row)
        tx["tx_date_friendly"] = friendly_date(tx["tx_date"])

        summary = get_financial_summary(user_id)
        _check_and_create_budget_alerts(user_id, category)

        return {"transaction": tx, "summary": summary}
    finally:
        conn.close()


def get_transactions(
    user_id: int,
    period: str = "month",
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    start, end = get_date_range(period)
    conn = get_connection()
    try:
        sql = """
            SELECT * FROM transactions
            WHERE user_id = ? AND tx_date BETWEEN ? AND ?
        """
        params: list = [user_id, start, end]

        if category:
            sql += " AND LOWER(category) = LOWER(?)"
            params.append(category)

        if search:
            sql += " AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)"
            q = f"%{search.lower()}%"
            params.extend([q, q])

        sql += " ORDER BY tx_date DESC, datetime(created_at) DESC, id DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        result = []
        for row in rows:
            tx = dict(row)
            tx["tx_date_friendly"] = friendly_date(tx["tx_date"])
            result.append(tx)
        return result
    finally:
        conn.close()


def delete_transaction(tx_id: int, user_id: int) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM transactions WHERE id = ? AND user_id = ?",
            (tx_id, user_id)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def update_transaction(
    tx_id: int,
    user_id: int,
    fields: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    allowed = {"title", "amount", "category", "description", "tx_date"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return None

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [tx_id, user_id]

    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE transactions SET {set_clause} WHERE id = ? AND user_id = ?",
            values
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM transactions WHERE id = ?", (tx_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ── Financial Summary ─────────────────────────────────────────────────────────

def get_financial_summary(user_id: int, period: str = "month") -> Dict[str, Any]:
    start, end = get_date_range(period)
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT category, SUM(amount) as total
               FROM transactions
               WHERE user_id = ? AND tx_date BETWEEN ? AND ?
               GROUP BY category""",
            (user_id, start, end)
        ).fetchall()

        income = 0.0
        expenses = 0.0
        category_spending: Dict[str, float] = {}

        for row in rows:
            if row["total"] > 0:
                income += row["total"]
            else:
                amt = abs(row["total"])
                expenses += amt
                category_spending[row["category"]] = amt

        top_category = max(category_spending, key=category_spending.get) if category_spending else None

        budget_row = conn.execute(
            """SELECT amount FROM budgets
               WHERE user_id = ? AND category = 'monthly' AND month = ?""",
            (user_id, current_month())
        ).fetchone()
        monthly_budget = budget_row["amount"] if budget_row else 0.0

        remaining = monthly_budget - expenses
        used_pct = round((expenses / monthly_budget) * 100, 1) if monthly_budget > 0 else 0.0

        tx_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND tx_date BETWEEN ? AND ?",
            (user_id, start, end)
        ).fetchone()["cnt"]

        return {
            "total_income": round(income, 2),
            "total_expenses": round(expenses, 2),
            "net_balance": round(income - expenses, 2),
            "monthly_budget": monthly_budget,
            "budget_used_pct": used_pct,
            "remaining_budget": round(remaining, 2),
            "transaction_count": tx_count,
            "top_category": top_category,
            "category_breakdown": category_spending,
            "category_spending": category_spending,
            "period": period,
            "monthly_income": get_monthly_income(user_id),
        }
    finally:
        conn.close()


# ── Budgets ───────────────────────────────────────────────────────────────────

def set_budget(
    user_id: int,
    category: str = "monthly",
    amount: float = 2500.0,
    month: Optional[str] = None,
) -> Dict[str, Any]:
    if month is None:
        month = current_month()

    conn = get_connection()
    try:
        conn.execute(
            """INSERT INTO budgets (user_id, category, amount, month)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, category, month) DO UPDATE SET amount = excluded.amount""",
            (user_id, category, amount, month)
        )
        conn.commit()
        return {"user_id": user_id, "category": category, "amount": amount, "month": month}
    finally:
        conn.close()


def delete_budget(user_id: int, category: str) -> bool:
    """Remove a budget category row for the current month. Returns True if deleted."""
    month = current_month()
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM budgets WHERE user_id = ? AND category = ? AND month = ?",
            (user_id, category, month)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_budgets(user_id: int, month: Optional[str] = None) -> List[Dict[str, Any]]:
    if month is None:
        month = current_month()

    start = f"{month}-01"
    # end = last day of month (approximate)
    end = f"{month}-31"

    conn = get_connection()
    try:
        budgets = conn.execute(
            "SELECT * FROM budgets WHERE user_id = ? AND month = ?",
            (user_id, month)
        ).fetchall()

        result = []
        for b in budgets:
            # Calculate how much was spent in this category this month
            row = conn.execute(
                """SELECT COALESCE(SUM(ABS(amount)), 0) as spent
                   FROM transactions
                   WHERE user_id = ? AND category = ? AND tx_date BETWEEN ? AND ? AND amount < 0""",
                (user_id, b["category"], start, end)
            ).fetchone()
            spent = row["spent"]
            limit = b["amount"]
            remaining = limit - spent
            used_pct = round((spent / limit) * 100, 1) if limit > 0 else 0.0

            result.append({
                "id": b["id"],
                "user_id": b["user_id"],
                "category": b["category"],
                "amount": limit,
                "month": b["month"],
                "spent": round(spent, 2),
                "remaining": round(remaining, 2),
                "used_pct": used_pct,
            })
        return result
    finally:
        conn.close()


# ── Notifications ─────────────────────────────────────────────────────────────

def create_notification(
    user_id: int,
    title: str,
    message: str,
    notif_type: str = "info",
) -> Dict[str, Any]:
    conn = get_connection()
    created_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    try:
        cur = conn.execute(
            """INSERT INTO notifications (user_id, title, message, notif_type, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, title, message, notif_type, created_at)
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM notifications WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        n = dict(row)
        n["is_read"] = bool(n["is_read"])
        n["type"] = n.get("notif_type", "info")
        return n
    finally:
        conn.close()


def get_notifications(user_id: int, unread_only: bool = False) -> List[Dict[str, Any]]:
    conn = get_connection()
    try:
        sql = "SELECT * FROM notifications WHERE user_id = ?"
        params: list = [user_id]
        if unread_only:
            sql += " AND is_read = 0"
        sql += " ORDER BY created_at DESC LIMIT 50"
        rows = conn.execute(sql, params).fetchall()
        result = []
        for row in rows:
            n = dict(row)
            n["is_read"] = bool(n["is_read"])
            n["type"] = n.get("notif_type", "info")
            result.append(n)
        return result
    finally:
        conn.close()


def mark_notifications_read(user_id: int, notification_ids: Optional[List[int]] = None):
    conn = get_connection()
    try:
        if notification_ids:
            placeholders = ",".join("?" * len(notification_ids))
            conn.execute(
                f"UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN ({placeholders})",
                [user_id] + notification_ids
            )
        else:
            conn.execute(
                "UPDATE notifications SET is_read = 1 WHERE user_id = ?",
                (user_id,)
            )
        conn.commit()
    finally:
        conn.close()


def _check_and_create_budget_alerts(user_id: int, category: str):
    """Auto-create a notification if budget thresholds are breached."""
    summary = get_financial_summary(user_id, "month")
    pct = summary["budget_used_pct"] / 100.0
    budget = summary["monthly_budget"]
    spent = summary["total_expenses"]

    if pct >= settings.BUDGET_CRITICAL_PCT:
        create_notification(
            user_id,
            title="Critical: Budget Nearly Exhausted",
            message=f"You have spent ₹{spent:.0f} of your ₹{budget:.0f} budget ({int(pct*100)}% used).",
            notif_type="critical",
        )
    elif pct >= settings.BUDGET_WARNING_PCT:
        create_notification(
            user_id,
            title=f"Budget Alert: {int(pct*100)}% Used",
            message=f"You have used {int(pct*100)}% of your monthly budget. ₹{budget - spent:.0f} remaining.",
            notif_type="warning",
        )


# ── Conversation History ──────────────────────────────────────────────────────

def save_conversation(user_id: int, role: str, content: str):
    conn = get_connection()
    try:
        # Store local datetime explicitly so frontend gets correct time
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        conn.execute(
            "INSERT INTO conversation_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (user_id, role, content, now)
        )
        conn.commit()
        # Prune: keep only the most recent 500 rows per user to prevent unbounded growth
        conn.execute("""
            DELETE FROM conversation_history
            WHERE user_id = ?
            AND id NOT IN (
                SELECT id FROM conversation_history
                WHERE user_id = ?
                ORDER BY created_at DESC LIMIT 500
            )
        """, (user_id, user_id))
        conn.commit()
    finally:
        conn.close()


def get_conversation_history(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT * FROM conversation_history
               WHERE user_id = ?
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in reversed(rows)]
    finally:
        conn.close()


# ── Monthly Income ────────────────────────────────────────────────────────────

def set_monthly_income(user_id: int, amount: float) -> Dict[str, Any]:
    """Set or update the user's monthly income in user_settings."""
    conn = get_connection()
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    try:
        conn.execute("""
            INSERT INTO user_settings (user_id, monthly_income, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                monthly_income = excluded.monthly_income,
                updated_at = excluded.updated_at
        """, (user_id, amount, now))
        conn.commit()

        # Also record as an income transaction for the current month
        add_transaction(
            user_id=user_id,
            title="Monthly Income",
            amount=abs(amount),
            category="Income",
            description="Monthly income set by user",
        )
        return {"user_id": user_id, "monthly_income": amount}
    finally:
        conn.close()


def get_monthly_income(user_id: int) -> float:
    """Retrieve the user's configured monthly income."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT monthly_income FROM user_settings WHERE user_id = ?", (user_id,)
        ).fetchone()
        return row["monthly_income"] if row else 0.0
    finally:
        conn.close()
