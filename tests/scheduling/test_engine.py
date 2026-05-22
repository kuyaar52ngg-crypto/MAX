"""Unit tests for ``scheduling.engine`` (Schedule_Mode_Engine dispatcher).

Объём тестов сознательно ограничен задачей 4.1: проверяем контракт
диспетчера и Protocol-а, а не конкретные стратегии (для них —
отдельные задачи 4.3/4.6/4.7/4.13). Property-тесты P3/P13 идут в
отдельных подзадачах 4.2 и 4.8.

Ключевые проверки:

* Регистрация стратегии: invalid ``schedule_type`` → ``ValueError``;
  объект без ``distribute`` → ``TypeError``; повторная регистрация —
  override + warning-лог.
* :meth:`ScheduleModeEngine.distribute` — pure delegation в
  зарегистрированную стратегию; ValueError на отсутствующей.
* :meth:`ScheduleModeEngine.dispatch_due` — фильтрация
  pending-approval (Req 7.4 / задача 4.1), per-iteration try/except
  (одна упавшая рассылка не валит остальные), отсутствующая
  стратегия пропускается без exception, корректная конверсия
  dict-row в :class:`BroadcastRow`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import pytest

from scheduling.engine import (
    BroadcastRow,
    DISPATCHED_SCHEDULE_TYPES,
    ScheduleModeEngine,
    ScheduleModeStrategy,
)
from scheduling.types import ScheduledSend


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _RecordingStrategy:
    """Стратегия-шпион, записывающая аргументы и возвращающая фиксированный ответ."""

    def __init__(self, sends: list[ScheduledSend] | None = None) -> None:
        self.calls: list[tuple[BroadcastRow, Any, list[Any]]] = []
        self._sends = sends if sends is not None else []

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: Any,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        self.calls.append((broadcast, anti_ban, exceptions))
        return list(self._sends)


class _RaisingStrategy:
    """Стратегия, которая всегда падает — для теста изоляции tick'а."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: Any,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        raise self._exc


class _FakeCursor:
    """Минимальный psycopg2-cursor stub для тестирования _fetch_due_broadcasts."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.executed: list[tuple[str, tuple]] = []

    def execute(self, sql: str, params: tuple) -> None:
        self.executed.append((sql, params))

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConnection:
    """Минимальный psycopg2-connection stub."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.cursor_calls: list[Any] = []

    def cursor(self, cursor_factory: Any = None) -> _FakeCursor:
        # Принимаем cursor_factory, но игнорируем — тест не зависит от него.
        self.cursor_calls.append(cursor_factory)
        return _FakeCursor(self._rows)

    def close(self) -> None:
        return None

    def __enter__(self) -> "_FakeConnection":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _make_db_factory(rows: list[dict[str, Any]]) -> Any:
    """Фабрика, возвращающая фейковое соединение с указанными rows."""

    def _factory() -> _FakeConnection:
        return _FakeConnection(rows)

    return _factory


def _row(
    *,
    broadcast_id: int = 1,
    schedule_type: str = "window",
    status: str = "scheduled",
    approval_status: str = "none",
    user_id: str = "user-uuid",
) -> dict[str, Any]:
    """Фабрика минимально валидной dict-строки scheduled_broadcasts."""

    return {
        "id": broadcast_id,
        "user_id": user_id,
        "schedule_type": schedule_type,
        "status": status,
        "contacts": [{"phone": "79991234567"}],
        "next_run_at": datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
        "scheduled_for": datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
        "user_tz": "UTC",
        "send_window_start": None,
        "send_window_end": None,
        "smart_time_window_days": None,
        "smart_time_top_n": None,
        "ab_time_test_id": None,
        "quiet_hours_enabled": False,
        "quiet_hours_start": 22,
        "quiet_hours_end": 8,
        "respect_recipient_tz": False,
        "approval_status": approval_status,
        "approval_user_id": None,
        "auto_snooze_enabled": False,
        "message": "hi",
    }


# ---------------------------------------------------------------------------
# BroadcastRow.from_db_row
# ---------------------------------------------------------------------------


class TestBroadcastRowFromDbRow:
    def test_basic_dict_row_is_parsed(self) -> None:
        row = _row(broadcast_id=42, schedule_type="smart_time")
        bc = BroadcastRow.from_db_row(row)

        assert bc.id == 42
        assert bc.schedule_type == "smart_time"
        assert bc.status == "scheduled"
        assert bc.user_tz == "UTC"
        assert bc.contacts == [{"phone": "79991234567"}]
        assert bc.approval_status == "none"
        # Полная строка должна быть доступна через .raw для расширения.
        assert bc.raw["message"] == "hi"

    def test_contacts_string_is_parsed_as_json(self) -> None:
        row = _row()
        row["contacts"] = '[{"phone": "79991234567"}, {"phone": "79992223344"}]'
        bc = BroadcastRow.from_db_row(row)

        assert len(bc.contacts) == 2
        assert bc.contacts[0]["phone"] == "79991234567"

    def test_contacts_invalid_json_falls_back_to_empty_list(self) -> None:
        row = _row()
        row["contacts"] = "not-a-json"
        bc = BroadcastRow.from_db_row(row)

        assert bc.contacts == []

    def test_missing_optional_columns_use_defaults(self) -> None:
        # Минимально допустимая строка — только обязательные id/schedule_type.
        bc = BroadcastRow.from_db_row(
            {
                "id": 1,
                "schedule_type": "burst",
                "status": "scheduled",
                "contacts": [],
            }
        )

        assert bc.user_tz == "UTC"
        assert bc.quiet_hours_enabled is False
        assert bc.approval_status == "none"
        assert bc.contacts == []


# ---------------------------------------------------------------------------
# ScheduleModeStrategy Protocol
# ---------------------------------------------------------------------------


class TestScheduleModeStrategyProtocol:
    def test_object_with_distribute_satisfies_protocol(self) -> None:
        assert isinstance(_RecordingStrategy(), ScheduleModeStrategy)

    def test_object_without_distribute_does_not_satisfy_protocol(self) -> None:
        class _NoDistribute:
            pass

        assert not isinstance(_NoDistribute(), ScheduleModeStrategy)


# ---------------------------------------------------------------------------
# ScheduleModeEngine.register
# ---------------------------------------------------------------------------


class TestScheduleModeEngineRegister:
    def test_registers_strategy_for_supported_schedule_type(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )
        strategy = _RecordingStrategy()

        engine.register("window", strategy)

        assert engine.is_registered("window")

    def test_rejects_unknown_schedule_type(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )

        with pytest.raises(ValueError, match="unsupported schedule_type"):
            engine.register("exact", _RecordingStrategy())

    def test_rejects_strategy_without_distribute(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )

        with pytest.raises(TypeError, match="distribute"):
            engine.register("window", object())  # type: ignore[arg-type]

    def test_re_registration_overrides_with_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )
        first = _RecordingStrategy()
        second = _RecordingStrategy()

        engine.register("window", first)
        with caplog.at_level(logging.WARNING, logger="scheduling"):
            engine.register("window", second)

        assert any(
            "перезапис" in rec.message or "schedule_type=window" in rec.message
            for rec in caplog.records
        )

    def test_all_dispatched_schedule_types_are_acceptable(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )
        for schedule_type in DISPATCHED_SCHEDULE_TYPES:
            engine.register(schedule_type, _RecordingStrategy())
            assert engine.is_registered(schedule_type)


# ---------------------------------------------------------------------------
# ScheduleModeEngine.distribute
# ---------------------------------------------------------------------------


class TestScheduleModeEngineDistribute:
    def test_delegates_to_registered_strategy(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )
        sends = [
            ScheduledSend(
                phone="79991234567",
                send_at=datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
                metadata={},
            )
        ]
        strategy = _RecordingStrategy(sends=sends)
        engine.register("window", strategy)

        bc = BroadcastRow.from_db_row(_row(schedule_type="window"))
        result = engine.distribute(bc, anti_ban="ab", exceptions=["e"])

        assert result == sends
        assert len(strategy.calls) == 1
        called_bc, called_ab, called_exc = strategy.calls[0]
        assert called_bc.id == bc.id
        assert called_ab == "ab"
        assert called_exc == ["e"]

    def test_raises_when_strategy_not_registered(self) -> None:
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory([]),
            anti_ban_loader=lambda _uid: None,
            exceptions_loader=lambda _uid: [],
        )
        bc = BroadcastRow.from_db_row(_row(schedule_type="window"))

        with pytest.raises(ValueError, match="unsupported schedule_type"):
            engine.distribute(bc, anti_ban=None, exceptions=[])


# ---------------------------------------------------------------------------
# ScheduleModeEngine.dispatch_due
# ---------------------------------------------------------------------------


class TestDispatchDue:
    def test_calls_strategy_for_each_due_row(self) -> None:
        rows = [
            _row(broadcast_id=1, schedule_type="window"),
            _row(broadcast_id=2, schedule_type="smart_time"),
        ]
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory(rows),
            anti_ban_loader=lambda _uid: "ab-config",
            exceptions_loader=lambda _uid: ["exc"],
        )
        window = _RecordingStrategy()
        smart = _RecordingStrategy()
        engine.register("window", window)
        engine.register("smart_time", smart)

        engine.dispatch_due()

        assert len(window.calls) == 1
        assert window.calls[0][0].id == 1
        assert window.calls[0][1] == "ab-config"
        assert window.calls[0][2] == ["exc"]
        assert len(smart.calls) == 1
        assert smart.calls[0][0].id == 2

    def test_pending_approval_rows_are_skipped_defence_in_depth(self) -> None:
        # Симулируем рассинхрон: SQL-фильтр (теоретически) пропустил
        # строку с status='pending_approval'. Внутренняя проверка
        # должна её отклонить (Req 7.4 / задача 7.3).
        rows = [
            _row(
                broadcast_id=11,
                schedule_type="window",
                status="pending_approval",
                approval_status="pending",
            ),
            _row(broadcast_id=12, schedule_type="window"),
        ]
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory(rows),
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )
        window = _RecordingStrategy()
        engine.register("window", window)

        engine.dispatch_due()

        # Только не-pending рассылка должна попасть в стратегию.
        assert len(window.calls) == 1
        assert window.calls[0][0].id == 12

    def test_approval_status_pending_alone_blocks_dispatch(self) -> None:
        # Если по какой-то причине status=scheduled, но
        # approval_status=pending — defence-in-depth тоже должен
        # отклонить.
        rows = [
            _row(
                broadcast_id=21,
                schedule_type="window",
                status="scheduled",
                approval_status="pending",
            ),
        ]
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory(rows),
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )
        window = _RecordingStrategy()
        engine.register("window", window)

        engine.dispatch_due()

        assert window.calls == []

    def test_strategy_exception_does_not_break_other_rows(self) -> None:
        rows = [
            _row(broadcast_id=1, schedule_type="window"),
            _row(broadcast_id=2, schedule_type="smart_time"),
            _row(broadcast_id=3, schedule_type="window"),
        ]
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory(rows),
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )
        window = _RaisingStrategy(RuntimeError("boom"))
        smart = _RecordingStrategy()
        engine.register("window", window)
        engine.register("smart_time", smart)

        # Не должно поднять исключение наружу (Req 8.1).
        engine.dispatch_due()

        # smart_time-стратегия должна была отработать несмотря на
        # падение window-стратегии для id=1.
        assert len(smart.calls) == 1
        assert smart.calls[0][0].id == 2

    def test_missing_strategy_is_logged_and_skipped(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        rows = [_row(broadcast_id=99, schedule_type="burst")]
        engine = ScheduleModeEngine(
            db_connection_factory=_make_db_factory(rows),
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )
        # burst НЕ зарегистрирована.

        with caplog.at_level(logging.WARNING, logger="scheduling"):
            engine.dispatch_due()  # не должно бросить

        assert any("no strategy" in r.message for r in caplog.records)

    def test_db_failure_is_swallowed_and_tick_no_ops(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def _broken_factory() -> Any:
            raise RuntimeError("db down")

        engine = ScheduleModeEngine(
            db_connection_factory=_broken_factory,
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )

        with caplog.at_level(logging.ERROR, logger="scheduling"):
            engine.dispatch_due()  # не должно бросить

        assert any("ошибка SELECT due" in r.message for r in caplog.records)

    def test_select_filters_by_dispatched_types_and_approval(self) -> None:
        # Хотим убедиться, что SQL подаётся с правильными параметрами,
        # включая фильтр по DISPATCHED_SCHEDULE_TYPES и approval.
        captured: dict[str, Any] = {}

        class _CapturingCursor(_FakeCursor):
            def execute(self, sql: str, params: tuple) -> None:
                captured["sql"] = sql
                captured["params"] = params

        class _CapturingConn(_FakeConnection):
            def cursor(self, cursor_factory: Any = None) -> _CapturingCursor:
                return _CapturingCursor([])

        engine = ScheduleModeEngine(
            db_connection_factory=lambda: _CapturingConn([]),
            anti_ban_loader=lambda _uid: "ab",
            exceptions_loader=lambda _uid: [],
        )
        engine.dispatch_due()

        sql = captured.get("sql", "")
        assert "scheduled_broadcasts" in sql
        assert "schedule_type IN" in sql
        assert "status = 'scheduled'" in sql
        assert "next_run_at <= NOW()" in sql
        assert "approval_status <> 'pending'" in sql

        # Первый параметр — кортеж типов.
        types_param = captured["params"][0]
        assert set(types_param) == set(DISPATCHED_SCHEDULE_TYPES)
