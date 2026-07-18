from fastapi import APIRouter, Query, HTTPException
from typing import Optional

from models.notification_model import MarkReadRequest
from services.finance_service import (
    get_notifications,
    mark_notifications_read,
    create_notification,
)

router = APIRouter(prefix="/notifications", tags=["Notifications"])


@router.get("")
def list_notifications(
    user_id: int = Query(...),
    unread_only: bool = Query(default=False),
):
    """Return all notifications for a user, newest first."""
    notifications = get_notifications(user_id, unread_only=unread_only)
    unread_count = sum(1 for n in notifications if not n["is_read"])
    return {
        "notifications": notifications,
        "count": len(notifications),
        "unread_count": unread_count,
    }


@router.post("/mark-read")
def mark_read(user_id: int = Query(...), req: MarkReadRequest = None):
    """Mark specific notifications as read."""
    ids = req.notification_ids if req and req.notification_ids else None
    mark_notifications_read(user_id, ids)
    return {"success": True, "message": "Notifications marked as read."}


@router.post("/mark-all-read")
def mark_all_read(user_id: int = Query(...)):
    """Mark all notifications as read."""
    mark_notifications_read(user_id)
    return {"success": True, "message": "All notifications marked as read."}


@router.post("/create")
def push_notification(user_id: int, title: str, message: str, notif_type: str = "info"):
    """Manually push a notification (admin/testing)."""
    n = create_notification(user_id, title, message, notif_type)
    return {"success": True, "notification": n}


@router.get("/daily-summary")
def daily_summary(user_id: int = Query(...)):
    """Generate and return a daily financial summary notification."""
    from services.finance_service import get_financial_summary
    summary = get_financial_summary(user_id, "today")

    msg = (
        f"Today you spent ₹{summary['total_expenses']:.0f} "
        f"and earned ₹{summary['total_income']:.0f}. "
        f"Monthly budget used: {summary['budget_used_pct']}%."
    )
    n = create_notification(
        user_id,
        title="Daily Summary 📊",
        message=msg,
        notif_type="info",
    )
    return {"success": True, "notification": n, "summary": summary}
