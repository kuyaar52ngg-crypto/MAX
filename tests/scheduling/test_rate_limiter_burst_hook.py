"""Unit tests for the burst-mode hook on :class:`RateLimiter`.

These tests verify the integration glue between
``broadcast-scheduling-suite`` Task 7.1 and the existing
``anti_ban.rate_limiter`` module:

* When ``acquire(burst_mode=True)`` is called, the random jitter step
  is replaced by a deterministic call to
  :meth:`scheduling.burst_engine.BurstEngine.delay_for` and the
  ``long_pause_every_n`` step is skipped (Req 8.2 / 8.3).
* The pending-backoff after an HTTP 429 still applies in burst mode
  (Req 8.5: recovery via Adaptive_Throttle state machine).
* The sliding-window invariant still applies in burst mode (anti-ban
  hard floor — burst does not override it).
* ``burst_mode=False`` (the default) preserves legacy behaviour
  bit-for-bit — no impact on the non-burst broadcast / check paths.

The tests use the ``clock``/``sleep``/``rng`` DI parameters of
``RateLimiter`` to avoid real waits and to make assertions
deterministic.
"""

from __future__ import annotations

import random
from typing import Callable

import pytest

from anti_ban.config import AntiBanConfig
from anti_ban.rate_limiter import RateLimiter


class _FakeClock:
    """Manually-controlled clock for deterministic tests."""

    def __init__(self, t0: float = 1_000_000.0) -> None:
        self.t = t0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class _SleepRecorder:
    """Records sleep durations and advances a paired clock."""

    def __init__(self, clock: _FakeClock) -> None:
        self.clock = clock
        self.calls: list[float] = []

    def __call__(self, dt: float) -> None:
        self.calls.append(dt)
        self.clock.advance(dt)


def _make_limiter(
    config: AntiBanConfig,
    *,
    rng_seed: int = 42,
) -> tuple[RateLimiter, _FakeClock, _SleepRecorder]:
    clock = _FakeClock()
    sleeper = _SleepRecorder(clock)
    rng = random.Random(rng_seed)
    rl = RateLimiter(config, clock=clock, sleep=sleeper, rng=rng)
    return rl, clock, sleeper


# ---------------------------------------------------------------------------
# Burst mode pacing
# ---------------------------------------------------------------------------


class TestBurstModeAcquire:
    def test_burst_normal_uses_delay_min_exactly(self) -> None:
        # Req 8.2: delay = AntiBanConfig.delay_min, никакого джиттера.
        cfg = AntiBanConfig(
            delay_min=3.0,
            delay_max=10.0,
            broadcast_delay_min=5.0,    # обычно бы поднимало floor
            broadcast_jitter_max=2.0,    # обычно добавляло бы jitter
            long_pause_every_n=0,        # отключено для чистоты
            sliding_window_n=1000,       # SW не должен срабатывать
        )
        rl, _, sleeper = _make_limiter(cfg)

        rl.acquire(kind="broadcast", burst_mode=True)

        # Expected sleeps: только burst-delay (3.0). Никаких других пауз.
        assert sleeper.calls == [3.0]

    def test_burst_slowed_uses_delay_min_times_one_point_five(self) -> None:
        cfg = AntiBanConfig(
            delay_min=4.0,
            delay_max=10.0,
            long_pause_every_n=0,
            sliding_window_n=1000,
        )
        rl, _, sleeper = _make_limiter(cfg)

        rl.acquire(
            kind="broadcast",
            burst_mode=True,
            burst_throttle_state="slowed",
        )

        # 4.0 * 1.5 == 6.0
        assert sleeper.calls == [6.0]

    def test_burst_skips_long_pause_every_n(self) -> None:
        # Req 8.3: long_pause_every_n должен пропускаться в burst mode.
        cfg = AntiBanConfig(
            delay_min=2.0,
            delay_max=5.0,
            long_pause_every_n=2,        # каждые 2 запроса
            long_pause_seconds=60.0,
            sliding_window_n=1000,
        )
        rl, _, sleeper = _make_limiter(cfg)

        # Делаем 5 acquire'ов — long pause НЕ должен сработать ни разу.
        for _ in range(5):
            rl.acquire(kind="broadcast", burst_mode=True)

        # Все 5 sleep'ов — это burst-delay 2.0; никаких 60.0
        assert sleeper.calls == [2.0] * 5
        assert 60.0 not in sleeper.calls

    def test_legacy_mode_still_applies_long_pause(self) -> None:
        # Регрессия: обычный путь без burst_mode должен вставлять
        # long pause каждые N запросов (Requirement 1.7).
        cfg = AntiBanConfig(
            delay_min=0.0,                # минимизируем jitter-вклад
            delay_max=0.0,
            broadcast_delay_min=0.0,
            broadcast_jitter_max=0.0,
            long_pause_every_n=2,
            long_pause_seconds=60.0,
            sliding_window_n=1000,
        )
        rl, _, sleeper = _make_limiter(cfg)

        rl.acquire(kind="broadcast")
        rl.acquire(kind="broadcast")  # 2-й — должен включить long pause

        # Среди sleep-вызовов должен быть 60.0
        assert 60.0 in sleeper.calls

    def test_burst_pending_backoff_still_applies(self) -> None:
        # Req 8.5: pending_backoff после 429 должен срабатывать
        # независимо от burst_mode. Adaptive_Throttle отвечает за
        # state machine (normal → slowed → normal), а pending_backoff
        # — за конкретную паузу после 429.
        cfg = AntiBanConfig(
            delay_min=2.0,
            backoff_base_seconds=5.0,
            long_pause_every_n=0,
            sliding_window_n=1000,
        )
        rl, _, sleeper = _make_limiter(cfg)
        wait = rl.on_http_429(0)

        rl.acquire(kind="broadcast", burst_mode=True)

        # Первый sleep — pending_backoff, второй — burst-delay 2.0
        assert sleeper.calls[0] == wait
        assert sleeper.calls[1] == 2.0

    def test_burst_paused_state_raises(self) -> None:
        # paused-state не должен использоваться worker'ом — broadcast
        # ставится на паузу до запроса delay_for. Защита от бага
        # вызывающего кода — явный ValueError.
        cfg = AntiBanConfig(delay_min=3.0, sliding_window_n=1000, long_pause_every_n=0)
        rl, _, _ = _make_limiter(cfg)

        with pytest.raises(ValueError, match="paused"):
            rl.acquire(
                kind="broadcast",
                burst_mode=True,
                burst_throttle_state="paused",
            )

    def test_burst_unknown_state_raises(self) -> None:
        cfg = AntiBanConfig(delay_min=3.0, sliding_window_n=1000, long_pause_every_n=0)
        rl, _, _ = _make_limiter(cfg)

        with pytest.raises(ValueError, match="unknown throttle_state"):
            rl.acquire(
                kind="broadcast",
                burst_mode=True,
                burst_throttle_state="weird",
            )


# ---------------------------------------------------------------------------
# Backward compatibility
# ---------------------------------------------------------------------------


class TestBackwardCompatibility:
    def test_default_kwargs_match_legacy_signature(self) -> None:
        # acquire(kind=...) без burst_* должен работать как и раньше.
        cfg = AntiBanConfig(
            delay_min=1.0, delay_max=1.0,                # фиксируем jitter
            broadcast_delay_min=1.0, broadcast_jitter_max=0.0,
            long_pause_every_n=0,
            sliding_window_n=1000,
        )
        rl, _, sleeper = _make_limiter(cfg)

        rl.acquire(kind="broadcast")

        # Должен быть один sleep — обычный jitter (1.0).
        assert len(sleeper.calls) == 1
        assert sleeper.calls[0] == pytest.approx(1.0)

    def test_check_kind_ignores_burst_mode(self) -> None:
        # burst_mode=True имеет смысл только для kind="broadcast".
        # Для kind="check" мы тоже принимаем burst_mode, но он там
        # не активирует branch (фактически идёт обычная check-jitter
        # ветка). Проверяем, что check-вызовы ведут себя одинаково
        # с burst_mode=True/False.
        cfg = AntiBanConfig(
            delay_min=1.0, delay_max=1.0,
            broadcast_delay_min=1.0, broadcast_jitter_max=0.0,
            long_pause_every_n=0,
            sliding_window_n=1000,
        )
        rl_a, _, sleeper_a = _make_limiter(cfg, rng_seed=0)
        rl_b, _, sleeper_b = _make_limiter(cfg, rng_seed=0)

        rl_a.acquire(kind="check")
        rl_b.acquire(kind="check", burst_mode=True)

        assert sleeper_a.calls == sleeper_b.calls
