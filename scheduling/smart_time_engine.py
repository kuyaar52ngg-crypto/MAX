"""SmartTimeEngine — режим ``smart_time`` для Schedule_Mode_Engine.

Реализует Requirement 2.3, 2.7, 2.8, 2.9 спеки
``broadcast-scheduling-suite`` и pseudocode из design.md
("Components and Interfaces → SmartTimeEngine.distribute(...)").

Контракт
========

Стратегия — pure-функция (Property 3 — детерминизм по
``broadcast.id`` через детерминированную обходку слотов и per-phone
RR-указатель). Внешние зависимости минимальны:

* :class:`scheduling.activity_analyzer.ActivityAnalyzer` — инжектится
  в конструктор, обращается к ней только метод
  :meth:`ActivityAnalyzer.top_slots`. Сама аналайзер уже
  кэширует гистограммы и не имеет побочных эффектов кроме чтения БД.
* Опциональная фабрика psycopg2-соединений для INSERT записей в
  ``incident_log`` при overflow по ``hourly_check_limit``. По
  умолчанию читается ``DATABASE_URL`` из env (тот же паттерн, что и
  в :mod:`scheduling.engine` и :mod:`scheduling.activity_analyzer`).
  В тестах инжектится фейк, чтобы distribute оставался
  тестируемым без БД.

Алгоритм размещения
===================

Для каждого получателя:

1. ``slots, source = activity_analyzer.top_slots(user_id, phone, top_n)``
   — получаем top-N часов отправки и метку источника
   (``recipient`` / ``operator_global`` / ``default_fallback``).
   Метка идёт в ``metadata.fallback`` финального
   :class:`ScheduledSend`.
2. Round-robin: ``target_hour = slots[rr_index[phone] % len(slots)]``,
   ``rr_index[phone] += 1``. Per-phone RR — точно как pseudocode в
   design.md и зеркало в ``preflight_calc.py``.
3. ``_place_in_window(target_hour, slots, ...)`` ищет earliest валидный
   слот: iterate ``day_offset ∈ [0, window_days)`` outer, перебираем
   слоты inner — сначала ``target_hour``, потом остальные слоты в
   исходном порядке (по убыванию count, см. Req 2.6). Для каждой
   пары ``(day, hour)``:

   * ``_shift_past_quiet_hours`` — если час в QH-зоне, сдвигаем на
     ``qh_end % 24`` (Requirement 2.8); НЕ логируем инцидент.
   * Проверка ``_any_interval_contains(exception_zones, ts)`` — если
     попадает в CalendarException, пропускаем слот (Req 1.8 / 2.8).
   * Проверка ``per_hour_count[(date, hour)] < hourly_check_limit``
     — если лимит достигнут, пропускаем слот И помечаем
     ``overflow=True``. Это запускает spillover-логику и пост-фактум
     INSERT в ``incident_log`` с kind=``smart_time_overflow``
     (Requirement 2.9).
4. Если все ``window_days × len(slots)`` кандидатов заняты — не
   падаем: возвращаем кандидата на последнем дне в ``target_hour``
   и помечаем overflow. Этот fallback гарантирует, что
   :meth:`distribute` вернёт ровно ``len(broadcast.contacts)``
   :class:`ScheduledSend` (Property 1, аналогично Window).
5. ``metadata = {"slot": target_hour, "fallback": source}`` —
   ``slot`` фиксирует исходный RR-выбор, даже если фактическое
   размещение сместилось (важно для UI и аналитики).

per_hour_count
==============

Словарь ``dict[tuple[year, month, day, hour], int]`` — ключуется
датой и часом в локальной таймзоне ``user_tz``, а не в UTC. Это
важно для DST: 23:00 локально 31 марта и 23:00 локально 1 апреля
— разные дни даже если UTC-разница 23 часа. Локальные части
получаются из :func:`_zoned_parts` / :func:`_add_calendar_days`,
зеркалящих TS-логику preflight'а.

Note
----

distribute не делает ``UPDATE``/``INSERT`` для ScheduledBroadcast —
worker enqueue выполняет ``BroadcastScheduler`` или
``ScheduleModeEngine.dispatch_due`` после возврата результата. Сам
factor incident_log INSERT — единственный side-effect, и он
"best-effort": при ошибке БД мы только логируем, расчёт
расписания не падает (детерминизм возвращаемых ``ScheduledSend``-ов
сохраняется).
"""

from __future__ import annotations

import json
import os
import threading
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

from anti_ban.config import AntiBanConfig
from scheduling.activity_analyzer import ActivityAnalyzer
from scheduling.engine import BroadcastRow
from scheduling.logger import logger
from scheduling.preflight_calc import (
    _add_calendar_days,
    _any_interval_contains,
    _calendar_exception_zones,
    _clamp_int,
    _ensure_aware_utc,
    _safe_zoneinfo,
    _shift_past_quiet_hours,
    _zoned_parts,
    _zoned_to_utc,
)
from scheduling.types import Hour, Phone, ScheduledSend


__all__ = ["SmartTimeEngine"]


#: Константа kind для записей incident_log при spillover (Req 2.9).
_INCIDENT_KIND_SMART_TIME_OVERFLOW = "smart_time_overflow"

#: Default top-N если broadcast.smart_time_top_n не задан или вне
#: диапазона. По требованию 2.2 default=3.
_DEFAULT_TOP_N = 3

#: Default window_days если broadcast.smart_time_window_days не
#: задан или вне диапазона. По требованию 2.2 диапазон 1..14.
_DEFAULT_WINDOW_DAYS = 1


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений для INSERT в ``incident_log``.

    Зеркальна :func:`scheduling.engine._default_db_connection_factory`
    и :func:`scheduling.activity_analyzer._default_db_connection_factory`.
    Импорт ``psycopg2`` ленивый, чтобы импорт smart_time_engine не
    падал в окружениях без psycopg2 (тестовые окружения с
    инжектированной фабрикой).

    Raises:
        RuntimeError: ``DATABASE_URL`` не задан.
        ImportError:  ``psycopg2`` не установлен.
    """

    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL не задан — SmartTimeEngine не может писать "
            "smart_time_overflow в incident_log"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


@dataclass(frozen=True)
class _PlaceResult:
    """Результат :meth:`_place_in_window` — wall-clock UTC + флаг overflow."""

    send_at: datetime
    overflow: bool
    placed_hour: int


class SmartTimeEngine:
    """Стратегия ``smart_time`` для Schedule_Mode_Engine.

    Args:
        activity_analyzer: инжектируемый :class:`ActivityAnalyzer`,
            на нём вызывается только :meth:`ActivityAnalyzer.top_slots`.
            Это контролируемая зависимость; pure-функциональность
            distribute обеспечивается тем, что сам аналайзер
            кэширует результаты и не имеет write-сайд-эффектов.
        db_connection_factory: опциональная фабрика psycopg2-соединений
            для INSERT в ``incident_log``. По умолчанию читается
            ``DATABASE_URL`` через :func:`_default_db_connection_factory`.
            В тестах инжектируется фейк (см. ``tests/scheduling/
            test_smart_time_engine.py``).
    """

    def __init__(
        self,
        activity_analyzer: ActivityAnalyzer,
        *,
        db_connection_factory: Optional[Callable[[], Any]] = None,
    ) -> None:
        self.activity_analyzer = activity_analyzer
        self._db_connection_factory: Callable[[], Any] = (
            db_connection_factory or _default_db_connection_factory
        )
        # Лок для кэша factory-вызовов; сами factory-вызовы могут
        # быть параллельны (psycopg2 connection-pool), но мы не
        # держим shared state здесь — лок используется только для
        # consistency при потенциальных будущих расширениях.
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API (ScheduleModeStrategy.distribute)
    # ------------------------------------------------------------------

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: AntiBanConfig,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        """Запланировать smart_time-рассылку по получателям.

        Validates: Requirements 2.3, 2.7, 2.8, 2.9.

        Args:
            broadcast: снимок строки ``scheduled_broadcasts`` с полями
                ``smart_time_window_days``, ``smart_time_top_n``,
                ``contacts``, ``user_id``, ``user_tz``,
                ``scheduled_for``, ``quiet_hours_*``.
            anti_ban: ``AntiBanConfig`` оператора — нам нужен
                ``hourly_check_limit`` (Req 2.9). ``delay_min`` тут
                НЕ применяется — smart_time режим расставляет сообщения
                по «подходящим часам», а не по delay-интервалу;
                фактическая защита delay_min применяется
                Broadcast_Worker'ом во время отправки (Req 2.10).
            exceptions: список ``CalendarException`` пользователя
                (dict-форма из таблицы ``calendar_exceptions``).

        Returns:
            Список ``ScheduledSend`` ровно длины ``len(broadcast.contacts)``.
            Каждый элемент содержит:

            * ``phone`` — телефон получателя (строка как пришла в
              ``broadcast.contacts``);
            * ``send_at`` — UTC ``datetime`` с timezone-aware флагом;
            * ``metadata`` — ``{"slot": int, "fallback": str}``, где
              ``slot`` — RR-выбранный target_hour (НЕ обязательно
              hour, в который фактически попало размещение),
              ``fallback`` — метка источника гистограммы.
        """

        contacts = list(broadcast.contacts or [])
        if not contacts:
            return []

        tz = _safe_zoneinfo(broadcast.user_tz or "UTC")
        anchor_utc = self._resolve_anchor(broadcast)
        window_days = self._normalize_window_days(broadcast.smart_time_window_days)
        top_n = self._normalize_top_n(broadcast.smart_time_top_n)
        hourly_limit = max(1, int(anti_ban.hourly_check_limit or 1))
        qh_enabled = bool(broadcast.quiet_hours_enabled)
        qh_start = _clamp_int(broadcast.quiet_hours_start, 0, 23)
        qh_end = _clamp_int(broadcast.quiet_hours_end, 0, 23)

        # Calendar-exception зоны считаем один раз на всю рассылку
        # (window_days дней от anchor) — экономим 5000+ повторных
        # вычислений при тысячном списке контактов.
        ex_zones = _calendar_exception_zones(
            anchor_utc,
            anchor_utc + timedelta(days=window_days + 1),
            exceptions or [],
            tz,
        ).zones

        anchor_parts = _zoned_parts(anchor_utc, tz)
        per_hour_count: dict[tuple[int, int, int, int], int] = {}
        rr_index: dict[Phone, int] = defaultdict(int)
        sends: list[ScheduledSend] = []

        for phone in contacts:
            phone_str = self._extract_phone(phone)
            if not phone_str:
                # Пропуск пустого/невалидного телефона нарушил бы
                # Property 1 (length(out) == length(in)). Нормализуем
                # к пустой строке и кладём в anchor — downstream
                # validation в API роуте отсеет.
                phone_str = ""

            slots, source = self._safe_top_slots(
                broadcast.user_id, phone_str, top_n
            )

            idx = rr_index[phone_str]
            target_hour = int(slots[idx % len(slots)])
            rr_index[phone_str] = idx + 1

            place = self._place_in_window(
                target_hour=target_hour,
                slots=[int(s) for s in slots],
                anchor_parts=anchor_parts,
                window_days=window_days,
                hourly_limit=hourly_limit,
                per_hour_count=per_hour_count,
                qh_enabled=qh_enabled,
                qh_start=qh_start,
                qh_end=qh_end,
                exception_zones=ex_zones,
                tz=tz,
            )

            if place.overflow:
                # IncidentLog — best-effort. Не нарушаем
                # детерминированный порядок и количество ScheduledSend
                # даже при ошибке БД.
                self._log_smart_time_overflow(
                    user_id=broadcast.user_id,
                    broadcast_id=broadcast.id,
                    phone=phone_str,
                    target_hour=target_hour,
                    placed_hour=place.placed_hour,
                    placed_at=place.send_at,
                    hourly_limit=hourly_limit,
                )

            sends.append(
                ScheduledSend(
                    phone=phone_str,
                    send_at=place.send_at,
                    metadata={"slot": target_hour, "fallback": source},
                )
            )

        return sends

    # ------------------------------------------------------------------
    # Placement
    # ------------------------------------------------------------------

    def _place_in_window(
        self,
        *,
        target_hour: int,
        slots: Sequence[int],
        anchor_parts: Mapping[str, int],
        window_days: int,
        hourly_limit: int,
        per_hour_count: dict[tuple[int, int, int, int], int],
        qh_enabled: bool,
        qh_start: int,
        qh_end: int,
        exception_zones: Sequence[tuple[datetime, datetime]],
        tz: ZoneInfo,
    ) -> _PlaceResult:
        """Найти earliest валидный slot в ``[anchor, anchor+window_days]``.

        Алгоритм описан в module docstring. Главные инварианты:

        * Возвращаемый ``send_at`` всегда timezone-aware UTC.
        * ``per_hour_count`` инкрементируется ТОЛЬКО для успешно
          размещённого слота. Fallback-возврат (когда все кандидаты
          заняты) НЕ инкрементирует счётчик — это намеренно: если
          мы вернули hour, на котором уже ``count >= limit``, то
          дальнейшие попытки на нём всё равно пройдут проверку
          `cnt >= hourly_limit` и спустятся в spill для будущих
          получателей.
        * ``overflow=True`` устанавливается только когда хотя бы один
          ранее выбранный кандидат был отклонён по ``hourly_limit``.
          Сдвиг по QH или skip по CalendarException НЕ помечают
          overflow (Requirement 2.9 / spec task).

        Args:
            target_hour: RR-выбранный час (0..23). Этот час
                добавляется в самое начало внутренней очереди
                кандидатов (``ordered`` ниже), чтобы при равных
                условиях именно target_hour был выбран первым.
            slots: список top-N часов (descending count, ascending
                hour); используется для построения ``ordered``.
                Если ``target_hour`` уже в slots, дубль не
                добавляется.
            anchor_parts: словарь ``{year, month, day}`` с
                локальной (``tz``) календарной датой anchor'а.
            window_days: ширина окна в днях; диапазон уже
                нормализован в :meth:`_normalize_window_days`.
            hourly_limit: ``AntiBanConfig.hourly_check_limit``,
                верхняя граница ``per_hour_count[key]``.
            per_hour_count: общий счётчик размещений «по часам»;
                ключ — кортеж ``(year, month, day, hour)`` в
                локальной таймзоне.
            qh_enabled / qh_start / qh_end: настройки тихих часов.
            exception_zones: pre-computed UTC-интервалы дней,
                попавших в CalendarException.
            tz: локальная таймзона оператора.
        """

        # Build ordered list: target_hour first, then other slots
        # in their original RR order. Это даёт detrministic «predict
        # target_hour first, fall back to other preferred hours».
        seen: set[int] = set()
        ordered: list[int] = []
        for h in (target_hour, *slots):
            hi = int(h) % 24
            if hi not in seen:
                ordered.append(hi)
                seen.add(hi)
        if not ordered:
            # Невозможно по контракту (target_hour всегда определён),
            # но защитный fallback — peak часы по умолчанию.
            ordered = [10, 14, 19]

        overflow = False
        last_attempt: Optional[tuple[datetime, int]] = None

        # Outer: day offset; inner: hour candidate.
        for day_offset in range(max(1, window_days)):
            if day_offset == 0:
                day_parts = {
                    "year": int(anchor_parts["year"]),
                    "month": int(anchor_parts["month"]),
                    "day": int(anchor_parts["day"]),
                }
            else:
                day_parts = _add_calendar_days(anchor_parts, day_offset, tz)

            for hour in ordered:
                adjusted = _shift_past_quiet_hours(
                    hour, qh_enabled, qh_start, qh_end
                )
                if adjusted is None:
                    # _shift_past_quiet_hours возвращает None только
                    # для патологических конфигураций (qh-период
                    # = весь день). На текущем этапе считаем такой
                    # слот невалидным и пробуем следующий.
                    continue
                adjusted = int(adjusted) % 24

                ts = _zoned_to_utc(
                    int(day_parts["year"]),
                    int(day_parts["month"]),
                    int(day_parts["day"]),
                    adjusted,
                    0,
                    0,
                    tz,
                )

                # CalendarException: skip slot, не помечаем overflow.
                if _any_interval_contains(exception_zones, ts):
                    last_attempt = (ts, adjusted)
                    continue

                key = (
                    int(day_parts["year"]),
                    int(day_parts["month"]),
                    int(day_parts["day"]),
                    adjusted,
                )
                cnt = per_hour_count.get(key, 0)
                if cnt >= hourly_limit:
                    # Hourly limit — главный триггер overflow.
                    overflow = True
                    last_attempt = (ts, adjusted)
                    continue

                per_hour_count[key] = cnt + 1
                return _PlaceResult(
                    send_at=ts, overflow=overflow, placed_hour=adjusted
                )

        # Window exhausted. Возвращаем последний кандидат (самый
        # «поздний» по обходу), либо anchor + target_hour, и
        # помечаем overflow=True. per_hour_count НЕ инкрементируем
        # (см. docstring): ёмкость уже превышена.
        if last_attempt is not None:
            return _PlaceResult(
                send_at=last_attempt[0],
                overflow=True,
                placed_hour=last_attempt[1],
            )
        # Резервный fallback — теоретически недостижимый, но
        # компенсирует gcc-warning «possibly unbound».
        ts = _zoned_to_utc(
            int(anchor_parts["year"]),
            int(anchor_parts["month"]),
            int(anchor_parts["day"]),
            int(target_hour) % 24,
            0,
            0,
            tz,
        )
        return _PlaceResult(send_at=ts, overflow=True, placed_hour=int(target_hour) % 24)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _safe_top_slots(
        self, user_id: str, phone: str, top_n: int
    ) -> tuple[list[Hour], str]:
        """Безопасный вызов ``activity_analyzer.top_slots``.

        Если аналайзер падает (например, БД временно недоступна),
        откатываемся на default fallback peaked at ``{10, 14, 19}``
        (Requirement 2.5). Это держит distribute total —
        получатель получит расписание даже при сбое БД.
        """

        try:
            slots, source = self.activity_analyzer.top_slots(
                user_id, phone, top_n
            )
            if slots:
                return list(slots), str(source)
        except Exception:
            logger.exception(
                "SmartTimeEngine._safe_top_slots: activity_analyzer.top_slots "
                "упал для user_id=%s phone=%s — fallback на default",
                user_id,
                phone,
            )
        # Default fallback: peaked at {10, 14, 19}.
        default_hist = [0] * 24
        for h in (10, 14, 19):
            default_hist[h] = 1
        ordered = sorted(
            enumerate(default_hist), key=lambda p: (-p[1], p[0])
        )
        n = max(1, min(int(top_n), 24))
        return [h for h, _ in ordered[:n]], "default_fallback"

    @staticmethod
    def _normalize_window_days(value: Any) -> int:
        """Нормализовать ``smart_time_window_days`` в диапазон ``[1, 14]``.

        Если значение None / out-of-range — возвращаем default 1.
        Это согласуется с серверной валидацией в Task 9.12 (та
        отбрасывает out-of-range значения с HTTP 400 ДО создания
        ScheduledBroadcast), здесь мы лишь подстраховываемся для
        старых записей и тестов с минимальным draft'ом.
        """

        try:
            v = int(value) if value is not None else _DEFAULT_WINDOW_DAYS
        except (TypeError, ValueError):
            return _DEFAULT_WINDOW_DAYS
        if v < 1:
            return 1
        if v > 14:
            return 14
        return v

    @staticmethod
    def _normalize_top_n(value: Any) -> int:
        """Нормализовать ``smart_time_top_n`` в ``[1, 6]``.

        Default 3 (Requirement 2.2). Защитная нормализация в стиле
        :meth:`_normalize_window_days` — для совместимости с
        broadcast'ами, созданными до миграции, и для unit-тестов с
        минимальным draft'ом.
        """

        try:
            v = int(value) if value is not None else _DEFAULT_TOP_N
        except (TypeError, ValueError):
            return _DEFAULT_TOP_N
        if v < 1:
            return 1
        if v > 6:
            return 6
        return v

    def _resolve_anchor(self, broadcast: BroadcastRow) -> datetime:
        """Получить UTC anchor для расчёта окна.

        Приоритет: ``broadcast.scheduled_for`` →
        ``broadcast.next_run_at`` → ``datetime.now(tz=UTC)``.
        Все варианты приводятся к timezone-aware UTC через
        :func:`_ensure_aware_utc` (naive→UTC).
        """

        for candidate in (broadcast.scheduled_for, broadcast.next_run_at):
            if isinstance(candidate, datetime):
                return _ensure_aware_utc(candidate)
        return datetime.now(timezone.utc)

    @staticmethod
    def _extract_phone(value: Any) -> str:
        """Извлечь строку телефона из элемента ``contacts``.

        Допускаются формы:
        * ``str`` — телефон как есть;
        * ``Mapping`` с ключом ``"phone"`` — извлекаем поле;
        * прочее — пустая строка (downstream API-валидация решает).
        """

        if isinstance(value, str):
            return value
        if isinstance(value, Mapping):
            ph = value.get("phone")
            if isinstance(ph, str):
                return ph
        return ""

    # ------------------------------------------------------------------
    # IncidentLog (Requirement 2.9)
    # ------------------------------------------------------------------

    def _log_smart_time_overflow(
        self,
        *,
        user_id: str,
        broadcast_id: int,
        phone: str,
        target_hour: int,
        placed_hour: int,
        placed_at: datetime,
        hourly_limit: int,
    ) -> None:
        """INSERT в ``incident_log`` с kind=``smart_time_overflow``.

        Best-effort: ошибка БД логируется и проглатывается, чтобы
        не валить весь цикл distribute. ``operation_run_id``
        ставим NULL, потому что smart_time-распределение
        выполняется ДО старта broadcast worker'а — на момент
        планирования operation_run ещё не создан.

        ``details`` содержит фиксированный набор полей, удобный
        для агрегации в Auto_Snooze_Watcher (см. design.md
        ``_count_incidents``) и для UI-диагностики:

        ``{"phone": "...", "broadcast_id": 42, "target_hour": 14,
        "placed_hour": 18, "placed_at": "2026-...", "hourly_limit": 200}``
        """

        details = {
            "phone": phone,
            "broadcast_id": int(broadcast_id),
            "target_hour": int(target_hour),
            "placed_hour": int(placed_hour),
            "placed_at": placed_at.astimezone(timezone.utc).isoformat(),
            "hourly_limit": int(hourly_limit),
        }
        details_json = json.dumps(details, ensure_ascii=False)

        try:
            with closing(self._db_connection_factory()) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO incident_log
                            (user_id, operation_run_id, kind, details)
                        VALUES (%s, %s, %s, %s::jsonb)
                        """,
                        (
                            user_id,
                            None,
                            _INCIDENT_KIND_SMART_TIME_OVERFLOW,
                            details_json,
                        ),
                    )
                # psycopg2: явный commit, потому что connection
                # по умолчанию в transaction-режиме.
                if hasattr(conn, "commit"):
                    conn.commit()
        except Exception:
            logger.exception(
                "SmartTimeEngine: не удалось записать smart_time_overflow "
                "в incident_log (user_id=%s, broadcast_id=%s, phone=%s, "
                "target_hour=%s, placed_hour=%s)",
                user_id,
                broadcast_id,
                phone,
                target_hour,
                placed_hour,
            )
