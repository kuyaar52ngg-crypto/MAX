import sqlite3
import os
import sys
from datetime import datetime

def get_data_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(get_data_path(), 'data', 'max_bot.db')


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Создание таблиц при первом запуске + миграции."""
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS broadcasts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT NOT NULL,
                message     TEXT NOT NULL,
                total       INTEGER DEFAULT 0,
                sent        INTEGER DEFAULT 0,
                not_found   INTEGER DEFAULT 0,
                failed      INTEGER DEFAULT 0,
                status      TEXT DEFAULT 'running',
                file_url    TEXT,
                file_name   TEXT,
                use_typing  INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS recipients (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                broadcast_id    INTEGER NOT NULL,
                phone           TEXT NOT NULL,
                status          TEXT NOT NULL,
                message_id      TEXT,
                delivery_status TEXT DEFAULT 'pending',
                sent_at         TEXT,
                FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id)
            );

            CREATE TABLE IF NOT EXISTS templates (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                text       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incoming (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                sender      TEXT NOT NULL,
                sender_name TEXT,
                message     TEXT,
                type        TEXT DEFAULT 'text',
                file_url    TEXT,
                received_at TEXT NOT NULL,
                is_read     INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS delivery_statuses (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id  TEXT NOT NULL UNIQUE,
                status      TEXT NOT NULL,
                timestamp   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS groups (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id    TEXT NOT NULL UNIQUE,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS hidden_groups (
                group_id    TEXT PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS contacts_cache (
                chat_id     TEXT PRIMARY KEY,
                name        TEXT,
                avatar_url  TEXT,
                updated_at  INTEGER DEFAULT 0
            );
        """)

        # Миграции: добавляем колонки если их ещё нет
        _migrate(conn)


def _migrate(conn):
    """Добавляем новые колонки в существующие таблицы без потери данных."""
    migrations = [
        ("broadcasts",  "file_url",    "ALTER TABLE broadcasts ADD COLUMN file_url TEXT"),
        ("broadcasts",  "file_name",   "ALTER TABLE broadcasts ADD COLUMN file_name TEXT"),
        ("broadcasts",  "use_typing",  "ALTER TABLE broadcasts ADD COLUMN use_typing INTEGER DEFAULT 0"),
        ("recipients",  "delivery_status", "ALTER TABLE recipients ADD COLUMN delivery_status TEXT DEFAULT 'pending'"),
        ("incoming",    "sender_name", "ALTER TABLE incoming ADD COLUMN sender_name TEXT"),
        ("incoming",    "file_url",    "ALTER TABLE incoming ADD COLUMN file_url TEXT"),
        ("incoming",    "is_read",     "ALTER TABLE incoming ADD COLUMN is_read INTEGER DEFAULT 0"),
    ]
    for table, col, sql in migrations:
        try:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            if col not in cols:
                conn.execute(sql)
                conn.commit()
        except Exception:
            pass  # Колонка уже существует или таблица не найдена


# ── CONTACTS CACHE ──────────────────────────────────────────────────

def get_contacts_cache(chat_ids: list) -> dict:
    """Returns cached contact info as {chat_id: {name, avatar_url, updated_at}}"""
    if not chat_ids:
        return {}
    placeholders = ','.join('?' * len(chat_ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT chat_id, name, avatar_url, updated_at FROM contacts_cache WHERE chat_id IN ({placeholders})",
            chat_ids
        ).fetchall()
    return {r['chat_id']: dict(r) for r in rows}


def upsert_contact_cache(chat_id: str, name: str = None, avatar_url: str = None):
    """Insert or update cached contact info."""
    import time
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO contacts_cache (chat_id, name, avatar_url, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(chat_id) DO UPDATE SET
                 name       = excluded.name,
                 avatar_url = excluded.avatar_url,
                 updated_at = excluded.updated_at""",
            (chat_id, name, avatar_url, int(time.time()))
        )



# ── BROADCASTS ────────────────────────────────────────────────────────────────

def create_broadcast(message, total, file_url=None, file_name=None, use_typing=False):
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO broadcasts
               (created_at, message, total, file_url, file_name, use_typing)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (datetime.now().isoformat(timespec='seconds'), message, total,
             file_url, file_name, 1 if use_typing else 0)
        )
        return cur.lastrowid


def update_broadcast_stats(broadcast_id, sent, not_found, failed, status='done'):
    with get_conn() as conn:
        conn.execute(
            """UPDATE broadcasts
               SET sent=?, not_found=?, failed=?, status=?
               WHERE id=?""",
            (sent, not_found, failed, status, broadcast_id)
        )


def add_recipient(broadcast_id, phone, status, message_id=None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO recipients (broadcast_id, phone, status, message_id, sent_at)
               VALUES (?, ?, ?, ?, ?)""",
            (broadcast_id, phone, status, message_id,
             datetime.now().isoformat(timespec='seconds'))
        )


def get_broadcasts(limit=50):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_broadcast_recipients(broadcast_id):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT r.*, d.status as delivery_status
               FROM recipients r
               LEFT JOIN delivery_statuses d ON r.message_id = d.message_id
               WHERE r.broadcast_id=? ORDER BY r.id""",
            (broadcast_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_total_stats():
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(total),0) as total, "
            "COALESCE(SUM(sent),0) as sent, "
            "COALESCE(SUM(not_found),0) as not_found, "
            "COALESCE(SUM(failed),0) as failed "
            "FROM broadcasts WHERE status='done'"
        ).fetchone()
        return dict(row)


# ── DELIVERY STATUSES ─────────────────────────────────────────────────────────

def upsert_delivery_status(message_id, status):
    """Обновить или создать статус доставки по ID сообщения."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO delivery_statuses (message_id, status, timestamp)
               VALUES (?, ?, ?)
               ON CONFLICT(message_id) DO UPDATE SET status=excluded.status, timestamp=excluded.timestamp""",
            (message_id, status, datetime.now().isoformat(timespec='seconds'))
        )


def get_delivery_statuses_for_broadcast(broadcast_id):
    """Получить статусы доставки для конкретной рассылки."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT r.phone, r.message_id, r.status as send_status,
                      d.status as delivery_status, d.timestamp
               FROM recipients r
               LEFT JOIN delivery_statuses d ON r.message_id = d.message_id
               WHERE r.broadcast_id=?""",
            (broadcast_id,)
        ).fetchall()
        return [dict(r) for r in rows]


# ── TEMPLATES ─────────────────────────────────────────────────────────────────

def get_templates():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM templates ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


def create_template(name, text):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO templates (name, text, created_at) VALUES (?, ?, ?)",
            (name, text, datetime.now().isoformat(timespec='seconds'))
        )
        return cur.lastrowid


def delete_template(template_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM templates WHERE id=?", (template_id,))


# ── INCOMING ──────────────────────────────────────────────────────────────────

def add_incoming(sender, message, msg_type='text', sender_name=None, file_url=None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO incoming (sender, sender_name, message, type, file_url, received_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (sender, sender_name, message, msg_type, file_url,
             datetime.now().isoformat(timespec='seconds'))
        )


def get_incoming(limit=100):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM incoming ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def mark_incoming_read(incoming_id):
    with get_conn() as conn:
        conn.execute("UPDATE incoming SET is_read=1 WHERE id=?", (incoming_id,))


def get_unread_count():
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM incoming WHERE is_read=0"
        ).fetchone()
        return row['cnt']


# ── GROUPS ────────────────────────────────────────────────────────────────────

def save_group(group_id, name):
    """Сохранить созданную группу."""
    with get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO groups (group_id, name, created_at)
               VALUES (?, ?, ?)""",
            (group_id, name, datetime.now().isoformat(timespec='seconds'))
        )


def get_groups():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM groups ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete_group(group_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM groups WHERE group_id=?", (group_id,))


def hide_group(group_id):
    """Добавить группу в список скрытых."""
    with get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO hidden_groups (group_id) VALUES (?)", (group_id,))


def get_hidden_groups():
    """Получить список ID всех скрытых групп."""
    with get_conn() as conn:
        rows = conn.execute("SELECT group_id FROM hidden_groups").fetchall()
        return [r['group_id'] for r in rows]
