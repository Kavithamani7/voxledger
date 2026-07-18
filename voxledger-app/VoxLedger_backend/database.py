import sqlite3
import os
from pathlib import Path
from config import settings

# Ensure database directory exists
Path(settings.DATABASE_PATH).parent.mkdir(parents=True, exist_ok=True)
Path(settings.VOICE_SAMPLE_DIR).mkdir(parents=True, exist_ok=True)
Path(settings.TTS_DIR).mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    """Return a SQLite connection with row factory set."""
    conn = sqlite3.connect(settings.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables if they don't exist."""
    conn = get_connection()
    cursor = conn.cursor()

    # ── users ──────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            password    TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── voice_embeddings ───────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS voice_embeddings (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL,
            sample_path TEXT,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── transactions ───────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title       TEXT    NOT NULL,
            amount      REAL    NOT NULL,
            category    TEXT    NOT NULL DEFAULT 'Other',
            description TEXT    DEFAULT '',
            tx_date     TEXT    NOT NULL DEFAULT (date('now')),
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── budgets ────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS budgets (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category    TEXT    NOT NULL DEFAULT 'monthly',
            amount      REAL    NOT NULL,
            month       TEXT    NOT NULL DEFAULT (strftime('%Y-%m', 'now')),
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(user_id, category, month)
        )
    """)

    # ── notifications ──────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title       TEXT    NOT NULL,
            message     TEXT    NOT NULL,
            notif_type  TEXT    NOT NULL DEFAULT 'info',
            is_read     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── conversation_history ───────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversation_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role        TEXT    NOT NULL CHECK(role IN ('user','assistant')),
            content     TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── pending_intents (multi-turn conversation state) ────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pending_intents (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            intent        TEXT    NOT NULL,
            amount        REAL,
            category      TEXT,
            description   TEXT,
            step          TEXT    NOT NULL DEFAULT 'awaiting_category',
            updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # ── user_settings (monthly income, preferences) ────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            monthly_income  REAL    NOT NULL DEFAULT 0.0,
            updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)

    conn.commit()
    conn.close()
    print("✅  Database initialised successfully.")
