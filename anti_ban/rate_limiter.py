"""RateLimiter — поведенческое ограничение запросов к GREEN-API.

Реализует требования к "человекоподобной" защите от поведенческих банов:

* случайный jitter между запросами (Requirement 1.2, 1.6, 2.3);
* минимальный пол паузы для рассылки (Requirement 2.1, 2.2);
* "длинная пауза" каждые N запросов (Requirement 1.1, 1.7);
* sliding-window лимит N запросов в T секунд (Requirement 1.3);
* экспоненциальный backoff с jitter после HTTP 429 (Requirement 4.1, 4.2).

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

    def acquire(self, *, kind: _AcquireKind) -> None:
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
        3. Инкрементируем счётчик запросов и, если он кратен
           ``long_pause_every_n`` (и ``long_pause_every_n > 0``),
           добавляем ``long_pause_seconds`` — Requirement 1.7.
        4. Sliding window (Requirement 1.3): удаляем из ``_window``
           метки старше ``now - sliding_window_t``; пока в окне
           ``>= sliding_window_n`` запросов — спим до момента, когда
           старейшая метка выйдет за окно, и повторяем.

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
        with self._lock:
            backoff = self._pending_backoff
            self._pending_backoff = 0.0
        if backoff > 0:
            self._sleep(backoff)

        # --- Шаг 2: случайный jitter ------------------------------------
        # rng.uniform под локом, потому что random.Random не thread-safe.
        with self._lock:
            jitter_sleep = self._compute_jitter(kind)
        if jitter_sleep > 0:
            self._sleep(jitter_sleep)

        # --- Шаг 3: long pause каждые N запросов ------------------------
        with self._lock:
            self._request_counter += 1
            every_n = self._config.long_pause_every_n
            long_pause_triggered = (
                every_n > 0 and self._request_counter % every_n == 0
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
