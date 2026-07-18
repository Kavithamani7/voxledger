from datetime import datetime, timedelta
from typing import Tuple


def get_date_range(period: str) -> Tuple[str, str]:
    """
    Return (start_date, end_date) as 'YYYY-MM-DD' strings for a given period.
    Supports: today, yesterday, week, last_week, month, last_month, year, last_year, all
    """
    today = datetime.now().date()

    if period in ("today",):
        return str(today), str(today)

    elif period == "yesterday":
        d = today - timedelta(days=1)
        return str(d), str(d)

    elif period in ("week", "this_week"):
        start = today - timedelta(days=today.weekday())  # Monday
        return str(start), str(today)

    elif period == "last_week":
        end = today - timedelta(days=today.weekday() + 1)   # last Sunday
        start = end - timedelta(days=6)                       # previous Monday
        return str(start), str(end)

    elif period in ("month", "this_month"):
        start = today.replace(day=1)
        return str(start), str(today)

    elif period == "last_month":
        first_of_this = today.replace(day=1)
        last_of_prev  = first_of_this - timedelta(days=1)
        first_of_prev = last_of_prev.replace(day=1)
        return str(first_of_prev), str(last_of_prev)

    elif period in ("year", "this_year"):
        start = today.replace(month=1, day=1)
        return str(start), str(today)

    elif period == "last_year":
        y = today.year - 1
        return f"{y}-01-01", f"{y}-12-31"

    else:  # "all"
        return "2000-01-01", str(today)


def current_month() -> str:
    """Return current month as 'YYYY-MM'."""
    return datetime.now().strftime("%Y-%m")


def friendly_date(iso_date: str) -> str:
    """Convert YYYY-MM-DD to a friendly label like 'Today', 'Yesterday', 'Oct 25'."""
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d").date()
        today = datetime.now().date()
        if d == today:
            return "Today"
        elif d == today - timedelta(days=1):
            return "Yesterday"
        elif d >= today - timedelta(days=6):
            return d.strftime("%A")   # e.g. "Monday"
        else:
            return d.strftime("%b %d")  # e.g. "Oct 25"
    except Exception:
        return iso_date
