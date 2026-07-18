"""
Intent parser for VoxLedger voice commands — v9.4 FULL OVERHAUL

Changes in v9.4:
  - Period detection: "last month", "last week", "yesterday", "last year" all mapped correctly
  - Category spending queries: "show food spending this week" → query_spending + category
  - Create category: now actually supported (stored as custom budget category)
  - Broken-English tolerance: very short utterances with amounts always try add_expense
  - Improved: "add 300" → awaiting_category (not unknown)
  - "What did I spend today/last month" properly resolves period
  - Stop command covers interruption phrases
"""
import re
from typing import Dict, Any, Optional

CATEGORY_KEYWORDS: Dict[str, list] = {
    "Food":          ["food", "groceries", "grocery", "restaurant", "cafe", "coffee", "lunch",
                      "dinner", "breakfast", "swiggy", "zomato", "pizza", "burger", "snack",
                      "eat", "meal", "hotel", "canteen", "tiffin", "chai", "tea", "biryani",
                      "chicken", "rice", "vegetables", "milk", "bread", "bakery", "dosa",
                      "idli", "paratha", "samosa", "juice", "takeaway", "delivery"],
    "Transport":     ["transport", "uber", "ola", "cab", "bus", "auto", "metro", "petrol",
                      "fuel", "train", "ticket", "travel", "ride", "taxi", "rickshaw", "bike",
                      "scooter", "toll", "parking", "flight", "rapido", "commute", "fare"],
    "Shopping":      ["shopping", "amazon", "flipkart", "clothes", "shirt", "shoe", "mall",
                      "buy", "purchase", "order", "myntra", "dress", "trouser", "kurta",
                      "saree", "watch", "bag", "meesho", "ajio", "jeans", "jacket", "slipper"],
    "Entertainment": ["entertainment", "movie", "cinema", "netflix", "spotify", "youtube",
                      "game", "gaming", "prime", "hotstar", "concert", "show", "theatre",
                      "park", "outing", "pvr", "inox", "subscription", "fun", "leisure"],
    "Utilities":     ["utility", "utilities", "electricity", "water", "gas", "internet",
                      "wifi", "broadband", "phone bill", "recharge", "jio", "airtel", "vi",
                      "bsnl", "bill", "emi", "insurance", "mobile recharge", "data"],
    "Healthcare":    ["health", "healthcare", "doctor", "medicine", "pharmacy", "hospital",
                      "medical", "clinic", "dentist", "tablet", "injection", "diagnostic",
                      "lab", "test", "scan", "surgery", "capsule", "syrup", "checkup"],
    "Housing":       ["rent", "house", "housing", "maintenance", "society", "flat",
                      "apartment", "landlord", "deposit", "repair", "plumber", "electrician",
                      "carpenter", "pg", "hostel", "room rent"],
    "Education":     ["education", "course", "book", "tuition", "school", "college", "fees",
                      "udemy", "coursera", "coaching", "class", "exam", "stationery",
                      "pen", "notebook", "study", "certificate", "training"],
    "Income":        ["salary", "income", "freelance", "bonus", "payment received", "credit",
                      "got salary", "received salary", "payday", "commission", "profit",
                      "dividend", "stipend", "earnings", "got paid", "received money"],
    "Others":        ["other", "misc", "miscellaneous", "general", "gift", "donation",
                      "charity", "puja", "festival", "wedding"],
}

_CATEGORY_BUDGET_MAP = {
    # Food — including Whisper mishearing phonetic variants
    "food":          "Food",
    "foods":         "Food",
    "full":          "Food",   # Whisper mishears "food" as "full"
    "fool":          "Food",   # Whisper mishears "food" as "fool"
    "flood":         "Food",   # Whisper mishears "food" as "flood"
    "fud":           "Food",
    "groceries":     "Food",
    "grocery":       "Food",
    # Transport — phonetic variants
    "transport":     "Transport",
    "transportation":"Transport",
    "travel":        "Transport",
    "travels":       "Transport",
    "transit":       "Transport",
    # Shopping
    "shopping":      "Shopping",
    "shop":          "Shopping",
    # Entertainment
    "entertainment": "Entertainment",
    "entertain":     "Entertainment",
    # Utilities
    "utilities":     "Utilities",
    "utility":       "Utilities",
    "bills":         "Utilities",
    # Healthcare
    "healthcare":    "Healthcare",
    "health":        "Healthcare",
    "medical":       "Healthcare",
    # Housing
    "housing":       "Housing",
    "rent":          "Housing",
    "house":         "Housing",
    # Education
    "education":     "Education",
    "edu":           "Education",
    "school":        "Education",
    # Others
    "others":        "Others",
    "other":         "Others",
    "misc":          "Others",
    # Monthly/overall — checked LAST so category names take priority
    "overall":       "monthly",
    "monthly":       "monthly",
    "total":         "monthly",
}
# Category-first iteration: specific categories before "monthly" fallback
# The map is ordered — Python 3.7+ preserves insertion order.
# Monthly keywords are at the END so category names always win.

_SETTINGS_VERBS = r'\b(set|sit|put|fix|update|change|modify|adjust|make|keep|maintain|update my|change my|set my|sit my)\b'


def detect_category(text: str) -> str:
    lower = text.lower()
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if re.search(r'\b' + re.escape(kw.lower()) + r'\b', lower):
                return cat
    return "Others"


def extract_amount(text: str) -> Optional[float]:
    """Extract numeric amount from natural speech (including word forms)."""
    text = text.lower()
    # Strip thousands-separator commas FIRST: "60,000"→"60000", "1,50,000"→"150000"
    # Matches any comma that sits between digits (handles both Western and Indian formats)
    text = re.sub(r'(?<=\d),(?=\d)', '', text)
    replacements = [
        (r'\b(one\s+hundred\s+thousand)\b',   '100000'),
        (r'\b(two\s+hundred\s+thousand)\b',   '200000'),
        (r'\b(five\s+hundred\s+thousand)\b',  '500000'),
        (r'\b(one\s+lakh|ek\s+lakh)\b',       '100000'),
        (r'\b(ninety\s+five\s+thousand)\b',  '95000'),
        (r'\b(ninety\s+thousand)\b',           '90000'),
        (r'\b(eighty\s+five\s+thousand)\b',   '85000'),
        (r'\b(eighty\s+thousand)\b',           '80000'),
        (r'\b(seventy\s+five\s+thousand)\b',  '75000'),
        (r'\b(seventy\s+thousand)\b',          '70000'),
        (r'\b(sixty\s+five\s+thousand)\b',    '65000'),
        (r'\b(sixty\s+thousand)\b',            '60000'),
        (r'\b(fifty\s+five\s+thousand)\b',    '55000'),
        (r'\b(fifty\s+thousand|pacha\s+hazar)\b', '50000'),
        (r'\b(forty\s+five\s+thousand)\b',    '45000'),
        (r'\b(forty\s+thousand)\b',            '40000'),
        (r'\b(thirty\s+five\s+thousand)\b',   '35000'),
        (r'\b(thirty\s+thousand)\b',           '30000'),
        (r'\b(twenty\s+five\s+thousand)\b',   '25000'),
        (r'\b(twenty\s+thousand|bees\s+hazar)\b', '20000'),
        (r'\b(fifteen\s+thousand)\b',          '15000'),
        (r'\b(twelve\s+thousand)\b',           '12000'),
        (r'\b(eleven\s+thousand)\b',           '11000'),
        (r'\b(ten\s+thousand|das\s+hazar)\b', '10000'),
        (r'\b(nine\s+thousand)\b',             '9000'),
        (r'\b(eight\s+thousand)\b',            '8000'),
        (r'\b(seven\s+thousand)\b',            '7000'),
        (r'\b(six\s+thousand)\b',              '6000'),
        (r'\b(five\s+thousand|paanch\s+hazar)\b', '5000'),
        (r'\b(four\s+thousand|chaar\s+hazar)\b', '4000'),
        (r'\b(three\s+thousand|teen\s+hazar)\b', '3000'),
        (r'\b(two\s+thousand|do\s+hazar)\b',  '2000'),
        (r'\b(one\s+thousand|ek\s+hazar|thousand)\b', '1000'),
        (r'\b(nine\s+hundred)\b', '900'),
        (r'\b(eight\s+hundred)\b', '800'),
        (r'\b(seven\s+hundred)\b', '700'),
        (r'\b(six\s+hundred)\b', '600'),
        (r'\b(five\s+hundred|paanch\s+sau)\b', '500'),
        (r'\b(four\s+hundred|chaar\s+sau)\b', '400'),
        (r'\b(three\s+hundred|teen\s+sau)\b', '300'),
        (r'\b(two\s+hundred|do\s+sau)\b', '200'),
        (r'\b(one\s+hundred|ek\s+sau|hundred)\b', '100'),
        (r'\b(ninety)\b', '90'), (r'\b(eighty)\b', '80'),
        (r'\b(seventy)\b', '70'), (r'\b(sixty)\b', '60'),
        (r'\b(fifty|pachas)\b', '50'), (r'\b(forty)\b', '40'),
        (r'\b(thirty)\b', '30'), (r'\b(twenty|bees)\b', '20'),
        (r'\b(ten|das)\b', '10'),
    ]
    for pat, rep in replacements:
        text = re.sub(pat, rep, text)
    text = re.sub(r'(\d+(?:\.\d+)?)\s*k\b', lambda m: str(int(float(m.group(1)) * 1000)), text)
    text = re.sub(r'(\d+(?:\.\d+)?)\s*lakh\b', lambda m: str(int(float(m.group(1)) * 100000)), text)

    patterns = [
        r'₹\s*(\d+(?:\.\d+)?)',
        r'(\d+(?:\.\d+)?)\s*(?:rupees?|rs\.?|inr|/-)',
        r'(?:rs|inr)\s*\.?\s*(\d+(?:\.\d+)?)',
        r'(\d+(?:\.\d+)?)',
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if val > 0:
                return val
    return None


def _normalize(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r'^(hey\s*vox[,.]?\s*|hi\s*vox[,.]?\s*|ok\s*vox[,.]?\s*|okay\s*vox[,.]?\s*|vox[,.]?\s+)', '', text)
    text = re.sub(r'^(please\s+|can you\s+|could you\s+|i want to\s+|i need to\s+|kindly\s+|just\s+)', '', text)
    return text.strip()


OFF_TOPIC_PATTERNS = [
    r'\b(who is|who was|where is|how does|why does)\b.{5,}.*(president|prime minister|ceo|founder|born|history|capital|war)',
    r'\b(weather|temperature|rain forecast)\b',
    r'\b(cricket score|football|ipl score)\b',
    r'\b(joke|poem|song lyrics|music recommendation)\b',
    r'\b(translate|synonym for|grammar check)\b',
    r'\b(relationship advice|love advice|weight loss|diet plan)\b',
]

FINANCE_PASSTHROUGH = [
    "add", "spent", "spend", "paid", "pay", "expense", "income", "salary", "budget",
    "transaction", "balance", "summary", "rupee", "rs", "₹", "notification", "alert",
    "profile", "dashboard", "home", "show", "open", "navigate", "how much", "total",
    "received", "got", "earned", "set", "money", "finance", "purchase", "bought", "bill",
    "delete", "remove", "update", "edit", "change", "last", "recent", "today", "week",
    "month", "year", "yesterday", "category", "food", "transport", "shopping",
    "dark", "theme", "voice sample", "voice profile", "authentication", "conversation",
]


def is_off_topic(text: str) -> bool:
    lower = text.lower()
    for term in FINANCE_PASSTHROUGH:
        if term in lower:
            return False
    if len(lower.split()) <= 4:
        return False
    for pat in OFF_TOPIC_PATTERNS:
        if re.search(pat, lower, re.IGNORECASE):
            return True
    is_question = lower.split()[0] in ["what", "who", "where", "when", "why", "how", "can", "tell", "explain"]
    has_numbers = bool(re.search(r'\d', lower))
    has_finance = any(t in lower for t in ["money", "finance", "budget", "expense", "income", "balance", "rupee", "spend", "earn", "cost", "pay"])
    if is_question and not has_numbers and not has_finance and len(lower) > 50:
        return True
    return False


def _detect_budget_category(text: str) -> str:
    """
    Detect which budget category is being set.
    Checks specific categories FIRST, monthly keywords LAST.
    Handles Whisper phonetic mishearings (food→full, transport→travels, etc.)
    """
    lower = text.lower()
    # Pass 1: check specific (non-monthly) categories first
    for kw, cat in _CATEGORY_BUDGET_MAP.items():
        if cat == "monthly":
            continue  # skip monthly keywords in first pass
        if re.search(r'\b' + re.escape(kw) + r'\b', lower):
            return cat
    # Pass 2: only if no specific category found, check monthly keywords
    monthly_kws = ["monthly", "overall", "total", "all budget", "my budget",
                   "whole budget", "entire budget", "full budget"]
    for kw in monthly_kws:
        if kw in lower:
            return "monthly"
    # Pass 3: if text mentions a category word adjacent to "budget", extract it
    cat_match = re.search(
        r'\b(food|foods|transport|transportation|shopping|entertainment|'
        r'utilities|utility|healthcare|health|housing|rent|education|others?)\b',
        lower
    )
    if cat_match:
        word = cat_match.group(1)
        return _CATEGORY_BUDGET_MAP.get(word, word.capitalize())
    return "monthly"


def _detect_period(lower: str) -> Optional[str]:
    """
    Detect time period from natural language — supports:
    today, yesterday, this week, last week, this month, last month, this year, last year
    """
    # last X — check before "this X" to avoid ambiguity
    if re.search(r'\blast\s+month\b|\bprevious\s+month\b', lower):      return "last_month"
    if re.search(r'\blast\s+week\b|\bprevious\s+week\b', lower):        return "last_week"
    if re.search(r'\blast\s+year\b|\bprevious\s+year\b', lower):        return "last_year"
    if re.search(r'\byesterday\b', lower):                               return "yesterday"
    if re.search(r'\btoday\b', lower):                                   return "today"
    if re.search(r'\b(this\s+)?week\b', lower):                          return "week"
    if re.search(r'\b(this\s+)?month\b', lower):                         return "month"
    if re.search(r'\b(this\s+)?year\b', lower):                          return "year"
    return None


def _is_settings_command(lower: str) -> bool:
    has_settings_verb = bool(re.search(_SETTINGS_VERBS, lower))
    has_settings_target = bool(re.search(r'(budget|income|salary|limit|cap|threshold)', lower))
    return has_settings_verb and has_settings_target


def parse_intent(text: str) -> Dict[str, Any]:
    """Parse voice text into structured intent dict."""
    original = text
    lower = _normalize(text)

    result: Dict[str, Any] = {
        "intent":      "unknown",
        "amount":      None,
        "category":    None,
        "description": None,
        "page":        None,
        "period":      None,
        "tx_id":       None,
        "raw_text":    original,
        "target_section": None,
        "query_kind": None,
    }

    if is_off_topic(lower):
        result["intent"] = "off_topic"
        return result

    # ── Stop ─────────────────────────────────────────────────────
    if re.search(r'^(stop|enough|quiet|shut up|be quiet|silence|cancel|abort|stop talking|stop speaking|thats enough|that\'s enough|ok stop|okay stop|stop it|no more)[\s!.]*$', lower):
        result["intent"] = "stop"
        return result

    # ── Greeting ──────────────────────────────────────────────────
    if re.search(r'^(hello|hi|hey|good\s+(morning|evening|afternoon|night)|namaste|namaskar|hola|wassup)[\s!.]*$', lower):
        result["intent"] = "greeting"
        return result

    # ── Help ──────────────────────────────────────────────────────
    if re.search(r'\b(help|what can you do|what commands|features|how do i use|assist)\b', lower):
        result["intent"] = "help"
        return result

    # ── Create category ───────────────────────────────────────────
    if re.search(r'\b(add|create|new)\b.{0,20}\b(budget\s+)?categor(y|ies)\b', lower):
        result["intent"] = "create_category"
        # Try to extract the new category name
        name_match = re.search(r'\b(?:called|named?|category)\s+([a-zA-Z][a-zA-Z\s]{1,20})', lower)
        if not name_match:
            name_match = re.search(r'categor(?:y|ies)\s+(?:for\s+)?([a-zA-Z][a-zA-Z\s]{1,20})', lower)
        result["description"] = name_match.group(1).strip() if name_match else None
        return result

    # ═══════════════════════════════════════════════════════════════
    # SETTINGS COMMANDS — checked BEFORE any transaction logic
    # ═══════════════════════════════════════════════════════════════

    # ── SET MONTHLY INCOME ────────────────────────────────────────
    _income_signals = [
        r'\b(set|sit|update|change|modify|adjust|put|fix)\b.{0,40}\b(monthly\s+)?income\b',
        r'\b(set|sit|update|change|modify|adjust|put|fix)\b.{0,40}\bsalary\b',
        r'\b(monthly\s+)?income\b.{0,20}\b(to|is|at|as|=)\b',
        r'\bmy\s+(monthly\s+)?(salary|income)\s+is\b',
        r'\bi\s+(earn|make|get)\b.{0,20}\b(per\s+month|monthly|a\s+month)\b',
        r'\bsalary\s+(is|to|=)\b',
    ]
    if any(re.search(p, lower) for p in _income_signals):
        amt = extract_amount(lower)
        result["intent"] = "set_income"
        result["amount"] = amt
        result["target_section"] = "Dashboard → Monthly Income"
        return result

    # ── DELETE BUDGET ─────────────────────────────────────────
    # Must be checked BEFORE set_budget so "delete budget" doesn't fall to transaction delete.
    _del_budget_pats = [
        r'\b(delete|remove|clear|erase|discard|cancel)\b.{0,30}\bbudget\b',
        r'\bbudget\b.{0,30}\b(delete|remove|clear|erase|discard|cancel)\b',
    ]
    if any(re.search(p, lower) for p in _del_budget_pats):
        budget_cat = _detect_budget_category(lower)
        result["intent"] = "delete_budget"
        result["category"] = budget_cat
        result["target_section"] = "Budget Page"
        return result

    # ── SET / CREATE BUDGET (monthly OR category) ─────────────────────────
    _budget_signals = [
        r'\b(set|sit|update|change|modify|adjust|put|fix|make)\b.{0,50}\bbudget\b',
        r'\bbudget\b.{0,30}\b(to|is|at|as|should\s+be|=)\b',
        r'\b(monthly|overall|total|all)\s+budget\b',
        r'\b(food|travel|transport|shopping|entertainment|utilities|utility|healthcare|health|housing|rent|education|edu|bills)\s+budget\b',
        # NEW: "create budget / add budget / new budget" variants
        r'\b(create|add|make|new|start|setup|set up)\b.{0,30}\bbudget\b',
        r'\bbudget\b.{0,30}\b(for|on|under)\b',
        r'\b(allocate|assign)\b.{0,20}\b(food|travel|transport|shopping|entertainment|utilities|utility|healthcare|health|housing|rent|education|edu|bills|category)\b',
    ]
    if any(re.search(p, lower) for p in _budget_signals):
        amt = extract_amount(lower)
        budget_cat = _detect_budget_category(lower)
        result["intent"] = "set_budget"
        result["amount"] = amt
        result["category"] = budget_cat
        if budget_cat == "monthly":
            result["target_section"] = "Budget Page → Monthly Budget"
        else:
            result["target_section"] = f"Budget Page → {budget_cat} Category"
        return result

    # ═══════════════════════════════════════════════════════════════
    # TRANSACTION COMMANDS
    # ═══════════════════════════════════════════════════════════════

    # ── Query transaction by position ─────────────────────────────────────────
    # "What is my first expense?" / "Show my last expense" / "second transaction"
    # Must be checked BEFORE delete_transaction and add_expense so that
    # "first expense" isn't caught by the expense_triggers catch-all.
    _TX_QUERY_ORDINALS = r'\b(first|second|third|fourth|fifth|last|latest|recent|oldest|newest|1st|2nd|3rd|4th|5th)\b'
    _TX_QUERY_NOUNS    = r'\b(expense|transaction|payment|entry|record|purchase)\b'
    _tx_query_pats = [
        # "what is my first expense" / "what was my last transaction"
        r'\b(what|show|tell|get|fetch|find|give).{0,20}' + _TX_QUERY_ORDINALS + r'.{0,10}' + _TX_QUERY_NOUNS,
        # "my first expense" / "my last transaction"
        r'\bmy\s+' + _TX_QUERY_ORDINALS + r'\s+' + _TX_QUERY_NOUNS,
        # "first expense" / "second transaction" (bare ordinal + noun)
        _TX_QUERY_ORDINALS + r'\s+' + _TX_QUERY_NOUNS,
        # "show first expense" / "view last transaction"
        r'\b(show|view|display|see|check)\s+' + _TX_QUERY_ORDINALS + r'\s+' + _TX_QUERY_NOUNS,
    ]
    _has_delete_verb = bool(re.search(r'\b(delete|remove|undo|erase|discard)\b', lower))
    for _tqp in _tx_query_pats:
        if not _has_delete_verb and re.search(_tqp, lower, re.IGNORECASE):
            # Extract which position the user wants
            _ordinal_map = [
                ("first",  0), ("1st",    0),
                ("second", 1), ("2nd",    1),
                ("third",  2), ("3rd",    2),
                ("fourth", 3), ("4th",    3),
                ("fifth",  4), ("5th",    4),
                ("last",  -1), ("latest", -1), ("recent", -1), ("newest", -1),
                ("oldest",  0),  # "oldest" = first chronologically
            ]
            _pos_idx = None
            for _word, _idx in _ordinal_map:
                if re.search(r'\b' + re.escape(_word) + r'\b', lower):
                    _pos_idx = _idx
                    break
            result["intent"]    = "query_transaction"
            result["tx_pos"]    = _pos_idx  # 0-based index into oldest-first list; -1 = last
            result["target_section"] = "Transactions"
            return result

    # ── Delete transaction ────────────────────────────────────────
    if re.search(r'\b(delete|remove|undo|erase|discard|cancel)\b', lower):
        result["intent"] = "delete_transaction"
        id_match = re.search(r'(?:number|id|#)\s*(\d+)', lower)
        if id_match:
            result["tx_id"] = int(id_match.group(1))
        # Detect category mentioned (e.g. "delete last food transaction", "delete skincare transaction")
        _del_cat = detect_category(lower)
        if _del_cat and _del_cat != "Others":
            result["category"] = _del_cat
        # Detect positional ordinal (first/second/last/recent)
        _del_ordinal_map = [
            ("first",  0), ("1st",    0),
            ("second", 1), ("2nd",    1),
            ("third",  2), ("3rd",    2),
            ("fourth", 3), ("4th",    3),
            ("fifth",  4), ("5th",    4),
            ("last",  -1), ("latest", -1), ("recent", -1), ("newest", -1),
            ("oldest",  0),
        ]
        for _dw, _di in _del_ordinal_map:
            if re.search(r'\b' + re.escape(_dw) + r'\b', lower):
                result["tx_pos"] = _di
                break
        result["raw_text"] = lower
        result["target_section"] = "Transactions"
        return result

    # ── Update transaction ────────────────────────────────────────
    if re.search(r'\b(update|edit|change|modify|correct|fix|amend)\b', lower) and re.search(r'\b(transaction|expense|entry|record|payment)\b', lower):
        result["intent"] = "update_transaction"
        id_match = re.search(r'(?:number|id|#)\s*(\d+)', lower)
        if id_match:
            result["tx_id"] = int(id_match.group(1))
        amt = extract_amount(lower)
        if amt:
            result["amount"] = amt
        result["category"] = detect_category(lower) if detect_category(lower) != "Others" else None
        result["target_section"] = "Transactions"
        return result

    # ── Navigate ──────────────────────────────────────────────────
    nav_map = {
        "budget":        "/budget",
        "transaction":   "/transactions",
        "transactions":  "/transactions",
        "finance":       "/transactions",
        "spending":      "/transactions",
        "notification":  "/notifications",
        "notifications": "/notifications",
        "inbox":         "/notifications",
        "alert":         "/alerts",
        "alerts":        "/alerts",
        "profile":       "/profile",
        "setting":       "/profile",
        "settings":      "/profile",
        "account":       "/profile",
        "home":          "/",
        "dashboard":     "/",
        "main":          "/",
        "add voice sample": "/add-voice-profile",
        "voice sample":  "/add-voice-profile",
        "voice profile": "/add-voice-profile",
        "voice authentication": "/add-voice-profile",
        "conversation":  "/conversation",
        "chat":          "/conversation",
        "assistant":     "/conversation",
        "locked":        "/locked",
        "lock":          "/locked",
        "lock screen":   "/locked",
        "lock page":     "/locked",
    }
    nav_triggers = ["open", "go to", "navigate", "show", "take me to", "display",
                    "bring up", "load", "launch", "visit", "switch to", "go", "view"]

    for kw, page in nav_map.items():
        for trigger in nav_triggers:
            if re.search(r'\b' + re.escape(trigger) + r'\b', lower) and re.search(r'\b' + re.escape(kw) + r'\b', lower):
                result["intent"] = "navigate"
                result["page"] = page
                result["target_section"] = f"Navigate → {kw.title()}"
                return result
    for kw, page in nav_map.items():
        if re.fullmatch(re.escape(kw) + r'(\s+page)?', lower.strip()):
            result["intent"] = "navigate"
            result["page"] = page
            result["target_section"] = f"Navigate → {kw.title()}"
            return result

    # ── Add voice sample / profile ──────────────────────────────
    if re.search(r'\b(add|record|create|register|open|go to|navigate|need|want)\b.{0,30}\b(voice\s+sample|voice\s+profile|voice\s+authentication)\b', lower) or re.search(r'\b(one more|another|new)\b.{0,25}\b(voice\s+sample|voice\s+profile)\b', lower) or re.fullmatch(r'voice\s+authentication', lower.strip(' .!?')):
        result["intent"] = "add_voice_sample"
        result["target_section"] = "Profile → Add Voice Sample"
        return result

    # ── Add income (transaction) ──────────────────────────────────
    income_triggers = r'\b(received?|got paid|got\s+money|earned?|add income|record income|credited|deposited?|salary came)\b'
    income_amount_pats = [
        r'(?:received?|got paid|earned?|add income|record income|credited|deposited?)[^\d]{0,15}(?:₹\s*)?(\d[\d,.]*)[^\d]{0,20}(?:rupees?|rs\.?|inr)?(?:\s+(?:as|for|from)\s+(.+))?',
        r'(?:salary|bonus|freelance|commission|stipend)\s+(?:of\s+)?(?:₹\s*)?(\d[\d,.]*)',
        r'add\s+income\s+(?:of\s+)?(?:₹\s*)?(\d[\d,.]*)',
    ]
    if re.search(income_triggers, lower, re.IGNORECASE):
        for pat in income_amount_pats:
            m = re.search(pat, lower, re.IGNORECASE)
            if m:
                try:
                    amount = float(m.group(1).replace(',', ''))
                    desc = m.group(2).strip() if m.lastindex and m.lastindex >= 2 and m.group(2) else "income"
                    result["intent"] = "add_income"
                    result["amount"] = amount
                    result["description"] = desc
                    result["category"] = "Income"
                    result["title"] = desc.capitalize()
                    result["target_section"] = "Transactions → Income"
                    return result
                except ValueError:
                    pass
        result["intent"] = "add_income"
        result["category"] = "Income"
        result["description"] = "income"
        result["target_section"] = "Transactions → Income"
        return result

    # ── Spending query BEFORE expense parsing ──────────────────────────
    # Prevent questions like "how much did I spend" from being treated as add_expense.
    _EARLY_SPENDING_QUERY_PATS = [
        r'\bhow\s+much\b.{0,25}\b(i|did i|have i)?\b.{0,15}\b(spend|spent|paid|spending)\b',
        r'\btotal\s+(spending|spent|expenses?)\b',
        r'\bwhat\s+(is|was)\b.{0,20}\b(my\s+)?(total\s+)?(spending|spent|expenses?)\b',
    ]
    if any(re.search(p, lower, re.IGNORECASE) for p in _EARLY_SPENDING_QUERY_PATS):
        result["intent"] = "query_spending"
        result["period"] = _detect_period(lower) or "month"
        result["query_kind"] = "total_spending"
        result["target_section"] = "Dashboard → Summary"
        return result

    # ── Insights / analytics BEFORE expense parsing ──────────────
    if re.search(r'\b(insight|insights|analysis|analytics|spending\s+pattern|top\s+category|biggest\s+spend|where\s+am\s+i\s+spending|give\s+(me\s+)?(my\s+)?insight|show\s+(me\s+)?(my\s+)?insight|get\s+insight|my\s+insight)\b', lower):
        result["intent"] = "query_insights"
        result["period"] = _detect_period(lower) or "month"
        result["target_section"] = "Dashboard → Insights"
        return result

    # ── Add expense ───────────────────────────────────────────────
    expense_triggers = r'\b(add|spent?|spend|paid|pay|bought?|purchased?|give|deduct|used|cost|charged?|log(?:ged)?|note[d]?|record(?:ed)?|expense)\b'
    expense_pats = [
        r'(?:add(?:ed)?|spent?|spend|paid|pay|bought?|purchased?|deduct|log(?:ged)?|record(?:ed)?|charge[d]?)[^\d]{0,10}(?:an?\s+)?(?:expense\s+of\s+)?(?:₹\s*)?(\d[\d,.]*)[^\d]{0,5}(?:rupees?|rs\.?|inr)?(?:\s+(?:for|on|in|at|to|of|towards?)\s+(.+))?',
        r'(?:₹\s*)?(\d[\d,.]*)[^\d]{0,5}(?:rupees?|rs\.?|inr)\s*(?:for|on|in|at)?\s*(.+)',
        r'^(?:₹\s*)?(\d[\d,.]*)[^\d]{0,5}(?:for|on)\s+(.+)$',
        r'^([a-zA-Z][a-zA-Z\s]{1,25}?)\s+(?:₹\s*)?(\d[\d,.]*)[\s]*(?:rupees?|rs\.?|inr)?$',
        r'(?:spent?|paid)\s+(?:on|for)\s+([a-zA-Z\s]{2,25}?)\s+(?:₹\s*)?(\d[\d,.]*)',
    ]
    has_expense_trigger = bool(re.search(expense_triggers, lower))

    for i, pat in enumerate(expense_pats):
        m = re.search(pat, lower.strip(), re.IGNORECASE)
        if m:
            if i == 3:
                desc = m.group(1).strip()
                amount_str = m.group(2).replace(',', '')
            elif i == 4:
                desc = m.group(1).strip()
                amount_str = m.group(2).replace(',', '')
            else:
                amount_str = m.group(1).replace(',', '')
                desc = m.group(2).strip() if m.lastindex and m.lastindex >= 2 and m.group(2) else "expense"
            desc = re.sub(r'\b(rupees?|rs\.?|inr|please|okay|ok|thank you|thanks)\b', '', desc, flags=re.IGNORECASE).strip()
            desc = re.sub(r'\s+', ' ', desc).strip() or "expense"
            try:
                amount = float(amount_str)
            except ValueError:
                continue
            if amount <= 0:
                continue
            cat = detect_category(lower)
            result["intent"] = "add_expense"
            result["amount"] = amount
            result["description"] = desc
            result["category"] = cat
            result["title"] = desc.capitalize()
            result["target_section"] = f"Transactions → {cat}"
            return result

    # ── Spending query BEFORE expense catch-all ──────────────────────────────
    # "how much did i spend on food" / "what did i spend on education this month"
    # These contain expense-trigger words (spent/spend) but the INTENT is a QUERY.
    # Must be checked BEFORE the has_expense_trigger catch-all below.
    _CATEGORY_PAT = r'(food|foods|transport|transportation|shopping|entertainment|utilities|utility|healthcare|health|housing|rent|education|grocery|groceries|travel|bills|school|college)'
    _spend_query_pats = [
        # "how much i spent on X" / "how much did i spend on X"
        r'\b(how much|what).{0,20}\b(spent?|spend|paid|spend on|spent on)\b.{0,20}\b' + _CATEGORY_PAT + r'\b',
        # "what did i spend on education"
        r'\b(what|how much|tell me|show).{0,15}\b(did i|have i|i).{0,10}\b(spent?|spend|paid)\b.{0,20}\b(on|for)\b',
        # "how much spent on food" (dropped subject)
        r'\bhow much.{0,10}\b(spent?|spend|paid).{0,20}\b(on|for)\b',
        # "i spent on education" / "i spent in education"
        r'\bi\s+(spent?|spend|paid).{0,20}\b(on|in|for)\b',
        # "spent on education" (no subject — Whisper often drops "I")
        r'\bspent?\s+(on|in|for)\s+' + _CATEGORY_PAT + r'\b',
        # "X expense" / "my X expenses" / "what is my X expense"
        r'\b(my\s+|what.{0,15})?' + _CATEGORY_PAT + r'\s+expense[s]?\b',
        # "show X spending" / "check X spending"
        r'\b(show|check|see|view|display|what.{0,10})\s+' + _CATEGORY_PAT + r'\s+spend(ing)?\b',
        # "total spent on X" / "total spending on X"
        r'\b(total|overall)\s+(spent?|spend|spending|expenses?)\s+(on|in|for)\s+' + _CATEGORY_PAT + r'\b',
    ]
    for _sqp in _spend_query_pats:
        if re.search(_sqp, lower, re.IGNORECASE):
            cat = detect_category(lower)
            period = _detect_period(lower)
            result["intent"] = "query_spending"
            result["category"] = cat if cat != "Others" else None
            result["period"] = period
            return result

    # Word-form amount fallback for expense triggers
    if has_expense_trigger:
        amt = extract_amount(lower)
        cat = detect_category(lower)
        result["intent"] = "add_expense"
        result["amount"] = amt
        result["category"] = cat
        result["description"] = "expense"
        result["target_section"] = f"Transactions → {cat}"
        return result

    # ── Bare amount — "add 300" / just a number = likely add_expense ──────────
    bare_amount = extract_amount(lower)
    if bare_amount and len(lower.split()) <= 4:
        cat = detect_category(lower)
        result["intent"] = "add_expense"
        result["amount"] = bare_amount
        result["category"] = cat if cat != "Others" else None  # force category prompt
        result["description"] = lower.strip() or "expense"
        result["target_section"] = "Transactions"
        return result

    # ── Period detection (for query intents) ──────────────────────
    period = _detect_period(lower)

    # ── Category-specific spending query ─────────────────────────
    # "show food spending this week" / "how much on transport last month"
    cat_query_pats = [
        r'\b(show|how much|what|tell|check)\b.{0,30}\b(food|transport|shopping|entertainment|utilities|healthcare|housing|education)\b',
        r'\b(food|transport|shopping|entertainment|utilities|healthcare|housing|education)\b.{0,30}\b(spending|spent|expense|cost)\b',
    ]
    for cpat in cat_query_pats:
        m = re.search(cpat, lower)
        if m:
            # extract which category word matched
            cats_in_text = [c for c in ["food","transport","shopping","entertainment","utilities","healthcare","housing","education"] if c in lower]
            canon_cat = None
            for c in cats_in_text:
                canon_cat = _CATEGORY_BUDGET_MAP.get(c) or c.capitalize()
                break
            result["intent"] = "query_spending"
            result["period"] = period or "month"
            result["category"] = canon_cat
            result["target_section"] = "Dashboard → Category Spending"
            return result

    # ── Time/date-based transaction query ────────────────────────
    # "What is my transaction at 9:36 PM?"  "What did I spend on March 5?"
    # Must be checked BEFORE summary_pats which would otherwise steal these.
    _TIME_PAT  = r'\b(\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b'
    _DATE_PAT  = (
        r'\b(january|february|march|april|may|june|july|august|september|october|november|december|'
        r'jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b'
        r'|\b\d{1,2}(?:st|nd|rd|th)?\s+'
        r'(january|february|march|april|may|june|july|august|september|october|november|december|'
        r'jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b'
        r'|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b'
    )
    _TX_QUERY_NOUN = r'\b(transaction[s]?|expense[s]?|spending|spent|spend|payment[s]?|entry|entries)\b'
    _QUERY_VERB    = r'\b(what|show|find|get|check|list|tell|give|which|when|how much)\b'
    has_time  = bool(re.search(_TIME_PAT, lower, re.IGNORECASE))
    has_date  = bool(re.search(_DATE_PAT, lower, re.IGNORECASE))
    has_tx    = bool(re.search(_TX_QUERY_NOUN, lower, re.IGNORECASE))
    has_qverb = bool(re.search(_QUERY_VERB, lower, re.IGNORECASE))

    if has_time or (has_date and (has_tx or has_qverb)):
        # Extract time string if present
        _tm = re.search(_TIME_PAT, lower, re.IGNORECASE)
        # Extract date string if present
        _dt = re.search(_DATE_PAT, lower, re.IGNORECASE)
        result["intent"]       = "query_transactions_datetime"
        result["time_str"]     = _tm.group(0).strip() if _tm else None
        result["date_str"]     = _dt.group(0).strip() if _dt else None
        result["period"]       = _detect_period(lower) or "all"
        result["target_section"] = "Transactions"
        return result

    # ── Transaction count ─────────────────────────────────────────
    if re.search(r'\b(how\s+many|number\s+of|count|total)\b.{0,25}\b(transaction|transactions|expenses|expense\s+entries|entries)\b', lower):
        result["intent"] = "query_transaction_count"
        result["period"] = period or "month"
        result["target_section"] = "Transactions Page"
        return result

    # ── Insights ────────────────────────────────────────────────
    if re.search(r'\b(insight|insights|analysis|analytics|spending\s+pattern|top\s+category|biggest\s+spend|where\s+am\s+i\s+spending|give\s+(me\s+)?(my\s+)?insight|show\s+(me\s+)?(my\s+)?insight|get\s+insight|my\s+insight)\b', lower):
        result["intent"] = "query_insights"
        result["period"] = period or "month"
        result["target_section"] = "Dashboard → Insights"
        return result

    # ── Query spending / balance ──────────────────────────────────
    summary_pats = [
        r'\b(summary|balance|how much|spending|spent|total|overview|report|remaining|left|income|what do i have)\b',
        r'\b(show me|what is|tell me|give me|check|whats|what\'s)\b.{0,25}\b(balance|spending|budget|total|expense|income)\b',
        r'\bhow\s+(much|many)\b',
        r'\bwhat.*?(spend|spent|budget|balance|income|earn)\b',
        r'\b(my\s+)?(financial\s+)?(status|report|overview|summary)\b',
        r'\bmy\s+balance\b',
        r'\bcheck\s+(my\s+)?balance\b',
    ]
    if any(re.search(pat, lower) for pat in summary_pats):
        result["intent"] = "query_spending"
        result["period"] = period or "month"
        result["target_section"] = "Dashboard → Summary"

        if re.search(r'\bremaining\s+balance\b|\bbalance\s+left\b|\bwhat\s+do\s+i\s+have\s+left\b|\bmy\s+balance\b|\bcheck\s+(my\s+)?balance\b|\bwhat\s+(is\s+)?my\s+balance\b|\bwhat\'s\s+my\s+balance\b', lower):
            result["query_kind"] = "remaining_balance"
        elif re.search(r'\bremaining\s+income\b|\bincome\s+left\b', lower):
            result["query_kind"] = "remaining_income"
        elif re.search(r'\bremaining\s+budget\b|\bbudget\s+left\b', lower):
            result["query_kind"] = "remaining_budget"
        elif re.search(r'\bremaining\b.{0,20}\bbudget\b', lower) and re.search(r'\b(food|transport|shopping|entertainment|utilities|healthcare|housing|education|others?)\b', lower):
            result["query_kind"] = "category_remaining_budget"
            cat = detect_category(lower)
            if cat != "Others":
                result["category"] = cat
        elif re.search(r'\bhow\s+much\b.{0,25}\b(spend|spent|spending)\b|\btotal\s+(spending|spent|expenses?)\b', lower):
            result["query_kind"] = "total_spending"
        return result

    # ── Mark notifications as read ───────────────────────────────
    if re.search(r'\bmark\s+all\s+(?:notifications?\s+)?read\b', lower) or re.search(r'\bmark\b.{0,15}\b(?:all\s+)?notifications?\b.{0,10}\bas\s+read\b', lower) or re.search(r'\bmark\s+(?:the\s+)?read\s+notification\b', lower):
        result["intent"] = "mark_notification_read"
        result["target_section"] = "Notifications Page"
        return result

    # ── Read alerts ───────────────────────────────────────────────
    if re.search(r'\b(alert|alerts)\b', lower) and re.search(r'\b(read|show|open|view|check|see|tell|any)\b', lower):
        result["intent"] = "read_alerts"
        result["target_section"] = "Alerts Page"
        return result

    # ── Read notifications ────────────────────────────────────────
    if re.search(r'\b(notification|notifications|notify|remind|message|inbox|unread)\b', lower):
        result["intent"] = "read_notifications"
        result["target_section"] = "Notifications Page"
        return result

    # ── Show transactions ─────────────────────────────────────────
    if re.search(r'\b(transaction|history|list|recent|previous|past|record)\b', lower):
        result["intent"] = "show_transactions"
        result["period"] = period or "month"
        result["target_section"] = "Transactions Page"
        return result

    # ── Dark mode / Light mode ─────────────────────────────────────
    # Check turn-off FIRST so "turn off dark mode" doesn't match the generic "dark mode" pattern
    if re.search(r'\b(turn\s+off|disable|deactivate|switch\s+off)\b.{0,20}\bdark\b', lower):
        result["intent"] = "dark_mode"
        result["value"] = "off"
        return result
    if re.search(r'\b(light\s*mode|light\s*theme|day\s*mode|bright\s*mode)\b', lower):
        result["intent"] = "dark_mode"
        result["value"] = "off"
        return result
    if re.search(r'\b(dark\s*mode|dark\s*theme|night\s*mode|dark\s*screen)\b', lower):
        result["intent"] = "dark_mode"
        result["value"] = "on"
        return result
    if re.search(r'\b(turn\s+on|enable|activate|switch\s+on)\b.{0,20}\bdark\b', lower):
        result["intent"] = "dark_mode"
        result["value"] = "on"
        return result

    # ── User info: name, profile ───────────────────────────────────
    if re.search(r'\b(what\s+is\s+my\s+name|who\s+am\s+i|my\s+name|tell\s+me\s+my\s+name|show\s+my\s+name)\b', lower):
        result["intent"] = "user_info"
        result["field"] = "name"
        return result
    if re.search(r'\b(my\s+profile|my\s+account|user\s+info|who\s+is\s+logged\s+in)\b', lower):
        result["intent"] = "user_info"
        result["field"] = "profile"
        return result
    if re.search(r'\b(monthly\s+income|my\s+income|salary)\b', lower) and re.search(r'\b(what|show|tell)\b', lower):
        result["intent"] = "user_info"
        result["field"] = "income"
        return result
    if re.search(r'\b(voice\s+samples?|voice\s+profiles?)\b', lower) and re.search(r'\b(how\s+many|show|tell|count|number\s+of)\b', lower):
        result["intent"] = "user_info"
        result["field"] = "voice_samples"
        return result

    # ── Catch-all off_topic for unknown / unrelated requests ─────
    question_starters = {"what", "who", "where", "when", "why", "how",
                         "tell", "explain", "describe", "define", "recommend",
                         "suggest", "give", "find", "search", "lookup"}
    off_topic_verbs   = {"recommend", "suggest", "tell", "explain", "describe", "define",
                         "find", "search", "translate", "convert", "calculate"}
    first_word = lower.split()[0] if lower.split() else ""
    has_question_or_request = first_word in question_starters
    has_finance_word = any(w in lower for w in [
        "money", "finance", "budget", "expense", "income", "balance", "rupee",
        "spend", "earn", "cost", "pay", "transaction", "salary", "saving",
        "my name", "my profile", "my account", "vox", "app", "this app",
        "notification", "alert", "category", "add", "set", "open", "show",
    ])
    # Explicit off-topic phrases
    off_topic_phrases = [
        r"\b(joke|jokes|funny|humor)\b",
        r"\b(movie|film|series|song|music|game|sport)\b.{0,20}\b(recommend|suggest|good|best)\b",
        r"\b(recommend|suggest)\b.{0,20}\b(movie|film|series|song|book|restaurant|food)\b",
        r"\b(weather|temperature|forecast|rain|sunny)\b",
        r"\b(cricket|football|ipl|match|score)\b",
        r"\b(capital\s+of|president\s+of|pm\s+of|history\s+of)\b",
    ]
    if any(re.search(p, lower) for p in off_topic_phrases):
        result["intent"] = "off_topic"
        return result
    if has_question_or_request and not has_finance_word and len(lower.split()) >= 3:
        result["intent"] = "off_topic"
        return result

    return result
