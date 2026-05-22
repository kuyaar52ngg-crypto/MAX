"""Unit tests for ``scheduling.auto_snooze_watcher.AutoSnoozeWatcher``.

Покрывает Requirements 9.2 / 9.3 / 9.5 / 9.6 / 9.7 / 9.8 (Task 6.1
спеки ``broadcast-scheduling-suite``). Property-тесты P17/P18 — в
отдельных задачах (6.2/6.3); здесь только unit-кейсы.

Ключевые проверки:

* ``start()`` / ``stop()`` идемпотентны, daemon thread корректно
  снимается.
* ``_count_incidents`` фильтрует **только** по ``operation_run_id`` +
  ``kind ∈ AUTO_SNOOZE_INCIDENT_KINDS`` + временное окно (Req 9.8).
* ``_evaluate_one`` пропускает broadcast'ы без ``operation_run_id``
  (защитный гард).
* ``_auto_snooze`` при ``count >= threshold`` транзакционно
  бампит ``auto_snooze_count``, ставит ``status='paused'`` и
  правильный ``next_run_at`` (Req 9.3).
* После 3-го авто-снуза → ``status='failed'`` с
  ``last_error='AUTO_SNOOZE_REPEATED'`` (Req 9.6).
* Notification — best-effort: ошибка INSERT в ``notifications`` НЕ
  откатывает уже применённый pause (Req 9.5).
* Per-iteration try/except в ``_tick``: исключение по одной
  рассылке не валит остальные.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional

import pytest

from scheduling.auto_snooze_watcher import (
    AUTO_SNOOZE_INCIDENT_KINDS,
    AUTO_SNOOZE_MAX_BEFORE_FAIL,
    AutoSnoozeContext,
    AutoSnoozeWatcher,
)


# ---------------------------------------------------------------------------
# Recording fakes
# ---------------------------------------------------------------------------


class _RecordingCursor:
    """psycopg2-cursor stub с rule-based fetch."""

    def __init__(
        self,
        rules: list[tuple[str, list[Mapping[str, Any]] | int]] | None = None,
    ) -> None:
        # rules: list of (sql_substring → either list-of-rows or int-count)
        self._rules: list[tuple[str, Any]] = list(rules or [])
        self._last_result: Any = None
        self.executed: list[tuple[str, tuple]] = []

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.executed.append((sql, params))
        for substring, payload in self._rules:
            if substring in sql:
                self._last_result = payload
                return
        self._last_result = []

    def fetchall(self) -> list[Any]:
        result = self._last_result
        if isinstance(result, int):
            return [{"cnt": result}]
        return list(result or [])

    def fetchone(self) -> Optional[Any]:
        result = self._last_result
        if isinstance(result, int):
            return {"cnt": result}
        if isinstance(result, list) and result:
            return result[0]
        return None

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _RecordingConn:
    def __init__(
        self,
        rules: list[tuple[str, Any]] | None = None,
        *,
        execute_raises: Optional[Exception] = None,
    ) -> None:
        self._rules = rules or []
        self._execute_raises = execute_raises
        self.cursor_obj: Optional[_RecordingCursor] = None
        self.committed = False
        self.closed = False

    def cursor(self, cursor_factory: Any = None) -> _RecordingCursor:
        cur = _RecordingCursor(self._rules)
        if self._execute_raises is not None:
            original = cur.execute
            exc = self._execute_raises

            def raising_execute(sql: str, params: tuple = ()) -> None:
                original(sql, params)
                raise exc

            cur.execute = raising_execute  # type: ignore[method-assign]
        self.cursor_obj = cur
        return cur

    def commit(self) -> None:
        self.committed = True

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> "_RecordingConn":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _make_factory(
    rules: list[tuple[str, Any]] | None = None,
    *,
    execute_raises: Optional[Exception] = None,
) -> tuple[Callable[[], _RecordingConn], list[_RecordingConn]]:
    """Возвращает (factory, list-of-issued-connections)."""

    issued: list[_RecordingConn] = []

    def _factory() -> _RecordingConn:
        c = _RecordingConn(rules=rules, execute_raises=execute_raises)
        issued.append(c)
        return c

    return _factory, issued


def _make_ctx(
    *,
    broadcast_id: int = 1,
    user_id: str = "user-uuid",
    operation_run_id: Optional[int] = 100,
    auto_snooze_count: int = 0,
    auto_snooze_threshold: int = 3,
    auto_snooze_minutes: int = 30,
    auto_snooze_window_minutes: int = 15,
) -> AutoSnoozeContext:
    return AutoSnoozeContext(
        broadcast_id=broadcast_id,
        user_id=user_id,
        operation_run_id=operation_run_id,
        auto_snooze_count=auto_snooze_count,
        auto_snooze_threshold=auto_snooze_threshold,
        auto_snooze_minutes=auto_snooze_minutes,
        auto_snooze_window_minutes=auto_snooze_window_minutes,
    )


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


class TestLifecycle:
    def test_start_starts_daemon_thread(self) -> None:
        watcher = AutoSnoozeWatcher(
            poll_interval_seconds=0.01,
            db_connection_factory=lambda: _RecordingConn(),
            clock=lambda: datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        watcher.start()
        try:
            assert watcher.is_running()
        finally:
            watcher.stop(timeout=1.0)
        assert not watcher.is_running()

    def test_start_is_idempotent(self) -> None:
        watcher = AutoSnoozeWatcher(
            poll_interval_seconds=0.01,
            db_connection_factory=lambda: _RecordingConn(),
        )
        watcher.start()
        try:
            t1 = watcher._thread  # type: ignore[attr-defined]
            watcher.start()
            t2 = watcher._thread  # type: ignore[attr-defined]
            assert t1 is t2
        finally:
            watcher.stop(timeout=1.0)

    def test_stop_is_idempotent(self) -> None:
        watcher = AutoSnoozeWatcher(
            poll_interval_seconds=0.01,
            db_connection_factory=lambda: _RecordingConn(),
        )
        watcher.start()
        watcher.stop(timeout=1.0)
        # Повторный stop должен пройти без exception.
        watcher.stop(timeout=1.0)
        assert not watcher.is_running()


# ---------------------------------------------------------------------------
# _count_incidents (Req 9.2 + 9.8 / Property P17)
# ---------------------------------------------------------------------------


class TestCountIncidents:
    def test_returns_zero_for_empty_kinds(self) -> None:
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        result = watcher._count_incidents(
            operation_run_id=10,
            kinds=[],
            window_minutes=15,
            now=datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
        )

        assert result == 0
        assert conns == []  # БД даже не открывается

    def test_returns_zero_for_non_positive_window(self) -> None:
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        for w in (0, -5):
            assert (
                watcher._count_incidents(
                    operation_run_id=10,
                    kinds=AUTO_SNOOZE_INCIDENT_KINDS,
                    window_minutes=w,
                    now=datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
                )
                == 0
            )

        assert conns == []

    def test_passes_correct_filters_to_db(self) -> None:
        rules = [("FROM incident_log", 7)]
        factory, conns = _make_factory(rules)
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        result = watcher._count_incidents(
            operation_run_id=42,
            kinds={"rate_limit_429", "watchdog_trigger"},
            window_minutes=15,
            now=now,
        )

        assert result == 7
        # Проверяем фильтры запроса.
        assert len(conns) == 1
        assert conns[0].cursor_obj is not None
        executed = conns[0].cursor_obj.executed
        assert len(executed) == 1
        sql, params = executed[0]
        # Жёсткое равенство по operation_run_id (Req 9.8 / P17).
        assert "operation_run_id = %s" in sql
        assert "kind = ANY(%s)" in sql
        assert params[0] == 42
        # kinds приходят как list (готов к ANY()).
        assert isinstance(params[1], list)
        assert set(params[1]) == {"rate_limit_429", "watchdog_trigger"}
        # Окно: [now - 15min; now]
        assert params[2] == now - timedelta(minutes=15)
        assert params[3] == now

    def test_returns_zero_when_no_rows(self) -> None:
        rules = [("FROM incident_log", [])]
        factory, _ = _make_factory(rules)
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        assert (
            watcher._count_incidents(
                operation_run_id=42,
                kinds=AUTO_SNOOZE_INCIDENT_KINDS,
                window_minutes=15,
                now=datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc),
            )
            == 0
        )


# ---------------------------------------------------------------------------
# _evaluate_one — guard for missing operation_run_id
# ---------------------------------------------------------------------------


class TestEvaluateOne:
    def test_skips_broadcast_without_operation_run_id(self) -> None:
        # Если фабрика всё-таки вызывается — тест упадёт на отсутствии rules.
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        ctx = _make_ctx(operation_run_id=None)

        watcher._evaluate_one(
            ctx, now=datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        )

        # Никаких запросов не должно произойти.
        assert conns == []

    def test_no_action_when_count_below_threshold(self) -> None:
        rules = [("FROM incident_log", 2)]  # threshold=3 → 2 < 3
        factory, conns = _make_factory(rules)
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        ctx = _make_ctx(auto_snooze_threshold=3)

        watcher._evaluate_one(
            ctx, now=datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        )

        # Только один запрос (count) — UPDATE не выполнялся.
        assert len(conns) == 1


# ---------------------------------------------------------------------------
# _auto_snooze (Req 9.3 / 9.6 / Property P18)
# ---------------------------------------------------------------------------


class TestAutoSnoozeApply:
    def test_first_snooze_sets_status_paused_and_next_run_at(self) -> None:
        # Любой UPDATE/INSERT возвращает успех.
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        ctx = _make_ctx(auto_snooze_count=0, auto_snooze_minutes=30)
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        watcher._auto_snooze(ctx, count=3, now=now)

        # Должны быть как минимум 2 round-trip'а:
        # UPDATE scheduled_broadcasts, build snapshot, INSERT notifications.
        update_calls = [
            (sql, params)
            for c in conns
            if c.cursor_obj is not None
            for (sql, params) in c.cursor_obj.executed
            if "UPDATE scheduled_broadcasts" in sql
        ]
        assert len(update_calls) == 1
        sql, params = update_calls[0]
        # Параметры: new_status, new_count, next_run_at, last_error,
        # new_status (для CASE WHEN), broadcast_id.
        assert params[0] == "paused"
        assert params[1] == 1  # count was 0, now 1
        assert params[2] == now + timedelta(minutes=30)
        assert params[3] is None  # last_error не выставляется при pause
        assert params[5] == ctx.broadcast_id

    def test_fourth_snooze_escalates_to_failed(self) -> None:
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        # auto_snooze_count=3 уже было — следующий бамп даст 4 → > 3.
        ctx = _make_ctx(auto_snooze_count=AUTO_SNOOZE_MAX_BEFORE_FAIL)
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        watcher._auto_snooze(ctx, count=5, now=now)

        update_calls = [
            (sql, params)
            for c in conns
            if c.cursor_obj is not None
            for (sql, params) in c.cursor_obj.executed
            if "UPDATE scheduled_broadcasts" in sql
        ]
        assert len(update_calls) == 1
        _, params = update_calls[0]
        assert params[0] == "failed"
        assert params[1] == 4
        assert params[2] is None  # next_run_at очищается на failed
        assert params[3] == "AUTO_SNOOZE_REPEATED"

    def test_notification_inserts_with_correct_payload(self) -> None:
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        ctx = _make_ctx(auto_snooze_count=0)
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        watcher._auto_snooze(ctx, count=3, now=now)

        # Найдём INSERT в notifications.
        insert_calls = [
            (sql, params)
            for c in conns
            if c.cursor_obj is not None
            for (sql, params) in c.cursor_obj.executed
            if "INSERT INTO notifications" in sql
        ]
        assert len(insert_calls) == 1
        _, params = insert_calls[0]
        user_id, kind, payload_json, snapshot_json = params
        assert user_id == ctx.user_id
        assert kind == "auto_snoozed"
        payload = json.loads(payload_json)
        assert payload["broadcast_id"] == ctx.broadcast_id
        assert payload["incident_count"] == 3
        assert payload["threshold"] == ctx.auto_snooze_threshold
        assert payload["resume_at"] == (now + timedelta(minutes=30)).isoformat()

    def test_failed_notification_payload_carries_reason(self) -> None:
        factory, conns = _make_factory()
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)
        ctx = _make_ctx(auto_snooze_count=AUTO_SNOOZE_MAX_BEFORE_FAIL)
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        watcher._auto_snooze(ctx, count=5, now=now)

        insert_calls = [
            (sql, params)
            for c in conns
            if c.cursor_obj is not None
            for (sql, params) in c.cursor_obj.executed
            if "INSERT INTO notifications" in sql
        ]
        assert len(insert_calls) == 1
        _, params = insert_calls[0]
        _, kind, payload_json, _ = params
        assert kind == "failed"
        payload = json.loads(payload_json)
        assert payload["reason"] == "AUTO_SNOOZE_REPEATED"
        assert payload["broadcast_id"] == ctx.broadcast_id


# ---------------------------------------------------------------------------
# Best-effort notification (Req 9.5)
# ---------------------------------------------------------------------------


class TestNotificationBestEffort:
    def test_notification_failure_does_not_rollback_pause(self) -> None:
        """Если INSERT в notifications упадёт, UPDATE на pause всё
        равно остаётся применённым (не откатывается). Tick возвращает
        управление нормально."""

        # Эмулируем сценарий: первая фабрика-вызов делает UPDATE OK,
        # последующие (build snapshot / INSERT notifications) падают.
        call_count = [0]
        update_seen: list[tuple[str, tuple]] = []

        class _Conn(_RecordingConn):
            def cursor(self, cursor_factory: Any = None) -> _RecordingCursor:
                cur = super().cursor(cursor_factory)
                # Перехватываем execute, чтобы зафиксировать UPDATE и
                # затем кидать исключение на следующих вызовах.
                original = cur.execute

                def execute(sql: str, params: tuple = ()) -> None:
                    call_count[0] += 1
                    if "UPDATE scheduled_broadcasts" in sql:
                        update_seen.append((sql, params))
                        original(sql, params)
                        return
                    # Любой запрос после UPDATE — падает.
                    raise RuntimeError("simulated DB failure")

                cur.execute = execute  # type: ignore[method-assign]
                return cur

        def _factory() -> _Conn:
            return _Conn()

        watcher = AutoSnoozeWatcher(db_connection_factory=_factory)
        ctx = _make_ctx(auto_snooze_count=0)
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        # _auto_snooze не должен поднять exception — best-effort.
        watcher._auto_snooze(ctx, count=3, now=now)

        # UPDATE был выполнен успешно.
        assert len(update_seen) == 1
        _, params = update_seen[0]
        assert params[0] == "paused"

    def test_apply_status_change_returns_false_on_db_error(self) -> None:
        factory, _ = _make_factory(execute_raises=RuntimeError("boom"))
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        ok = watcher._apply_status_change(
            broadcast_id=1,
            new_status="paused",
            new_count=1,
            next_run_at=None,
            last_error=None,
        )
        assert ok is False


# ---------------------------------------------------------------------------
# _build_payload / _build_preference_snapshot
# ---------------------------------------------------------------------------


class TestBuildHelpers:
    def test_build_payload_for_auto_snoozed(self) -> None:
        ctx = _make_ctx(auto_snooze_threshold=5)
        resume = datetime(2026, 6, 1, 13, 0, tzinfo=timezone.utc)
        payload = AutoSnoozeWatcher._build_payload(
            ctx=ctx,
            kind="auto_snoozed",
            count=7,
            new_count=2,
            resume_at=resume,
        )
        assert payload == {
            "broadcast_id": ctx.broadcast_id,
            "incident_count": 7,
            "threshold": 5,
            "resume_at": resume.isoformat(),
        }

    def test_build_payload_for_failed(self) -> None:
        ctx = _make_ctx()
        payload = AutoSnoozeWatcher._build_payload(
            ctx=ctx,
            kind="failed",
            count=10,
            new_count=4,
            resume_at=None,
        )
        assert payload == {
            "broadcast_id": ctx.broadcast_id,
            "reason": "AUTO_SNOOZE_REPEATED",
            "auto_snooze_count": 4,
        }

    def test_build_preference_snapshot_aggregates_rows(self) -> None:
        rules = [
            (
                "FROM notification_preferences",
                [
                    {"event_kind": "auto_snoozed", "channel": "in_app", "enabled": True},
                    {"event_kind": "auto_snoozed", "channel": "email", "enabled": False},
                    {"event_kind": "failed", "channel": "telegram", "enabled": True},
                ],
            )
        ]
        factory, _ = _make_factory(rules)
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        snapshot = watcher._build_preference_snapshot(user_id="u1")

        assert snapshot == {
            "auto_snoozed": {"in_app": True, "email": False},
            "failed": {"telegram": True},
        }

    def test_build_preference_snapshot_returns_empty_on_db_error(self) -> None:
        factory, _ = _make_factory(execute_raises=RuntimeError("boom"))
        watcher = AutoSnoozeWatcher(db_connection_factory=factory)

        snapshot = watcher._build_preference_snapshot(user_id="u1")
        assert snapshot == {}


# ---------------------------------------------------------------------------
# _tick — per-iteration isolation
# ---------------------------------------------------------------------------


class TestTickIsolation:
    def test_one_failing_broadcast_does_not_break_others(self) -> None:
        """Если ``_evaluate_one`` падает на одном broadcast'е,
        остальные обрабатываются корректно (Req 9.5)."""

        seen: list[int] = []
        evaluated_with: list[int] = []

        def _bad_evaluate(ctx: AutoSnoozeContext, *, now: datetime) -> None:
            evaluated_with.append(ctx.broadcast_id)
            seen.append(ctx.broadcast_id)
            if ctx.broadcast_id == 2:
                raise RuntimeError("boom on #2")

        watcher = AutoSnoozeWatcher(db_connection_factory=lambda: _RecordingConn())
        watcher._fetch_running_with_auto_snooze = lambda: [  # type: ignore[method-assign]
            _make_ctx(broadcast_id=1, operation_run_id=10),
            _make_ctx(broadcast_id=2, operation_run_id=20),
            _make_ctx(broadcast_id=3, operation_run_id=30),
        ]
        watcher._evaluate_one = _bad_evaluate  # type: ignore[method-assign]

        watcher._tick()

        # Все три broadcast'а были обработаны.
        assert evaluated_with == [1, 2, 3]

    def test_fetch_failure_aborts_tick_silently(self) -> None:
        """Ошибка SELECT не должна поднять исключение из ``_tick``."""

        watcher = AutoSnoozeWatcher(db_connection_factory=lambda: _RecordingConn())

        def _broken_fetch() -> list[AutoSnoozeContext]:
            raise RuntimeError("db down")

        watcher._fetch_running_with_auto_snooze = _broken_fetch  # type: ignore[method-assign]

        # _tick не должен пробрасывать exception наружу.
        watcher._tick()


# ---------------------------------------------------------------------------
# AUTO_SNOOZE_INCIDENT_KINDS — содержит ровно нужные виды (Req 9.2)
# ---------------------------------------------------------------------------


def test_incident_kinds_match_requirement_9_2() -> None:
    assert AUTO_SNOOZE_INCIDENT_KINDS == frozenset(
        {
            "rate_limit_429",
            "zero_response",
            "watchdog_trigger",
            "throttle_paused",
        }
    )
