"""Window Mode стратегия для ``Schedule_Mode_Engine``.

Этот модуль реализует :class:`WindowEngine` — стратегию режима
``schedule_type = "window"``, описанную в design.md (раздел
«WindowEngine.distribute(...) — pure function») и обоснованную в
Requirements 1.5–1.10.

Контракт (Requirements 1.5–1.10)
=================================

* **Req 1.5** — равномерное распределение N отправок по «usable»
  части окна ``[send_window_start, send_window_end)``.
* **Req 1.6** — детерминизм по ``broadcast.id``: повторный вызов с
  тем же broadcast'ом и теми же входами выдаёт побитово равные
  ``ScheduledSend``-ы. Достигается через :func:`mulberry32`,
  засеянную ``broadcast.id`` (тот же PRNG используется в
  TypeScript-mirror'е ``preflightEngine.ts``).
* **Req 1.7** — отправки не попадают в ``[quiet_hours_start, quiet_hours_end)``
  в часовом поясе ``broadcast.user_tz`` (вычитаем зоны quiet hours
  из usable-интервала).
* **Req 1.8** — отправки не попадают в действующие
  ``CalendarException``-ы (single-period и recurring weekly /
  monthly / yearly), вычитаются по тому же принципу.
* **Req 1.9** — жёсткая проверка ``usable_seconds < N * anti_ban.delay_min``
  бросает :class:`SchedulingError` ``WINDOW_INSUFFICIENT_TIME``. Эта
  ошибка имеет приоритет над всеми остальными window-валидациями
  (см. :func:`scheduling.preflight_calc.validate_window`).
* **Req 1.10** — базовый интервал ``usable_seconds / N``; jitter
  ``± min(60s, base_interval / 4)`` через mulberry32-RNG.

Чистота функции
================

:meth:`WindowEngine.distribute` — pure-функция:

* НЕ читает БД, НЕ пишет в БД, НЕ обращается к wall-clock'у;
* зависит только от своих аргументов (``broadcast``, ``anti_ban``,
  ``exceptions``);
* возвращает иммутабельные :class:`ScheduledSend`-ы.

Это критично для:

* **PreFlight Preview** — :func:`scheduling.preflight_calc.run_preflight`
  вызывает зеркальную логику (``_simulate_window``) для UI, и оба
  выхода обязаны совпадать побитово (cross-language equivalence —
  отдельная задача 11.4 проверяет JS↔Python).
* **Property test P3** (детерминизм) — два вызова с теми же входами
  должны дать идентичный результат.
* **Property tests P4/P5** (отсутствие пересечений с QH /
  CalendarException) — pure-функция позволяет hypothesis перебирать
  входы без mock-ов БД.

Переиспользование helpers
==========================

Все вычисления интервалов делегированы во внутренние helpers
:mod:`scheduling.preflight_calc`. Они уже реализуют bit-for-bit
зеркало TypeScript-логики из ``preflightEngine.ts``:

* :func:`scheduling.preflight_calc.mulberry32` — детерминированный
  PRNG (тот же, что в TS).
* :func:`scheduling.preflight_calc._safe_zoneinfo` — graceful
  fallback на UTC при некорректной таймзоне.
* :func:`scheduling.preflight_calc._clamp_int` — clamp числа в
  диапазон с graceful fallback.
* :func:`scheduling.preflight_calc._quiet_hours_zones` — UTC-зоны
  quiet hours, пересекающиеся с окном.
* :func:`scheduling.preflight_calc._calendar_exception_zones` —
  UTC-зоны календарных исключений (с поддержкой recurring).
* :func:`scheduling.preflight_calc._subtract_exclusions` — алгебра
  «окно минус список зон» → отсортированные непересекающиеся
  под-интервалы.
* :func:`scheduling.preflight_calc._interval_duration_seconds` —
  суммарная длительность интервалов в секундах.
* :func:`scheduling.preflight_calc._project_offset_into_intervals` —
  спроецировать секундный offset в список под-интервалов и вернуть
  абсолютный wall-clock.
* :func:`scheduling.preflight_calc._uniform_bipolar` — uniform-jitter
  в ``[-max, +max]`` через переданный RNG.

Дублирование этих функций здесь явно запрещено (см. tasks.md 4.3:
«Reuse them by importing — DO NOT duplicate»). Подчёркнутые имена в
``preflight_calc`` — это «внутри-пакетные» приватные функции, и
импорт их из соседнего модуля того же пакета — допустимая практика
(аналогично, как ``BurstEngine`` импортирует ``BroadcastRow`` из
``scheduling.engine``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Sequence

from anti_ban.config import AntiBanConfig
from scheduling.engine import BroadcastRow
from scheduling.preflight_calc import (
    Interval,
    _calendar_exception_zones,
    _clamp_int,
    _interval_duration_seconds,
    _project_offset_into_intervals,
    _quiet_hours_zones,
    _safe_zoneinfo,
    _subtract_exclusions,
    _uniform_bipolar,
    mulberry32,
)
from scheduling.types import ScheduledSend, SchedulingError


__all__ = ["WindowEngine"]


def _extract_phone(contact: Any) -> str:
    """Извлечь номер телефона из элемента ``broadcast.contacts``.

    ``ScheduledBroadcast.contacts`` — JSONB-колонка, в которую
    приходят либо сырые строки телефонов (``"79991234567"``), либо
    словари (``{"phone": "79991234567", ...}``). Та же логика
    дублируется в :class:`scheduler.BroadcastScheduler` и
    :class:`scheduling.burst_engine.BurstEngine` — это устоявшаяся
    конвенция в репозитории.

    Если структура неожиданная (None, dict без ключа ``phone``),
    возвращается пустая строка. Валидация на верхнем уровне отсекает
    пустые телефоны при необходимости — стратегия остаётся
    pure-функцией без побочных эффектов.
    """

    if isinstance(contact, Mapping):
        raw = contact.get("phone")
        return str(raw) if raw is not None else ""
    if contact is None:
        return ""
    return str(contact)


class WindowEngine:
    """Стратегия для ``schedule_type = "window"``.

    Реализует :class:`scheduling.engine.ScheduleModeStrategy` — pure
    функция :meth:`distribute` (без БД, без wall-clock-побочных
    эффектов). Регистрация в ``app.py`` (см. задачу 6.11):

        engine.register("window", WindowEngine())

    Класс не имеет состояния — все экземпляры взаимозаменяемы.
    Однако мы оставляем его именно классом (а не модуль-функцией),
    чтобы он соответствовал ``ScheduleModeStrategy``-протоколу и
    допускал инжекцию зависимостей в будущих расширениях без
    изменения внешнего API (как и :class:`BurstEngine`).
    """

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: AntiBanConfig,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        """Распределить N отправок равномерно по usable-части окна.

        Алгоритм (зеркало design.md и TS ``simulateWindow``):

        1. Извлечь телефоны из ``broadcast.contacts`` (поддерживаются
           dict-формат и сырые строки).
        2. Проверить shape окна: ``send_window_start <
           send_window_end``. Невалидное окно → ``WINDOW_INVALID_RANGE``
           400. Это происходит до :func:`validate_window` API-роута
           только при рассинхроне данных в БД (например, ручной UPDATE);
           обычно API-роут ловит это раньше.
        3. Вычесть из ``[start, end)`` зоны quiet hours и
           CalendarException → список под-интервалов ``usable``.
        4. Если ``sum(usable) < N * delay_min`` — бросить
           ``WINDOW_INSUFFICIENT_TIME`` 422 (Req 1.9, имеет
           приоритет — см. :func:`validate_window`).
        5. Базовый интервал ``base = usable_seconds / N``.
        6. Для каждого получателя ``i ∈ [0, N)``:
           a. ``jitter_max = min(60s, base / 4)``;
           b. ``jitter = rng.uniform(-jitter_max, jitter_max)`` через
              :func:`mulberry32` с seed = ``broadcast.id``;
           c. ``offset = i * base + jitter``;
           d. ``send_at = _project_offset_into_intervals(usable, offset)``.
        7. Вернуть список ``ScheduledSend(phone, send_at, metadata={})``.

        Args:
            broadcast: :class:`BroadcastRow` — снимок строки
                ``scheduled_broadcasts``. Должен иметь
                ``schedule_type='window'`` и валидные
                ``send_window_start``/``send_window_end``.
            anti_ban: :class:`AntiBanConfig` оператора. Используется
                поле ``delay_min`` (минимальная пауза между
                отправками, секунды).
            exceptions: список dict-ов из таблицы
                ``calendar_exceptions``. Каждый dict содержит
                ``name``, ``start_date``, ``end_date``,
                опционально ``recurring_type``/``recurring_value``.

        Returns:
            Список :class:`ScheduledSend` длины ``N == len(broadcast.contacts)``,
            отсортированный по индексу получателя (НЕ по ``send_at`` —
            jitter может локально менять порядок). Все ``send_at``
            гарантированно лежат внутри usable-интервалов
            (Property 4 / 5).

        Raises:
            SchedulingError(``WINDOW_INVALID_RANGE``, 400): окно
                невалидно по shape (``end <= start`` или одно из
                полей ``None``).
            SchedulingError(``WINDOW_INSUFFICIENT_TIME``, 422):
                ``usable_seconds < N * anti_ban.delay_min`` (Req 1.9).
        """

        phones = [_extract_phone(c) for c in (broadcast.contacts or [])]
        # Пустые строки (после _extract_phone) фильтруем — это уже
        # побочный мусор в JSONB, не задача стратегии валидировать
        # формат, но и считать их за «получателя» нельзя.
        phones = [p for p in phones if p]
        n = len(phones)

        start = broadcast.send_window_start
        end = broadcast.send_window_end
        if start is None or end is None or end <= start:
            # API-роут (см. задачу 9.12) валидирует окно ДО создания
            # ScheduledBroadcast, но defence-in-depth: если строка в
            # БД попала с невалидным окном (например, ручной UPDATE),
            # стратегия должна явно отказаться, а не делить на ноль.
            raise SchedulingError(
                "WINDOW_INVALID_RANGE",
                "send_window_start/end отсутствуют или end <= start",
                http_status=400,
            )

        usable = self._compute_usable_intervals(
            start,
            end,
            broadcast.quiet_hours_enabled,
            broadcast.quiet_hours_start,
            broadcast.quiet_hours_end,
            broadcast.user_tz,
            exceptions,
        )
        usable_seconds = _interval_duration_seconds(usable)

        # Req 1.9 — приоритетная проверка. Эта же проверка
        # дублируется в :func:`preflight_calc.validate_window` для
        # API-роута; здесь — defence-in-depth на случай вызова
        # стратегии напрямую (например, из задачи 6.11 wire-up'а).
        required = n * float(anti_ban.delay_min)
        if usable_seconds < required:
            raise SchedulingError(
                "WINDOW_INSUFFICIENT_TIME",
                (
                    f"Недостаточно времени в окне: usable="
                    f"{usable_seconds:.1f}s < required={required:.1f}s "
                    f"(N={n}, delay_min={anti_ban.delay_min})"
                ),
                http_status=422,
            )

        # n == 0 валиден (рассылка на пустой список): мы прошли
        # проверку 1.9 (0 < 0 = false), и базовый интервал считать
        # незачем. Возвращаем пустой список — worker увидит 0
        # элементов и закроет рассылку как ``completed``.
        if n == 0:
            return []

        base_interval = usable_seconds / n
        rng = mulberry32(int(broadcast.id))

        sends: list[ScheduledSend] = []
        for i, phone in enumerate(phones):
            jitter_max = min(60.0, base_interval / 4.0)
            jitter = _uniform_bipolar(rng, jitter_max)
            offset = i * base_interval + jitter
            send_at = self._project_offset_into_intervals(usable, offset)
            sends.append(ScheduledSend(phone=phone, send_at=send_at, metadata={}))
        return sends

    # ------------------------------------------------------------------
    # Helpers — тонкие обёртки над общими функциями preflight_calc.
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_usable_intervals(
        start: datetime,
        end: datetime,
        qh_enabled: bool,
        qh_start: int,
        qh_end: int,
        user_tz: str,
        exceptions: Sequence[Mapping[str, Any]],
    ) -> list[Interval]:
        """Вернуть список ``(datetime, datetime)`` с вычетом QH/exceptions.

        Делегирует в общие helpers
        :mod:`scheduling.preflight_calc`. Метод оставлен на классе
        как часть design.md-контракта (явно упомянут в pseudocode);
        фактический алгоритм — в shared utilities, чтобы PreFlight
        Preview и WindowEngine давали bit-for-bit равные интервалы.

        ``exceptions`` принимает любую sequence dict-ов — пустой
        список означает «нет исключений», что редуцируется к
        ``[(start, end)]`` минус только QH-зоны.
        """

        tz = _safe_zoneinfo(user_tz or "UTC")
        exclusions: list[Interval] = []
        if qh_enabled:
            qhs = _clamp_int(qh_start, 0, 23)
            qhe = _clamp_int(qh_end, 0, 23)
            exclusions.extend(_quiet_hours_zones(start, end, qhs, qhe, tz))
        if exceptions:
            exclusions.extend(
                _calendar_exception_zones(start, end, exceptions, tz).zones
            )
        return _subtract_exclusions((start, end), exclusions)

    @staticmethod
    def _project_offset_into_intervals(
        intervals: Sequence[Interval], offset_seconds: float
    ) -> datetime:
        """Спроецировать секундный offset в список интервалов.

        Тонкая обёртка над
        :func:`scheduling.preflight_calc._project_offset_into_intervals`,
        вынесенная как метод класса для соответствия design.md
        pseudocode (метод явно упомянут как ``self._project_...``).
        Реализация делегирована в shared utility, чтобы избежать
        дублирования с PreFlight Preview.
        """

        return _project_offset_into_intervals(intervals, offset_seconds)
