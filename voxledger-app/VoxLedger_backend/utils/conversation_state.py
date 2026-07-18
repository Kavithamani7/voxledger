"""
In-memory conversation state for multi-turn voice interactions.
Handles pending actions that need follow-up (e.g., "add 300" → ask category).
"""
from typing import Dict, Optional, Any
from datetime import datetime, timedelta

# user_id -> pending state dict
_pending: Dict[int, Dict[str, Any]] = {}
_TIMEOUT_SECONDS = 60  # clear pending state after 60s of inactivity


def set_pending(user_id: int, action: str, context: Dict[str, Any]):
    """Store a pending action waiting for follow-up input."""
    _pending[user_id] = {
        "action": action,
        "context": context,
        "created_at": datetime.now(),
    }


def get_pending(user_id: int) -> Optional[Dict[str, Any]]:
    """Get pending action for user, or None if expired/empty."""
    state = _pending.get(user_id)
    if not state:
        return None
    # Expire if older than timeout
    if datetime.now() - state["created_at"] > timedelta(seconds=_TIMEOUT_SECONDS):
        clear_pending(user_id)
        return None
    return state


def clear_pending(user_id: int):
    """Clear pending state for user."""
    _pending.pop(user_id, None)
