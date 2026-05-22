"""Unit tests for ``scheduling.reschedule_op.execute`` (Task 6.7).

Покрывает Requirements 11.5–11.9 спеки ``broadcast-scheduling-suite``.
Property-тесты P21/P22/P23 — отдельные подзадачи 6.8/6.9/6.10; здесь
только unit-кейсы на конкретные сценарии и edge-cases:

* status guard (Req 11.9) — для всех терминальных и pending-approval
  статусов;
* timestamp guard (Req 11.8) — равные и прошлые timestamps;
* snapshot pending получателей через operation_runs.payload joins;
* fallback: broadcast никогда не стартовал → все original.contacts pending;
* эмпти pending → original=cancelled, new=None;
* exact-value copy follow_up_chain_id (Req 11.7 / Property 21);
* parent_broadcast_id = original.id (Req 11.6);
* копируются message/personalized_messages/use_typing/delay_seconds/
  file_url/file_name/instance_id/adaptive_throttle/quiet_hours_*/
  respect_recipient_tz/user_tz (Req 11.5 acceptance criteria).
* атомарность: ROLLBACK на любой ошибке.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Sequence

import pytest

from scheduling.reschedule_op import (
    RESCHEDULE_VALID_STATUSES,
    RescheduleResult,
    execute,
)
from scheduling.types import SchedulingError


# ---------------------------------------------------------------------------
# Test doubles for psycopg2 connection
# ---------------------------------------------------------------------------


class _FakeCursor:
    """Минимальный psycopg2-cursor stub с rule-based fetch.

    Каждый ``execute`` ищет первое подходящее правило по подстроке
    SQL и запоминает (rows, returning_value) для следующего fetch.
    Все вызовы записываются в ``executed`` для assertion'ов.
    """

    def __init__(
        self,
        rules: list[tuple[str, list[Any]]],
    ) -> None:
        self._rules = rules
        self._fetch_rows: list[Any] = []
        self.executed: list[tuple[str, Any]] = []
        self.description: list[tuple[str, ...]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self.executed.append((sql, params))
        for substr, rows in self._rules:
            if substr in sql:
                self._fetch_rows = list(rows)
                if rows and isinstance(rows[0], dict):
                    self.description = [(k,) for k in rows[0].keys()]
                else:
                    self.description = []
                return
        # Не нашли правила — пустой результат (для UPDATE/INSERT).
        self._fetch_rows = []
        self.description = []

    def fetchone(self) -> Optional[Any]:
        if not self._fetch_rows:
            return None
        first = self._fetch_rows[0]
        # Симулируем consume первой строки, как настоящий cursor.
        self._fetch_rows = self._fetch_rows[1:]
        return first

    def fetchall(self) -> list[Any]:
        rows = list(self._fetch_rows)
        self._fetch_rows = []
        return rows

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConnection:
    def __init__(
        self,
        rules: list[tuple[str, list[Any]]],
        *,
        execute_raises_on_substr: Optional[str] = None,
    ) -> None:
        self._rules = rules
        self._execute_raises_on_substr = execute_raises_on_substr
        self.commits = 0
        self.rollbacks = 0
        self.closed = False
        self.autocommit = False
        self.cursors: list[_FakeCursor] = []

    def cursor(self, cursor_factory: Any = None) -> _FakeCursor:
        cur = _FakeCursor(self._rules)
        if self._execute_raises_on_substr is not None:
            original_execute = cur.execute
            substr = self._execute_raises_on_substr

            def raising_execute(sql: str, params: Any = None) -> None:
                original_execute(sql, params)
                if substr in sql:
                    raise RuntimeError(f"simulated DB failure on '{substr}'")

            cur.execute = raising_execute  # type: ignore[method-assign]
        self.cursors.append(cur)
        return cur

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> "_FakeConnection":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _make_factory(
    rules: list[tuple[str, list[Any]]],
    *,
    execute_raises_on_substr: Optional[str] = None,
) -> tuple[Any, list[_FakeConnection]]:
    """Возвращает (factory, list-of-issued-connections)."""

    issued: list[_FakeConnection] = []

    def _factory() -> _FakeConnection:
        c = _FakeConnection(
            rules=rules,
            execute_raises_on_substr=execute_raises_on_substr,
        )
        issued.append(c)
        return c

    return _factory, issued


# ---------------------------------------------------------------------------
# Helpers — original row builder
# ---------------------------------------------------------------------------


def _make_original(
    *,
    id: int = 100,
    user_id: str = "user-1",
    status: str = "running",
    follow_up_chain_id: Optional[int] = None,
    contacts: Optional[list[Any]] = None,
    **overrides: Any,
) -> dict[str, Any]:
    """Построить dict исходной строки ``scheduled_broadcasts``."""

    if contacts is None:
        contacts = [{"phone": "79991111111"}, {"phone": "79992222222"}]
    base = {
        "id": id,
        "user_id": user_id,
        "name": "test broadcast",
        "message": "Hello {name}",
        "contacts": contacts,
        "personalized_messages": None,
        "use_typing": True,
        "delay_seconds": 5.0,
        "file_url": "https://example.com/file.png",
        "file_name": "file.png",
        "schedule_type": "exact",
        "scheduled_for": datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc),
        "quiet_hours_enabled": True,
        "quiet_hours_start": 22,
        "quiet_hours_end": 8,
        "respect_recipient_tz": False,
        "user_tz": "Europe/Moscow",
        "status": status,
        "instance_id": 7,
        "adaptive_throttle": True,
        "follow_up_chain_id": follow_up_chain_id,
    }
    base.update(overrides)
    return base


_FROZEN_NOW = datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)
_FUTURE = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc)
_PAST = datetime(2026, 5, 30, 8, 0, tzinfo=timezone.utc)


def _frozen_clock() -> datetime:
    return _FROZEN_NOW


# ---------------------------------------------------------------------------
# RESCHEDULE_IN_PAST (Req 11.8 / Property P23)
# ---------------------------------------------------------------------------


class TestRescheduleInPast:
    def test_strictly_past_timestamp_raises_400(self) -> None:
        factory, issued = _make_factory([])

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=1,
                scheduled_for=_PAST,
                user_id="u",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_IN_PAST"
        assert exc_info.value.http_status == 400
        # Проверка идёт ДО открытия БД-соединения (защитный гард).
        assert issued == []

    def test_equal_timestamp_treated_as_in_past(self) -> None:
        # Req 11.8: ``less than or equal to current server time``.
        factory, issued = _make_factory([])

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=1,
                scheduled_for=_FROZEN_NOW,
                user_id="u",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_IN_PAST"
        assert exc_info.value.http_status == 400

    def test_naive_datetime_is_interpreted_as_utc(self) -> None:
        # Naive 2026-06-01 09:00:00 == _FROZEN_NOW в UTC → in past.
        naive = datetime(2026, 6, 1, 9, 0)
        factory, _ = _make_factory([])

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=1,
                scheduled_for=naive,
                user_id="u",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_IN_PAST"


# ---------------------------------------------------------------------------
# RESCHEDULE_INVALID_STATUS (Req 11.9)
# ---------------------------------------------------------------------------


class TestRescheduleInvalidStatus:
    @pytest.mark.parametrize(
        "status", ["scheduled", "completed", "failed", "cancelled", "pending_approval"]
    )
    def test_non_running_paused_status_raises_409(self, status: str) -> None:
        original = _make_original(status=status)
        rules = [("FROM scheduled_broadcasts", [original])]
        factory, conns = _make_factory(rules)

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=100,
                scheduled_for=_FUTURE,
                user_id="user-1",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_INVALID_STATUS"
        assert exc_info.value.http_status == 409
        # Транзакция откачена, никаких новых broadcast-ов.
        assert conns[0].rollbacks >= 1
        assert conns[0].commits == 0

    @pytest.mark.parametrize("status", ["running", "paused"])
    def test_running_and_paused_are_allowed(self, status: str) -> None:
        original = _make_original(status=status)
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),  # broadcast не стартовал → fallback
            ("INSERT INTO scheduled_broadcasts", [{"id": 555}]),
        ]
        factory, _ = _make_factory(rules)

        result = execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        # Не упало → status guard прошёл. Сам результат проверяется в
        # отдельном TestSnapshot.
        assert result.original_status_after in {"completed", "cancelled"}


class TestNotFound:
    def test_missing_broadcast_raises_404(self) -> None:
        rules = [("FROM scheduled_broadcasts", [])]  # ничего не вернётся
        factory, conns = _make_factory(rules)

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=999,
                scheduled_for=_FUTURE,
                user_id="user-1",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_NOT_FOUND"
        assert exc_info.value.http_status == 404
        assert conns[0].rollbacks >= 1


# ---------------------------------------------------------------------------
# Snapshot pending recipients
# ---------------------------------------------------------------------------


class TestSnapshotPending:
    def test_no_recipients_rows_falls_back_to_original_contacts(self) -> None:
        # Broadcast никогда не стартовал worker → recipients пуст →
        # все original.contacts считаются pending.
        original = _make_original(
            status="paused",
            contacts=[
                {"phone": "79991111111"},
                {"phone": "79992222222"},
                {"phone": "79993333333"},
            ],
        )
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),  # пусто
            ("INSERT INTO scheduled_broadcasts", [{"id": 200}]),
        ]
        factory, conns = _make_factory(rules)

        result = execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        assert result.new_broadcast_id == 200
        assert result.pending_recipient_count == 3
        assert result.original_status_after == "completed"

        # INSERT params содержат contacts JSON со всеми 3 телефонами.
        cur = conns[0].cursors[0]
        insert_call = next(
            (c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]),
            None,
        )
        assert insert_call is not None
        params = insert_call[1]
        # 4-й параметр (index 3) — contacts JSON.
        contacts_json = params[3]
        contacts = json.loads(contacts_json)
        assert {c["phone"] for c in contacts} == {
            "79991111111",
            "79992222222",
            "79993333333",
        }

    def test_partial_pending_excludes_already_sent(self) -> None:
        # Property 22: only pending recipients are copied.
        original = _make_original(status="running")
        recipients = [
            {"phone": "79991111111", "status": "sent"},
            {"phone": "79992222222", "status": "pending"},
            {"phone": "79993333333", "status": "failed"},
            {"phone": "79994444444", "status": "pending"},
        ]
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", recipients),
            ("INSERT INTO scheduled_broadcasts", [{"id": 300}]),
        ]
        factory, conns = _make_factory(rules)

        result = execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        assert result.new_broadcast_id == 300
        assert result.pending_recipient_count == 2
        # Проверим что в INSERT попали ровно pending phones.
        cur = conns[0].cursors[0]
        insert_call = next(
            c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]
        )
        contacts_json = insert_call[1][3]
        contacts = json.loads(contacts_json)
        phones = {c["phone"] for c in contacts}
        assert phones == {"79992222222", "79994444444"}
        # Уже-отправленные не должны попасть.
        assert "79991111111" not in phones
        assert "79993333333" not in phones

    def test_dedupes_duplicate_phones(self) -> None:
        # Защитный гард — одинаковые номера не должны попасть дважды.
        original = _make_original(status="running")
        recipients = [
            {"phone": "79991111111", "status": "pending"},
            {"phone": "79991111111", "status": "pending"},  # дубль
            {"phone": "79992222222", "status": "pending"},
        ]
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", recipients),
            ("INSERT INTO scheduled_broadcasts", [{"id": 301}]),
        ]
        factory, conns = _make_factory(rules)

        result = execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        assert result.pending_recipient_count == 2

    def test_zero_pending_recipients_cancels_original_no_new_broadcast(
        self,
    ) -> None:
        # Все уже отправлены → новая рассылка НЕ создаётся.
        original = _make_original(status="running")
        recipients = [
            {"phone": "79991111111", "status": "sent"},
            {"phone": "79992222222", "status": "sent"},
            {"phone": "79993333333", "status": "failed"},
        ]
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", recipients),
        ]
        factory, conns = _make_factory(rules)

        result = execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        assert result.new_broadcast_id is None
        assert result.pending_recipient_count == 0
        assert result.original_status_after == "cancelled"
        # Убедимся, что INSERT не выполнялся.
        cur = conns[0].cursors[0]
        insert_calls = [
            c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]
        ]
        assert insert_calls == []
        # Должен быть UPDATE с status=cancelled.
        update_calls = [
            c for c in cur.executed if "UPDATE scheduled_broadcasts" in c[0]
        ]
        assert len(update_calls) == 1
        assert update_calls[0][1][0] == "cancelled"
        # Транзакция закоммичена.
        assert conns[0].commits == 1


# ---------------------------------------------------------------------------
# Field copy (Req 11.5/11.6/11.7)
# ---------------------------------------------------------------------------


class TestFieldCopy:
    @pytest.mark.parametrize(
        "follow_up_chain_id", [None, 0, 42, 9999, 2**63 - 1]
    )
    def test_follow_up_chain_id_is_exact_value_copy(
        self, follow_up_chain_id: Optional[int]
    ) -> None:
        # Req 11.7 / Property 21: bit-for-bit copy, no transformation.
        original = _make_original(
            status="running", follow_up_chain_id=follow_up_chain_id
        )
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),  # fallback
            ("INSERT INTO scheduled_broadcasts", [{"id": 400}]),
        ]
        factory, conns = _make_factory(rules)

        execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        cur = conns[0].cursors[0]
        insert_call = next(
            c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]
        )
        params = insert_call[1]
        # follow_up_chain_id — предпоследний параметр (см. _INSERT_NEW_SQL).
        follow_up_param = params[-2]
        # parent_broadcast_id — последний параметр.
        parent_param = params[-1]
        assert follow_up_param == follow_up_chain_id
        assert parent_param == 100

    def test_copies_all_required_fields_into_new_broadcast(self) -> None:
        original = _make_original(
            status="running",
            follow_up_chain_id=77,
            personalized_messages={"79991111111": "Custom"},
        )
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),
            ("INSERT INTO scheduled_broadcasts", [{"id": 500}]),
        ]
        factory, conns = _make_factory(rules)

        execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        cur = conns[0].cursors[0]
        insert_call = next(
            c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]
        )
        params = list(insert_call[1])
        # Контракт _INSERT_NEW_SQL: позиции параметров фиксированы.
        # 0:user_id, 1:name, 2:message, 3:contacts, 4:personalized_messages,
        # 5:use_typing, 6:delay_seconds, 7:file_url, 8:file_name,
        # 9:schedule_type, 10:scheduled_for, 11:qh_enabled, 12:qh_start,
        # 13:qh_end, 14:respect_recipient_tz, 15:user_tz,
        # 16:next_run_at, 17:instance_id, 18:adaptive_throttle,
        # 19:follow_up_chain_id, 20:parent_broadcast_id.
        assert params[0] == "user-1"
        assert params[1] == "test broadcast"
        assert params[2] == "Hello {name}"
        # personalized_messages — JSONB-строка.
        assert json.loads(params[4]) == {"79991111111": "Custom"}
        assert params[5] is True  # use_typing
        assert params[6] == 5.0  # delay_seconds
        assert params[7] == "https://example.com/file.png"
        assert params[8] == "file.png"
        assert params[9] == "exact"
        assert params[10] == _FUTURE
        assert params[11] is True  # quiet_hours_enabled
        assert params[12] == 22
        assert params[13] == 8
        assert params[14] is False  # respect_recipient_tz
        assert params[15] == "Europe/Moscow"
        # next_run_at равен scheduled_for.
        assert params[16] == _FUTURE
        assert params[17] == 7  # instance_id
        assert params[18] is True  # adaptive_throttle
        assert params[19] == 77  # follow_up_chain_id
        assert params[20] == 100  # parent_broadcast_id

    def test_personalized_messages_null_remains_null(self) -> None:
        original = _make_original(status="paused", personalized_messages=None)
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),
            ("INSERT INTO scheduled_broadcasts", [{"id": 600}]),
        ]
        factory, conns = _make_factory(rules)

        execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        cur = conns[0].cursors[0]
        insert_call = next(
            c for c in cur.executed if "INSERT INTO scheduled_broadcasts" in c[0]
        )
        # personalized_messages — index 4.
        assert insert_call[1][4] is None


# ---------------------------------------------------------------------------
# Original status update (Req 11.5(c))
# ---------------------------------------------------------------------------


class TestOriginalStatusUpdate:
    def test_original_status_completed_when_pending_existed(self) -> None:
        original = _make_original(status="running")
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", [{"phone": "79990000000", "status": "pending"}]),
            ("INSERT INTO scheduled_broadcasts", [{"id": 700}]),
        ]
        factory, conns = _make_factory(rules)

        execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-1",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        cur = conns[0].cursors[0]
        update_calls = [
            c for c in cur.executed if "UPDATE scheduled_broadcasts" in c[0]
        ]
        assert len(update_calls) == 1
        params = update_calls[0][1]
        # _UPDATE_ORIGINAL_SQL: (status, last_run_at, id)
        assert params[0] == "completed"
        assert params[1] == _FROZEN_NOW
        assert params[2] == 100


# ---------------------------------------------------------------------------
# Atomicity / rollback
# ---------------------------------------------------------------------------


class TestAtomicity:
    def test_db_error_during_insert_rolls_back_and_raises_db_error(self) -> None:
        original = _make_original(status="running")
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", [{"phone": "79990000001", "status": "pending"}]),
            ("INSERT INTO scheduled_broadcasts", [{"id": 800}]),
        ]
        factory, conns = _make_factory(
            rules,
            execute_raises_on_substr="INSERT INTO scheduled_broadcasts",
        )

        with pytest.raises(SchedulingError) as exc_info:
            execute(
                original_id=100,
                scheduled_for=_FUTURE,
                user_id="user-1",
                db_connection_factory=factory,
                clock=_frozen_clock,
            )

        assert exc_info.value.code == "RESCHEDULE_DB_ERROR"
        assert exc_info.value.http_status == 500
        assert conns[0].rollbacks >= 1
        assert conns[0].commits == 0

    def test_select_for_update_uses_correct_params_and_locks(self) -> None:
        # Защита: SELECT … FOR UPDATE должен включать ``FOR UPDATE``
        # и фильтр user_id (defence-in-depth ownership).
        original = _make_original(status="running")
        rules = [
            ("FROM scheduled_broadcasts", [original]),
            ("FROM recipients", []),
            ("INSERT INTO scheduled_broadcasts", [{"id": 900}]),
        ]
        factory, conns = _make_factory(rules)

        execute(
            original_id=100,
            scheduled_for=_FUTURE,
            user_id="user-special",
            db_connection_factory=factory,
            clock=_frozen_clock,
        )

        cur = conns[0].cursors[0]
        select_call = next(
            c
            for c in cur.executed
            if "FROM scheduled_broadcasts" in c[0] and "FOR UPDATE" in c[0]
        )
        # Params: (original_id, user_id).
        assert select_call[1] == (100, "user-special")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_valid_statuses_match_requirement_11_5(self) -> None:
        assert RESCHEDULE_VALID_STATUSES == frozenset({"running", "paused"})

    def test_result_dataclass_is_frozen(self) -> None:
        result = RescheduleResult(
            new_broadcast_id=1,
            pending_recipient_count=2,
            original_status_after="completed",
        )
        with pytest.raises(Exception):
            result.new_broadcast_id = 99  # type: ignore[misc]
