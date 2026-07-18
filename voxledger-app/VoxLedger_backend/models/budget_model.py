from pydantic import BaseModel, Field
from typing import Optional, List


class SetBudgetRequest(BaseModel):
    user_id: int
    category: str = Field(default="monthly")
    amount: float = Field(..., gt=0)
    month: Optional[str] = None  # YYYY-MM; defaults to current month


class BudgetResponse(BaseModel):
    id: int
    user_id: int
    category: str
    amount: float
    month: str
    spent: float
    remaining: float
    used_pct: float


class BudgetSummaryResponse(BaseModel):
    monthly_budget: float
    total_spent: float
    remaining: float
    used_pct: float
    categories: List[BudgetResponse]
