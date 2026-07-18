from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from models.transaction_model import AddExpenseRequest, EditTransactionRequest
from services.finance_service import (
    add_transaction,
    get_transactions,
    delete_transaction,
    update_transaction,
    get_financial_summary,
)

router = APIRouter(prefix="/transactions", tags=["Transactions"])


@router.post("/add-expense")
def add_expense(req: AddExpenseRequest):
    """Add an expense transaction and return updated summary."""
    title = req.title or req.description.capitalize() or req.category
    result = add_transaction(
        user_id=req.user_id,
        title=title,
        amount=-abs(req.amount),   # expenses are negative
        category=req.category,
        description=req.description,
        tx_date=req.tx_date,
    )
    tx = result["transaction"]
    summary = result["summary"]
    return {
        "success": True,
        "message": f"₹{req.amount:.0f} added to {req.category}.",
        "transaction": tx,
        "updated_balance": summary["net_balance"],
        "summary": summary,
    }


@router.post("/add-income")
def add_income(req: AddExpenseRequest):
    """Add an income transaction."""
    title = req.title or req.description.capitalize() or "Income"
    result = add_transaction(
        user_id=req.user_id,
        title=title,
        amount=abs(req.amount),
        category=req.category or "Income",
        description=req.description,
        tx_date=req.tx_date,
    )
    return {
        "success": True,
        "message": f"₹{req.amount:.0f} income recorded.",
        "transaction": result["transaction"],
        "summary": result["summary"],
    }


@router.get("")
def list_transactions(
    user_id: int = Query(...),
    period: str = Query(default="month"),
    category: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=100, le=500),
):
    """Return transaction list with optional filters."""
    txs = get_transactions(
        user_id=user_id,
        period=period,
        category=category,
        search=search,
        limit=limit,
    )
    return {
        "transactions": txs,
        "count": len(txs),
        "period": period,
    }


@router.get("/summary")
def financial_summary(
    user_id: int = Query(...),
    period: str = Query(default="month"),
):
    """Return financial summary for a given period."""
    summary = get_financial_summary(user_id, period)
    return summary


@router.put("/{tx_id}")
def edit_transaction(tx_id: int, user_id: int, req: EditTransactionRequest):
    updated = update_transaction(tx_id, user_id, req.model_dump())
    if not updated:
        raise HTTPException(404, "Transaction not found.")
    return {"success": True, "transaction": updated}


@router.delete("/{tx_id}")
def remove_transaction(tx_id: int, user_id: int):
    ok = delete_transaction(tx_id, user_id)
    if not ok:
        raise HTTPException(404, "Transaction not found.")
    return {"success": True, "message": "Transaction deleted."}
