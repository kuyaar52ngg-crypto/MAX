"""RateLimiter — поведенческое ограничение запросов к GREEN-API.

Реализует требования к "человекоподобной" защите от поведенческих банов:

* случайный jitter между запросами (Requirement 1.2, 1.6, 2.3);
* минимальный пол паузы для рассылки (Requirement 2.1, 2.2);
* "длинная пауза" каждые N запросов (Requirement 1.1, 1.7);
* sliding-window лимит N запросов в T секунд (Requirement 1.3);
* экспоненциальный backoff с jitter после HTTP 429 (Requirement 4.1, 4.2);
* burst-mode hook для ``broadcast-scheduling-suite`` (Requirements 8.2,
  8.3, 8.5; задача 7.1): при ``acquire(burst_mode=True)`` шаги «jitter»
  и «long pause» заменяются вызовом
  :func:`scheduling.burst_engine.BurstEngine.delay_for`, который
  возвращает фиксированную паузу ``delay_min`` (или ``delay_min * 1.5``
  в slowed-state). Sliding-window и pending-backoff после 429 при этом
  продолжают применяться без изменений — anti-ban-фундамент сохранён.

Все источники недетерминизма (`time.time`, `time.sleep`, `random.Random`)
внедряются через DI, чтобы property-тесты могли подменять их на
`FakeClock` / `FakeSleep` / `Random(seed)` без реальных пауз.

Потокобезопасность обеспечивается одним `threading.Lock`, защищающим
изменяемое состояние (`_window`, `_request_counter`, `_pending_backoff`)
и обращения к `random.Random` (он не thread-safe). Лок **не удерживается**
во время вызова `sleep()`, иначе все одновременные вызовы `acquire()`
сериализовались бы и эффективная пропускная способность падала бы до
одного запроса за раз.

См. design.md, секцию "Components/Interfaces → Rate_Limiter".
"""

from __future__ import annotations

import random
import threading
import time
from collections import deque
from typing import Callable, Literal, Optional

from anti_ban.config import AntiBanConfig


__all__ = ["RateLimiter"]


_AcquireKind = Literal["check", "broadcast"]


class RateLimiter:
    """Потокобезопасный rate limiter с jitter, long-pause и sliding window.

    Один экземпляр обслуживает один логический инстанс GREEN-API
    (по `(user_id, id_instance)`); лимиты GREEN-API применяются на
    уровне инстанса, поэтому разделять лимитер между несколькими
    инстансами нельзя.

    Args:
        config: иммутабельная конфигурация (`AntiBanConfig`).
        clock: функция, возвращающая текущее unix-время (DI). По
            умолчанию ``time.time``.
        sleep: блокирующая функция сна (DI). По умолчанию ``time.sleep``.
        rng: генератор псевдослучайных чисел (DI). По умолчанию
            создаётся новый ``random.Random()`` (системно засеянный).
            Все обращения к `rng` выполняются под `_lock`, потому что
            ``random.Random`` не потокобезопасен.
    """

    def __init__(
        self,
        config: AntiBanConfig,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        rng: Optional[random.Random] = None,
    ) -> None:
        self._config = config
        self._clock = clock
        self._sleep = sleep
        self._rng = rng if rng is not None else random.Random()

        self._lock = threading.Lock()
        # Метки времени отправленных запросов (для sliding window).
        # Записываются `record_request()`, читаются `acquire()`.
        self._window: deque[float] = deque()
        # Счётчик `acquire()` для каденса длинных пауз.
        self._request_counter: int = 0
        # Обязательная пауза, выставленная `on_http_429`; её сжигает
        # ближайший вызов `acquire()` на шаге 1.
        self._pending_backoff: float = 0.0

    # ------------------------------------------------------------------ #
    # Public API                                                          #
    # ------------------------------------------------------------------ #

    def acquire(
        self,
        *,
        kind: _AcquireKind,
        burst_mode: bool = False,
        burst_throttle_state: str = "normal",
        burst_message_index: int = 0,
    ) -> None:
        """Заблокировать поток до момента, когда можно делать следующий запрос.

        Шаги:

        1. Если установлен ``_pending_backoff`` (после HTTP 429) — спим
           его, сбрасываем в 0.
        2. Спим случайный jitter:
           * для ``kind == "check"`` — ``rng.uniform(delay_min, delay_max)``;
           * для ``kind == "broadcast"`` — ``rng.uniform(max(delay_min,
             broadcast_delay_min), max(delay_max, broadcast_delay_min))``
             плюс ``rng.uniform(0, broadcast_jitter_max)``. Этим
             гарантируется пол ``broadcast_delay_min`` даже если
             пользователь выставил ``delay_min`` ниже (Requirement 2.2).
           * При ``burst_mode=True`` (Req 8.2) jitter и broadcast-floor
             игнорируются: задержка приходит из
             :meth:`scheduling.burst_engine.BurstEngine.delay_for`
             и равна ``delay_min`` (``normal``) либо ``delay_min*1.5``
             (``slowed``). Это даёт максимальную скорость в пределах
             анти-бан floor.
        3. Инкрементируем счётчик запросов и, если он кратен
           ``long_pause_every_n`` (и ``long_pause_every_n > 0``),
           добавляем ``long_pause_seconds`` — Requirement 1.7.
           При ``burst_mode=True`` шаг ПОЛНОСТЬЮ ПРОПУСКАЕТСЯ —
           Requirement 8.3 требует не вставлять long pause в burst.
        4. Sliding window (Requirement 1.3): удаляем из ``_window``
           метки старше ``now - sliding_window_t``; пока в окне
           ``>= sliding_window_n`` запросов — спим до момента, когда
           старейшая метка выйдет за окно, и повторяем.
           Это выполняется и в burst-mode: SW-лимит — это hard
           anti-ban-инвариант, его burst не отменяет.

        Args:
            kind: ``"check"`` для ``checkAccount``-подобных запросов
                или ``"broadcast"`` для отправки сообщений.
            burst_mode: True, когда вызов идёт из burst-режима
                (``ScheduledBroadcast.schedule_type == "burst"``).
                Активирует ветку, описанную выше (Req 8.2/8.3).
            burst_throttle_state: текущее состояние ``Adaptive_Throttle``
                — передаётся в ``BurstEngine.delay_for``. Допустимые
                значения — ``"normal"`` или ``"slowed"``; ``"paused"``
                запрещён, потому что paused-broadcast не должен
                запрашивать delay (worker сам ставит на паузу).
            burst_message_index: 0-based индекс отправляемого сообщения.
                В текущей реализации ``BurstEngine.delay_for`` индекс
                игнорируется (Req 8.3 — нет long-pause-каденса), но
                параметр сохранён для будущих расширений.

        Raises:
            ValueError: если ``kind`` не равен ``"check"`` или
                ``"broadcast"``.
        """
        if kind not in ("check", "broadcast"):
            raise ValueError(
                f"RateLimiter.acquire: unsupported kind {kind!r}; "
                "expected 'check' or 'broadcast'"
            )

        # --- Шаг 1: pending backoff после HTTP 429 -----------------------
        # Этот шаг НЕ зависит от burst_mode: даже в burst мы обязаны
        # honor'ить backoff после 429. Adaptive_Throttle при этом
        # переведёт state в slowed → следующий acquire(...) использует
        # увеличенный multiplier; как только AT увидит серию успешных
        # отправок, state вернётся в normal и burst recovery toward
        # delay_min завершится (Req 8.5).
        with self._lock:
            backoff = self._pending_backoff
            self._pending_backoff = 0.0
        if backoff > 0:
            self._sleep(backoff)

        # --- Шаг 2: задержка между сообщениями --------------------------
        if burst_mode and kind == "broadcast":
            # Burst Mode: фиксированная пауза из BurstEngine.delay_for
            # вместо случайного jitter (Req 8.2).
            #
            # Late import: scheduling.burst_engine импортирует
            # AntiBanConfig из anti_ban.config — обратный импорт
            # ``rate_limiter -> burst_engine`` создаёт цикл при
            # обычной загрузке модуля. Делаем import внутри метода,
            # чтобы он сработал только в момент использования burst-
            # режима (а в обычной рассылке rate_limiter работает
            # совершенно независимо от scheduling-пакета).
            from scheduling.burst_engine import BurstEngine

            delay = BurstEngine.delay_for(
                burst_message_index, self._config, burst_throttle_state
            )
            if delay > 0:
                self._sleep(delay)
        else:
            # Обычный режим: rng.uniform под локом, потому что
            # random.Random не thread-safe.
            with self._lock:
                jitter_sleep = self._compute_jitter(kind)
            if jitter_sleep > 0:
                self._sleep(jitter_sleep)

        # --- Шаг 3: long pause каждые N запросов ------------------------
        # В burst-mode этот шаг ПОЛНОСТЬЮ ПРОПУСКАЕТСЯ (Req 8.3):
        # «THE Broadcast_Worker SHALL skip every long pause that
        # would normally be inserted by AntiBanConfig.long_pause_every_n
        # and SHALL NOT call the long-pause routine.»
        # Счётчик _request_counter всё равно инкрементируем, чтобы
        # после возврата в обычный режим long-pause-каденс начинался
        # с естественной точки.
        with self._lock:
            self._request_counter += 1
            every_n = self._config.long_pause_every_n
            long_pause_triggered = (
                not burst_mode
                and every_n > 0
                and self._request_counter % every_n == 0
            )
            long_pause_duration = self._config.long_pause_seconds
        if long_pause_triggered and long_pause_duration > 0:
            self._sleep(long_pause_duration)

        # --- Шаг 4: sliding-window барьер -------------------------------
        # Возможно несколько итераций: пока окно полно, спим до выхода
        # старейшей метки и пробуем снова.
        while True:
            with self._lock:
                now = self._clock()
                window_t = self._config.sliding_window_t
                cutoff = now - window_t
                # Удаляем протухшие метки из головы deque.
                while self._window and self._window[0] <= cutoff:
                    self._window.popleft()
                if len(self._window) < self._config.sliding_window_n:
                    return  # окно не заполнено — можно отправлять
                oldest = self._window[0]
                remaining = window_t - (now - oldest)
            if remaining <= 0:
                # Защита от гонки: метка стала "протухшей" между чтением
                # и проверкой; повторим шаг и удалим её.
                continue
            self._sleep(remaining)

    def record_request(self) -> None:
        """Зарегистрировать факт ушедшего запроса.

        Должен вызываться после каждого успешно отправленного запроса
        к GREEN-API (даже если ответ 429/466 — мы всё равно потратили
        слот в окне). Метод добавляет текущее время в `_window` и
        сразу подчищает протухшие метки, чтобы deque не рос бесконечно
        в пограничных случаях.
        """
        with self._lock:
            now = self._clock()
            self._window.append(now)
            cutoff = now - self._config.sliding_window_t
            while self._window and self._window[0] <= cutoff:
                self._window.popleft()

    def on_http_429(self, retry_count: int) -> float:
        """Вычислить и сохранить паузу backoff после HTTP 429.

        Формула: ``wait = base * 2 ** retry_count + uniform(0, base)``,
        где ``base == config.backoff_base_seconds``. Получившееся
        значение сохраняется в ``_pending_backoff``; ближайший вызов
        ``acquire()`` отдаст этот sleep на первом шаге.

        Ограничение ``retry_count <= max_retries`` метод **не**
        накладывает — это политика вызывающего: он сам должен прервать
        повтор и завершить операцию, когда ``retry_count``
        достигнет ``config.max_retries`` (Requirement 4.2).

        Args:
            retry_count: номер текущей попытки (0-based: первый
                повтор — 0).

        Returns:
            Длительность паузы в секундах.
        """
        base = self._config.backoff_base_seconds
        with self._lock:
            wait = base * (2 ** retry_count) + self._rng.uniform(0, base)
            self._pending_backoff = wait
        return wait

    # ------------------------------------------------------------------ #
    # Internal helpers                                                    #
    # ------------------------------------------------------------------ #

    def _compute_jitter(self, kind: _AcquireKind) -> float:
        """Сгенерировать случайную паузу для шага 2 ``acquire``.

        Должен вызываться **под `_lock`**: использует ``self._rng``,
        который не потокобезопасен.
        """
        cfg = self._config
        if kind == "check":
            return self._rng.uniform(cfg.delay_min, cfg.delay_max)
        # kind == "broadcast"
        floor = cfg.broadcast_delay_min
        lo = max(cfg.delay_min, floor)
        hi = max(cfg.delay_max, floor)
        base = self._rng.uniform(lo, hi)
        jitter = self._rng.uniform(0.0, cfg.broadcast_jitter_max)
        return base + jitter
