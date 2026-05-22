"""Unit tests for ``scheduling.smart_time_engine.SmartTimeEngine``.

Покрывает Requirements 2.3 / 2.7 / 2.8 / 2.9 (Task 4.6 спеки
``broadcast-scheduling-suite``). Property-тесты P3/P4 — отдельные
задачи (4.8/4.9), здесь только unit-кейсы.

Объём:

* Базовое распределение: ровно ``len(contacts)`` ``ScheduledSend``,
  metadata содержит ``slot`` и ``fallback`` (Req 2.3).
* Round-robin per-recipient через slots (когда у получателя
  несколько вхождений в ``contacts``) — детерминирован.
* ``_shift_past_quiet_hours`` — слот в QH сдвигается на
  ``qh_end`` (Req 2.8).
* CalendarException — слот пропускается, не помечает overflow
  (Req 2.8 + общий контракт).
* ``hourly_check_limit`` — overflow триггерит spill и INSERT в
  incident_log (Req 2.9).
* Empty contacts → пустой результат (defensive nil-check).
* Pure: повторный distribute с тем же broadcast.id и теми же
  фейками возвращает идентичный список (Property 3 готова).
* Default fallback: получатель без истории + аналайзер без данных
  → ``slots=[10, 14, 19]``, ``source="default_fallback"``.
* IncidentLog INSERT — best-effort: ошибка фабрики не валит
  distribute.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pytest

from anti_ban.config import AntiBanConfig
from scheduling.engine import BroadcastRow
from scheduling.smart_time_engine import SmartTimeEngine


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeAnalyzer:
    """Минимальный stub для ``ActivityAnalyzer.top_slots``.

    Возвращает map ``phone → (slots, source)`` с дефолтом для
    «неизвестных» получателей. Идемпотентен: один и тот же
    phone всегда возвращает один и тот же tuple — это нужно
    для теста детерминизма.
    """

    def __init__(
        self,
        defaults: tuple[list[int], str] = ([10, 14, 19], "default_fallback"),
        *,
        per_phone: dict[str, tuple[list[int], str]] | None = None,
    ) -> None:
        self._defaults = defaults
        self._per_phone = per_phone or {}
        self.calls: list[tuple[str, str, int]] = []

    def top_slots(
        self, user_id: str, phone: str, top_n: int
    ) -> tuple[list[int], str]:
        self.calls.append((user_id, phone, top_n))
        if phone in self._per_phone:
            slots, source = self._per_phone[phone]
            # Honour top_n contract — обрезаем под top_n.
            return list(slots[: max(1, top_n)]), source
        slots, source = self._defaults
        return list(slots[: max(1, top_n)]), source


class _RaisingAnalyzer:
    """Аналайзер, который всегда падает — для теста fallback chain."""

    def top_slots(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("db down")


class _RecordingCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple]] = []

    def execute(self, sql: str, params: tuple) -> None:
        self.executed.append((sql, params))

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _RecordingConn:
    def __init__(self) -> None:
        self.cursor_obj = _RecordingCursor()
        self.committed = False

    def cursor(self) -> _RecordingCursor:
        return self.cursor_obj

    def commit(self) -> None:
        self.committed = True

    def close(self) -> None:
        return None

    def __enter__(self) -> "_RecordingConn":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _make_recording_factory() -> tuple[Any, list[_RecordingConn]]:
    """Возвращает фабрику и список созданных connection'ов."""

    conns: list[_RecordingConn] = []

    def _factory() -> _RecordingConn:
        c = _RecordingConn()
        conns.append(c)
        return c

    return _factory, conns


def _broken_factory() -> Any:
    raise RuntimeError("db unreachable")


def _make_broadcast(
    *,
    broadcast_id: int = 1,
    user_id: str = "user-uuid",
    contacts: list[Any] | None = None,
    scheduled_for: datetime | None = None,
    smart_time_window_days: int = 1,
    smart_time_top_n: int = 3,
    user_tz: str = "UTC",
    quiet_hours_enabled: bool = False,
    quiet_hours_start: int = 22,
    quiet_hours_end: int = 8,
) -> BroadcastRow:
    return BroadcastRow.from_db_row(
        {
            "id": broadcast_id,
            "user_id": user_id,
            "schedule_type": "smart_time",
            "status": "scheduled",
            "contacts": contacts if contacts is not None else [{"phone": "79991234567"}],
            "scheduled_for": scheduled_for or datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
            "next_run_at": scheduled_for or datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
            "user_tz": user_tz,
            "smart_time_window_days": smart_time_window_days,
            "smart_time_top_n": smart_time_top_n,
            "quiet_hours_enabled": quiet_hours_enabled,
            "quiet_hours_start": quiet_hours_start,
            "quiet_hours_end": quiet_hours_end,
            "approval_status": "none",
        }
    )


def _anti_ban(hourly_check_limit: int = 200) -> AntiBanConfig:
    return AntiBanConfig(hourly_check_limit=hourly_check_limit)


# ---------------------------------------------------------------------------
# Basic distribution
# ---------------------------------------------------------------------------


class TestDistributeBasic:
    def test_returns_one_send_per_contact(self) -> None:
        factory, _ = _make_recording_factory()
        engine = SmartTimeEngine(
            _FakeAnalyzer(([10, 14, 19], "recipient")),
            db_connection_factory=factory,
        )
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}, {"phone": "79992222222"}, {"phone": "79993333333"}]
        )

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert len(sends) == 3
        assert [s.phone for s in sends] == ["79991111111", "79992222222", "79993333333"]

    def test_metadata_contains_slot_and_fallback(self) -> None:
        engine = SmartTimeEngine(
            _FakeAnalyzer(([14], "recipient")),
        )
        bc = _make_broadcast(contacts=[{"phone": "79991111111"}])

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert sends[0].metadata == {"slot": 14, "fallback": "recipient"}

    def test_send_at_is_at_target_hour_in_user_tz(self) -> None:
        # anchor = 2026-06-01 00:00 UTC; user_tz=UTC; slots=[14] →
        # send_at должен быть 2026-06-01 14:00 UTC.
        engine = SmartTimeEngine(_FakeAnalyzer(([14], "recipient")))
        bc = _make_broadcast(contacts=[{"phone": "79991111111"}])

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert sends[0].send_at == datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)

    def test_empty_contacts_returns_empty_list(self) -> None:
        engine = SmartTimeEngine(_FakeAnalyzer())
        bc = _make_broadcast(contacts=[])

        assert engine.distribute(bc, _anti_ban(), exceptions=[]) == []


# ---------------------------------------------------------------------------
# Round-robin per recipient
# ---------------------------------------------------------------------------


class TestRoundRobin:
    def test_same_phone_repeated_advances_rr_pointer(self) -> None:
        # Один и тот же phone указан 3 раза → RR должен пройти
        # все 3 слота: 10 → 14 → 19. Этот тест ловит баг
        # «общий рр-указатель», когда RR идёт по порядку контактов
        # вместо per-phone.
        engine = SmartTimeEngine(_FakeAnalyzer(([10, 14, 19], "recipient")))
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79991111111"},
                {"phone": "79991111111"},
            ]
        )

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        slots_chosen = [s.metadata["slot"] for s in sends]
        assert slots_chosen == [10, 14, 19]

    def test_distinct_phones_each_start_at_first_slot(self) -> None:
        # Разные phones → каждый стартует с slots[0] (счётчик per-phone).
        engine = SmartTimeEngine(_FakeAnalyzer(([10, 14, 19], "recipient")))
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
                {"phone": "79993333333"},
            ]
        )

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        slots_chosen = [s.metadata["slot"] for s in sends]
        assert slots_chosen == [10, 10, 10]


# ---------------------------------------------------------------------------
# Quiet hours (Req 2.8)
# ---------------------------------------------------------------------------


class TestQuietHours:
    def test_slot_in_quiet_hours_is_shifted_to_qh_end(self) -> None:
        # QH 22..23 (1 час), target_hour=22 → должен сдвинуться на 23.
        engine = SmartTimeEngine(_FakeAnalyzer(([22], "recipient")))
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}],
            quiet_hours_enabled=True,
            quiet_hours_start=22,
            quiet_hours_end=23,
        )

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        # placed at 23:00 UTC
        assert sends[0].send_at.hour == 23
        # metadata.slot фиксирует исходный target_hour, не сдвинутый.
        assert sends[0].metadata["slot"] == 22

    def test_slot_outside_quiet_hours_is_not_shifted(self) -> None:
        engine = SmartTimeEngine(_FakeAnalyzer(([14], "recipient")))
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}],
            quiet_hours_enabled=True,
            quiet_hours_start=22,
            quiet_hours_end=8,
        )

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert sends[0].send_at.hour == 14
        assert sends[0].metadata["slot"] == 14


# ---------------------------------------------------------------------------
# Hourly check limit (Req 2.9)
# ---------------------------------------------------------------------------


class TestHourlyOverflow:
    def test_overflow_spills_to_next_slot_within_same_day(self) -> None:
        # hourly_limit=2, slots=[10, 14], 3 разных получателя →
        # первые 2 ложатся в 10:00, третий «переливается» на 14:00.
        engine = SmartTimeEngine(
            _FakeAnalyzer(([10, 14], "recipient")),
        )
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
                {"phone": "79993333333"},
            ]
        )

        sends = engine.distribute(bc, _anti_ban(hourly_check_limit=2), exceptions=[])

        assert sends[0].send_at.hour == 10
        assert sends[1].send_at.hour == 10
        assert sends[2].send_at.hour == 14

    def test_overflow_logs_incident(self) -> None:
        factory, conns = _make_recording_factory()
        engine = SmartTimeEngine(
            _FakeAnalyzer(([10, 14], "recipient")),
            db_connection_factory=factory,
        )
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
                {"phone": "79993333333"},
            ],
            broadcast_id=42,
        )

        sends = engine.distribute(bc, _anti_ban(hourly_check_limit=2), exceptions=[])

        # Третий получатель должен записать incident.
        assert len(sends) == 3
        # Должна быть как минимум одна запись в incident_log.
        all_executed: list[tuple[str, tuple]] = []
        for c in conns:
            all_executed.extend(c.cursor_obj.executed)
        # Только третий получатель попал на overflow
        assert len(all_executed) == 1
        sql, params = all_executed[0]
        assert "incident_log" in sql
        assert "smart_time_overflow" in params  # kind passed as param
        # user_id, operation_run_id (None), kind, details_json
        assert params[0] == "user-uuid"
        assert params[1] is None
        assert params[2] == "smart_time_overflow"
        details = json.loads(params[3])
        assert details["phone"] == "79993333333"
        assert details["broadcast_id"] == 42
        assert details["target_hour"] == 10
        assert details["placed_hour"] == 14
        assert details["hourly_limit"] == 2

    def test_no_overflow_means_no_incident_log_writes(self) -> None:
        factory, conns = _make_recording_factory()
        engine = SmartTimeEngine(
            _FakeAnalyzer(([10, 14, 19], "recipient")),
            db_connection_factory=factory,
        )
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}, {"phone": "79992222222"}]
        )

        sends = engine.distribute(bc, _anti_ban(hourly_check_limit=200), exceptions=[])

        assert len(sends) == 2
        # Нет overflow → нет открытий соединения вовсе.
        assert conns == []

    def test_incident_log_failure_does_not_break_distribute(self) -> None:
        engine = SmartTimeEngine(
            _FakeAnalyzer(([10], "recipient")),
            db_connection_factory=_broken_factory,
        )
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
            ]
        )

        # Лимит=1, 2 получателя → второй overflow → INSERT падает,
        # но distribute не должен выбросить.
        sends = engine.distribute(bc, _anti_ban(hourly_check_limit=1), exceptions=[])

        assert len(sends) == 2
        # Второй получатель всё равно получил send_at.
        assert sends[1].send_at is not None


# ---------------------------------------------------------------------------
# CalendarException
# ---------------------------------------------------------------------------


class TestCalendarException:
    def test_send_skips_calendar_exception_day(self) -> None:
        # 2026-06-01 — single-day exception. window_days=2, slots=[14].
        # Получатель должен попасть на 2026-06-02 14:00.
        engine = SmartTimeEngine(_FakeAnalyzer(([14], "recipient")))
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}],
            scheduled_for=datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
            smart_time_window_days=2,
        )
        exception = {
            "name": "Holiday",
            "start_date": "2026-06-01",
            "end_date": "2026-06-01",
            "recurring_type": None,
            "recurring_value": None,
        }

        sends = engine.distribute(bc, _anti_ban(), exceptions=[exception])

        assert sends[0].send_at == datetime(2026, 6, 2, 14, 0, tzinfo=timezone.utc)

    def test_calendar_exception_skip_does_not_log_overflow(self) -> None:
        factory, conns = _make_recording_factory()
        engine = SmartTimeEngine(
            _FakeAnalyzer(([14], "recipient")),
            db_connection_factory=factory,
        )
        bc = _make_broadcast(
            contacts=[{"phone": "79991111111"}],
            scheduled_for=datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
            smart_time_window_days=2,
        )
        exception = {
            "name": "Holiday",
            "start_date": "2026-06-01",
            "end_date": "2026-06-01",
            "recurring_type": None,
            "recurring_value": None,
        }

        engine.distribute(bc, _anti_ban(), exceptions=[exception])

        # CalendarException — НЕ overflow, не должен генерить incident.
        assert conns == []


# ---------------------------------------------------------------------------
# Fallback chain (Req 2.5) and resilience
# ---------------------------------------------------------------------------


class TestFallbackChain:
    def test_default_fallback_when_analyzer_returns_default(self) -> None:
        engine = SmartTimeEngine(_FakeAnalyzer(([10, 14, 19], "default_fallback")))
        bc = _make_broadcast(contacts=[{"phone": "79991111111"}])

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert sends[0].metadata["fallback"] == "default_fallback"
        assert sends[0].metadata["slot"] == 10

    def test_analyzer_exception_falls_back_to_default_hours(self) -> None:
        # Если аналайзер падает, distribute не должен валиться:
        # используется внутренний default {10, 14, 19}.
        engine = SmartTimeEngine(_RaisingAnalyzer())
        bc = _make_broadcast(contacts=[{"phone": "79991111111"}])

        sends = engine.distribute(bc, _anti_ban(), exceptions=[])

        assert len(sends) == 1
        assert sends[0].metadata["fallback"] == "default_fallback"
        assert sends[0].metadata["slot"] in {10, 14, 19}


# ---------------------------------------------------------------------------
# Determinism (groundwork for Property 3)
# ---------------------------------------------------------------------------


class TestDeterminism:
    def test_two_invocations_yield_identical_sends(self) -> None:
        # Чистая функция: тот же broadcast.id + те же inputs → тот
        # же output. Подложка для P3 (Task 4.8).
        analyzer1 = _FakeAnalyzer(([10, 14, 19], "recipient"))
        analyzer2 = _FakeAnalyzer(([10, 14, 19], "recipient"))
        engine1 = SmartTimeEngine(analyzer1)
        engine2 = SmartTimeEngine(analyzer2)
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
                {"phone": "79991111111"},
            ]
        )

        a = engine1.distribute(bc, _anti_ban(), exceptions=[])
        b = engine2.distribute(bc, _anti_ban(), exceptions=[])

        assert a == b
