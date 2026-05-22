"""Reschedule_Operation — атомарное перепланирование рассылки.

Этот модуль реализует функцию :func:`execute` (Task 6.7 спеки
``broadcast-scheduling-suite``), описанную в design.md разделом
«Reschedule_Operation» и обоснованную Requirements 11.5 / 11.6 /
11.7 / 11.8 / 11.9.

Контракт
========

* :func:`execute` принимает ``(original_id, scheduled_for, user_id)``
  и атомарно (одна транзакция psycopg2):

  1. Берёт ``SELECT … FOR UPDATE`` на исходной строке
     ``scheduled_broadcasts`` — это блокирует параллельные
     reschedule/pause/resume на том же broadcast'е (Req 11.9).
  2. Проверяет ``status ∈ {running, paused}`` — иначе бросает
     :class:`SchedulingError` с кодом ``RESCHEDULE_INVALID_STATUS``
     и HTTP 409 (Req 11.9).
  3. Проверяет ``scheduled_for > now()`` — иначе бросает
     :class:`SchedulingError` с кодом ``RESCHEDULE_IN_PAST`` и
     HTTP 400 (Req 11.8).
  4. Снапшот pending-получателей: строки ``recipients`` со
     ``status = 'pending'`` для всех ``broadcasts.id``, связанных
     с этим ScheduledBroadcast'ом через ``operation_runs``
     (см. ниже секцию «Линковка scheduled → broadcasts»).
  5. Если pending пусто — ``original.status='cancelled'``,
     ``last_run_at=now()``, новая рассылка НЕ создаётся
     (Req 11.5). Возвращается ``RescheduleResult`` с
     ``new_broadcast_id=None``.
  6. Иначе — INSERT новой строки ``scheduled_broadcasts`` с
     ``contacts = pending_phones`` (Req 11.5),
     ``parent_broadcast_id = original.id`` (Req 11.6),
     ``follow_up_chain_id = original.follow_up_chain_id``
     (exact-value copy, no transformation — Req 11.7 / Property 21),
     ``scheduled_for = body.scheduled_for``,
     ``next_run_at = scheduled_for``, ``status='scheduled'``.
     Копирует ``message``, ``personalized_messages``,
     ``use_typing``, ``delay_seconds``, ``file_url``, ``file_name``,
     ``instance_id``, ``adaptive_throttle``, ``quiet_hours_*``,
     ``respect_recipient_tz``, ``user_tz``, а также ``schedule_type``
     и ``name`` (по design.md pseudocode).
     Original получает ``status='completed'``, ``last_run_at=now()``.
  7. ``COMMIT``. На любой error — ``ROLLBACK`` и проброс
     :class:`SchedulingError` (либо общая ``SchedulingError`` с
     кодом ``RESCHEDULE_DB_ERROR`` для непредвиденных ошибок БД).

Линковка scheduled → broadcasts
================================

В текущей схеме ``scheduled_broadcasts`` НЕ имеет прямой ссылки на
``broadcasts.id`` (running Broadcast row). Линковка идёт через
``operation_runs``:

* ``operation_runs.broadcast_id`` ссылается на ``broadcasts.id``;
* ``operation_runs.payload`` (JSONB) содержит ключ
  ``"scheduled_broadcast_id"`` — записывает ``scheduler.py`` при
  старте рассылки (см. ``BroadcastScheduler._run_broadcast``).

Поэтому SELECT pending-получателей ищет так:

    SELECT r.phone, r.status
      FROM recipients r
     WHERE r.broadcast_id IN (
              SELECT DISTINCT opr.broadcast_id
                FROM operation_runs opr
               WHERE opr.broadcast_id IS NOT NULL
                 AND opr.payload->>'scheduled_broadcast_id' = %s
                 AND opr.user_id = %s
           )

Если ни одна строка не вернулась (broadcast никогда не стартовал
worker — например, ``status='paused'`` сразу после создания), то
**все** телефоны из ``original.contacts`` считаются pending. Это
явно прописано в task-описании 6.7: «If no Broadcast exists yet
(status was 'paused' before any send), all original.contacts are
pending.» Это согласуется с Property 22: при пустом
``recipients``-наборе ``R_sent ∪ R_pending = ∅``, а партиционирование
пустого множества тривиально верно.

Если строки вернулись, но среди них нет ``status='pending'`` (все
``sent``/``failed``/``not_found``) — pending пусто → cancel
(Req 11.5(c) "if there were none").

Атомарность
============

Все операции выполняются на одном psycopg2-соединении в одной
транзакции с ``conn.autocommit = False``. ``SELECT … FOR UPDATE``
держит блокировку на исходной строке ``scheduled_broadcasts`` до
``COMMIT``. На любой исключение — ``ROLLBACK``, исходная и новая
строки остаются в исходном состоянии (Property 23: ``RESCHEDULE_IN_PAST``
не должен менять обе записи).

Тестируемость
==============

Источники недетерминизма (``DATABASE_URL``, wall-clock) инжектируются
через kwargs ``db_connection_factory`` и ``clock``. Это позволяет
unit-тестам и property-тестам подавать фейковые соединения с
рулами по подстроке SQL и фиксированный clock.

См. также
==========

* design.md, секция «Reschedule_Operation» — pseudo-код.
* requirements.md, Requirement 11.5–11.9 — формальный контракт.
* Property tests P21 (preserves follow_up_chain_id), P22 (excludes
  already-sent), P23 (rejects past) — отдельные задачи 6.8/6.9/6.10.
"""

from __future__ import annotations

import json
import os
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

from scheduling.logger import logger
from scheduling.types import SchedulingError


__all__ = [
    "RescheduleResult",
    "RESCHEDULE_VALID_STATUSES",
    "execute",
]


#: Множество статусов исходной рассылки, при которых reschedule
#: разрешён (Req 11.5/11.9). Любой другой статус — 409
#: ``RESCHEDULE_INVALID_STATUS``.
RESCHEDULE_VALID_STATUSES: frozenset[str] = frozenset({"running", "paused"})


#: Имя переменной окружения с Postgres URL — то же, что и в
#: ``scheduler.py``, ``scheduling.engine`` и других модулях пакета.
_DATABASE_URL_ENV = "DATABASE_URL"


# ---------------------------------------------------------------------------
# Result DTO
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RescheduleResult:
    """Результат :func:`execute`.

    Attributes:
        new_broadcast_id: ``id`` новой ``scheduled_broadcasts``-строки,
            или ``None`` если pending получателей не было (исходная
            переведена в ``cancelled``, новая не создавалась).
        pending_recipient_count: число pending-получателей в
            момент snapshot'а. Равно ``len(new.contacts)`` при
            ``new_broadcast_id is not None``; равно ``0`` иначе.
        original_status_after: финальный ``status`` исходной
            рассылки — ``"completed"`` (если pending был) или
            ``"cancelled"`` (если pending пусто).
    """

    new_broadcast_id: Optional[int]
    pending_recipient_count: int
    original_status_after: str


# ---------------------------------------------------------------------------
# Default DB factory
# ---------------------------------------------------------------------------


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений по умолчанию.

    Зеркальна :func:`scheduling.engine._default_db_connection_factory`
    и :func:`scheduling.auto_snooze_watcher._default_db_connection_factory`.
    Импорт ``psycopg2`` ленивый, чтобы импорт модуля оставался
    тривиальным в тестовых окружениях с инжектированной фейк-фабрикой.

    Raises:
        RuntimeError: ``DATABASE_URL`` не задан.
        ImportError:  ``psycopg2`` не установлен.
    """

    url = os.getenv(_DATABASE_URL_ENV)
    if not url:
        raise RuntimeError(
            f"{_DATABASE_URL_ENV} не задан — Reschedule_Operation не может "
            f"обратиться к Postgres"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


def _default_clock() -> datetime:
    """Текущее время в UTC. Изолировано в функцию для DI в тестах."""

    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_phone(contact: Any) -> str:
    """Извлечь номер телефона из элемента ``contacts``.

    ``contacts`` в ``scheduled_broadcasts`` — это JSONB-массив
    объектов вида ``{"phone": "...", ...}`` либо строк-телефонов.
    Используем универсальное правило (как в
    :mod:`scheduling.window_engine`, :mod:`scheduling.burst_engine`):

    * dict с ключом ``phone`` → значение этого ключа;
    * строка → сама строка;
    * любой другой тип → пустая строка (не валидируем формат —
      это задача API gateway/`PreFlight`).
    """

    if isinstance(contact, Mapping):
        value = contact.get("phone")
        return str(value).strip() if value is not None else ""
    if isinstance(contact, str):
        return contact.strip()
    return ""


def _parse_contacts_field(raw: Any) -> list[Any]:
    """Нормализовать ``scheduled_broadcasts.contacts`` в Python-список.

    psycopg2 для JSONB-колонок без RealDictCursor может вернуть
    строку — парсим её один раз здесь, чтобы не тащить эту логику в
    snapshot-цикл.
    """

    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if raw is None:
        return []
    if isinstance(raw, list):
        return list(raw)
    return []


# ---------------------------------------------------------------------------
# execute()
# ---------------------------------------------------------------------------


# SELECT-список для FOR UPDATE — все колонки, которые мы потенциально
# копируем в новую рассылку, плюс служебные (status, follow_up_chain_id,
# parent_broadcast_id, contacts). Явный список колонок (а не SELECT *)
# делает SQL устойчивым к будущим расширениям схемы и читаемым в логах.
_SELECT_ORIGINAL_FOR_UPDATE_SQL = """
    SELECT id,
           user_id,
           name,
           message,
           contacts,
           personalized_messages,
           use_typing,
           delay_seconds,
           file_url,
           file_name,
           schedule_type,
           scheduled_for,
           quiet_hours_enabled,
           quiet_hours_start,
           quiet_hours_end,
           respect_recipient_tz,
           user_tz,
           status,
           instance_id,
           adaptive_throttle,
           follow_up_chain_id
      FROM scheduled_broadcasts
     WHERE id = %s
       AND user_id = %s
       FOR UPDATE
"""


# SELECT pending recipients через operation_runs.payload->>'scheduled_broadcast_id'.
# Возвращаем все статусы (не только pending) — это нужно для отличия
# случая «broadcast никогда не стартовал» (нет строк) от «все уже
# отправлены» (есть строки, но pending=0).
_SELECT_LINKED_RECIPIENTS_SQL = """
    SELECT r.phone   AS phone,
           r.status  AS status
      FROM recipients r
     WHERE r.broadcast_id IN (
              SELECT DISTINCT opr.broadcast_id
                FROM operation_runs opr
               WHERE opr.broadcast_id IS NOT NULL
                 AND opr.user_id = %s
                 AND opr.payload::jsonb ->> 'scheduled_broadcast_id' = %s
           )
"""


# INSERT в scheduled_broadcasts с теми же колонками, что и оригинал
# (плюс parent_broadcast_id и обновлённые contacts/scheduled_for/next_run_at).
# Используем именованные плейсхолдеры через %s по позициям для
# совместимости с базовым psycopg2 cursor (без RealDictCursor).
_INSERT_NEW_SQL = """
    INSERT INTO scheduled_broadcasts (
        user_id,
        name,
        message,
        contacts,
        personalized_messages,
        use_typing,
        delay_seconds,
        file_url,
        file_name,
        schedule_type,
        scheduled_for,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        respect_recipient_tz,
        user_tz,
        status,
        next_run_at,
        instance_id,
        adaptive_throttle,
        follow_up_chain_id,
        parent_broadcast_id,
        created_at,
        updated_at
    )
    VALUES (
        %s,    -- user_id
        %s,    -- name
        %s,    -- message
        %s,    -- contacts (JSONB)
        %s,    -- personalized_messages (JSONB | NULL)
        %s,    -- use_typing
        %s,    -- delay_seconds
        %s,    -- file_url
        %s,    -- file_name
        %s,    -- schedule_type
        %s,    -- scheduled_for
        %s,    -- quiet_hours_enabled
        %s,    -- quiet_hours_start
        %s,    -- quiet_hours_end
        %s,    -- respect_recipient_tz
        %s,    -- user_tz
        'scheduled',
        %s,    -- next_run_at = scheduled_for
        %s,    -- instance_id
        %s,    -- adaptive_throttle
        %s,    -- follow_up_chain_id (exact value, may be NULL)
        %s,    -- parent_broadcast_id = original.id
        NOW(),
        NOW()
    )
    RETURNING id
"""


_UPDATE_ORIGINAL_SQL = """
    UPDATE scheduled_broadcasts
       SET status      = %s,
           last_run_at = %s,
           updated_at  = NOW()
     WHERE id = %s
"""


def execute(
    original_id: int,
    scheduled_for: datetime,
    user_id: str,
    *,
    db_connection_factory: Optional[Callable[[], Any]] = None,
    clock: Optional[Callable[[], datetime]] = None,
) -> RescheduleResult:
    """Атомарно перепланировать остаток рассылки на новую дату.

    См. docstring модуля для полного описания контракта,
    requirements (11.5–11.9) и атомарности.

    Args:
        original_id: ``id`` исходной ``scheduled_broadcasts``-строки.
        scheduled_for: новое wall-clock время старта рассылки в UTC.
            Должно быть строго ``> now()`` в ``clock`` иначе
            ``RESCHEDULE_IN_PAST`` 400.
        user_id: UUID пользователя — для ownership-проверки в
            SELECT и для фильтрации ``operation_runs``.
        db_connection_factory: фабрика psycopg2-соединений; в
            production по умолчанию читает ``DATABASE_URL``.
            Инжектируется в тестах для подмены БД.
        clock: callable без аргументов, возвращающий ``datetime`` в
            UTC. По умолчанию ``datetime.now(timezone.utc)``.
            Используется для проверки ``RESCHEDULE_IN_PAST`` и для
            ``last_run_at`` исходной рассылки.

    Returns:
        :class:`RescheduleResult`. Поле ``new_broadcast_id`` равно
        ``None`` если pending получателей не было (исходная →
        ``cancelled``, новая не создаётся).

    Raises:
        SchedulingError(``RESCHEDULE_NOT_FOUND``, http=404):
            broadcast не существует или принадлежит другому
            пользователю. Это defence-in-depth: API gateway уже
            должен проверить ownership через Supabase auth, но
            повторная проверка на уровне БД защищает от логических
            ошибок в роуте.
        SchedulingError(``RESCHEDULE_INVALID_STATUS``, http=409):
            ``status`` исходной рассылки не входит в
            :data:`RESCHEDULE_VALID_STATUSES`.
        SchedulingError(``RESCHEDULE_IN_PAST``, http=400):
            ``scheduled_for <= now()``.
        SchedulingError(``RESCHEDULE_DB_ERROR``, http=500):
            непредвиденная ошибка БД (потеря соединения,
            constraint violation, и т.п.). Транзакция откатывается.
    """

    db_factory = db_connection_factory or _default_db_connection_factory
    now_fn = clock or _default_clock

    # Валидация наивных datetime: requirement формально не требует
    # tz-aware, но scheduler.py и весь стек работают в UTC, и
    # сравнение naive vs aware бросает TypeError. Нормализуем в UTC,
    # если pohjall naive (предполагаем UTC — то же поведение, что
    # в `scheduler._compute_next_run`).
    scheduled_for_utc = _normalise_utc(scheduled_for)
    now_utc = _normalise_utc(now_fn())

    if scheduled_for_utc <= now_utc:
        raise SchedulingError(
            "RESCHEDULE_IN_PAST",
            f"scheduled_for={scheduled_for_utc.isoformat()} <= now={now_utc.isoformat()}",
            http_status=400,
        )

    conn = db_factory()
    # Гарантируем явное управление транзакцией — psycopg2 по умолчанию
    # имеет autocommit=False, но опираться на дефолт неявно опасно
    # при инжектированных фейках в тестах.
    if hasattr(conn, "autocommit"):
        try:
            conn.autocommit = False
        except (AttributeError, TypeError):
            # Фейковые соединения могут не иметь setter'а — это OK.
            pass

    try:
        with closing(conn):
            try:
                with conn.cursor() as cur:
                    # ----------------------------------------------------------
                    # 1. SELECT FOR UPDATE на исходной строке.
                    # ----------------------------------------------------------
                    cur.execute(
                        _SELECT_ORIGINAL_FOR_UPDATE_SQL,
                        (int(original_id), str(user_id)),
                    )
                    original_row = cur.fetchone()
                    if original_row is None:
                        raise SchedulingError(
                            "RESCHEDULE_NOT_FOUND",
                            f"ScheduledBroadcast id={original_id} "
                            f"not found for user_id={user_id}",
                            http_status=404,
                        )
                    original = _row_to_dict(cur, original_row)

                    # ----------------------------------------------------------
                    # 2. Status guard (Req 11.9).
                    # ----------------------------------------------------------
                    status = str(original.get("status") or "")
                    if status not in RESCHEDULE_VALID_STATUSES:
                        raise SchedulingError(
                            "RESCHEDULE_INVALID_STATUS",
                            f"status={status!r} not in {sorted(RESCHEDULE_VALID_STATUSES)}",
                            http_status=409,
                        )

                    # ----------------------------------------------------------
                    # 3. Snapshot pending recipients.
                    # ----------------------------------------------------------
                    pending_phones = _snapshot_pending_phones(
                        cur=cur,
                        scheduled_broadcast_id=int(original_id),
                        user_id=str(user_id),
                        original_contacts=original.get("contacts"),
                    )

                    # ----------------------------------------------------------
                    # 4a. No pending → cancel original, no new broadcast.
                    # ----------------------------------------------------------
                    if not pending_phones:
                        cur.execute(
                            _UPDATE_ORIGINAL_SQL,
                            ("cancelled", now_utc, int(original_id)),
                        )
                        conn.commit()
                        logger.info(
                            "Reschedule_Operation: broadcast id=%s — no pending "
                            "recipients → original status=cancelled, "
                            "no new broadcast",
                            original_id,
                        )
                        return RescheduleResult(
                            new_broadcast_id=None,
                            pending_recipient_count=0,
                            original_status_after="cancelled",
                        )

                    # ----------------------------------------------------------
                    # 4b. Pending → INSERT new + UPDATE original = completed.
                    # ----------------------------------------------------------
                    new_contacts_json = _build_new_contacts_json(pending_phones)

                    cur.execute(
                        _INSERT_NEW_SQL,
                        (
                            str(original.get("user_id")),
                            original.get("name"),
                            original.get("message") or "",
                            new_contacts_json,
                            _personalized_to_jsonb(
                                original.get("personalized_messages")
                            ),
                            bool(original.get("use_typing") or False),
                            float(original.get("delay_seconds") or 3.0),
                            original.get("file_url"),
                            original.get("file_name"),
                            str(original.get("schedule_type") or "exact"),
                            scheduled_for_utc,
                            bool(original.get("quiet_hours_enabled") or False),
                            int(original.get("quiet_hours_start") or 22),
                            int(original.get("quiet_hours_end") or 8),
                            bool(original.get("respect_recipient_tz") or False),
                            str(original.get("user_tz") or "UTC"),
                            scheduled_for_utc,  # next_run_at = scheduled_for
                            original.get("instance_id"),
                            bool(original.get("adaptive_throttle") or False),
                            # Req 11.7 / Property 21: exact-value copy
                            # (включая NULL) — без преобразований.
                            original.get("follow_up_chain_id"),
                            int(original_id),  # parent_broadcast_id
                        ),
                    )
                    inserted = cur.fetchone()
                    if inserted is None:
                        # Это не должно произойти при удачном INSERT с
                        # RETURNING id, но защищаемся.
                        raise SchedulingError(
                            "RESCHEDULE_DB_ERROR",
                            "INSERT scheduled_broadcasts RETURNING id "
                            "вернул пустой результат",
                            http_status=500,
                        )
                    new_id = _extract_returning_id(cur, inserted)

                    cur.execute(
                        _UPDATE_ORIGINAL_SQL,
                        ("completed", now_utc, int(original_id)),
                    )

                conn.commit()
                logger.info(
                    "Reschedule_Operation: broadcast id=%s → completed; "
                    "new broadcast id=%s with %d pending recipient(s); "
                    "follow_up_chain_id=%r (exact copy)",
                    original_id,
                    new_id,
                    len(pending_phones),
                    original.get("follow_up_chain_id"),
                )
                return RescheduleResult(
                    new_broadcast_id=int(new_id),
                    pending_recipient_count=len(pending_phones),
                    original_status_after="completed",
                )

            except SchedulingError:
                # Известная бизнес-ошибка — откат и проброс.
                _safe_rollback(conn)
                raise
            except Exception as exc:
                # Непредвиденная ошибка БД — откат и оборачивание в
                # SchedulingError с кодом DB_ERROR (Req: атомарность).
                _safe_rollback(conn)
                logger.exception(
                    "Reschedule_Operation: непредвиденная ошибка для "
                    "broadcast id=%s — транзакция откачена",
                    original_id,
                )
                raise SchedulingError(
                    "RESCHEDULE_DB_ERROR",
                    f"DB error during reschedule: {exc}",
                    http_status=500,
                ) from exc

    finally:
        # ``closing(conn)`` закроет соединение, но если мы вышли
        # из ``with`` через исключение и ``conn.close()`` уже
        # вызван, повторный close на closing() — no-op.
        pass


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _snapshot_pending_phones(
    *,
    cur: Any,
    scheduled_broadcast_id: int,
    user_id: str,
    original_contacts: Any,
) -> list[str]:
    """Снимок pending-получателей для исходной рассылки.

    Алгоритм:

    1. SELECT всех ``recipients`` из ``broadcasts.id``-строк, связанных
       с этим ScheduledBroadcast'ом через
       ``operation_runs.payload->>'scheduled_broadcast_id'``.
    2. Если строк нет — broadcast никогда не стартовал worker
       (типичный случай ``status='paused'`` сразу после создания);
       все телефоны из ``original.contacts`` считаются pending.
    3. Если строки есть — фильтруем по ``status='pending'``.
       Это даёт корректный ответ и для случая «уже отправили
       часть» (Property 22: intersection с sent пуста), и для
       случая «все уже обработаны» (pending=[] → cancel).

    Возвращает список нормализованных телефонов в порядке:
    1) сначала — те, что попали в recipients (порядок SELECT);
    2) если фолбэк на original.contacts — порядок original.

    Дедупликация по нормализованному телефону: одинаковые номера
    не попадают в новый ``contacts`` дважды (фактически recipients
    уже unique по (broadcast_id, phone) в нашей бизнес-логике, но
    защитный гард не вреден).

    Args:
        cur: текущий psycopg2 cursor (внутри транзакции).
        scheduled_broadcast_id: id исходной строки.
        user_id: UUID пользователя — для ownership-проверки в
            SELECT operation_runs.
        original_contacts: значение колонки ``contacts`` из
            ``scheduled_broadcasts`` исходной строки (JSONB-массив
            или его строковое представление).

    Returns:
        Список телефонов (str) с дедупликацией.
    """

    cur.execute(
        _SELECT_LINKED_RECIPIENTS_SQL,
        (str(user_id), str(scheduled_broadcast_id)),
    )
    recipient_rows = list(cur.fetchall() or [])

    if not recipient_rows:
        # Broadcast никогда не стартовал worker (status='paused'
        # сразу после create) — все original.contacts pending.
        return _phones_from_contacts(original_contacts)

    pending_phones: list[str] = []
    seen: set[str] = set()
    for row in recipient_rows:
        row_dict = _row_to_dict_or_none(cur, row)
        if row_dict is None:
            continue
        status = str(row_dict.get("status") or "").strip().lower()
        if status != "pending":
            continue
        phone = str(row_dict.get("phone") or "").strip()
        if not phone or phone in seen:
            continue
        seen.add(phone)
        pending_phones.append(phone)
    return pending_phones


def _phones_from_contacts(raw_contacts: Any) -> list[str]:
    """Извлечь дедуплицированный список телефонов из ``contacts``-JSONB."""

    contacts = _parse_contacts_field(raw_contacts)
    phones: list[str] = []
    seen: set[str] = set()
    for c in contacts:
        phone = _extract_phone(c)
        if not phone or phone in seen:
            continue
        seen.add(phone)
        phones.append(phone)
    return phones


def _build_new_contacts_json(phones: list[str]) -> str:
    """Построить JSON-строку для колонки ``contacts`` новой рассылки.

    Формат — список объектов ``{"phone": "..."}``, совместимый с
    остальным backend (см. :mod:`scheduling.window_engine`,
    :mod:`scheduling.burst_engine` — они тоже принимают этот формат).
    Сериализуем в строку через ``json.dumps`` — psycopg2 принимает
    JSON-строку для JSONB-колонок без отдельного adapter'а.

    ``ensure_ascii=False`` — кириллица и другие non-ASCII символы
    в payload не экранируются (хотя для номеров телефонов это
    обычно не нужно).
    """

    payload = [{"phone": p} for p in phones]
    return json.dumps(payload, ensure_ascii=False)


def _personalized_to_jsonb(value: Any) -> Optional[str]:
    """Подготовить ``personalized_messages`` для INSERT.

    Колонка ``personalized_messages`` — JSONB nullable. На входе
    может быть:

    * ``None`` → передаём ``NULL``;
    * dict → сериализуем в JSON-строку;
    * строка (если psycopg2 уже отдал JSONB как str) → пробуем
      распарсить и заново сериализовать (защита от double-encoding);
      при невалидном JSON — передаём как есть.
    """

    if value is None:
        return None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            # Не валидный JSON — записываем как есть, БД сама
            # отвергнет (или сохранит как строку, если колонка text).
            return value
        return json.dumps(parsed, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False)


def _normalise_utc(value: datetime) -> datetime:
    """Привести datetime к tz-aware UTC.

    Naive datetime интерпретируется как UTC (то же поведение, что в
    ``scheduler._compute_next_run`` и большинстве модулей пакета).
    """

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _row_to_dict(cur: Any, row: Any) -> dict[str, Any]:
    """Конверсия psycopg2-row в dict с учётом cursor type.

    ``RealDictCursor`` отдаёт dict-row напрямую — возвращаем его.
    Обычный cursor отдаёт tuple — мапим через ``cur.description``.
    Тестовые фейк-курсоры могут отдавать любой из вариантов,
    поэтому проверяем оба.
    """

    if isinstance(row, Mapping):
        return dict(row)
    description = getattr(cur, "description", None) or []
    keys = [d[0] for d in description]
    if not keys:
        return {}
    return dict(zip(keys, list(row)))


def _row_to_dict_or_none(cur: Any, row: Any) -> Optional[dict[str, Any]]:
    """Безопасный wrapper :func:`_row_to_dict` — None при пустых данных."""

    try:
        result = _row_to_dict(cur, row)
    except Exception:
        return None
    return result or None


def _extract_returning_id(cur: Any, row: Any) -> int:
    """Извлечь ``id`` из RETURNING-row (RealDictCursor или tuple)."""

    if isinstance(row, Mapping):
        value = row.get("id")
    else:
        # tuple/list — первая колонка из RETURNING id.
        try:
            value = row[0]
        except (IndexError, TypeError):
            value = None
    if value is None:
        raise SchedulingError(
            "RESCHEDULE_DB_ERROR",
            "INSERT … RETURNING id вернул NULL",
            http_status=500,
        )
    return int(value)


def _safe_rollback(conn: Any) -> None:
    """Best-effort rollback. Логируем, но не пробрасываем ошибку
    rollback'а — основное исключение уже на пути наверх."""

    try:
        conn.rollback()
    except Exception:
        logger.exception(
            "Reschedule_Operation: ошибка rollback — игнорируем, "
            "основное исключение пробрасывается выше"
        )
