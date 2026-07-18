from pydantic import BaseModel, Field
from typing import Optional, List
from enum import Enum


class FilterPeriod(str, Enum):
    today = "today"
    week = "week"
    month = "month"
    year = "year"
    all = "all"


class AddExpenseRequest(BaseModel):
    user_id: int
    amount: float = Field(..., gt=0)
    category: str = Field(default="Other")
    description: str = Field(default="")
    title: Optional[str] = None
    tx_date: Optional[str] = None  # YYYY-MM-DD; defaults to today


class EditTransactionRequest(BaseModel):
    title: Optional[str] = None
    amount: Optional[float] = None
    category: Optional[str] = None
    description: Optional[str] = None


class TransactionResponse(BaseModel):
    id: int
    user_id: int
    title: str
    amount: float
    category: str
    description: str
    tx_date: str
    created_at: str


class FinancialSummary(BaseModel):
    total_income: float
    total_expenses: float
    net_balance: float
    monthly_budget: float
    budget_used_pct: float
    remaining_budget: float
    transaction_count: int
    top_category: Optional[str] = None
