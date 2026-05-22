"""ActivityAnalyzer — 24-bucket гистограмма активности получателя.

Поведение определено Requirements 2.3 / 2.4 / 2.5 / 2.6 спеки
``broadcast-scheduling-suite`` и design.md (секция
"Components and Interfaces → Activity_Analyzer").

Что считаем
===========

Для пары ``(user_id, phone)`` за последние 30 дней суммируем по
часам дня (0..23):

* записи ``incoming`` со ``sender = phone`` AND ``user_id = user_id``
  (расценивается как «получатель был онлайн и ответил/написал
  оператору в этот час»);
* записи ``delivery_statuses`` со статусами в ``{read, played,
  viewed}``, чей ``message_id`` принадлежит ``recipients`` с
  ``phone = phone`` рассылок ``broadcasts`` оператора
  (расценивается как «получатель прочитал в этот час»).

Кэш
====

In-memory, per-process, потокобезопасный через ``threading.Lock``.
Структура кэша точно как в design.md:

    self._cache: dict[(user_id, phone), (timestamp, list[int])]

TTL = 3600 секунд (1 час). Operator-global histogram кэшируется
отдельным словарём ``dict[user_id, (timestamp, list[int])]`` с тем
же TTL — это спасает от N+1 запросов при распределении большой
рассылки в Smart-Time режиме, где для каждого получателя без
истории мы скатываемся в operator-global fallback.

Без Redis: для текущего масштаба (десятки тысяч контактов в день,
один Flask-процесс) этого достаточно. См. design.md "Ключевые
архитектурные решения".

Fallback chain в ``top_slots(...)``
====================================

1. ``recipient``         — если ``sum(hist) >= 5`` для пары
                           ``(user_id, phone)``;
2. ``operator_global``   — иначе если ``sum(hist) >= 5`` для
                           operator-global histogram пользователя;
3. ``default_fallback``  — иначе фиксированный default peaked at
                           часах ``{10, 14, 19}``.

Tie-break при выборе top-N: descending count, ascending hour value
(Requirement 2.6, Property 7).

Подключение к БД
================

Расчёт идёт по Postgres (Supabase) — той же базе, куда фронтенд
пишет через Prisma. По умолчанию используется ``psycopg2`` через
переменную окружения ``DATABASE_URL`` — тот же паттерн, что и в
``scheduler.py``. Для тестов фабрика соединений инжектится через
параметр ``db_connection_factory``.

Если ``DATABASE_URL`` не задан или соединение упало, расчёт
гистограммы возвращает массив из 24 нулей — это корректный nil-объект
для последующего fallback в ``top_slots``: ``sum=0 < 5`` ⇒ перейдём
на operator_global или default_fallback. Это сохраняет тотальность
``top_slots`` (Property 7) даже без БД, что важно для локальной
разработки и unit-тестов.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import closing
from typing import Any, Callable, Optional

from scheduling.logger import logger
from scheduling.types import Histogram, Hour, Phone, UserId


__all__ = ["ActivityAnalyzer", "DEFAULT_FALLBACK_HISTOGRAM"]


#: Минимальное количество событий, при котором гистограмма считается
#: значимой и используется без fallback. См. Requirements 2.4 и 2.5.
_MIN_EVENTS_FOR_VALID_HISTOGRAM = 5

#: TTL кэша по умолчанию — 1 час, как требует Requirement 2.x и
#: design.md. Выражено в секундах для совместимости с ``time.time()``.
_DEFAULT_TTL_SECONDS = 3600

#: Окно агрегации — последние 30 дней. Выражено в днях, потому что в
#: SQL мы используем ``NOW() - INTERVAL '30 days'``.
_AGGREGATION_WINDOW_DAYS = 30

#: Допустимые статусы доставки, считающиеся положительной активностью
#: получателя в Smart-Time гистограмме (Requirement 2.3).
_POSITIVE_DELIVERY_STATUSES: tuple[str, ...] = ("read", "played", "viewed")


def _build_default_fallback() -> Histogram:
    """Дефолтная 24-bucket гистограмма с пиками в часах ``{10, 14, 19}``.

    Часы нумеруются 0..23 (как ``datetime.hour``), пики — на индексах
    10, 14 и 19. Все остальные часы — 0. Сумма гистограммы = 3, что
    меньше ``_MIN_EVENTS_FOR_VALID_HISTOGRAM``, но это намеренно: на
    этом фоллбеке ``top_slots`` помечает источник как
    ``"default_fallback"`` и ``_select_top_n`` корректно вернёт три
    пика плюс далее по tie-break (ascending hour).
    """

    hist: Histogram = [0] * 24
    for hour in (10, 14, 19):
        hist[hour] = 1
    return hist


#: Замороженная (read-only по соглашению — не мутируем) копия дефолтного
#: fallback. Возвращаем :func:`list` копию из публичного API, чтобы
#: вызывающий код не мог накосячить мутацией глобального состояния.
DEFAULT_FALLBACK_HISTOGRAM: Histogram = _build_default_fallback()


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений по умолчанию.

    Использует ``DATABASE_URL`` из окружения — тот же паттерн, что и
    ``scheduler.py``. Импортируем ``psycopg2`` лениво, чтобы импорт
    модуля ``activity_analyzer`` не падал в окружениях без psycopg2
    (например, в unit-тестах с инжектированной фабрикой).

    Raises:
        RuntimeError: если ``DATABASE_URL`` не задан в окружении.
        ImportError: если ``psycopg2`` не установлен (это
            маловероятно в production, потому что он в
            ``requirements.txt``, но возможно в slim-тестовых
            окружениях).
    """

    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL не задан — ActivityAnalyzer не может обратиться к Postgres"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


class ActivityAnalyzer:
    """Pure-функциональный аналитик активности с in-memory LRU-кэшем.

    Класс не имеет фоновых потоков и не запускает никаких таймеров —
    кэш самоинвалидируется по TTL при следующем чтении. Безопасно
    создавать один синглтон на процесс Flask и инжектить его в
    ``SmartTimeEngine`` и ``ABTimeEngine`` (см. design.md).

    Args:
        db_connection_factory: фабрика DB-соединений. По умолчанию —
            :func:`_default_db_connection_factory` (psycopg2 через
            ``DATABASE_URL``). В тестах инжектится фейковая фабрика,
            возвращающая объект, удовлетворяющий контракту
            ``conn.cursor()`` → ``cur.execute(sql, params)`` →
            ``cur.fetchall() -> list[tuple]``.
        clock: функция получения текущего unix-времени; по умолчанию
            ``time.time``. Инжектится в тестах, чтобы детерминированно
            проверять TTL.
        ttl_seconds: время жизни записи в кэше, секунд; дефолт 3600
            (Requirement: «cache… c TTL 3600s»).

    Attributes:
        _cache: точный тип, заданный design.md, —
            ``dict[(user_id, phone), (unix_ts, histogram)]``.
        _global_cache: вспомогательный кэш operator-global histograms
            ``dict[user_id, (unix_ts, histogram)]``. Не упомянут в
            design.md явно, но логически идентичен и нужен, чтобы
            одна и та же гистограмма не пересчитывалась 1000 раз
            при распределении рассылки на 1000 получателей.
    """

    def __init__(
        self,
        *,
        db_connection_factory: Optional[Callable[[], Any]] = None,
        clock: Callable[[], float] = time.time,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    ) -> None:
        self._db_connection_factory: Callable[[], Any] = (
            db_connection_factory or _default_db_connection_factory
        )
        self._clock = clock
        self._ttl_seconds = int(ttl_seconds)
        self._lock = threading.Lock()
        self._cache: dict[tuple[UserId, Phone], tuple[float, Histogram]] = {}
        self._global_cache: dict[UserId, tuple[float, Histogram]] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compute_histogram(self, user_id: UserId, phone: Phone) -> Histogram:
        """Вернуть 24-bucket гистограмму активности получателя за 30 дней.

        Возвращает СВЕЖУЮ копию списка, чтобы вызывающий код мог
        свободно мутировать результат (например, спускать в
        ``_select_top_n``). Кэш изнутри хранит каноническую копию,
        чтобы повторное чтение в течение TTL не платило за query.

        Validates: Requirements 2.3, 2.4 (per-recipient часть).
        """

        key = (user_id, phone)
        cached = self._read_cache(self._cache, key)
        if cached is not None:
            return list(cached)

        try:
            hist = self._query_recipient_histogram(user_id, phone)
        except Exception:
            # Свидетельства из БД получить не удалось — отдаём nil-объект
            # (24 нуля). Это валидно для fallback-цепочки в top_slots:
            # sum=0 < 5 ⇒ перейдём на operator_global / default_fallback.
            logger.exception(
                "ActivityAnalyzer: не удалось посчитать recipient histogram "
                "user_id=%s phone=%s — возвращаю нулевую гистограмму",
                user_id,
                phone,
            )
            hist = [0] * 24

        self._write_cache(self._cache, key, hist)
        return list(hist)

    def top_slots(
        self,
        user_id: UserId,
        phone: Phone,
        top_n: int,
    ) -> tuple[list[Hour], str]:
        """Вернуть топ-N часов отправки и метку источника.

        Источник — один из:

        * ``"recipient"`` — recipient-гистограмма набрала ``>= 5``
          событий (Requirement 2.4);
        * ``"operator_global"`` — recipient-гистограмма «пустая», но
          operator-global гистограмма набрала ``>= 5`` событий
          (Requirement 2.4);
        * ``"default_fallback"`` — обе гистограммы «пустые», берём
          фиксированный default с пиками ``{10, 14, 19}``
          (Requirement 2.5).

        Длина возвращаемого списка — ``min(max(1, top_n), 24)``
        (контракт Property 7: список НЕ пустой, не длиннее 24).

        Validates: Requirements 2.4, 2.5, 2.6.
        """

        n = self._normalize_top_n(top_n)

        recipient_hist = self.compute_histogram(user_id, phone)
        if sum(recipient_hist) >= _MIN_EVENTS_FOR_VALID_HISTOGRAM:
            return self._select_top_n(recipient_hist, n), "recipient"

        global_hist = self._compute_operator_global_histogram(user_id)
        if sum(global_hist) >= _MIN_EVENTS_FOR_VALID_HISTOGRAM:
            return self._select_top_n(global_hist, n), "operator_global"

        return (
            self._select_top_n(DEFAULT_FALLBACK_HISTOGRAM, n),
            "default_fallback",
        )

    def invalidate(self, user_id: UserId, phone: Optional[Phone] = None) -> None:
        """Сбросить кэш для пользователя (опционально — конкретного телефона).

        Полезно после ручной правки данных в БД или в e2e-тестах.
        Если ``phone`` не задан, сбрасывается также operator-global
        кэш ``user_id`` И все per-phone записи этого ``user_id``.

        Не упомянуто в Requirements явно, но необходимо для
        корректной семантики «свежее чтение» после write-операций.
        """

        with self._lock:
            if phone is not None:
                self._cache.pop((user_id, phone), None)
                return
            # Сбрасываем operator-global и все per-phone записи юзера.
            self._global_cache.pop(user_id, None)
            stale_keys = [k for k in self._cache if k[0] == user_id]
            for k in stale_keys:
                self._cache.pop(k, None)

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def _read_cache(
        self,
        cache: dict[Any, tuple[float, Histogram]],
        key: Any,
    ) -> Optional[Histogram]:
        """Прочитать запись из кэша с проверкой TTL. Возвращает None при miss."""

        with self._lock:
            entry = cache.get(key)
            if entry is None:
                return None
            ts, hist = entry
            if self._clock() - ts >= self._ttl_seconds:
                # Lazy eviction: удаляем протухшую запись, чтобы
                # словарь не рос в памяти бесконечно.
                cache.pop(key, None)
                return None
            return hist

    def _write_cache(
        self,
        cache: dict[Any, tuple[float, Histogram]],
        key: Any,
        hist: Histogram,
    ) -> None:
        with self._lock:
            cache[key] = (self._clock(), list(hist))

    # ------------------------------------------------------------------
    # Operator-global histogram
    # ------------------------------------------------------------------

    def _compute_operator_global_histogram(self, user_id: UserId) -> Histogram:
        """Гистограмма по всем получателям оператора (для fallback).

        Считается ровно как recipient-гистограмма, но без фильтра по
        конкретному ``phone``: суммируем все ``incoming`` со
        ``user_id = user_id`` за 30 дней + все ``delivery_statuses``
        с положительными статусами рассылок этого оператора.
        """

        cached = self._read_cache(self._global_cache, user_id)
        if cached is not None:
            return list(cached)

        try:
            hist = self._query_operator_global_histogram(user_id)
        except Exception:
            logger.exception(
                "ActivityAnalyzer: не удалось посчитать operator-global "
                "histogram user_id=%s — возвращаю нулевую гистограмму",
                user_id,
            )
            hist = [0] * 24

        self._write_cache(self._global_cache, user_id, hist)
        return list(hist)

    # ------------------------------------------------------------------
    # SQL queries
    # ------------------------------------------------------------------

    def _query_recipient_histogram(
        self,
        user_id: UserId,
        phone: Phone,
    ) -> Histogram:
        """SELECT incoming + delivery_statuses → 24-bucket по hour-of-day.

        Используется два отдельных запроса (UNION ALL дал бы то же
        самое, но менее читаемо для развития: обе агрегации могут
        получить разные доп. фильтры в будущем). Оба возвращают
        строки ``(hour, count)``; счётчики складываются в один
        массив длины 24.
        """

        hist: Histogram = [0] * 24
        with closing(self._db_connection_factory()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT EXTRACT(HOUR FROM received_at)::int AS hour,
                           COUNT(*)::int                       AS cnt
                      FROM incoming
                     WHERE user_id = %s
                       AND sender  = %s
                       AND received_at >= NOW() - INTERVAL '%s days'
                  GROUP BY 1
                    """,
                    (user_id, phone, _AGGREGATION_WINDOW_DAYS),
                )
                for hour, cnt in cur.fetchall():
                    if 0 <= int(hour) <= 23:
                        hist[int(hour)] += int(cnt)

                cur.execute(
                    """
                    SELECT EXTRACT(HOUR FROM ds.timestamp)::int AS hour,
                           COUNT(*)::int                        AS cnt
                      FROM delivery_statuses ds
                      JOIN recipients r ON r.message_id = ds.message_id
                      JOIN broadcasts b ON b.id         = r.broadcast_id
                     WHERE b.user_id   = %s
                       AND r.phone     = %s
                       AND ds.status   = ANY(%s)
                       AND ds.timestamp >= NOW() - INTERVAL '%s days'
                  GROUP BY 1
                    """,
                    (
                        user_id,
                        phone,
                        list(_POSITIVE_DELIVERY_STATUSES),
                        _AGGREGATION_WINDOW_DAYS,
                    ),
                )
                for hour, cnt in cur.fetchall():
                    if 0 <= int(hour) <= 23:
                        hist[int(hour)] += int(cnt)
        return hist

    def _query_operator_global_histogram(self, user_id: UserId) -> Histogram:
        """То же, что :meth:`_query_recipient_histogram`, но без фильтра по phone."""

        hist: Histogram = [0] * 24
        with closing(self._db_connection_factory()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT EXTRACT(HOUR FROM received_at)::int AS hour,
                           COUNT(*)::int                       AS cnt
                      FROM incoming
                     WHERE user_id = %s
                       AND received_at >= NOW() - INTERVAL '%s days'
                  GROUP BY 1
                    """,
                    (user_id, _AGGREGATION_WINDOW_DAYS),
                )
                for hour, cnt in cur.fetchall():
                    if 0 <= int(hour) <= 23:
                        hist[int(hour)] += int(cnt)

                cur.execute(
                    """
                    SELECT EXTRACT(HOUR FROM ds.timestamp)::int AS hour,
                           COUNT(*)::int                        AS cnt
                      FROM delivery_statuses ds
                      JOIN recipients r ON r.message_id = ds.message_id
                      JOIN broadcasts b ON b.id         = r.broadcast_id
                     WHERE b.user_id    = %s
                       AND ds.status    = ANY(%s)
                       AND ds.timestamp >= NOW() - INTERVAL '%s days'
                  GROUP BY 1
                    """,
                    (
                        user_id,
                        list(_POSITIVE_DELIVERY_STATUSES),
                        _AGGREGATION_WINDOW_DAYS,
                    ),
                )
                for hour, cnt in cur.fetchall():
                    if 0 <= int(hour) <= 23:
                        hist[int(hour)] += int(cnt)
        return hist

    # ------------------------------------------------------------------
    # Pure helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_top_n(top_n: int) -> int:
        """Нормализовать ``top_n`` в диапазон ``[1, 24]``.

        Контракт Smart-Time (Requirement 2.2) разрешает ``top_n``
        в диапазоне 1..6, но публичный API ``/api/recipient-activity``
        и любые внутренние вызовы не обязаны это валидировать
        повторно. Property 7 требует non-empty список длины
        ``min(top_n, 24)``, поэтому нижнюю границу зажимаем в 1.
        """

        try:
            n = int(top_n)
        except (TypeError, ValueError):
            n = 1
        if n < 1:
            n = 1
        if n > 24:
            n = 24
        return n

    @staticmethod
    def _select_top_n(hist: Histogram, top_n: int) -> list[Hour]:
        """Top-N часов: descending count, ascending hour value (Req 2.6).

        Важно: длину ``hist`` НЕ валидируем явно — для всех вызовов
        в этом классе она ровно 24 (см. ``_build_default_fallback``,
        ``_query_*_histogram``). ``top_n`` уже нормализован вызывающим
        кодом через :meth:`_normalize_top_n`.

        Реализация: сортируем пары ``(hour, count)`` ключом
        ``(-count, hour)`` — `-count` даёт descending по count,
        `hour` даёт ascending по часу для tie-break. Это в точности
        соответствует Property 7 и pseudocode из design.md.
        """

        return [
            hour
            for hour, _cnt in sorted(
                enumerate(hist), key=lambda pair: (-pair[1], pair[0])
            )[:top_n]
        ]
