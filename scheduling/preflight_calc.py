"""PreFlight calc — серверный mirror клиентского ``preflightEngine.ts``.

Этот модуль — авторитативная реализация PreFlight-расчёта на стороне
сервера. Клиентский ``frontend/src/lib/scheduling/preflightEngine.ts``
выполняет тот же расчёт в браузере для мгновенного preview, а сервер
перевалидирует результат перед записью ``ScheduledBroadcast`` в БД и
возвращает тот же набор warnings (Requirement 5.2–5.8) и тот же
``histogram``. Cross-language equivalence-test (Task 11.4) сравнивает
оба выхода поэлементно.

Все алгоритмы скопированы из TypeScript-зеркала bit-for-bit:

* :func:`mulberry32` — детерминированный 32-bit PRNG (псевдокод
  приведён в JSDoc TS-файла; этот файл реализует его на Python).
* :func:`dedupe_phones` — нормализация ``\\D+`` → дедупликация с
  сохранением первого вхождения.
* :func:`simulate_distribution` — диспатч по ``schedule_type``:
  ``window`` / ``smart_time`` / ``ab_time`` / ``burst`` /
  legacy (``exact`` / ``drip`` / ``recurring``).
* :func:`compute_histogram` — 24-bucket в ``user_tz``.
* :func:`build_warnings` — фиксированный порядок:
  ``quiet_hours_postpone`` → ``calendar_exception_postpone`` →
  ``daily_limit_exceeded`` → ``instance_unhealthy``.

Публичный API
=============

* :class:`PreFlightServerResult` — dataclass с агрегированным
  результатом (recipient_count, first/last ETA, histogram,
  warnings, compute_ms).
* :func:`run_preflight` — точка входа, вызывается Next.js API роутом
  через RPC/HTTP перед INSERT ``ScheduledBroadcast``.
* :func:`validate_window` — отдельная функция, бросающая
  ``WINDOW_INSUFFICIENT_TIME`` (Requirement 1.9). Эта ошибка имеет
  приоритет над всеми другими window-валидациями.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from anti_ban.config import AntiBanConfig
from scheduling.activity_analyzer import ActivityAnalyzer
from scheduling.logger import logger
from scheduling.types import Histogram, Hour, Phone, ScheduledSend, SchedulingError


__all__ = [
    "PreFlightServerResult",
    "PreFlightWarning",
    "build_warnings",
    "compute_histogram",
    "dedupe_phones",
    "mulberry32",
    "run_preflight",
    "simulate_distribution",
    "validate_window",
]


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreFlightWarning:
    """Один warning в выходе PreFlight-расчёта.

    Соответствует TS-типу ``PreFlightWarning`` из
    ``frontend/src/lib/scheduling/types.ts`` и Requirement 5.5–5.8.

    ``kind`` — машинно-читаемый идентификатор; ``message`` — текст для
    UI; ``affected_count`` — опциональный счётчик (сколько сообщений
    под warning подпало). ``message`` намеренно не локализован
    повторно — серверный mirror возвращает тот же текст, что
    клиентский preview, чтобы Cross-language test 11.4 был истиной.

    Сериализация в API-ответ — :meth:`to_dict` (camelCase ключи под
    стиль Next.js). В property-тестах сравниваются именно ``kind`` и
    ``affected_count`` (а не ``message``), потому что текст может
    содержать Unicode-тире, нумбер- и проценты-форматирование, что
    шумит в diff'ах.
    """

    kind: str  # "quiet_hours_postpone" | "calendar_exception_postpone" | "daily_limit_exceeded" | "instance_unhealthy"
    message: str
    affected_count: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind, "message": self.message}
        if self.affected_count is not None:
            out["affectedCount"] = self.affected_count
        return out


@dataclass(frozen=True)
class PreFlightServerResult:
    """Итог :func:`run_preflight`.

    Поля повторяют TS-тип ``PreFlightResult`` (camelCase в JSON →
    snake_case в Python; преобразование делает :meth:`to_dict`).

    * ``recipient_count`` — после дедупликации (Requirement 5.2).
    * ``first_send_eta`` / ``last_send_eta`` — ``HH:MM`` в
      ``draft.user_tz`` (Requirement 5.3). Когда ``recipient_count == 0``
      оба поля равны ``"—"`` — символ unicode em-dash, чтобы UI
      рендерил «—» одинаково на сервере и клиенте.
    * ``histogram`` — 24 неотрицательных целых числа (Requirement 5.4).
    * ``warnings`` — список dict-форм :class:`PreFlightWarning`,
      порядок фиксирован (Requirement 5.5–5.8).
    * ``compute_ms`` — измеренное время расчёта на сервере (для
      телеметрии); НЕ участвует в cross-language сравнении.
    """

    recipient_count: int
    first_send_eta: str
    last_send_eta: str
    histogram: Histogram
    warnings: list[dict[str, Any]]
    compute_ms: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "recipientCount": self.recipient_count,
            "firstSendEta": self.first_send_eta,
            "lastSendEta": self.last_send_eta,
            "histogram": list(self.histogram),
            "warnings": [dict(w) for w in self.warnings],
            "computeMs": self.compute_ms,
        }


# ---------------------------------------------------------------------------
# Deterministic PRNG (mirror of TS `mulberry32`)
# ---------------------------------------------------------------------------


def mulberry32(seed: int):
    """Mulberry32 — детерминированный 32-bit PRNG.

    Точный псевдокод из JSDoc TS-файла, переписанный на Python.
    Алгоритм — public domain, автор Tommy Ettinger. Идентичная
    последовательность чисел в JS и Python критична для
    cross-language equivalence (TS использует ``Math.imul``,
    Python — ручную маску ``& 0xFFFFFFFF``; результаты совпадают).

    Args:
        seed: int. Любое целое; используется младшие 32 бита.

    Returns:
        Функция без аргументов, возвращающая float в ``[0, 1)``.
    """

    a = seed & 0xFFFFFFFF

    def gen() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61)))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return gen


def _uniform_bipolar(rng, max_val: float) -> float:
    """Uniform в ``[-max, +max]``. Зеркало TS ``uniformBipolar``."""

    return (rng() * 2 - 1) * max_val


# ---------------------------------------------------------------------------
# Phone deduplication (mirror of TS `dedupePhones`)
# ---------------------------------------------------------------------------


_NON_DIGIT_RE = re.compile(r"\D+")


def _normalize_phone(phone: str) -> str:
    """Удалить все нецифровые символы. Зеркало TS ``normalizePhone``."""

    if not isinstance(phone, str):
        return ""
    return _NON_DIGIT_RE.sub("", phone)


def dedupe_phones(contacts: Iterable[Mapping[str, Any]]) -> list[str]:
    """Дедуплицировать список контактов по нормализованному номеру.

    Сохраняет ОРИГИНАЛЬНУЮ строку телефона первого вхождения (как в
    TS-зеркале) — это важно для downstream-кода, который рендерит
    телефон обратно пользователю с тем же форматированием, что он
    ввёл (например, ``+7 (901) 123-45-67`` → выводится как было,
    хотя дедуп идёт по ``79011234567``).

    Args:
        contacts: список словарей с ключом ``"phone"``. Допускаются
            словари без ``phone`` — они просто пропускаются (не
            бросаем исключение, потому что валидация полей лежит на
            вызывающем слое).

    Returns:
        Список оригинальных строк ``phone`` в порядке первого появления.
    """

    seen: set[str] = set()
    out: list[str] = []
    if not contacts:
        return out
    for c in contacts:
        if not isinstance(c, Mapping):
            continue
        raw = c.get("phone")
        if not isinstance(raw, str):
            continue
        norm = _normalize_phone(raw)
        if not norm:
            continue
        if norm in seen:
            continue
        seen.add(norm)
        out.append(raw)
    return out


# ---------------------------------------------------------------------------
# Timezone helpers
# ---------------------------------------------------------------------------


def _safe_zoneinfo(tz_name: str) -> ZoneInfo:
    """Получить ``ZoneInfo`` с graceful fallback на UTC.

    TS-зеркало использует ``Intl.DateTimeFormat`` с graceful fallback
    («safeIntlParts» — никогда не бросает). Здесь делаем то же:
    некорректный ``user_tz`` (например, опечатка) не должен валить
    весь расчёт.
    """

    if not tz_name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        logger.warning(
            "preflight_calc: неизвестная таймзона %r — fallback на UTC", tz_name
        )
        return ZoneInfo("UTC")


def _ensure_aware_utc(dt: datetime) -> datetime:
    """Привести datetime к timezone-aware UTC.

    Naive datetime интерпретируется как UTC (как TS ``new Date(iso)``
    для ISO-строк без таймзоны). Если уже aware — конвертируем в UTC.
    """

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    """Распарсить строку/datetime в timezone-aware UTC datetime.

    Обрабатывает:
    * строки ISO-8601 с/без миллисекунд, с/без ``Z`` суффикса;
    * уже разобранные ``datetime`` (naive → UTC, aware → конвертируем).

    Возвращает ``None`` для всего остального, чтобы вызывающий код
    мог сделать nil-check без try/except.
    """

    if value is None:
        return None
    if isinstance(value, datetime):
        return _ensure_aware_utc(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # ``fromisoformat`` в 3.11+ понимает суффикс Z; для совместимости
    # с младшими версиями (3.9/3.10) явно меняем Z → +00:00.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _ensure_aware_utc(dt)


def _zoned_parts(dt: datetime, tz: ZoneInfo) -> dict[str, int]:
    """Получить wall-clock компоненты в локальной таймзоне.

    Эквивалент TS ``safeIntlParts`` — возвращает словарь с ключами
    ``year, month, day, hour, minute, second``.
    """

    local = _ensure_aware_utc(dt).astimezone(tz)
    return {
        "year": local.year,
        "month": local.month,
        "day": local.day,
        "hour": local.hour,
        "minute": local.minute,
        "second": local.second,
    }


def _zoned_to_utc(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    second: int,
    tz: ZoneInfo,
) -> datetime:
    """Wall-clock дату/время в ``tz`` → UTC instant.

    Зеркало TS ``zonedToUtc``. Использует нативную ``ZoneInfo``-логику
    (Python поддерживает DST через ``zoneinfo`` без Intl-пробинга).
    """

    naive_local = datetime(year, month, day, hour, minute, second)
    aware_local = naive_local.replace(tzinfo=tz)
    return aware_local.astimezone(timezone.utc)


def _add_calendar_days(
    parts: Mapping[str, int], n: int, tz: ZoneInfo
) -> dict[str, int]:
    """Прибавить ``n`` календарных дней в ``tz``. Возвращает naive parts.

    Зеркало TS ``addCalendarDays``. Якорим в полдень, чтобы не
    наступить на DST spring-forward.
    """

    utc = _zoned_to_utc(
        int(parts["year"]),
        int(parts["month"]),
        int(parts["day"]),
        12,
        0,
        0,
        tz,
    )
    shifted = utc + timedelta(days=int(n))
    p = _zoned_parts(shifted, tz)
    return {"year": p["year"], "month": p["month"], "day": p["day"]}


def _format_hour_minute(dt: datetime, tz: ZoneInfo) -> str:
    """``"HH:MM"`` строка в локальной таймзоне."""

    p = _zoned_parts(dt, tz)
    return f"{p['hour']:02d}:{p['minute']:02d}"


def _format_hour(h: int) -> str:
    """``"HH:00"`` для UI-сообщений (например, в quiet_hours warning)."""

    h = max(0, min(23, int(h)))
    return f"{h:02d}:00"


# ---------------------------------------------------------------------------
# Interval algebra
# ---------------------------------------------------------------------------


Interval = tuple[datetime, datetime]


def _interval_duration_seconds(intervals: Sequence[Interval]) -> float:
    """Сумма длительностей интервалов в секундах. Зеркало ``intervalDuration``."""

    total = 0.0
    for a, b in intervals:
        delta = (b - a).total_seconds()
        if delta > 0:
            total += delta
    return total


def _clip_interval(
    iv: Interval, lo: datetime, hi: datetime
) -> Optional[Interval]:
    """Зажать интервал в ``[lo, hi]``. Зеркало TS ``clipInterval``."""

    a = lo if iv[0] < lo else iv[0]
    b = hi if iv[1] > hi else iv[1]
    if b > a:
        return (a, b)
    return None


def _merge_intervals(intervals: Sequence[Interval]) -> list[Interval]:
    """Слить пересекающиеся/смежные интервалы. Зеркало TS ``mergeIntervals``."""

    filtered = [iv for iv in intervals if iv[1] > iv[0]]
    if not filtered:
        return []
    sorted_iv = sorted(filtered, key=lambda iv: iv[0])
    out: list[Interval] = []
    for iv in sorted_iv:
        if not out:
            out.append((iv[0], iv[1]))
            continue
        last = out[-1]
        if iv[0] <= last[1]:
            if iv[1] > last[1]:
                out[-1] = (last[0], iv[1])
        else:
            out.append((iv[0], iv[1]))
    return out


def _subtract_exclusions(
    window: Interval, exclusions: Sequence[Interval]
) -> list[Interval]:
    """Вычесть ``exclusions`` из единого окна. Зеркало TS ``subtractExclusions``.

    Возвращает отсортированный список непересекающихся под-интервалов.
    """

    if window[1] <= window[0]:
        return []
    clipped = []
    for ex in exclusions:
        c = _clip_interval(ex, window[0], window[1])
        if c is not None:
            clipped.append(c)
    merged = _merge_intervals(clipped)
    if not merged:
        return [(window[0], window[1])]

    out: list[Interval] = []
    cursor = window[0]
    for s, e in merged:
        if s > cursor:
            out.append((cursor, s))
        if e > cursor:
            cursor = e
        if cursor >= window[1]:
            break
    if cursor < window[1]:
        out.append((cursor, window[1]))
    return out


def _project_offset_into_intervals(
    intervals: Sequence[Interval], offset_seconds: float
) -> datetime:
    """Спроецировать секундный offset в список интервалов. Зеркало ``projectOffsetIntoIntervals``.

    Идём по интервалам, уменьшая ``offset_seconds`` на длительность
    каждого; когда остаётся меньше длины текущего интервала — возвращаем
    точку внутри него. Перебор → возвращаем правую границу последнего
    интервала (clamp).
    """

    if not intervals:
        # Same as TS `new Date(0)` — UNIX epoch.
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    remaining = max(0.0, float(offset_seconds))
    for a, b in intervals:
        span = (b - a).total_seconds()
        if remaining <= span:
            return a + timedelta(seconds=remaining)
        remaining -= span
    return intervals[-1][1]


# ---------------------------------------------------------------------------
# Quiet hours and calendar exceptions
# ---------------------------------------------------------------------------


def _quiet_hours_zones(
    win_start: datetime,
    win_end: datetime,
    qh_start: int,
    qh_end: int,
    tz: ZoneInfo,
) -> list[Interval]:
    """Сгенерировать UTC-зоны quiet hours, пересекающиеся с окном.

    Семантика идентична TS ``quietHoursZones``:
    * целочисленные часы 0..23 в ``tz``;
    * ``qhStart <= qhEnd`` → зона ``[qhStart, qhEnd)``;
    * ``qhStart >  qhEnd`` → wrap midnight: ``[qhStart, 24) ∪ [0, qhEnd)``.

    Итерируем от дня перед ``win_start`` до дня после ``win_end``,
    чтобы зацепить wrap-around зоны, начавшиеся вчера. Hard cap 92
    итерации — защита от бесконечного цикла на патологических входах.
    """

    zones: list[Interval] = []
    if qh_start == qh_end:
        return zones  # пустая зона (Req 1.7 не активируется)

    start_parts = _zoned_parts(win_start, tz)
    end_parts = _zoned_parts(win_end, tz)
    cursor = _add_calendar_days(
        {
            "year": start_parts["year"],
            "month": start_parts["month"],
            "day": start_parts["day"],
        },
        -1,
        tz,
    )
    for _ in range(92):
        if qh_start < qh_end:
            zones.append(
                (
                    _zoned_to_utc(
                        cursor["year"], cursor["month"], cursor["day"],
                        qh_start, 0, 0, tz,
                    ),
                    _zoned_to_utc(
                        cursor["year"], cursor["month"], cursor["day"],
                        qh_end, 0, 0, tz,
                    ),
                )
            )
        else:
            # Wraps midnight: two intervals.
            nxt = _add_calendar_days(cursor, 1, tz)
            zones.append(
                (
                    _zoned_to_utc(
                        cursor["year"], cursor["month"], cursor["day"],
                        qh_start, 0, 0, tz,
                    ),
                    _zoned_to_utc(
                        nxt["year"], nxt["month"], nxt["day"], 0, 0, 0, tz
                    ),
                )
            )
            zones.append(
                (
                    _zoned_to_utc(
                        cursor["year"], cursor["month"], cursor["day"],
                        0, 0, 0, tz,
                    ),
                    _zoned_to_utc(
                        cursor["year"], cursor["month"], cursor["day"],
                        qh_end, 0, 0, tz,
                    ),
                )
            )
        # Прервать после прохождения end_parts.
        if (
            cursor["year"] > end_parts["year"]
            or (
                cursor["year"] == end_parts["year"]
                and cursor["month"] > end_parts["month"]
            )
            or (
                cursor["year"] == end_parts["year"]
                and cursor["month"] == end_parts["month"]
                and cursor["day"] > end_parts["day"]
            )
        ):
            break
        cursor = _add_calendar_days(cursor, 1, tz)

    clipped: list[Interval] = []
    for z in zones:
        c = _clip_interval(z, win_start, win_end)
        if c is not None:
            clipped.append(c)
    return _merge_intervals(clipped)


def _iso_weekday(year: int, month: int, day: int) -> int:
    """Mon=0..Sun=6. Зеркало TS ``isoWeekday``."""

    return date(year, month, day).weekday()


def _day_of_year(year: int, month: int, day: int) -> int:
    """Day-of-year 1..366. Зеркало TS ``dayOfYear``."""

    return date(year, month, day).timetuple().tm_yday


def _parse_yyyy_mm_dd(s: Any) -> Optional[tuple[int, int, int]]:
    """Парсить ``"YYYY-MM-DD"`` в кортеж ``(y, m, d)``.

    CalendarException хранит ``start_date``/``end_date`` как ISO-даты
    (Prisma ``@db.Date``). Сериализованные API могут отдавать их как
    ``"YYYY-MM-DD"`` или как ``"YYYY-MM-DDTHH:MM:SSZ"`` — мы режем
    после первого ``T`` для устойчивости.
    """

    if not isinstance(s, str):
        return None
    head = s.split("T", 1)[0]
    parts = head.split("-")
    if len(parts) != 3:
        return None
    try:
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None
    return (y, m, d)


def _date_matches_exception(
    parts: Mapping[str, int], ex: Mapping[str, Any]
) -> bool:
    """Проверить, попадает ли (y,m,d) в действие ``CalendarException``.

    Зеркало TS ``dateMatchesException``. Поддерживает single-period
    исключения и три типа recurring (``weekly`` / ``monthly`` /
    ``yearly``). На некорректных полях возвращает ``False`` — это
    устойчивее, чем бросать исключение из горячего цикла расчёта.
    """

    sp = _parse_yyyy_mm_dd(ex.get("start_date"))
    ep = _parse_yyyy_mm_dd(ex.get("end_date"))
    if sp is None or ep is None:
        return False
    rec_type = ex.get("recurring_type")
    rec_value = ex.get("recurring_value")

    if rec_type is None:
        cur = parts["year"] * 10000 + parts["month"] * 100 + parts["day"]
        lo = sp[0] * 10000 + sp[1] * 100 + sp[2]
        hi = ep[0] * 10000 + ep[1] * 100 + ep[2]
        return lo <= cur <= hi

    if rec_value is None:
        return False
    try:
        rv = int(rec_value)
    except (TypeError, ValueError):
        return False

    if rec_type == "weekly":
        # Schema допускает ISO Mon=1..Sun=7 ИЛИ 0..6 — обе нормализуем
        # к Mon=0..Sun=6 (как Python ``date.weekday()``).
        target = (rv - 1) % 7 if 1 <= rv <= 7 else rv % 7
        return _iso_weekday(parts["year"], parts["month"], parts["day"]) == target
    if rec_type == "monthly":
        return parts["day"] == rv
    if rec_type == "yearly":
        return _day_of_year(parts["year"], parts["month"], parts["day"]) == rv
    return False


@dataclass
class _ExceptionZoneResult:
    zones: list[Interval]
    affected: dict[str, int]  # name → days inside window


def _calendar_exception_zones(
    win_start: datetime,
    win_end: datetime,
    exceptions: Sequence[Mapping[str, Any]],
    tz: ZoneInfo,
) -> _ExceptionZoneResult:
    """Сгенерировать UTC-зоны календарных исключений в окне.

    Зеркало TS ``calendarExceptionZones``. Защитный cap 400 итераций —
    upper bound «чуть больше года», чтобы не повиснуть на патологии.
    """

    zones: list[Interval] = []
    affected: dict[str, int] = {}
    if not exceptions:
        return _ExceptionZoneResult(zones=zones, affected=affected)
    start_parts = _zoned_parts(win_start, tz)
    end_parts = _zoned_parts(win_end, tz)
    cursor = {
        "year": start_parts["year"],
        "month": start_parts["month"],
        "day": start_parts["day"],
    }
    for _ in range(400):
        for ex in exceptions:
            if _date_matches_exception(cursor, ex):
                a = _zoned_to_utc(
                    cursor["year"], cursor["month"], cursor["day"], 0, 0, 0, tz
                )
                nxt = _add_calendar_days(cursor, 1, tz)
                b = _zoned_to_utc(nxt["year"], nxt["month"], nxt["day"], 0, 0, 0, tz)
                zones.append((a, b))
                name = str(ex.get("name", ""))
                affected[name] = affected.get(name, 0) + 1
        if (
            cursor["year"] > end_parts["year"]
            or (
                cursor["year"] == end_parts["year"]
                and cursor["month"] > end_parts["month"]
            )
            or (
                cursor["year"] == end_parts["year"]
                and cursor["month"] == end_parts["month"]
                and cursor["day"] >= end_parts["day"]
            )
        ):
            break
        cursor = _add_calendar_days(cursor, 1, tz)

    clipped: list[Interval] = []
    for z in zones:
        c = _clip_interval(z, win_start, win_end)
        if c is not None:
            clipped.append(c)
    return _ExceptionZoneResult(
        zones=_merge_intervals(clipped), affected=affected
    )


def _any_interval_contains(intervals: Sequence[Interval], dt: datetime) -> bool:
    """Содержится ли datetime хоть в одном интервале (полуоткрытом)."""

    aware = _ensure_aware_utc(dt)
    for a, b in intervals:
        if a <= aware < b:
            return True
    return False


# ---------------------------------------------------------------------------
# Smart-Time helpers
# ---------------------------------------------------------------------------


def _clamp_int(value: Any, lo: int, hi: int) -> int:
    """Целое число в ``[lo, hi]`` с graceful fallback на ``lo``.

    Зеркало TS ``clampInt``. Принимает None / non-int / NaN-подобное.
    """

    try:
        v = int(value)
    except (TypeError, ValueError):
        return lo
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def _pick_top_hours(hist: Sequence[int], top_n: int) -> list[Hour]:
    """Top-N часов: descending count, ascending hour. Зеркало TS ``pickTopHours``.

    Эта функция дублирует логику ``ActivityAnalyzer._select_top_n``,
    но локально чтобы preflight оставался pure-функцией без зависимости
    от инстанса аналайзера для default fallback.
    """

    if not hist:
        return []
    indexed = list(enumerate(hist))
    indexed.sort(key=lambda p: (-int(p[1] or 0), p[0]))
    return [h for h, _ in indexed[: max(1, int(top_n))]]


def _default_smart_time_fallback_hours(top_n: int) -> list[Hour]:
    """Default fallback peaked at ``{10, 14, 19}``. Зеркало TS массива в ``simulateSmartTime``.

    Сумма default-гистограммы = 3 < 5, и мы НЕ применяем порог здесь —
    это уже fallback по определению; берём top-N как есть.
    """

    hist = [0] * 24
    for h in (10, 14, 19):
        hist[h] = 1
    return _pick_top_hours(hist, top_n)


def _pick_recipient_slots(
    phone: str,
    histograms: Optional[Mapping[str, Sequence[int]]],
    fallback: Sequence[Hour],
    top_n: int,
    activity_analyzer: Optional[ActivityAnalyzer],
    user_id: Optional[str],
) -> list[Hour]:
    """Top-N слотов получателя с fallback chain.

    Приоритет источников (ровно как в Requirement 2.4–2.6 и
    ``Activity_Analyzer.top_slots``):

    1. ``histograms[phone]`` — если передан и сумма ≥ 5;
    2. ``activity_analyzer.top_slots(user_id, phone, top_n)`` — если
       аналайзер инжектирован (server-side путь, БД доступна);
    3. ``fallback`` — иначе.

    TS-зеркало знает только пути 1 и 3 (браузер не имеет прямого
    доступа к Activity_Analyzer и читает гистограммы через
    ``GET /api/recipient-activity``, передавая результат сюда как
    ``recipientHistograms``). Серверный mirror получает аналайзер
    напрямую через DI и поэтому может дополнительно дотянуться до
    БД-агрегации.
    """

    if histograms is not None:
        hist = histograms.get(phone)
        if hist is not None and len(hist) == 24 and sum(int(v or 0) for v in hist) >= 5:
            return _pick_top_hours(hist, top_n)

    if activity_analyzer is not None and user_id:
        try:
            slots, _source = activity_analyzer.top_slots(user_id, phone, top_n)
            if slots:
                return list(slots)
        except Exception:
            logger.exception(
                "preflight_calc: activity_analyzer.top_slots упал — fallback"
            )

    return list(fallback)


def _shift_past_quiet_hours(
    hour: int,
    enabled: bool,
    qh_start: int,
    qh_end: int,
) -> Optional[int]:
    """Если час попадает в QH — сдвинуть на ``qh_end``. Зеркало TS ``shiftPastQuietHours``.

    Возвращает:
    * исходный ``hour`` — если QH выключены или час вне зоны;
    * ``qh_end % 24`` — если час в QH (первый час за пределами QH);
    * ``None`` — для невозможных конфигураций (NEVER в текущей логике).
    """

    if not enabled or qh_start == qh_end:
        return hour
    if qh_start < qh_end:
        in_qh = qh_start <= hour < qh_end
    else:
        in_qh = hour >= qh_start or hour < qh_end
    if not in_qh:
        return hour
    return qh_end % 24


# ---------------------------------------------------------------------------
# Distribution simulators (mirror Schedule_Mode_Engine strategies)
# ---------------------------------------------------------------------------


def _simulate_window(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
    phones: Sequence[str],
) -> list[ScheduledSend]:
    """``window`` mode — even spread с детерминированным jitter.

    Зеркало TS ``simulateWindow``. Ключевое: при недостаточном usable
    окне (Req 1.9) preflight НЕ бросает — мы делаем best-effort spread
    по полному окну, чтобы пользователь увидел histogram. Реальная
    блокировка происходит в :func:`validate_window`, который API-роут
    вызывает отдельно перед INSERT.
    """

    if not phones:
        return []
    start = _parse_iso_utc(draft.get("send_window_start"))
    end = _parse_iso_utc(draft.get("send_window_end"))
    if start is None or end is None or end <= start:
        return []
    user_tz = _safe_zoneinfo(str(draft.get("user_tz") or "UTC"))

    exclusions: list[Interval] = []
    if draft.get("quiet_hours_enabled"):
        qhs = _clamp_int(draft.get("quiet_hours_start", 22), 0, 23)
        qhe = _clamp_int(draft.get("quiet_hours_end", 8), 0, 23)
        exclusions.extend(_quiet_hours_zones(start, end, qhs, qhe, user_tz))
    exclusions.extend(_calendar_exception_zones(start, end, exceptions, user_tz).zones)

    usable = _subtract_exclusions((start, end), exclusions)
    usable_seconds = _interval_duration_seconds(usable)
    n = len(phones)

    intervals_for_spread: list[Interval]
    if usable_seconds >= n * float(anti_ban.delay_min) and usable:
        intervals_for_spread = list(usable)
    else:
        intervals_for_spread = [(start, end)]
    spread_seconds = _interval_duration_seconds(intervals_for_spread)
    base_interval = spread_seconds / max(n, 1)

    rng = mulberry32(int(draft.get("id") or 0))
    sends: list[ScheduledSend] = []
    for i, phone in enumerate(phones):
        jitter_max = min(60.0, base_interval / 4.0)
        jitter = _uniform_bipolar(rng, jitter_max)
        offset = i * base_interval + jitter
        send_at = _project_offset_into_intervals(intervals_for_spread, offset)
        sends.append(ScheduledSend(phone=phone, send_at=send_at, metadata={}))
    return sends


def _simulate_smart_time(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
    phones: Sequence[str],
    activity_analyzer: Optional[ActivityAnalyzer],
    recipient_histograms: Optional[Mapping[str, Sequence[int]]],
) -> list[ScheduledSend]:
    """``smart_time`` mode — round-robin top-slots с QH/exceptions.

    Зеркало TS ``simulateSmartTime`` плюс DI-путь к Activity_Analyzer
    (см. :func:`_pick_recipient_slots`). Метаданные не заполняем
    (в TS-mirror их тоже нет) — фактическая разметка ``slot``/
    ``fallback`` живёт в `SmartTimeEngine` (Task 4.6).
    """

    if not phones:
        return []
    anchor = _parse_iso_utc(draft.get("scheduled_for"))
    if anchor is None:
        anchor = datetime.now(timezone.utc)
    user_tz = _safe_zoneinfo(str(draft.get("user_tz") or "UTC"))
    window_days = _clamp_int(draft.get("smart_time_window_days", 1), 1, 14)
    top_n = _clamp_int(draft.get("smart_time_top_n", 3), 1, 6)
    hourly_limit = max(1, int(anti_ban.hourly_check_limit))

    default_fallback = _default_smart_time_fallback_hours(top_n)
    user_id = str(draft.get("user_id") or "") or None

    exclusion_zones = _calendar_exception_zones(
        anchor,
        anchor + timedelta(days=window_days),
        exceptions,
        user_tz,
    ).zones

    per_hour_count: dict[str, int] = {}
    rr_index: dict[str, int] = {}
    sends: list[ScheduledSend] = []

    anchor_parts = _zoned_parts(anchor, user_tz)
    cursor = {
        "year": anchor_parts["year"],
        "month": anchor_parts["month"],
        "day": anchor_parts["day"],
    }

    for phone in phones:
        slots = _pick_recipient_slots(
            phone, recipient_histograms, default_fallback, top_n,
            activity_analyzer, user_id,
        )
        if not slots:
            slots = list(default_fallback)
        idx = rr_index.get(phone, 0)
        rr_index[phone] = idx + 1
        # base_hour отбирается RR'ом, но в основном цикле перебираются
        # ВСЕ slots — это поведение TS-зеркала (см. строки
        # `for (const hour of slots)` внутри simulateSmartTime).
        # Мы воспроизводим точно тот же цикл.

        placed: Optional[datetime] = None
        for day_offset in range(window_days + 1):
            if placed is not None:
                break
            candidate_parts = (
                cursor if day_offset == 0
                else _add_calendar_days(cursor, day_offset, user_tz)
            )
            for hour in slots:
                adjusted = _shift_past_quiet_hours(
                    int(hour),
                    bool(draft.get("quiet_hours_enabled")),
                    _clamp_int(draft.get("quiet_hours_start", 22), 0, 23),
                    _clamp_int(draft.get("quiet_hours_end", 8), 0, 23),
                )
                if adjusted is None:
                    continue
                ts = _zoned_to_utc(
                    candidate_parts["year"],
                    candidate_parts["month"],
                    candidate_parts["day"],
                    int(adjusted),
                    0, 0,
                    user_tz,
                )
                if _any_interval_contains(exclusion_zones, ts):
                    continue
                key = (
                    f"{candidate_parts['year']}-{candidate_parts['month']}-"
                    f"{candidate_parts['day']}-{adjusted}"
                )
                cnt = per_hour_count.get(key, 0)
                if cnt >= hourly_limit:
                    continue
                per_hour_count[key] = cnt + 1
                placed = ts
                break
        sends.append(ScheduledSend(phone=phone, send_at=placed or anchor, metadata={}))
    return sends


def _deterministic_split(items: Sequence[str], n: int, seed: int) -> list[list[str]]:
    """Fisher-Yates с mulberry32, потом round-robin. Зеркало TS ``deterministicSplit``.

    Гарантирует ``max_size − min_size <= 1`` и идентичность с
    TS-результатом для того же ``seed`` (mulberry32 одинаков).
    """

    arr = list(items)
    rng = mulberry32(int(seed))
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng() * (i + 1))
        if j < 0:
            j = 0
        if j > i:
            j = i
        arr[i], arr[j] = arr[j], arr[i]
    groups_count = max(1, int(n))
    groups: list[list[str]] = [[] for _ in range(groups_count)]
    for i, val in enumerate(arr):
        groups[i % groups_count].append(val)
    return groups


def _simulate_ab_time(
    draft: Mapping[str, Any], phones: Sequence[str]
) -> list[ScheduledSend]:
    """``ab_time`` mode — split N групп, отправка в slot-час дня anchor'а.

    Зеркало TS ``simulateAbTime``. Без БД-доступа PreFlight defaults
    к ``[10, 19]`` — фактические slots создаёт сервер при создании
    ``ABTimeTest`` (Task 9.11).
    """

    if not phones:
        return []
    anchor = _parse_iso_utc(draft.get("scheduled_for"))
    if anchor is None:
        anchor = datetime.now(timezone.utc)
    user_tz = _safe_zoneinfo(str(draft.get("user_tz") or "UTC"))

    slots: list[int] = [10, 19]
    groups = _deterministic_split(phones, len(slots), int(draft.get("id") or 0))
    anchor_parts = _zoned_parts(anchor, user_tz)
    sends: list[ScheduledSend] = []
    for g, group_phones in enumerate(groups):
        ts = _zoned_to_utc(
            anchor_parts["year"],
            anchor_parts["month"],
            anchor_parts["day"],
            slots[g],
            0, 0,
            user_tz,
        )
        for phone in group_phones:
            sends.append(ScheduledSend(phone=phone, send_at=ts, metadata={}))
    return sends


def _simulate_burst(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    phones: Sequence[str],
) -> list[ScheduledSend]:
    """``burst`` mode — anchor + i * delay_min. Зеркало TS ``simulateBurst``.

    Это превью для throttle_state=normal. Реальный
    ``BurstEngine.delay_for`` (Task 4.13) учтёт slowed-state и
    фактический message_index в worker'е.
    """

    if not phones:
        return []
    anchor = _parse_iso_utc(draft.get("scheduled_for"))
    if anchor is None:
        anchor = datetime.now(timezone.utc)
    step = max(1.0, float(anti_ban.delay_min))
    return [
        ScheduledSend(
            phone=p, send_at=anchor + timedelta(seconds=i * step), metadata={}
        )
        for i, p in enumerate(phones)
    ]


def _simulate_legacy(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    phones: Sequence[str],
) -> list[ScheduledSend]:
    """``exact`` / ``drip`` / ``recurring`` — линейный спред avg(delay_min, delay_max).

    Зеркало TS ``simulateLegacy``. Server остаётся authoritative для
    этих режимов через существующий ``BroadcastScheduler``; preflight
    для них только превью histogram'а.
    """

    if not phones:
        return []
    anchor = _parse_iso_utc(draft.get("scheduled_for"))
    if anchor is None:
        anchor = datetime.now(timezone.utc)
    step = max(1.0, (float(anti_ban.delay_min) + float(anti_ban.delay_max)) / 2.0)
    return [
        ScheduledSend(
            phone=p, send_at=anchor + timedelta(seconds=i * step), metadata={}
        )
        for i, p in enumerate(phones)
    ]


def simulate_distribution(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
    phones: Sequence[str],
    activity_analyzer: Optional[ActivityAnalyzer] = None,
    recipient_histograms: Optional[Mapping[str, Sequence[int]]] = None,
) -> list[ScheduledSend]:
    """Top-level dispatcher по ``schedule_type``. Зеркало TS ``simulateDistribution``.

    Возвращает список ScheduledSend, отсортированный по ``send_at``,
    чтобы извлечение first/last ETA было тривиальным.
    """

    schedule_type = str(draft.get("schedule_type") or "")
    if schedule_type == "window":
        sends = _simulate_window(draft, anti_ban, exceptions, phones)
    elif schedule_type == "smart_time":
        sends = _simulate_smart_time(
            draft, anti_ban, exceptions, phones, activity_analyzer, recipient_histograms
        )
    elif schedule_type == "ab_time":
        sends = _simulate_ab_time(draft, phones)
    elif schedule_type == "burst":
        sends = _simulate_burst(draft, anti_ban, phones)
    else:
        sends = _simulate_legacy(draft, anti_ban, phones)

    sends.sort(key=lambda s: s.send_at)
    return sends


# ---------------------------------------------------------------------------
# Histogram and warnings
# ---------------------------------------------------------------------------


def compute_histogram(
    sends: Sequence[ScheduledSend], user_tz: str
) -> Histogram:
    """24-bucket гистограмма часов в локальной таймзоне.

    Зеркало TS ``computeHistogram``. Без fast-path / slow-path
    оптимизаций (Python с zoneinfo достаточно быстр; на 5000 сэндов
    < 50 ms на типовом железе). Точность DST гарантирована
    нативной zoneinfo-логикой.
    """

    hist: Histogram = [0] * 24
    if not sends:
        return hist
    tz = _safe_zoneinfo(user_tz or "UTC")
    for s in sends:
        if not isinstance(s.send_at, datetime):
            continue
        try:
            local = _ensure_aware_utc(s.send_at).astimezone(tz)
        except Exception:
            continue
        hist[local.hour % 24] += 1
    return hist


def build_warnings(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
    instance: Optional[Mapping[str, Any]],
    sends: Sequence[ScheduledSend],
) -> list[PreFlightWarning]:
    """Собрать warnings в фиксированном порядке Req 5.5–5.8.

    Порядок:
    1. ``quiet_hours_postpone``
    2. ``calendar_exception_postpone``
    3. ``daily_limit_exceeded``
    4. ``instance_unhealthy``

    Тесты (cross-language P11.4 + unit для PreFlight) полагаются на
    этот порядок — менять нельзя.
    """

    warnings: list[PreFlightWarning] = []
    user_tz = _safe_zoneinfo(str(draft.get("user_tz") or "UTC"))

    # 1) quiet_hours_postpone (Req 5.5)
    if draft.get("quiet_hours_enabled"):
        qhs = _clamp_int(draft.get("quiet_hours_start", 22), 0, 23)
        qhe = _clamp_int(draft.get("quiet_hours_end", 8), 0, 23)
        if qhs != qhe and sends:
            affected = 0
            for s in sends:
                try:
                    local = _ensure_aware_utc(s.send_at).astimezone(user_tz)
                except Exception:
                    continue
                hour = local.hour
                in_window = (
                    qhs <= hour < qhe if qhs < qhe else (hour >= qhs or hour < qhe)
                )
                if in_window:
                    affected += 1
            if affected > 0:
                warnings.append(
                    PreFlightWarning(
                        kind="quiet_hours_postpone",
                        message=(
                            f"{affected} сообщ. попадают в тихие часы "
                            f"{_format_hour(qhs)}–{_format_hour(qhe)} и будут отложены"
                        ),
                        affected_count=affected,
                    )
                )

    # 2) calendar_exception_postpone (Req 5.6)
    if exceptions and sends:
        win_start = sends[0].send_at
        win_end = sends[-1].send_at
        ex_zones = _calendar_exception_zones(win_start, win_end, exceptions, user_tz)
        if ex_zones.affected:
            parts = [f"{name} ({days} дн.)" for name, days in ex_zones.affected.items()]
            total_affected = 0
            for s in sends:
                if _any_interval_contains(ex_zones.zones, s.send_at):
                    total_affected += 1
            warnings.append(
                PreFlightWarning(
                    kind="calendar_exception_postpone",
                    message=f"Календарные исключения: {', '.join(parts)}",
                    affected_count=total_affected,
                )
            )

    # 3) daily_limit_exceeded (Req 5.7)
    daily_limit = int(anti_ban.daily_message_limit or 0)
    if daily_limit > 0 and len(sends) > daily_limit:
        per_day: dict[tuple[int, int, int], int] = {}
        for s in sends:
            try:
                local = _ensure_aware_utc(s.send_at).astimezone(user_tz)
            except Exception:
                continue
            key = (local.year, local.month, local.day)
            per_day[key] = per_day.get(key, 0) + 1
        max_day = max(per_day.values()) if per_day else 0
        if max_day > daily_limit:
            warnings.append(
                PreFlightWarning(
                    kind="daily_limit_exceeded",
                    message=(
                        f"Превышен дневной лимит: {max_day} сообщ. за день при лимите {daily_limit}"
                    ),
                    affected_count=max_day - daily_limit,
                )
            )

    # 4) instance_unhealthy (Req 5.8)
    if instance is not None:
        status = instance.get("status") if isinstance(instance, Mapping) else None
        name = instance.get("name") if isinstance(instance, Mapping) else None
        if status and status != "authorized":
            warnings.append(
                PreFlightWarning(
                    kind="instance_unhealthy",
                    message=f"Инстанс «{name or ''}» в статусе {status}",
                )
            )

    return warnings


# ---------------------------------------------------------------------------
# validate_window — приоритетная валидация
# ---------------------------------------------------------------------------


def validate_window(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
) -> None:
    """Бросить ``WINDOW_INSUFFICIENT_TIME`` (Req 1.9) если usable_seconds < N * delay_min.

    Эта ошибка имеет ПРИОРИТЕТ над всеми остальными window-валидациями
    (``WINDOW_INVALID_RANGE``, ``WINDOW_IN_PAST`` и т.п.) — Requirement 1.9
    эксплицитно: «THE WINDOW_INSUFFICIENT_TIME error SHALL take precedence
    over any other validation error in this requirement».

    Валидация скипается, если:
    * ``schedule_type`` не ``"window"`` (нечего проверять);
    * ``send_window_start`` или ``send_window_end`` отсутствуют /
      некорректны (другая ошибка покроет);
    * список контактов пуст (delete-by-zero — N=0, ничего не нарушает).

    Property 6 (Task 3.5) проверяет, что для drafts которые провалили
    бы и Req 1.2/1.3/1.4 и 1.9 одновременно — возвращается именно
    ``WINDOW_INSUFFICIENT_TIME``.

    Raises:
        SchedulingError: с code=``WINDOW_INSUFFICIENT_TIME`` и
            ``http_status=422``.
    """

    if str(draft.get("schedule_type") or "") != "window":
        return

    start = _parse_iso_utc(draft.get("send_window_start"))
    end = _parse_iso_utc(draft.get("send_window_end"))
    if start is None or end is None or end <= start:
        # Эти случаи покрыты WINDOW_INVALID_RANGE / WINDOW_IN_PAST в
        # вышестоящем валидаторе; здесь мы делаем no-op, потому что
        # «приоритет над window-валидациями» актуален ТОЛЬКО когда
        # WINDOW_INSUFFICIENT_TIME действительно фактически
        # триггерится. Если окно само по себе невалидно по shape —
        # говорить о «недостаточном usable» бессмысленно.
        return

    phones = dedupe_phones(draft.get("contacts") or [])
    n = len(phones)
    if n == 0:
        return

    user_tz = _safe_zoneinfo(str(draft.get("user_tz") or "UTC"))
    exclusions: list[Interval] = []
    if draft.get("quiet_hours_enabled"):
        qhs = _clamp_int(draft.get("quiet_hours_start", 22), 0, 23)
        qhe = _clamp_int(draft.get("quiet_hours_end", 8), 0, 23)
        exclusions.extend(_quiet_hours_zones(start, end, qhs, qhe, user_tz))
    exclusions.extend(_calendar_exception_zones(start, end, exceptions, user_tz).zones)

    usable = _subtract_exclusions((start, end), exclusions)
    usable_seconds = _interval_duration_seconds(usable)
    required = n * float(anti_ban.delay_min)
    if usable_seconds < required:
        raise SchedulingError(
            "WINDOW_INSUFFICIENT_TIME",
            (
                f"Недостаточно времени в окне: usable={usable_seconds:.1f}s "
                f"< required={required:.1f}s (N={n}, delay_min={anti_ban.delay_min})"
            ),
            http_status=422,
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_preflight(
    draft: Mapping[str, Any],
    anti_ban: AntiBanConfig,
    exceptions: Sequence[Mapping[str, Any]],
    instance: Optional[Mapping[str, Any]],
    activity_analyzer: Optional[ActivityAnalyzer] = None,
    *,
    recipient_histograms: Optional[Mapping[str, Sequence[int]]] = None,
) -> PreFlightServerResult:
    """Серверный mirror TS ``runPreFlight``.

    Используется внутри ``POST /api/scheduled-broadcasts`` ПЕРЕД INSERT
    (см. Task 9.12) для повторной валидации и для surface'инга тех
    же warnings, которые видел пользователь в PreFlight модалке.

    Args:
        draft: словарь-черновик ``ScheduledBroadcast``. Поля повторяют
            TS-тип ``ScheduledBroadcastDraft``: ``contacts``,
            ``schedule_type``, ``scheduled_for``, ``send_window_start``,
            ``send_window_end``, ``smart_time_window_days``,
            ``smart_time_top_n``, ``quiet_hours_*``, ``user_tz``,
            опционально ``id`` (для seed jitter'а), ``user_id``
            (для DI Activity_Analyzer).
        anti_ban: ``AntiBanConfig`` пользователя — для ``delay_min``,
            ``delay_max``, ``hourly_check_limit``, ``daily_message_limit``.
        exceptions: список словарей ``CalendarException`` (или Prisma
            row dict) — поля ``name``, ``start_date``, ``end_date``,
            ``recurring_type``, ``recurring_value``.
        instance: словарь ``GreenInstance`` или ``None``. Поля
            ``status``, ``name``.
        activity_analyzer: опциональная инжекция
            :class:`ActivityAnalyzer` для smart_time-режима. Если
            ``None``, используется только ``recipient_histograms``
            и default fallback.
        recipient_histograms: опциональный pre-fetched mapping
            ``phone → 24-bucket histogram`` (как в TS-зеркале);
            обходит вызов ``activity_analyzer`` для уже известных
            histogram'ов.

    Returns:
        :class:`PreFlightServerResult` с ETA, гистограммой, warnings.

    Note:
        НЕ бросает ``WINDOW_INSUFFICIENT_TIME`` — это делает
        :func:`validate_window` отдельно. Преfflight всегда отдаёт
        best-effort превью, чтобы UI мог отрисовать гистограмму
        даже при невалидном окне (для диагностики).
    """

    t0 = time.perf_counter()
    user_tz = str(draft.get("user_tz") or "UTC")

    phones = dedupe_phones(draft.get("contacts") or [])

    # Вызываем simulate_distribution с уже дедуплицированным списком —
    # повторная дедупликация внутри симуляторов не нужна, и так
    # счётчики гистограммы получаются точные (ровно как в TS,
    # см. ``runPreFlight`` → `draft.contacts = phones.map(...)`).
    sends = simulate_distribution(
        draft, anti_ban, exceptions, phones,
        activity_analyzer=activity_analyzer,
        recipient_histograms=recipient_histograms,
    )

    histogram = compute_histogram(sends, user_tz)
    warnings = build_warnings(draft, anti_ban, exceptions, instance, sends)
    compute_ms = (time.perf_counter() - t0) * 1000.0

    tz = _safe_zoneinfo(user_tz)
    first_eta = _format_hour_minute(sends[0].send_at, tz) if sends else "—"
    last_eta = _format_hour_minute(sends[-1].send_at, tz) if sends else "—"

    return PreFlightServerResult(
        recipient_count=len(phones),
        first_send_eta=first_eta,
        last_send_eta=last_eta,
        histogram=histogram,
        warnings=[w.to_dict() for w in warnings],
        compute_ms=compute_ms,
    )
