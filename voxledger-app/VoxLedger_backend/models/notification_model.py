from pydantic import BaseModel
from typing import Optional, List


class NotificationResponse(BaseModel):
    id: int
    user_id: int
    title: str
    message: str
    notif_type: str   # info | warning | critical | success
    is_read: bool
    created_at: str


class MarkReadRequest(BaseModel):
    notification_ids: List[int]
