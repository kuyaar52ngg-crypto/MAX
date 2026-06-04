"""Lightweight Telegram notifications for Flask-side operations.

The scheduling suite already has a Postgres-backed NotificationDispatcher.
Flask bulk operations such as immediate broadcasts and contact checks run
outside that scheduler path, so this module sends best-effort Telegram
messages directly using the same Profile telegram settings.
"""

from __future__ import annotations

import os
from typing import Optional

import requests

from scheduling.logger import logger
from scheduling.notification_dispatcher import (
    EncryptionKeyInvalidError,
    EncryptionKeyMissingError,
    decrypt_aes_gcm,
)


TELEGRAM_API_BASE = "https://api.telegram.org"
HTTP_TIMEOUT_SECONDS = 10


def _connect_postgres():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return None
    try:
        import psycopg2
        import psycopg2.extras

        return psycopg2.connect(database_url)
    except Exception:
        logger.warning("Telegram notifications: cannot connect to Postgres", exc_info=True)
        return None


def _load_profile(identifier: str) -> Optional[dict]:
    """Load Telegram settings by Supabase user_id or GREEN-API id.

    Browser requests normally pass ``X-User-Id`` with the Supabase UUID,
    but long-running Flask operations also have the GREEN-API instance id
    available as their audit ``user_id``. Looking up both makes completion
    notifications reliable even when the browser did not send ``X-User-Id``
    or an older client version is still cached.
    """
    if not identifier:
        return None
    conn = _connect_postgres()
    if conn is None:
        return None
    try:
        import psycopg2.extras

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT telegram_bot_token, telegram_chat_id
                     FROM profiles
                    WHERE user_id::text = %s OR green_api_id = %s
                    LIMIT 1""",
                (identifier, identifier),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception:
        logger.warning(
            "Telegram notifications: cannot load profile for identifier=%s",
            identifier,
            exc_info=True,
        )
        return None
    finally:
        try:
            conn.close()
        except Exception:
            pass


def send_telegram_notification(identifier: str | None, title: str, message: str) -> bool:
    """Send a best-effort Telegram notification for a Flask operation.

    Returns True when Telegram accepted the request. All configuration and
    network failures are logged and returned as False, never raised, because
    notifications must not break broadcasts or checks.
    """
    if not identifier:
        logger.info("Telegram notifications: skipped, no profile identifier")
        return False

    profile = _load_profile(identifier)
    if not profile:
        logger.info("Telegram notifications: skipped, profile not found for identifier=%s", identifier)
        return False

    encrypted_token = profile.get("telegram_bot_token")
    chat_id = profile.get("telegram_chat_id")
    if not encrypted_token or not chat_id:
        logger.info("Telegram notifications: skipped, Telegram is not configured for identifier=%s", identifier)
        return False

    try:
        token = decrypt_aes_gcm(str(encrypted_token))
    except EncryptionKeyMissingError:
        logger.warning("Telegram notifications: INSTANCE_ENCRYPTION_KEY is not configured")
        return False
    except EncryptionKeyInvalidError:
        logger.warning("Telegram notifications: token decrypt failed", exc_info=True)
        return False

    text = f"{title}\n\n{message}".strip()
    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    try:
        response = requests.post(
            url,
            json={
                "chat_id": str(chat_id),
                "text": text[:4096],
                "disable_web_page_preview": True,
            },
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        if 200 <= response.status_code < 300:
            return True
        logger.warning(
            "Telegram notifications: sendMessage failed status=%s body=%s",
            response.status_code,
            response.text[:300],
        )
        return False
    except Exception:
        logger.warning("Telegram notifications: sendMessage request failed", exc_info=True)
        return False
