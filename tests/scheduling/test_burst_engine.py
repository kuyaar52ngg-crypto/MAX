"""Unit tests for ``scheduling.burst_engine`` (Burst Mode стратегия).

Объём этих тестов — задача 4.13: проверяем контракт
:meth:`BurstEngine.distribute` (один anchor для всех получателей,
правильные метаданные, корректная обработка edge-кейсов в формате
``contacts``) и :meth:`BurstEngine.delay_for` (мэппинг
``throttle_state`` → задержка, защита от ``paused`` вызова).

Property-test P15 (Burst respects delay_min) реализуется отдельной
подзадачей 4.14 в ``test_burst_engine_property.py`` — здесь только
unit-тесты с конкретными примерами.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from anti_ban.config import AntiBanConfig
from scheduling.burst_engine import (
    BurstEngine,
    SLOWED_MULTIPLIER,
    THROTTLE_NORMAL,
    THROTTLE_PAUSED,
    THROTTLE_SLOWED,
)
from scheduling.engine import BroadcastRow
from scheduling.types import ScheduledSend


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _row(
    *,
    contacts: list,
    scheduled_for: datetime | None = datetime(
        2026, 1, 1, 12, 0, tzinfo=timezone.utc
    ),
    broadcast_id: int = 1,
) -> dict:
    """Минимально валидная dict-строка ``scheduled_broadcasts`` для burst."""

    return {
        "id": broadcast_id,
        "user_id": "user-uuid",
        "schedule_type": "burst",
        "status": "scheduled",
        "contacts": contacts,
        "next_run_at": scheduled_for,
        "scheduled_for": scheduled_for,
        "user_tz": "UTC",
    }


def _make_broadcast(
    *,
    contacts: list,
    scheduled_for: datetime | None = datetime(
        2026, 1, 1, 12, 0, tzinfo=timezone.utc
    ),
    broadcast_id: int = 1,
) -> BroadcastRow:
    return BroadcastRow.from_db_row(
        _row(
            contacts=contacts,
            scheduled_for=scheduled_for,
            broadcast_id=broadcast_id,
        )
    )


# ---------------------------------------------------------------------------
# BurstEngine.distribute
# ---------------------------------------------------------------------------


class TestBurstEngineDistribute:
    def test_returns_one_send_per_contact(self) -> None:
        engine = BurstEngine()
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991234567"},
                {"phone": "79992223344"},
                {"phone": "79993334455"},
            ]
        )

        sends = engine.distribute(bc, AntiBanConfig(), [])

        assert len(sends) == 3
        assert all(isinstance(s, ScheduledSend) for s in sends)

    def test_all_sends_share_same_anchor_send_at(self) -> None:
        engine = BurstEngine()
        anchor = datetime(2026, 5, 10, 15, 30, tzinfo=timezone.utc)
        bc = _make_broadcast(
            contacts=[{"phone": str(70000000000 + i)} for i in range(5)],
            scheduled_for=anchor,
        )

        sends = engine.distribute(bc, AntiBanConfig(), [])

        # Главное свойство Burst Mode: все sends с одинаковым anchor
        # send_at — фактический schedule делает worker.
        assert all(s.send_at == anchor for s in sends)

    def test_metadata_contains_burst_flag_and_index(self) -> None:
        engine = BurstEngine()
        contacts = [{"phone": str(70000000000 + i)} for i in range(4)]
        bc = _make_broadcast(contacts=contacts)

        sends = engine.distribute(bc, AntiBanConfig(), [])

        for i, send in enumerate(sends):
            assert send.metadata["burst"] is True
            assert send.metadata["index"] == i

    def test_indices_are_sequential_starting_from_zero(self) -> None:
        engine = BurstEngine()
        contacts = [{"phone": str(70000000000 + i)} for i in range(7)]
        bc = _make_broadcast(contacts=contacts)

        sends = engine.distribute(bc, AntiBanConfig(), [])

        indices = [s.metadata["index"] for s in sends]
        assert indices == [0, 1, 2, 3, 4, 5, 6]

    def test_phone_extracted_from_dict_contact(self) -> None:
        engine = BurstEngine()
        bc = _make_broadcast(
            contacts=[
                {"phone": "79991234567", "name": "Alice"},
                {"phone": "79992223344", "name": "Bob"},
            ]
        )

        sends = engine.distribute(bc, AntiBanConfig(), [])

        assert [s.phone for s in sends] == ["79991234567", "79992223344"]

    def test_phone_extracted_from_string_contact(self) -> None:
        # contacts иногда приходят как строки — поведение зеркалирует
        # ``BroadcastScheduler._partition_by_recipient_tz``.
        engine = BurstEngine()
        bc = _make_broadcast(contacts=["79991234567", "79992223344"])

        sends = engine.distribute(bc, AntiBanConfig(), [])

        assert [s.phone for s in sends] == ["79991234567", "79992223344"]

    def test_empty_contacts_returns_empty_list(self) -> None:
        engine = BurstEngine()
        bc = _make_broadcast(contacts=[])

        sends = engine.distribute(bc, AntiBanConfig(), [])

        assert sends == []

    def test_uses_now_when_scheduled_for_is_none(self) -> None:
        engine = BurstEngine()
        bc = _make_broadcast(
            contacts=[{"phone": "79991234567"}],
            scheduled_for=None,
        )
        before = datetime.now(timezone.utc)

        sends = engine.distribute(bc, AntiBanConfig(), [])

        after = datetime.now(timezone.utc)
        assert len(sends) == 1
        # Anchor должен попасть в окно [before, after] — это
        # подтверждает использование now() как fallback.
        assert before <= sends[0].send_at <= after

    def test_distribute_is_pure_no_state_mutation(self) -> None:
        # Pure-функция: повторный вызов с тем же broadcast возвращает
        # эквивалентный результат и не модифицирует аргументы.
        engine = BurstEngine()
        contacts = [{"phone": str(70000000000 + i)} for i in range(3)]
        bc = _make_broadcast(contacts=contacts)
        original_contacts = [dict(c) for c in contacts]

        sends_1 = engine.distribute(bc, AntiBanConfig(), [])
        sends_2 = engine.distribute(bc, AntiBanConfig(), [])

        assert sends_1 == sends_2
        # Аргументы не изменились.
        assert contacts == original_contacts

    def test_anti_ban_and_exceptions_are_ignored_in_distribute(self) -> None:
        # distribute не должна зависеть от anti_ban / exceptions —
        # вся anti-ban логика burst-mode сидит в delay_for и в worker'е.
        engine = BurstEngine()
        bc = _make_broadcast(contacts=[{"phone": "79991234567"}])

        result_1 = engine.distribute(bc, AntiBanConfig(delay_min=3.0), [])
        result_2 = engine.distribute(
            bc,
            AntiBanConfig(delay_min=99.0),
            [{"id": 1, "kind": "holiday"}],
        )

        assert result_1 == result_2

    def test_satisfies_schedule_mode_strategy_protocol(self) -> None:
        # BurstEngine должен соответствовать структурному протоколу
        # ScheduleModeStrategy, чтобы регистрироваться в
        # ScheduleModeEngine.register("burst", BurstEngine()).
        from scheduling.engine import ScheduleModeStrategy

        assert isinstance(BurstEngine(), ScheduleModeStrategy)


# ---------------------------------------------------------------------------
# BurstEngine.delay_for
# ---------------------------------------------------------------------------


class TestBurstEngineDelayFor:
    def test_normal_state_returns_delay_min(self) -> None:
        anti_ban = AntiBanConfig(delay_min=3.0, delay_max=7.0)

        delay = BurstEngine.delay_for(0, anti_ban, THROTTLE_NORMAL)

        assert delay == 3.0

    def test_slowed_state_returns_delay_min_times_one_point_five(self) -> None:
        anti_ban = AntiBanConfig(delay_min=4.0, delay_max=10.0)

        delay = BurstEngine.delay_for(0, anti_ban, THROTTLE_SLOWED)

        # 4.0 * 1.5 = 6.0
        assert delay == 4.0 * SLOWED_MULTIPLIER
        assert delay == 6.0

    def test_normal_ignores_delay_max_and_jitter(self) -> None:
        # Req 8.2: in burst mode delay_max и jitter игнорируются.
        anti_ban = AntiBanConfig(delay_min=3.0, delay_max=999.0)

        delay = BurstEngine.delay_for(0, anti_ban, THROTTLE_NORMAL)

        assert delay == 3.0

    def test_paused_state_raises_value_error(self) -> None:
        # Worker не должен вызывать delay_for в paused — это означает
        # баг вызывающего кода. Метод явно падает.
        anti_ban = AntiBanConfig()

        with pytest.raises(ValueError, match="paused"):
            BurstEngine.delay_for(0, anti_ban, THROTTLE_PAUSED)

    def test_unknown_state_raises_value_error(self) -> None:
        anti_ban = AntiBanConfig()

        with pytest.raises(ValueError, match="unknown throttle_state"):
            BurstEngine.delay_for(0, anti_ban, "blocked")

    @pytest.mark.parametrize("index", [0, 1, 5, 49, 50, 100])
    def test_delay_for_independent_of_message_index_in_normal(
        self, index: int
    ) -> None:
        # Burst пропускает long_pause_every_n (Req 8.3) — задержка
        # не должна меняться от индекса.
        anti_ban = AntiBanConfig(delay_min=3.0, long_pause_every_n=50)

        delay = BurstEngine.delay_for(index, anti_ban, THROTTLE_NORMAL)

        assert delay == 3.0

    @pytest.mark.parametrize("index", [0, 1, 5, 49, 50, 100])
    def test_delay_for_independent_of_message_index_in_slowed(
        self, index: int
    ) -> None:
        anti_ban = AntiBanConfig(delay_min=4.0, long_pause_every_n=50)

        delay = BurstEngine.delay_for(index, anti_ban, THROTTLE_SLOWED)

        assert delay == 6.0

    @pytest.mark.parametrize(
        "delay_min", [0.0, 0.5, 1.0, 3.0, 5.0, 10.0, 30.0]
    )
    def test_delay_for_at_least_delay_min_in_normal(
        self, delay_min: float
    ) -> None:
        # Property 15 example check (full property test — задача 4.14).
        anti_ban = AntiBanConfig(
            delay_min=delay_min,
            delay_max=max(delay_min, 1.0),  # delay_max не должен быть < delay_min
        )

        delay = BurstEngine.delay_for(0, anti_ban, THROTTLE_NORMAL)

        assert delay >= delay_min

    @pytest.mark.parametrize(
        "delay_min", [0.0, 0.5, 1.0, 3.0, 5.0, 10.0, 30.0]
    )
    def test_delay_for_at_least_delay_min_in_slowed(
        self, delay_min: float
    ) -> None:
        # Property 15: slowed state также удовлетворяет инварианту.
        anti_ban = AntiBanConfig(
            delay_min=delay_min,
            delay_max=max(delay_min, 1.0),
        )

        delay = BurstEngine.delay_for(0, anti_ban, THROTTLE_SLOWED)

        assert delay >= delay_min

    def test_delay_for_is_static_method(self) -> None:
        # Можно вызывать без экземпляра — это удобно для worker'а,
        # который не хранит engine в state.
        delay = BurstEngine.delay_for(
            0, AntiBanConfig(delay_min=3.0), THROTTLE_NORMAL
        )
        assert delay == 3.0

    def test_returns_float_type(self) -> None:
        # Сигнатура контракта: -> float. Проверяем тип явно, чтобы
        # наказать случайные int-ответы при будущих рефакторингах.
        delay_normal = BurstEngine.delay_for(
            0, AntiBanConfig(delay_min=3.0), THROTTLE_NORMAL
        )
        delay_slowed = BurstEngine.delay_for(
            0, AntiBanConfig(delay_min=3.0), THROTTLE_SLOWED
        )

        assert isinstance(delay_normal, float)
        assert isinstance(delay_slowed, float)
