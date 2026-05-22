"""ABTimeEngine — стратегия расписания режима ``schedule_type='ab_time'``.

Покрывает Requirements 3.3 / 3.4 / 3.5 / 3.6 / 3.8 спеки
``broadcast-scheduling-suite`` и design.md (секция
"Components and Interfaces → ABTimeEngine").

Что делает
==========

* :meth:`ABTimeEngine.distribute` — для рассылки в режиме
  ``ab_time`` берёт связанный ``ABTimeTest`` (через
  ``scheduled_broadcast_id = broadcast.id``), детерминированно
  делит получателей на ``len(test.slots)`` групп с разницей
  размеров не более 1 (Property 9, Req 3.3) и формирует
  ``ScheduledSend`` с ``send_at`` равным ``hour:00`` в дне
  ``broadcast.scheduled_for`` (в ``broadcast.user_tz``)
  для каждого слота. Параллельно атомарно записывает каждое
  назначение в ``ab_time_test_recipients`` через upsert
  ``ON CONFLICT (ab_time_test_id, phone) DO UPDATE``
  (Req 3.4 — single-source-of-truth для назначения).
* :meth:`ABTimeEngine.compute_winner` — после завершения теста
  агрегирует ``DeliveryStatus`` + ``Incoming`` per slot и
  выбирает «выигравший» слот по правилу: max ``reply_pct`` →
  ties max ``read_pct`` → ties min hour value (Req 3.5).
  Возвращает ``None`` если тест ещё в ``running``/``waiting``
  (Req 3.6 / Property 10 предусловие).

Чистота distribute
==================

В отличие от ``WindowEngine`` и ``BurstEngine``, ``distribute``
у этой стратегии имеет один контролируемый side-effect — upsert
в ``ab_time_test_recipients``. Это сознательное решение из
design.md (см. псевдокод ``ABTimeEngine.distribute`` —
``ABTimeTestRecipient.upsert(test.id, phone, hour)``): без
синхронной записи назначения PreFlight Preview покажет одно
распределение, а реальная отправка — другое (если seed одинаков,
группы совпадут — но мы не хотим полагаться на это для
доставки метрик).

Детерминизм при том же ``broadcast.id`` гарантирован
:func:`_deterministic_split` (Fisher-Yates с ``mulberry32(seed)``);
повторный вызов ``distribute`` для одной и той же рассылки
производит идентичные группы и upsert (idempotent через
ON CONFLICT) — это удовлетворяет Property 9.

Источники данных compute_winner
================================

* ``ab_time_test_recipients(ab_time_test_id, phone, slot_hour, sent_at)``
  — таблица назначений: какой получатель попал в какой слот.
* ``recipients(broadcast_id, phone, message_id)`` — мост от phone
  к message_id в исходной рассылке.
* ``delivery_statuses(message_id, status)`` — статусы доставки;
  ``delivered`` считается как ``status ∈ {delivered, sent, read,
  played, viewed}``, ``read`` — ``status ∈ {read, played, viewed}``.
* ``incoming(sender, user_id, received_at)`` — входящие сообщения;
  ``replied`` — есть хотя бы одна запись с ``sender = phone``
  пользователя в окне ``[sent_at, sent_at + wait_hours]``.

Ошибки и устойчивость
=====================

* ``ABTimeTest`` не найден для ``broadcast.id`` →
  :class:`SchedulingError` с кодом ``"ABTIME_TEST_NOT_FOUND"``
  и HTTP 404. Эта ошибка ловится диспетчером и логируется без
  падения tick'а (см. ``ScheduleModeEngine.dispatch_due``).
* ``slots`` пустой / некорректный shape →
  ``"ABTIME_SLOTS_INVALID"`` с HTTP 400. Соответствует Req 3.2.
* ``broadcast.scheduled_for`` отсутствует — fallback на
  ``datetime.now(UTC)`` (как в TS preflight), чтобы PreFlight
  Preview всё равно отрисовал расписание; реальный pipeline
  при INSERT валидирует ``scheduled_for`` отдельно.
* DB-соединение упало во время upsert → ``SchedulingError``
  с кодом ``"ABTIME_DB_ERROR"``. Диспетчер залогирует и
  не уронит остальные рассылки.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional, Sequence

from scheduling.engine import BroadcastRow
from scheduling.logger import logger
from scheduling.preflight_calc import (
    _deterministic_split,
    _safe_zoneinfo,
    _zoned_parts,
    _zoned_to_utc,
    dedupe_phones,
)
from scheduling.types import Hour, ScheduledSend, SchedulingError


__all__ = ["ABTimeEngine"]


#: Статусы доставки, считающиеся «delivered» для расчёта delivery_pct.
#: Включают и положительные подтверждения (delivered/sent), и
#: «прочитано»-подобные — потому что прочитанное сообщение неявно
#: было доставлено (Req 3.5 не вводит другой семантики).
_DELIVERED_STATUSES: tuple[str, ...] = (
    "delivered",
    "sent",
    "read",
    "played",
    "viewed",
)

#: Статусы, считающиеся «read» (для расчёта read_pct).
_READ_STATUSES: tuple[str, ...] = ("read", "played", "viewed")


# ---------------------------------------------------------------------------
# Default DB factory (mirror of engine.py / activity_analyzer.py)
# ---------------------------------------------------------------------------


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений по умолчанию.

    Зеркало :func:`scheduling.engine._default_db_connection_factory` —
    та же стратегия lazy-import psycopg2, чтобы импорт модуля не
    падал в окружениях без psycopg2 (unit-тесты с инжектированной
    фабрикой).
    """

    import os

    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL не задан — ABTimeEngine не может обратиться к Postgres"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class ABTimeEngine:
    """Стратегия распределения для режима ``ab_time``.

    Args:
        activity_analyzer: инстанс :class:`ActivityAnalyzer`. На
            текущем этапе ``ABTimeEngine`` НЕ использует analyzer
            (Req 3.4 — все получатели в слот-группе шлются в
            тот же фиксированный час; smart-time уже отдельный
            режим). Параметр сохранён в подписи для совместимости
            с design.md (см. ``ABTimeEngine(activity_analyzer)``)
            и для будущего расширения (например, post-test learning).
        db_connection_factory: фабрика psycopg2-соединений; по
            умолчанию читается ``DATABASE_URL``. В тестах инжектится
            фейковая фабрика.
    """

    def __init__(
        self,
        activity_analyzer: Any = None,
        *,
        db_connection_factory: Optional[Callable[[], Any]] = None,
    ) -> None:
        # Сохраняем activity_analyzer для совместимости с
        # design.md-сигнатурой; на текущем этапе он не используется.
        self._activity_analyzer = activity_analyzer
        self._db_connection_factory: Callable[[], Any] = (
            db_connection_factory or _default_db_connection_factory
        )

    # ------------------------------------------------------------------
    # distribute
    # ------------------------------------------------------------------

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: Any,  # unused for ab_time — kept for Protocol compatibility
        exceptions: Sequence[Any],  # unused — slot hours are fixed
    ) -> list[ScheduledSend]:
        """Раcпределить получателей по слотам теста.

        Возвращает список ``ScheduledSend`` длиной
        ``len(broadcast.contacts)`` (после дедупликации). Параллельно
        делает upsert каждого назначения в ``ab_time_test_recipients``.

        Validates: Requirements 3.3, 3.4, 3.8.

        Raises:
            SchedulingError: ``ABTIME_TEST_NOT_FOUND`` (404) если для
                ``broadcast.id`` нет ``ABTimeTest``;
                ``ABTIME_SLOTS_INVALID`` (400) если ``slots`` имеет
                неверный shape;
                ``ABTIME_DB_ERROR`` (500) при ошибке записи upsert.
        """

        phones = dedupe_phones(broadcast.contacts or [])
        if not phones:
            return []

        # 1. Загрузить ABTimeTest по scheduled_broadcast_id.
        test = self._load_test_by_broadcast(broadcast.id)
        if test is None:
            raise SchedulingError(
                "ABTIME_TEST_NOT_FOUND",
                f"ABTimeTest для broadcast id={broadcast.id} не найден",
                http_status=404,
            )

        slots = self._normalize_slots(test.get("slots"))

        # 2. Anchor-день: ``broadcast.scheduled_for`` в user_tz.
        anchor = broadcast.scheduled_for or datetime.now(timezone.utc)
        if anchor.tzinfo is None:
            anchor = anchor.replace(tzinfo=timezone.utc)
        user_tz = _safe_zoneinfo(broadcast.user_tz or "UTC")
        anchor_parts = _zoned_parts(anchor, user_tz)

        # 3. Детерминированный split (seed = broadcast.id) →
        #    max-min <= 1 (Property 9).
        groups = _deterministic_split(phones, len(slots), seed=int(broadcast.id))

        # 4. Сформировать sends + накопить рядки для upsert.
        test_id = int(test["id"])
        sends: list[ScheduledSend] = []
        upsert_rows: list[tuple[int, str, int]] = []
        for slot_idx, hour in enumerate(slots):
            send_at = _zoned_to_utc(
                anchor_parts["year"],
                anchor_parts["month"],
                anchor_parts["day"],
                int(hour),
                0,
                0,
                user_tz,
            )
            for phone in groups[slot_idx]:
                sends.append(
                    ScheduledSend(
                        phone=phone,
                        send_at=send_at,
                        metadata={"slot": int(hour)},
                    )
                )
                upsert_rows.append((test_id, phone, int(hour)))

        # 5. Upsert ABTimeTestRecipient. Идемпотентно — повторный
        #    distribute для того же broadcast.id переписывает slot_hour
        #    (но не сбрасывает delivered/read/replied/sent_at — они
        #    обновляются worker'ом и не должны теряться при re-run).
        try:
            self._upsert_recipients(upsert_rows)
        except SchedulingError:
            raise
        except Exception as exc:
            logger.exception(
                "ABTimeEngine.distribute: ошибка upsert ab_time_test_recipients "
                "для test_id=%s broadcast_id=%s",
                test_id,
                broadcast.id,
            )
            raise SchedulingError(
                "ABTIME_DB_ERROR",
                f"Ошибка записи ab_time_test_recipients: {exc}",
                http_status=500,
            ) from exc

        return sends

    # ------------------------------------------------------------------
    # compute_winner
    # ------------------------------------------------------------------

    def compute_winner(self, test_id: int) -> Optional[Hour]:
        """Выбрать выигравший слот теста.

        Returns:
            Hour (0..23) — час с максимальным reply_pct (ties по
            max read_pct, ties по min hour).
            ``None`` — если тест ещё в статусе ``running`` или
            ``waiting`` (winner ещё не известен; Req 3.6).

        Validates: Requirement 3.5, 3.6.

        Notes:
            * Метод НЕ устанавливает ``ABTimeTest.winner_slot`` и
              НЕ переводит status в ``completed`` — это делает
              ``AB_Time_Test_Coordinator`` (отдельный компонент,
              задача за пределами 4.7). Здесь — pure-функция выбора.
            * Если у теста ноль recipient-ов хотя бы в одном слоте —
              этот слот участвует в выборе с pcts=0 (а не пропускается),
              чтобы tie-break по hour value был определённым.
            * Если в test.slots нет ни одного валидного часа,
              возвращаем ``None`` (защита от corrupt-row).
        """

        test = self._load_test_by_id(test_id)
        if test is None:
            return None

        status = str(test.get("status") or "").lower()
        if status in ("running", "waiting"):
            # Req 3.6: пока test не finished, winner не известен.
            return None

        slots = self._normalize_slots(test.get("slots"), strict=False)
        if not slots:
            return None

        broadcast_id = int(test["scheduled_broadcast_id"])
        user_id = str(test["user_id"])
        wait_hours = int(test.get("wait_hours") or 24)

        metrics = self._aggregate_slot_metrics(
            test_id=test_id,
            broadcast_id=broadcast_id,
            user_id=user_id,
            wait_hours=wait_hours,
        )

        # Tie-break: max reply_pct → max read_pct → min hour.
        # Используем сортировку с ключом (-reply, -read, hour).
        scored: list[tuple[Hour, float, float, float]] = []
        for hour in slots:
            m = metrics.get(int(hour), {"total": 0, "delivered": 0, "read": 0, "replied": 0})
            total = int(m["total"] or 0)
            if total <= 0:
                delivery_pct = 0.0
                read_pct = 0.0
                reply_pct = 0.0
            else:
                delivery_pct = float(m["delivered"]) / total
                read_pct = float(m["read"]) / total
                reply_pct = float(m["replied"]) / total
            scored.append((int(hour), delivery_pct, read_pct, reply_pct))

        scored.sort(key=lambda t: (-t[3], -t[2], t[0]))
        return scored[0][0]

    # ------------------------------------------------------------------
    # Internals — DB queries
    # ------------------------------------------------------------------

    def _load_test_by_broadcast(
        self, broadcast_id: int
    ) -> Optional[Mapping[str, Any]]:
        """SELECT первый ABTimeTest для broadcast_id.

        Возвращает dict-row или ``None``. Если по какой-то причине
        для одного broadcast_id нашлось несколько записей (теоретически
        невозможно — ``ab_time_tests`` не имеет UNIQUE на это поле,
        но Req 3.10 запрещает), берётся самая свежая по ``started_at``.
        """

        rows = self._select_dicts(
            """
            SELECT id, user_id, scheduled_broadcast_id, slots, winner_slot,
                   wait_hours, status, started_at, completed_at
              FROM ab_time_tests
             WHERE scheduled_broadcast_id = %s
          ORDER BY started_at DESC
             LIMIT 1
            """,
            (int(broadcast_id),),
        )
        return rows[0] if rows else None

    def _load_test_by_id(self, test_id: int) -> Optional[Mapping[str, Any]]:
        """SELECT ABTimeTest по id."""

        rows = self._select_dicts(
            """
            SELECT id, user_id, scheduled_broadcast_id, slots, winner_slot,
                   wait_hours, status, started_at, completed_at
              FROM ab_time_tests
             WHERE id = %s
             LIMIT 1
            """,
            (int(test_id),),
        )
        return rows[0] if rows else None

    def _upsert_recipients(
        self, rows: Sequence[tuple[int, str, int]]
    ) -> None:
        """UPSERT в ab_time_test_recipients (id, phone, slot_hour).

        Использует ``ON CONFLICT (ab_time_test_id, phone) DO UPDATE``,
        чтобы повторный вызов :meth:`distribute` для того же broadcast
        переписал slot_hour, но не затёр статусы delivered/read/replied
        и sent_at (они обновляются worker'ом отдельно).

        Делает один batch-INSERT через ``executemany`` — это простой
        и портируемый путь; на больших списках ``execute_values`` дал
        бы выигрыш по latency, но на типовых 100..1000 контактов
        executemany достаточно.
        """

        if not rows:
            return
        sql = """
            INSERT INTO ab_time_test_recipients (ab_time_test_id, phone, slot_hour)
            VALUES (%s, %s, %s)
            ON CONFLICT (ab_time_test_id, phone) DO UPDATE
               SET slot_hour = EXCLUDED.slot_hour
        """
        with closing(self._db_connection_factory()) as conn:
            with conn.cursor() as cur:
                cur.executemany(sql, list(rows))
            commit = getattr(conn, "commit", None)
            if callable(commit):
                commit()

    def _aggregate_slot_metrics(
        self,
        *,
        test_id: int,
        broadcast_id: int,
        user_id: str,
        wait_hours: int,
    ) -> dict[int, dict[str, int]]:
        """Per-slot aggregation для compute_winner.

        Возвращает словарь
        ``{slot_hour: {"total", "delivered", "read", "replied"}}``.

        Реализация — три SQL-запроса:

        1. **total per slot** — COUNT из ``ab_time_test_recipients``;
        2. **delivered + read** — JOIN ``ab_time_test_recipients`` →
           ``recipients`` (по broadcast_id + phone) → ``delivery_statuses``
           (по message_id). Если у получателя нет ``message_id``
           (NULL) — он не считается delivered (это согласуется с
           Req 3.5 — мы аггрегируем DeliveryStatus, а не assumption);
        3. **replied** — JOIN ``ab_time_test_recipients`` → ``incoming``
           по ``sender = phone AND user_id = test.user_id``, в окне
           ``[sent_at, sent_at + wait_hours]``. ``DISTINCT phone``,
           чтобы 5 ответных сообщений от одного получателя считались
           как 1 reply.

        Все три запроса делаются в одном connection через одну
        транзакцию для read consistency.
        """

        metrics: dict[int, dict[str, int]] = {}

        with closing(self._db_connection_factory()) as conn:
            with conn.cursor() as cur:
                # 1) total per slot
                cur.execute(
                    """
                    SELECT slot_hour, COUNT(*) AS total
                      FROM ab_time_test_recipients
                     WHERE ab_time_test_id = %s
                  GROUP BY slot_hour
                    """,
                    (int(test_id),),
                )
                for row in cur.fetchall():
                    slot, total = self._row_pair(row, "slot_hour", "total")
                    self._ensure_slot(metrics, int(slot))
                    metrics[int(slot)]["total"] = int(total)

                # 2) delivered + read per slot (JOIN delivery_statuses)
                cur.execute(
                    """
                    SELECT atr.slot_hour, ds.status, COUNT(*) AS cnt
                      FROM ab_time_test_recipients atr
                      JOIN recipients r ON r.broadcast_id = %s AND r.phone = atr.phone
                      JOIN delivery_statuses ds ON ds.message_id = r.message_id
                     WHERE atr.ab_time_test_id = %s
                  GROUP BY atr.slot_hour, ds.status
                    """,
                    (int(broadcast_id), int(test_id)),
                )
                for row in cur.fetchall():
                    slot, status, cnt = self._row_triple(
                        row, "slot_hour", "status", "cnt"
                    )
                    slot_int = int(slot)
                    self._ensure_slot(metrics, slot_int)
                    status_str = str(status or "").lower()
                    cnt_int = int(cnt or 0)
                    if status_str in _DELIVERED_STATUSES:
                        metrics[slot_int]["delivered"] += cnt_int
                    if status_str in _READ_STATUSES:
                        metrics[slot_int]["read"] += cnt_int

                # 3) replied per slot (JOIN incoming, by phone match)
                cur.execute(
                    """
                    SELECT atr.slot_hour,
                           COUNT(DISTINCT atr.phone) AS replied
                      FROM ab_time_test_recipients atr
                      JOIN incoming inc
                        ON inc.sender = atr.phone
                       AND inc.user_id = %s
                       AND atr.sent_at IS NOT NULL
                       AND inc.received_at >= atr.sent_at
                       AND inc.received_at <= atr.sent_at + (%s * INTERVAL '1 hour')
                     WHERE atr.ab_time_test_id = %s
                  GROUP BY atr.slot_hour
                    """,
                    (str(user_id), int(wait_hours), int(test_id)),
                )
                for row in cur.fetchall():
                    slot, replied = self._row_pair(row, "slot_hour", "replied")
                    self._ensure_slot(metrics, int(slot))
                    metrics[int(slot)]["replied"] = int(replied or 0)

        return metrics

    # ------------------------------------------------------------------
    # SQL helpers
    # ------------------------------------------------------------------

    def _select_dicts(
        self, sql: str, params: tuple
    ) -> list[Mapping[str, Any]]:
        """SELECT, возвращающий список dict-rows. Зеркало engine.py.

        Использует ``RealDictCursor`` если psycopg2 доступен; в тестах
        инжектированная фабрика возвращает любые объекты — главное,
        чтобы они отдавали dict-like rows из ``fetchall()``.
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        out: list[Mapping[str, Any]] = []
        with closing(self._db_connection_factory()) as conn:
            if psycopg2_extras is not None:
                try:
                    cur_ctx = conn.cursor(
                        cursor_factory=psycopg2_extras.RealDictCursor
                    )
                except TypeError:
                    # Тестовый stub-conn может не поддерживать kwargs.
                    cur_ctx = conn.cursor()
            else:
                cur_ctx = conn.cursor()
            with cur_ctx as cur:
                cur.execute(sql, params)
                for row in cur.fetchall():
                    out.append(self._row_to_mapping(row, cur))
        return out

    @staticmethod
    def _row_to_mapping(
        row: Any, cur: Any
    ) -> Mapping[str, Any]:
        """Привести строку к dict.

        Поддерживает три случая:
        * RealDictRow / dict — возвращаем как есть;
        * tuple + ``cur.description`` — собираем dict по колонкам;
        * иначе — оборачиваем в ``{"_raw": row}`` (тесты должны
          передавать dict-rows; этот fallback просто чтобы не
          уронить production на сюрпризах).
        """

        if isinstance(row, Mapping):
            return dict(row)
        description = getattr(cur, "description", None)
        if description:
            cols = [d[0] for d in description]
            if isinstance(row, (list, tuple)) and len(row) == len(cols):
                return {col: val for col, val in zip(cols, row)}
        return {"_raw": row}

    @staticmethod
    def _row_pair(
        row: Any, k1: str, k2: str
    ) -> tuple[Any, Any]:
        """Извлечь пару значений из строки (dict или tuple)."""

        if isinstance(row, Mapping):
            return row[k1], row[k2]
        if isinstance(row, (list, tuple)) and len(row) >= 2:
            return row[0], row[1]
        raise TypeError(f"unexpected row shape: {type(row).__name__}")

    @staticmethod
    def _row_triple(
        row: Any, k1: str, k2: str, k3: str
    ) -> tuple[Any, Any, Any]:
        """Извлечь тройку значений из строки (dict или tuple)."""

        if isinstance(row, Mapping):
            return row[k1], row[k2], row[k3]
        if isinstance(row, (list, tuple)) and len(row) >= 3:
            return row[0], row[1], row[2]
        raise TypeError(f"unexpected row shape: {type(row).__name__}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_slots(
        raw: Any, *, strict: bool = True
    ) -> list[Hour]:
        """Распарсить ``slots`` из БД-строки в список часов 0..23.

        ``raw`` может прийти как:
        * ``list[int]`` — уже разобранный JSONB;
        * ``str`` — если RealDictCursor не разобрал;
        * ``None`` или мусор — обрабатываем graceful.

        При ``strict=True`` (default — для distribute):
        пустой / некорректный shape → ``SchedulingError(ABTIME_SLOTS_INVALID)``.

        При ``strict=False`` (для compute_winner) — возвращаем пустой
        список, что приведёт к ``None`` winner — менее агрессивная
        реакция на «странные» данные read-side.

        Validates: Requirement 3.2 (валидация slots на 2..4 distinct
        hours делается на API-роутном слое; здесь только базовая
        sanity-check).
        """

        if isinstance(raw, str):
            import json
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                raw = None

        if not isinstance(raw, (list, tuple)):
            if strict:
                raise SchedulingError(
                    "ABTIME_SLOTS_INVALID",
                    f"ABTimeTest.slots должен быть списком, получен {type(raw).__name__}",
                    http_status=400,
                )
            return []

        slots: list[Hour] = []
        for s in raw:
            try:
                h = int(s)
            except (TypeError, ValueError):
                if strict:
                    raise SchedulingError(
                        "ABTIME_SLOTS_INVALID",
                        f"ABTimeTest.slots содержит не-целое значение {s!r}",
                        http_status=400,
                    )
                return []
            if h < 0 or h > 23:
                if strict:
                    raise SchedulingError(
                        "ABTIME_SLOTS_INVALID",
                        f"ABTimeTest.slots: час {h} вне диапазона 0..23",
                        http_status=400,
                    )
                return []
            slots.append(h)

        if not slots:
            if strict:
                raise SchedulingError(
                    "ABTIME_SLOTS_INVALID",
                    "ABTimeTest.slots пуст",
                    http_status=400,
                )
            return []

        return slots

    @staticmethod
    def _ensure_slot(
        metrics: dict[int, dict[str, int]], slot: int
    ) -> None:
        """Гарантировать наличие записи slot в metrics с нулями.

        Используется на каждом проходе SQL, чтобы агрегации не
        падали на missing-key и любой слот, по которому пришли
        строки, имел хотя бы нулевую запись.
        """

        if slot not in metrics:
            metrics[slot] = {
                "total": 0,
                "delivered": 0,
                "read": 0,
                "replied": 0,
            }
