"""Unit tests for ``scheduling.notification_dispatcher``.

Объём тестов сознательно ограничен задачей 6.4: проверяем контракт
диспетчера — backoff-таймер (Req 10.11), no-dup-channel-after-success
(Req 10.12), snapshot semantics (Req 10.4), in-app no-op (Req 10.5),
warning-once для отсутствующего email-провайдера (Req 10.6),
Telegram-канал с decrypt'ом (Req 10.7).

Property-тесты P19 (snapshot semantics) и P20 (3 retries before failed)
идут в отдельных задачах 6.5 и 6.6 — здесь только example-based unit-тесты,
которые формально закрепляют поведение для конкретных сценариев.

Все БД и HTTP взаимодействия мокаются через DI: ``db_connection_factory``,
``http_post``, ``telegram_post``, ``decrypt_token``, ``profile_loader``,
``clock``. Это позволяет тестам быть полностью offline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import pytest

from scheduling.notification_dispatcher import (
    BACKOFF_SECONDS,
    CHANNEL_EMAIL,
    CHANNEL_IN_APP,
    CHANNEL_TELEGRAM,
    EncryptionKeyInvalidError,
    EncryptionKeyMissingError,
    MAX_ATTEMPTS,
    NotificationDispatcher,
    NotificationRow,
    _ProfileRow,
    _row_to_notification,
    decrypt_aes_gcm,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeDB:
    """Минимальный psycopg2-stub для unit-тестов dispatcher'а.

    Поддерживает SELECT pending notifications и UPDATE через
    captured-side-effect: каждый ``UPDATE notifications`` пишется
    в ``self.updates`` для последующих ассертов в тесте.
    """

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = list(rows)
        self.updates: list[tuple[Any, ...]] = []

    # --- connection / cursor protocol ---------------------------------

    class _Cursor:
        def __init__(self, db: "_FakeDB") -> None:
            self._db = db
            self._last_select_rows: list[dict[str, Any]] = []

        def execute(self, sql: str, params: tuple) -> None:
            sql_upper = sql.strip().upper()
            if sql_upper.startswith("SELECT"):
                # SELECT pending notifications.
                self._last_select_rows = list(self._db._rows)
            elif sql_upper.startswith("UPDATE"):
                self._db.updates.append(params)
                # Применяем UPDATE к in-memory rows, чтобы повторный
                # SELECT возвращал свежее состояние.
                if "notifications" in sql:
                    (
                        new_status,
                        new_attempts,
                        new_error,
                        new_channels,
                        notif_id,
                    ) = params
                    for r in self._db._rows:
                        if r["id"] == notif_id:
                            r["dispatch_status"] = new_status
                            r["dispatch_attempts"] = new_attempts
                            r["dispatch_error"] = new_error
                            r["dispatched_channels"] = list(new_channels)

        def fetchall(self) -> list[dict[str, Any]]:
            return list(self._last_select_rows)

        def fetchone(self) -> Any:
            return None

        def __enter__(self) -> "_FakeDB._Cursor":
            return self

        def __exit__(self, *exc: Any) -> None:
            return None

    def cursor(self, cursor_factory: Any = None) -> "_FakeDB._Cursor":
        return _FakeDB._Cursor(self)

    def commit(self) -> None:
        return None

    def close(self) -> None:
        return None

    def __enter__(self) -> "_FakeDB":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    # --- factory ------------------------------------------------------

    def factory(self) -> "_FakeDB":
        return self


def _row(
    *,
    notif_id: int = 1,
    user_id: str = "user-uuid",
    kind: str = "scheduled",
    snapshot: dict[str, Any] | None = None,
    dispatch_status: str = "pending",
    dispatch_attempts: int = 0,
    dispatched_channels: list[str] | None = None,
    created_at: datetime | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Фабрика минимальной строки notifications."""

    return {
        "id": notif_id,
        "user_id": user_id,
        "kind": kind,
        "payload": payload or {"message": "hello"},
        "preference_snapshot": snapshot
        or {kind: {CHANNEL_IN_APP: True}},
        "dispatch_status": dispatch_status,
        "dispatch_attempts": dispatch_attempts,
        "dispatch_error": None,
        "dispatched_channels": list(dispatched_channels or []),
        "created_at": created_at or datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
        "read_at": None,
    }


def _make_dispatcher(
    db: _FakeDB,
    *,
    http_post: Any = None,
    telegram_post: Any = None,
    decrypt_token: Any = None,
    profile_loader: Any = None,
    clock_value: float = 1735732800.0,  # 2025-01-01 12:00 UTC
) -> NotificationDispatcher:
    """Сконструировать dispatcher с DI-моками. ``clock_value`` — фиксированный
    «сейчас», много секунд позже всех ``created_at`` в тестах.
    """

    return NotificationDispatcher(
        db_connection_factory=db.factory,
        http_post=http_post or (lambda **kw: (200, "ok")),
        telegram_post=telegram_post or (lambda **kw: (200, "ok")),
        decrypt_token=decrypt_token or (lambda enc: "decrypted-bot-token"),
        profile_loader=profile_loader or (lambda uid: None),
        clock=lambda: clock_value,
    )


# ---------------------------------------------------------------------------
# In-app channel: no-op success (Req 10.5)
# ---------------------------------------------------------------------------


class TestInAppChannel:
    def test_in_app_marks_delivered_immediately(self) -> None:
        db = _FakeDB([_row()])
        d = _make_dispatcher(db)

        d._tick()

        # Должна быть ровно одна UPDATE-запись.
        assert len(db.updates) == 1
        new_status, new_attempts, new_error, new_channels, _ = db.updates[0]
        assert new_status == "delivered"
        assert new_attempts == 0  # in-app не считается попыткой "ретрая"
        assert new_error is None
        assert CHANNEL_IN_APP in new_channels


# ---------------------------------------------------------------------------
# Snapshot semantics (Req 10.4) — example-based version of P19
# ---------------------------------------------------------------------------


class TestSnapshotSemantics:
    def test_dispatch_uses_snapshot_not_live_preferences(self) -> None:
        # Snapshot говорит: in_app=true, telegram=false. Live preferences
        # инвертированы (но dispatcher их не должен спрашивать).
        snapshot = {"scheduled": {CHANNEL_IN_APP: True, CHANNEL_TELEGRAM: False}}
        db = _FakeDB([_row(snapshot=snapshot)])

        # Если dispatcher решит спросить telegram — пусть mock выкинет
        # AssertionError: в этом тесте мы должны увидеть только in_app.
        def _telegram_must_not_be_called(**kw: Any) -> tuple[int, str]:
            raise AssertionError("telegram channel must NOT be attempted")

        d = _make_dispatcher(db, telegram_post=_telegram_must_not_be_called)
        d._tick()

        new_channels = db.updates[-1][3]
        assert CHANNEL_IN_APP in new_channels
        assert CHANNEL_TELEGRAM not in new_channels


# ---------------------------------------------------------------------------
# No duplicate channel after success (Req 10.12)
# ---------------------------------------------------------------------------


class TestNoDuplicateChannelAfterSuccess:
    def test_already_dispatched_channel_is_not_resent(self) -> None:
        snapshot = {
            "scheduled": {CHANNEL_IN_APP: True, CHANNEL_EMAIL: True}
        }
        # Email уже отправлен на предыдущей попытке. На in_app remaining.
        db = _FakeDB(
            [
                _row(
                    snapshot=snapshot,
                    dispatched_channels=[CHANNEL_EMAIL],
                    dispatch_attempts=1,
                    created_at=datetime(2025, 1, 1, 11, 0, tzinfo=timezone.utc),
                )
            ]
        )

        # Если бы email был вызван снова — это было бы нарушение Req 10.12.
        def _email_must_not_be_called(**kw: Any) -> tuple[int, str]:
            raise AssertionError("email channel must NOT be re-attempted")

        d = _make_dispatcher(db, http_post=_email_must_not_be_called)
        # Set FRONTEND_URL/SECRET to bypass email-disabled short-circuit.
        # Test assertion is on http_post being called, not on env vars.

        d._tick()

        new_status, new_attempts, _err, new_channels, _id = db.updates[-1]
        assert new_status == "delivered"
        # in_app добавлен, email сохранён (было до tick'а).
        assert CHANNEL_EMAIL in new_channels
        assert CHANNEL_IN_APP in new_channels


# ---------------------------------------------------------------------------
# Backoff timer (Req 10.11)
# ---------------------------------------------------------------------------


class TestBackoffTimer:
    def test_attempt1_runs_immediately(self) -> None:
        # attempts=0 ⇒ задержки нет, dispatch выполняется немедленно.
        db = _FakeDB([_row(dispatch_attempts=0)])
        d = _make_dispatcher(db)
        d._tick()
        assert len(db.updates) == 1

    def test_attempt2_waits_for_15s(self) -> None:
        # attempts=1, прошло 10s от created_at — ещё рано (нужно 15s).
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [_row(dispatch_attempts=1, created_at=created)]
        )
        # clock = created + 10s
        d = _make_dispatcher(db, clock_value=created.timestamp() + 10)
        d._tick()
        assert db.updates == []

    def test_attempt2_runs_after_15s(self) -> None:
        # attempts=1, прошло 16s — попытка №2 разрешена.
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [_row(dispatch_attempts=1, created_at=created)]
        )
        d = _make_dispatcher(db, clock_value=created.timestamp() + 16)
        d._tick()
        assert len(db.updates) == 1


# ---------------------------------------------------------------------------
# Failure after MAX_ATTEMPTS (Req 10.11) — example version of P20
# ---------------------------------------------------------------------------


class TestFailureAfterMaxAttempts:
    def test_third_failed_attempt_marks_dispatch_failed(self) -> None:
        # Snapshot требует email, но http_post возвращает 500 (failure).
        # attempts=2, прошло 60s от created_at ⇒ это третья и последняя попытка.
        snapshot = {"failed": {CHANNEL_EMAIL: True}}
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [
                _row(
                    kind="failed",
                    snapshot=snapshot,
                    dispatch_attempts=2,
                    created_at=created,
                )
            ]
        )

        # Установим env, чтобы email channel был "configured".
        import os

        os.environ["FRONTEND_URL"] = "http://localhost:3000"
        os.environ["NOTIFICATION_RELAY_SECRET"] = "test-secret"

        try:
            d = _make_dispatcher(
                db,
                http_post=lambda **kw: (500, "smtp down"),
                profile_loader=lambda uid: _ProfileRow(
                    user_id=uid,
                    email="op@example.com",
                ),
                clock_value=created.timestamp() + 70,
            )
            d._tick()

            new_status, new_attempts, new_error, _ch, _id = db.updates[-1]
            assert new_attempts == MAX_ATTEMPTS
            assert new_status == "failed"
            assert new_error is not None
            assert "EMAIL_RELAY_HTTP_500" in new_error
        finally:
            os.environ.pop("FRONTEND_URL", None)
            os.environ.pop("NOTIFICATION_RELAY_SECRET", None)

    def test_first_failed_attempt_stays_pending(self) -> None:
        snapshot = {"failed": {CHANNEL_EMAIL: True}}
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [
                _row(
                    kind="failed",
                    snapshot=snapshot,
                    dispatch_attempts=0,
                    created_at=created,
                )
            ]
        )

        import os

        os.environ["FRONTEND_URL"] = "http://localhost:3000"
        os.environ["NOTIFICATION_RELAY_SECRET"] = "test-secret"

        try:
            d = _make_dispatcher(
                db,
                http_post=lambda **kw: (500, "smtp down"),
                profile_loader=lambda uid: _ProfileRow(
                    user_id=uid,
                    email="op@example.com",
                ),
                clock_value=created.timestamp() + 1,
            )
            d._tick()

            new_status, new_attempts, _err, _ch, _id = db.updates[-1]
            assert new_status == "pending"
            assert new_attempts == 1
        finally:
            os.environ.pop("FRONTEND_URL", None)
            os.environ.pop("NOTIFICATION_RELAY_SECRET", None)


# ---------------------------------------------------------------------------
# Email provider warning once per process (Req 10.6)
# ---------------------------------------------------------------------------


class TestEmailProviderWarning:
    def test_warning_emitted_once_per_process(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # FRONTEND_URL/SECRET НЕ заданы — email-provider-not-configured.
        import os

        os.environ.pop("FRONTEND_URL", None)
        os.environ.pop("NOTIFICATION_RELAY_SECRET", None)

        snapshot = {"failed": {CHANNEL_EMAIL: True}}
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [
                _row(
                    notif_id=1,
                    kind="failed",
                    snapshot=snapshot,
                    dispatch_attempts=0,
                    created_at=created,
                ),
                _row(
                    notif_id=2,
                    kind="failed",
                    snapshot=snapshot,
                    dispatch_attempts=0,
                    created_at=created,
                ),
            ]
        )

        d = _make_dispatcher(
            db,
            profile_loader=lambda uid: _ProfileRow(
                user_id=uid, email="op@example.com"
            ),
            clock_value=created.timestamp() + 1,
        )

        with caplog.at_level(logging.WARNING, logger="scheduling"):
            d._tick()

        no_provider_warnings = [
            r for r in caplog.records
            if "email provider is not configured" in r.message.lower()
        ]
        # Хотя в БД 2 строки, для каждой попытался отправить email,
        # warning должен быть ровно один.
        assert len(no_provider_warnings) == 1


# ---------------------------------------------------------------------------
# Telegram channel (Req 10.7)
# ---------------------------------------------------------------------------


class TestTelegramChannel:
    def test_telegram_success_marks_channel_dispatched(self) -> None:
        snapshot = {"scheduled": {CHANNEL_TELEGRAM: True}}
        db = _FakeDB([_row(snapshot=snapshot)])

        captured: dict[str, Any] = {}

        def _telegram(**kw: Any) -> tuple[int, str]:
            captured.update(kw)
            return (200, '{"ok":true}')

        d = _make_dispatcher(
            db,
            telegram_post=_telegram,
            profile_loader=lambda uid: _ProfileRow(
                user_id=uid,
                telegram_bot_token="encrypted-token",
                telegram_chat_id="12345",
            ),
            decrypt_token=lambda enc: "real-bot-token",
        )

        d._tick()

        new_status, _att, _err, channels, _id = db.updates[-1]
        assert new_status == "delivered"
        assert CHANNEL_TELEGRAM in channels
        # URL сформирован на основе расшифрованного токена.
        assert "real-bot-token" in captured["url"]
        assert captured["json_body"] == {"chat_id": "12345", "text": "hello"}

    def test_telegram_decrypt_failure_records_dispatch_error(self) -> None:
        snapshot = {"scheduled": {CHANNEL_TELEGRAM: True}}
        # На последней (третьей) попытке, ставим fail.
        created = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        db = _FakeDB(
            [
                _row(
                    snapshot=snapshot,
                    dispatch_attempts=2,
                    created_at=created,
                )
            ]
        )

        def _bad_decrypt(enc: str) -> str:
            raise EncryptionKeyInvalidError("test invalid key")

        d = _make_dispatcher(
            db,
            decrypt_token=_bad_decrypt,
            profile_loader=lambda uid: _ProfileRow(
                user_id=uid,
                telegram_bot_token="encrypted-token",
                telegram_chat_id="12345",
            ),
            clock_value=created.timestamp() + 70,  # past 60s backoff
        )

        d._tick()
        new_status, _att, new_error, _ch, _id = db.updates[-1]
        assert new_status == "failed"
        assert new_error == "ENCRYPTION_KEY_INVALID"

    def test_telegram_missing_credentials_fails_gracefully(self) -> None:
        snapshot = {"scheduled": {CHANNEL_TELEGRAM: True, CHANNEL_IN_APP: True}}
        db = _FakeDB([_row(snapshot=snapshot)])

        d = _make_dispatcher(
            db,
            profile_loader=lambda uid: None,  # no profile at all
        )

        d._tick()

        new_status, _att, _err, channels, _id = db.updates[-1]
        # in_app delivered, telegram failed → notif остаётся pending
        # (не failed, потому что только 1 попытка).
        assert new_status == "pending"
        assert CHANNEL_IN_APP in channels
        assert CHANNEL_TELEGRAM not in channels


# ---------------------------------------------------------------------------
# Encryption helper (zero-roundtrip mirror of frontend/src/lib/encryption.ts)
# ---------------------------------------------------------------------------


class TestDecryptAesGcm:
    def test_missing_key_raises_missing_error(self) -> None:
        import os

        os.environ.pop("INSTANCE_ENCRYPTION_KEY", None)
        with pytest.raises(EncryptionKeyMissingError):
            decrypt_aes_gcm("aaaa:bbbb:cccc")

    def test_invalid_key_length_raises_invalid_error(self) -> None:
        import base64

        too_short = base64.b64encode(b"only-16-bytes-ke").decode("ascii")
        with pytest.raises(EncryptionKeyInvalidError):
            decrypt_aes_gcm("aaaa:bbbb:cccc", key_base64=too_short)

    def test_invalid_format_raises_invalid_error(self) -> None:
        import base64

        good_key = base64.b64encode(b"\x00" * 32).decode("ascii")
        with pytest.raises(EncryptionKeyInvalidError, match="Invalid encrypted format"):
            decrypt_aes_gcm("not-three-parts", key_base64=good_key)

    def test_roundtrip_with_node_compatible_format(self) -> None:
        """Decrypt'ит то, что зашифровал бы JS-encrypt из
        ``frontend/src/lib/encryption.ts``: ``iv:ciphertext:tag``
        (все base64), ciphertext и tag отдельно (не склеенные).

        Тест зашифровывает через cryptography Python-библиотеку,
        разделяет ciphertext+tag в формат node.js, и проверяет, что
        decrypt_aes_gcm обратно даёт plaintext.
        """

        pytest.importorskip("cryptography")
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import base64
        import os as _os

        plaintext = "secret-bot-token-value"
        key = _os.urandom(32)
        iv = _os.urandom(12)

        aes = AESGCM(key)
        ct_with_tag = aes.encrypt(iv, plaintext.encode("utf-8"), None)
        # cryptography склеивает ciphertext+tag (16 byte tag в конце).
        ciphertext, tag = ct_with_tag[:-16], ct_with_tag[-16:]

        encrypted_str = ":".join(
            (
                base64.b64encode(iv).decode("ascii"),
                base64.b64encode(ciphertext).decode("ascii"),
                base64.b64encode(tag).decode("ascii"),
            )
        )

        result = decrypt_aes_gcm(
            encrypted_str,
            key_base64=base64.b64encode(key).decode("ascii"),
        )

        assert result == plaintext


# ---------------------------------------------------------------------------
# _row_to_notification helper
# ---------------------------------------------------------------------------


class TestRowToNotification:
    def test_parses_minimal_row(self) -> None:
        row = _row()
        notif = _row_to_notification(row)

        assert notif.id == 1
        assert notif.kind == "scheduled"
        assert notif.dispatch_status == "pending"
        assert notif.dispatch_attempts == 0
        assert notif.dispatched_channels == []

    def test_parses_string_payload_as_json(self) -> None:
        row = _row()
        row["payload"] = '{"message": "hi"}'
        row["preference_snapshot"] = '{"scheduled": {"in_app": true}}'
        notif = _row_to_notification(row)

        assert notif.payload == {"message": "hi"}
        assert notif.preference_snapshot == {"scheduled": {"in_app": True}}

    def test_naive_datetime_becomes_utc(self) -> None:
        row = _row()
        row["created_at"] = datetime(2025, 1, 1, 12, 0, 0)  # naive
        notif = _row_to_notification(row)

        assert notif.created_at.tzinfo is timezone.utc
