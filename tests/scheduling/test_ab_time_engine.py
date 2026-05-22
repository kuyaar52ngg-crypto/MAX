"""Unit tests for ``scheduling.ab_time_engine`` (Task 4.7).

Покрывает:

* :meth:`ABTimeEngine.distribute` — распределение по слотам с
  детерминированным split'ом, upsert ``ab_time_test_recipients``,
  send_at в нужном часе локальной TZ, обработка edge-cases
  (пустые контакты, отсутствующий test, невалидные slots);
* :meth:`ABTimeEngine.compute_winner` — выбор winner'а по
  reply_pct → read_pct → hour, return None при ``running`` /
  ``waiting``, агрегация per slot из delivery_statuses + incoming.

Property-тесты P9 (deterministic split) и P10 (winner selection
rule) вынесены в отдельные подзадачи 4.11 и 4.12 — здесь только
unit-тесты на конкретные сценарии.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from scheduling.ab_time_engine import ABTimeEngine
from scheduling.engine import BroadcastRow
from scheduling.types import SchedulingError


# ---------------------------------------------------------------------------
# Test doubles for psycopg2 connection
# ---------------------------------------------------------------------------


class _FakeCursor:
    """Минимальный psycopg2-cursor stub.

    Хранит список `(sql_substring, rows)`-pair'ов; на каждом
    ``execute`` ищет первое подходящее правило по подстроке SQL и
    запоминает его ``rows`` для последующего ``fetchall``.

    Также записывает все вызовы ``execute`` / ``executemany`` для
    последующих assertion'ов.
    """

    def __init__(
        self,
        rules: list[tuple[str, list[Any]]],
        executemany_log: list[tuple[str, list[Any]]],
    ) -> None:
        self._rules = rules
        self._fetch_rows: list[Any] = []
        self.executed: list[tuple[str, Any]] = []
        self._executemany_log = executemany_log
        self.description: list[tuple[str, ...]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self.executed.append((sql, params))
        # Найти правило, чья подстрока есть в sql.
        for substr, rows in self._rules:
            if substr in sql:
                self._fetch_rows = list(rows)
                # Description для row_to_mapping — берём ключи из
                # первой dict-row, если она есть.
                if rows and isinstance(rows[0], dict):
                    self.description = [(k,) for k in rows[0].keys()]
                else:
                    self.description = []
                return
        # Не нашли правила — вернём пустой список (insert/update).
        self._fetch_rows = []

    def executemany(self, sql: str, rows: list[Any]) -> None:
        self._executemany_log.append((sql, list(rows)))

    def fetchall(self) -> list[Any]:
        return list(self._fetch_rows)

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConnection:
    def __init__(
        self,
        rules: list[tuple[str, list[Any]]],
    ) -> None:
        self._rules = rules
        self.executemany_log: list[tuple[str, list[Any]]] = []
        self.commits = 0

    def cursor(self, cursor_factory: Any = None) -> _FakeCursor:
        return _FakeCursor(self._rules, self.executemany_log)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        return None

    def __enter__(self) -> "_FakeConnection":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _make_db_factory(
    rules: list[tuple[str, list[Any]]],
) -> tuple[Any, list[_FakeConnection]]:
    """Фабрика, возвращающая фейковое соединение со статичными rules.

    Возвращает (factory, connections_log) — connections_log
    наполняется КАЖДЫМ созданным соединением, так что в тестах
    можно проверить, что upsert состоялся (через
    ``connections_log[-1].executemany_log``).
    """

    connections: list[_FakeConnection] = []

    def _factory() -> _FakeConnection:
        c = _FakeConnection(rules)
        connections.append(c)
        return c

    return _factory, connections


def _make_broadcast(
    *,
    broadcast_id: int = 100,
    user_id: str = "user-1",
    contacts: list[dict[str, Any]] | None = None,
    scheduled_for: datetime | None = None,
    user_tz: str = "UTC",
) -> BroadcastRow:
    if contacts is None:
        contacts = [{"phone": f"7999000{i:04d}"} for i in range(8)]
    if scheduled_for is None:
        scheduled_for = datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc)
    return BroadcastRow.from_db_row(
        {
            "id": broadcast_id,
            "user_id": user_id,
            "schedule_type": "ab_time",
            "status": "scheduled",
            "contacts": contacts,
            "next_run_at": scheduled_for,
            "scheduled_for": scheduled_for,
            "user_tz": user_tz,
        }
    )


# ---------------------------------------------------------------------------
# distribute() — happy path
# ---------------------------------------------------------------------------


class TestDistribute:
    def test_distributes_phones_into_slot_groups_max_min_le_one(self) -> None:
        # 7 телефонов, 3 слота → группы 3/2/2 (max-min=1, Property 9).
        contacts = [{"phone": f"7999000{i:04d}"} for i in range(7)]
        bc = _make_broadcast(broadcast_id=42, contacts=contacts)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 5,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 42,
                        "slots": [10, 14, 19],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, connections = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        sends = engine.distribute(bc, anti_ban=None, exceptions=[])

        assert len(sends) == 7
        # Метаданные содержат assigned slot.
        slots_in_sends = [s.metadata["slot"] for s in sends]
        # Все три hour-значения должны встречаться.
        assert set(slots_in_sends) == {10, 14, 19}
        # Распределение балансное (max-min <= 1).
        from collections import Counter

        counts = Counter(slots_in_sends)
        assert max(counts.values()) - min(counts.values()) <= 1

    def test_send_at_uses_slot_hour_in_user_tz(self) -> None:
        # scheduled_for = 2026-06-15 00:00 UTC, user_tz = Europe/Moscow (UTC+3).
        # День в Moscow всё ещё 2026-06-15 (03:00 локального).
        # Слот 10 в Moscow = 07:00 UTC.
        bc = _make_broadcast(
            broadcast_id=7,
            contacts=[{"phone": "79990001111"}],
            scheduled_for=datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc),
            user_tz="Europe/Moscow",
        )
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 7,
                        "slots": [10],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        sends = engine.distribute(bc, anti_ban=None, exceptions=[])

        assert len(sends) == 1
        assert sends[0].send_at == datetime(2026, 6, 15, 7, 0, tzinfo=timezone.utc)
        assert sends[0].metadata == {"slot": 10}

    def test_distribute_is_deterministic_for_same_broadcast_id(self) -> None:
        # Property 9: повторный вызов с тем же seed → идентичные группы.
        contacts = [{"phone": f"7999111{i:04d}"} for i in range(10)]
        bc = _make_broadcast(broadcast_id=99, contacts=contacts)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 3,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 99,
                        "slots": [9, 18],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        sends1 = engine.distribute(bc, anti_ban=None, exceptions=[])
        sends2 = engine.distribute(bc, anti_ban=None, exceptions=[])

        assert [(s.phone, s.metadata["slot"]) for s in sends1] == [
            (s.phone, s.metadata["slot"]) for s in sends2
        ]

    def test_upsert_writes_one_row_per_phone(self) -> None:
        contacts = [{"phone": f"7999222{i:04d}"} for i in range(4)]
        bc = _make_broadcast(broadcast_id=11, contacts=contacts)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 8,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 11,
                        "slots": [10, 19],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, connections = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        engine.distribute(bc, anti_ban=None, exceptions=[])

        # Last connection used for upsert must have executemany call.
        assert connections, "expected at least one connection"
        # Find the connection that did upsert (executemany_log non-empty).
        upsert_conns = [c for c in connections if c.executemany_log]
        assert upsert_conns, "expected upsert via executemany"
        sql, rows = upsert_conns[-1].executemany_log[-1]
        assert "INSERT INTO ab_time_test_recipients" in sql
        assert "ON CONFLICT" in sql
        assert len(rows) == 4
        # Each row is (test_id, phone, slot_hour)
        for r in rows:
            assert len(r) == 3
            assert r[0] == 8
            assert r[2] in (10, 19)

    def test_empty_contacts_returns_empty_list_no_db(self) -> None:
        bc = _make_broadcast(contacts=[])
        # Pass a factory that would fail if called.
        def _failing_factory() -> Any:
            raise RuntimeError("must not be called for empty contacts")

        engine = ABTimeEngine(db_connection_factory=_failing_factory)

        assert engine.distribute(bc, anti_ban=None, exceptions=[]) == []

    def test_dedupes_phones_before_split(self) -> None:
        # Один и тот же номер встречается дважды — должен учитываться один раз.
        contacts = [
            {"phone": "+7 (999) 000-11-22"},
            {"phone": "79990001122"},  # тот же номер после нормализации
            {"phone": "79990003344"},
        ]
        bc = _make_broadcast(broadcast_id=5, contacts=contacts)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 5,
                        "slots": [10, 14],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        sends = engine.distribute(bc, anti_ban=None, exceptions=[])

        # 2 unique phones (после dedupe) разделились на 2 слота — по одному.
        assert len(sends) == 2


# ---------------------------------------------------------------------------
# distribute() — error paths
# ---------------------------------------------------------------------------


class TestDistributeErrors:
    def test_raises_when_test_not_found(self) -> None:
        bc = _make_broadcast(broadcast_id=999)
        rules = [("FROM ab_time_tests", [])]  # ничего не вернётся
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        with pytest.raises(SchedulingError) as exc_info:
            engine.distribute(bc, anti_ban=None, exceptions=[])

        assert exc_info.value.code == "ABTIME_TEST_NOT_FOUND"
        assert exc_info.value.http_status == 404

    def test_raises_on_invalid_slots_shape(self) -> None:
        bc = _make_broadcast(broadcast_id=1)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 1,
                        "slots": "not-a-list",
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        with pytest.raises(SchedulingError) as exc_info:
            engine.distribute(bc, anti_ban=None, exceptions=[])

        assert exc_info.value.code == "ABTIME_SLOTS_INVALID"
        assert exc_info.value.http_status == 400

    def test_raises_on_out_of_range_hour_in_slots(self) -> None:
        bc = _make_broadcast(broadcast_id=1)
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 1,
                        "slots": [10, 25],  # 25 — невалидный час
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        with pytest.raises(SchedulingError) as exc_info:
            engine.distribute(bc, anti_ban=None, exceptions=[])

        assert exc_info.value.code == "ABTIME_SLOTS_INVALID"

    def test_slots_as_json_string_is_parsed(self) -> None:
        # Если RealDictCursor не разобрал JSONB и отдал строку — парсим.
        bc = _make_broadcast(broadcast_id=1, contacts=[{"phone": "79990000001"}])
        rules = [
            (
                "FROM ab_time_tests",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 1,
                        "slots": "[10, 14]",
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        sends = engine.distribute(bc, anti_ban=None, exceptions=[])

        assert len(sends) == 1
        assert sends[0].metadata["slot"] in (10, 14)


# ---------------------------------------------------------------------------
# compute_winner() — Req 3.5 / 3.6
# ---------------------------------------------------------------------------


class TestComputeWinner:
    def test_returns_none_when_status_running(self) -> None:
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 1,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [10, 14, 19],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "running",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        assert engine.compute_winner(1) is None

    def test_returns_none_when_status_waiting(self) -> None:
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 2,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [10, 14],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "waiting",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        assert engine.compute_winner(2) is None

    def test_returns_none_when_test_not_found(self) -> None:
        rules = [("FROM ab_time_tests\n             WHERE id", [])]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        assert engine.compute_winner(123) is None

    def test_picks_slot_with_max_reply_pct(self) -> None:
        # Slot 10: 10 total, 5 replied → reply_pct=0.5
        # Slot 14: 10 total, 8 replied → reply_pct=0.8 ← winner
        # Slot 19: 10 total, 7 replied → reply_pct=0.7
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 5,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [10, 14, 19],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "completed",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
            (
                "FROM ab_time_test_recipients\n                     WHERE ab_time_test_id",
                [
                    {"slot_hour": 10, "total": 10},
                    {"slot_hour": 14, "total": 10},
                    {"slot_hour": 19, "total": 10},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN recipients",
                [
                    {"slot_hour": 10, "status": "delivered", "cnt": 8},
                    {"slot_hour": 14, "status": "delivered", "cnt": 9},
                    {"slot_hour": 19, "status": "delivered", "cnt": 9},
                    {"slot_hour": 10, "status": "read", "cnt": 6},
                    {"slot_hour": 14, "status": "read", "cnt": 7},
                    {"slot_hour": 19, "status": "read", "cnt": 8},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN incoming",
                [
                    {"slot_hour": 10, "replied": 5},
                    {"slot_hour": 14, "replied": 8},
                    {"slot_hour": 19, "replied": 7},
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        winner = engine.compute_winner(5)

        assert winner == 14

    def test_ties_broken_by_max_read_pct(self) -> None:
        # Slot 10 и 14 имеют одинаковый reply_pct, но slot 14 имеет
        # больший read_pct → winner = 14.
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 6,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [10, 14],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "completed",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
            (
                "FROM ab_time_test_recipients\n                     WHERE ab_time_test_id",
                [
                    {"slot_hour": 10, "total": 10},
                    {"slot_hour": 14, "total": 10},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN recipients",
                [
                    {"slot_hour": 10, "status": "read", "cnt": 5},
                    {"slot_hour": 14, "status": "read", "cnt": 8},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN incoming",
                [
                    {"slot_hour": 10, "replied": 5},
                    {"slot_hour": 14, "replied": 5},
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        assert engine.compute_winner(6) == 14

    def test_ties_broken_by_min_hour_when_reply_and_read_equal(self) -> None:
        # Все три слота имеют одинаковые pcts → выигрывает min hour = 10.
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 7,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [19, 14, 10],  # порядок в JSONB не отсортирован
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "completed",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
            (
                "FROM ab_time_test_recipients\n                     WHERE ab_time_test_id",
                [
                    {"slot_hour": 10, "total": 10},
                    {"slot_hour": 14, "total": 10},
                    {"slot_hour": 19, "total": 10},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN recipients",
                [
                    {"slot_hour": 10, "status": "read", "cnt": 5},
                    {"slot_hour": 14, "status": "read", "cnt": 5},
                    {"slot_hour": 19, "status": "read", "cnt": 5},
                ],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN incoming",
                [
                    {"slot_hour": 10, "replied": 3},
                    {"slot_hour": 14, "replied": 3},
                    {"slot_hour": 19, "replied": 3},
                ],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        assert engine.compute_winner(7) == 10

    def test_zero_metrics_picks_min_hour(self) -> None:
        # Тест complete, но per slot ноль events → tie на нуле → min hour.
        rules = [
            (
                "FROM ab_time_tests\n             WHERE id",
                [
                    {
                        "id": 8,
                        "user_id": "user-1",
                        "scheduled_broadcast_id": 100,
                        "slots": [10, 14, 19],
                        "winner_slot": None,
                        "wait_hours": 24,
                        "status": "completed",
                        "started_at": datetime(2026, 6, 15, tzinfo=timezone.utc),
                        "completed_at": None,
                    }
                ],
            ),
            (
                "FROM ab_time_test_recipients\n                     WHERE ab_time_test_id",
                [],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN recipients",
                [],
            ),
            (
                "FROM ab_time_test_recipients atr\n                      JOIN incoming",
                [],
            ),
        ]
        factory, _ = _make_db_factory(rules)
        engine = ABTimeEngine(db_connection_factory=factory)

        # Нет данных — все pcts=0, tie-break по min hour.
        assert engine.compute_winner(8) == 10
