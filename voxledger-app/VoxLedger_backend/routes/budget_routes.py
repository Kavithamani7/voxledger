from fastapi import APIRouter, Query, HTTPException
from typing import Optional

from models.budget_model import SetBudgetRequest
from services.finance_service import set_budget, get_budgets, get_financial_summary
from utils.date_parser import current_month

router = APIRouter(prefix="/budget", tags=["Budget"])

# All default categories — always shown on budget page even when no DB rows exist
DEFAULT_CATEGORIES = [
    "Food", "Transport", "Shopping", "Utilities",
    "Entertainment", "Healthcare", "Housing", "Education", "Others",
]


@router.post("/set")
def set_budget_endpoint(req: SetBudgetRequest):
    result = set_budget(user_id=req.user_id, category=req.category,
                        amount=req.amount, month=req.month)
    return {"success": True, "budget": result}


@router.post("/init-defaults")
def init_default_budgets(user_id: int, monthly_total: float = 0.0):
    """
    Initialise default category budgets for a new user.
    All start at ₹0 — user sets real values via voice.
    """
    created = []
    set_budget(user_id, "monthly", monthly_total)
    created.append({"category": "monthly", "amount": monthly_total})
    for cat in DEFAULT_CATEGORIES:
        set_budget(user_id, cat, 0.0)
        created.append({"category": cat, "amount": 0.0})
    return {"success": True, "budgets_created": created}


@router.get("")
def get_budget_summary(
    user_id: int            = Query(...),
    month: Optional[str]    = Query(default=None),
):
    """
    Return all budgets with spending progress.
    ALWAYS returns all default categories — never blank.
    Custom categories created by the user are also included.
    """
    if month is None:
        month = current_month()

    budgets = get_budgets(user_id, month)
    summary = get_financial_summary(user_id, "month")

    monthly_budget = next(
        (b["amount"] for b in budgets if b["category"] == "monthly"),
        summary.get("monthly_budget", 0.0)
    )
    total_spent = summary["total_expenses"]
    remaining   = monthly_budget - total_spent
    used_pct    = round((total_spent / monthly_budget) * 100, 1) if monthly_budget > 0 else 0

    # Build lookup of DB-stored category budgets
    existing = {b["category"]: b for b in budgets if b["category"] != "monthly"}
    category_spending = summary.get("category_spending", {}) or {}

    # Determine full category list = defaults + any custom ones the user created
    all_cats = list(DEFAULT_CATEGORIES)
    for cat in existing:
        if cat not in all_cats:
            all_cats.append(cat)

    category_budgets = []
    for cat in all_cats:
        if cat in existing:
            category_budgets.append(existing[cat])
        else:
            # Not yet in DB — show as ₹0 budget with real spending if any
            spent = round(category_spending.get(cat, 0.0), 2)
            category_budgets.append({
                "id": None,
                "user_id": user_id,
                "category": cat,
                "amount": 0.0,
                "month": month,
                "spent": spent,
                "remaining": -spent,
                "used_pct": 0.0,
            })

    return {
        "month": month,
        "monthly_budget": monthly_budget,
        "total_spent": round(total_spent, 2),
        "remaining": round(remaining, 2),
        "used_pct": used_pct,
        "categories": category_budgets,
    }
