"""
Run this script to clear all user data and start fresh.
Usage: python reset_db.py
"""
import os
import sqlite3
from pathlib import Path

db_path = Path(__file__).parent / "database" / "voxledger.db"

if db_path.exists():
    conn = sqlite3.connect(str(db_path))
    conn.execute("DELETE FROM voice_embeddings")
    conn.execute("DELETE FROM notifications")
    conn.execute("DELETE FROM transactions")
    conn.execute("DELETE FROM budgets")
    conn.execute("DELETE FROM conversation_history")
    conn.execute("DELETE FROM users")
    conn.commit()
    conn.close()
    print("✅ All user data cleared. You can now register fresh at http://localhost:5173")
else:
    print("No database found — nothing to clear.")
