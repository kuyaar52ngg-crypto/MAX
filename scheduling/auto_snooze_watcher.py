"""Auto_Snooze_Watcher — фоновый поток автопаузы рассылки при инцидентах.

Этот модуль реализует Requirement 9 (`Auto-Snooze on Incident`): при
накоплении инцидентов 429 / zero_response / watchdog_trigger /
throttle_paused в пределах окна ``auto_snooze_window_minutes``
рассылка ставится на паузу на ``auto_snooze_minutes`` минут.
Эскалация: после > 3 авто-снузов — ``status='failed'`` навсегда
(Req 9.6).

Архитектура (см. design.md → Components/Interfaces → ``Auto_Snooze_Watcher``)
================================================================================

* ``Auto_Snooze_Watcher`` живёт **отдельным daemon-thread** рядом с
  существующим ``BroadcastScheduler`` и ``Watchdog``. Тик —
  30 секунд (Req 9.2 не уточняет частоту, 30s — компромисс между
  отзывчивостью и нагрузкой на БД).
* На каждом тике: SELECT ``scheduled_broadcasts`` WHERE
  ``status='running'`` AND ``auto_snooze_enabled=true``, joined к
  последнему running ``operation_runs`` (для получения
  ``operation_run_id``).
* Для каждой строки — :meth:`_count_incidents` со **строгой
  фильтрацией только по своему ``operation_run_id``** (Req 9.8;
  property P17). Считаются только kinds
  ``{rate_limit_429, zero_response, watchdog_trigger, throttle_paused}``
  (Req 9.2) в окне ``[now() - window_minutes; now()]``.
* Если ``count >= auto_snooze_threshold`` — транзакционно бампим
  ``auto_snooze_count``, ставим ``status=paused`` с
  ``next_run_at = now() + auto_snooze_minutes*60`` (Req 9.3) ИЛИ
  при ``> 3`` — ``status=failed`` с
  ``last_error='AUTO_SNOOZE_REPEATED'`` (Req 9.6).

Best-effort Notification dispatch (Req 9.5)
============================================

Создание ``Notification`` (kind=``auto_snoozed`` или ``failed``)
вынесено **за пределы транзакции** обновления broadcast'а. Любая
ошибка дальше (сборка ``preference_snapshot``, INSERT в
``notifications``) **НЕ откатывает** уже применённую паузу: защита
рассылки приоритетнее, чем гарантия доставки уведомления (Req 9.5).
Сам ретрай уведомления — задача ``Notification_Dispatcher`` (Req 10.11).

Property-tests (P17, P18)
==========================

* P17 (Req 9.8): mixed ``IncidentLog`` records → count == ровно
  записей с совпадающим ``operation_run_id`` AND правильным kind
  AND в окне.
* P18 (Req 9.6): после 4-го triggering события переход в
  ``status=failed`` необратим.

DI и тестируемость
==================

Все источники недетерминизма (``time.time``, фабрика psycopg2,
``threading.Event``) инжектируются через конструктор: тесты могут
быстро прокручивать сотни тиков без реальных пауз (см. паттерн
из ``anti_ban/watchdog.py``). Параллельно с DI-фабрикой можно
инжектировать ``audit_logger``-подобный объект для best-effort
notification ops, но в первой реализации мы пишем ``notifications``
напрямую через ту же DB-фабрику для простоты.
"""

from __future__ import annotations

import json
import os
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Optional

from scheduling.logger import logger


__all__ = [
    "AutoSnoozeWatcher",
    "AutoSnoozeContext",
    "AUTO_SNOOZE_INCIDENT_KINDS",
    "AUTO_SNOOZE_MAX_BEFORE_FAIL",
]


#: Множество incident.kind, которые учитываются при подсчёте
#: (Req 9.2). Любой другой kind игнорируется, даже если он
#: относится к тому же ``operation_run_id``.
AUTO_SNOOZE_INCIDENT_KINDS: frozenset[str] = frozenset(
    {
        "rate_limit_429",
        "zero_response",
        "watchdog_trigger",
        "throttle_paused",
    }
)


#: Максимальное число авто-снузов в одной операции. Пятый бамп
#: (``auto_snooze_count`` после ``+= 1`` становится больше 3) —
#: эскалация в ``failed`` (Req 9.6, property P18).
AUTO_SNOOZE_MAX_BEFORE_FAIL: int = 3


#: Имя переменной окружения с Postgres URL — то же, что и в
#: ``scheduler.py``, ``scheduling.engine`` и ``scheduling.activity_analyzer``.
_DATABASE_URL_ENV = "DATABASE_URL"


#: Период polling-а Auto_Snooze_Watcher, в секундах. 30s выбраны
#: как компромисс между отзывчивостью реакции на инциденты
#: (Adaptive_Throttle уже обрабатывает микро-уровень за секунды) и
#: нагрузкой на БД. См. design.md, "Потоковая модель Flask backend".
DEFAULT_POLL_INTERVAL_SECONDS: float = 30.0


# ---------------------------------------------------------------------------
# Lightweight DTO
# ---------------------------------------------------------------------------


class AutoSnoozeContext:
    """Снимок одной строки SELECT-запроса для удобной передачи в логику.

    Использует обычные атрибуты вместо frozen-dataclass — нам не
    нужна иммутабельность, и иногда удобно дозаполнять поля
    (например, ``operation_run_id`` отдельным запросом, если не
    приехал в JOIN). Эта структура **не предназначена** для long-lived
    хранения; её время жизни — один тик watcher'а.
    """

    __slots__ = (
        "broadcast_id",
        "user_id",
        "operation_run_id",
        "auto_snooze_count",
        "auto_snooze_threshold",
        "auto_snooze_minutes",
        "auto_snooze_window_minutes",
    )

    def __init__(
        self,
        *,
        broadcast_id: int,
        user_id: str,
        operation_run_id: Optional[int],
        auto_snooze_count: int,
        auto_snooze_threshold: int,
        auto_snooze_minutes: int,
        auto_snooze_window_minutes: int,
    ) -> None:
        self.broadcast_id = broadcast_id
        self.user_id = user_id
        self.operation_run_id = operation_run_id
        self.auto_snooze_count = auto_snooze_count
        self.auto_snooze_threshold = auto_snooze_threshold
        self.auto_snooze_minutes = auto_snooze_minutes
        self.auto_snooze_window_minutes = auto_snooze_window_minutes


# ---------------------------------------------------------------------------
# Default DB factory
# ---------------------------------------------------------------------------


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений по умолчанию.

    Зеркальна :func:`scheduling.engine._default_db_connection_factory`.
    Импорт ``psycopg2`` ленивый — это позволяет импортировать
    модуль в тестах с инжектированной фейк-фабрикой, без
    psycopg2 в окружении.

    Raises:
        RuntimeError: ``DATABASE_URL`` не задан.
        ImportError:  ``psycopg2`` не установлен.
    """

    url = os.getenv(_DATABASE_URL_ENV)
    if not url:
        raise RuntimeError(
            f"{_DATABASE_URL_ENV} не задан — Auto_Snooze_Watcher не может "
            f"обратиться к Postgres"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


# ---------------------------------------------------------------------------
# AutoSnoozeWatcher
# ---------------------------------------------------------------------------


class AutoSnoozeWatcher:
    """Фоновый поток автопаузы рассылки при накоплении инцидентов.

    Lifecycle::

        watcher = AutoSnoozeWatcher()
        watcher.start()
        ...
        watcher.stop()

    Поток — daemon, поэтому не мешает корректному завершению
    Flask-процесса. Контракт ``start()``/``stop()`` идемпотентен:
    повторный ``start()`` после ``stop()`` создаёт **новый** поток
    (старый не reuse'ится — это упрощает диагностику в логах).

    Args:
        poll_interval_seconds: период тика, дефолт
            ``DEFAULT_POLL_INTERVAL_SECONDS = 30``.
        db_connection_factory: фабрика psycopg2-соединений; в
            production по умолчанию читается ``DATABASE_URL``. В
            тестах инжектится фейковая.
        clock: callable без аргументов, возвращающий ``datetime`` в
            UTC; по умолчанию ``lambda: datetime.now(timezone.utc)``.
            Используется для расчёта ``next_run_at`` и для
            симуляции времени в property-тестах.
    """

    POLL_INTERVAL_SECONDS = DEFAULT_POLL_INTERVAL_SECONDS

    def __init__(
        self,
        *,
        poll_interval_seconds: Optional[float] = None,
        db_connection_factory: Optional[Callable[[], Any]] = None,
        clock: Optional[Callable[[], datetime]] = None,
    ) -> None:
        self._poll_interval_seconds: float = (
            float(poll_interval_seconds)
            if poll_interval_seconds is not None
            else self.POLL_INTERVAL_SECONDS
        )
        self._db_connection_factory: Callable[[], Any] = (
            db_connection_factory or _default_db_connection_factory
        )
        self._clock: Callable[[], datetime] = clock or (
            lambda: datetime.now(timezone.utc)
        )
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lifecycle_lock = threading.Lock()
        self._started = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Запустить daemon-thread Auto_Snooze_Watcher (идемпотентно)."""

        with self._lifecycle_lock:
            if self._started:
                logger.debug("AutoSnoozeWatcher.start: already started — no-op")
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="auto-snooze-watcher",
                daemon=True,
            )
            self._thread.start()
            self._started = True
            logger.info(
                "AutoSnoozeWatcher started (poll_interval=%.1fs)",
                self._poll_interval_seconds,
            )

    def stop(self, *, timeout: float = 5.0) -> None:
        """Остановить поток (идемпотентно).

        ``Event.wait`` в :meth:`_run` пробуждается мгновенно после
        ``self._stop_event.set()``, поэтому в нормальном режиме
        join завершается за секунды.
        """

        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        with self._lifecycle_lock:
            self._started = False
            self._thread = None

    def is_running(self) -> bool:
        """True, если daemon-thread запущен и ещё жив."""

        with self._lifecycle_lock:
            return bool(self._thread and self._thread.is_alive())

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def _run(self) -> None:
        """Цикл: tick → wait. Любые исключения внутри tick'а ловятся
        и логируются — поток никогда не должен умирать молча."""

        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logger.exception("AutoSnoozeWatcher tick failed")
            # Прерываемое ожидание: stop() пробуждает мгновенно.
            if self._stop_event.wait(self._poll_interval_seconds):
                break

    # ------------------------------------------------------------------
    # Tick
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        """Один проход: SELECT running broadcasts → per-broadcast count
        incidents → optional auto-snooze.

        Изолирован per-broadcast: исключение при обработке одного
        не валит остальные (Req 9.5: «защита broadcast'ов
        приоритетна»). Сам tick может тихо no-op'нуть, если БД
        недоступна.
        """

        try:
            contexts = self._fetch_running_with_auto_snooze()
        except Exception:
            logger.exception(
                "AutoSnoozeWatcher._tick: ошибка SELECT running broadcasts — "
                "tick пропущен"
            )
            return

        if not contexts:
            return

        logger.debug(
            "AutoSnoozeWatcher._tick: %d running broadcast(s) с "
            "auto_snooze_enabled=true",
            len(contexts),
        )

        now = self._clock()
        for ctx in contexts:
            try:
                self._evaluate_one(ctx, now=now)
            except Exception:
                # Per-iteration try/except — exception в одной рассылке
                # не должен валить весь tick (Req 9.5).
                logger.exception(
                    "AutoSnoozeWatcher: ошибка обработки broadcast id=%s — "
                    "продолжаю с остальными",
                    ctx.broadcast_id,
                )

    def _evaluate_one(self, ctx: AutoSnoozeContext, *, now: datetime) -> None:
        """Принять решение о паузе/эскалации для одной рассылки.

        Защитный гард: если у broadcast'а ещё нет
        ``operation_run_id`` (теоретически возможно сразу после
        старта worker'а), мы не можем корректно посчитать
        scoped-инциденты — пропускаем (Req 9.8: считаем **только** в
        своём run'е). Следующий tick подберёт.
        """

        if ctx.operation_run_id is None:
            logger.debug(
                "AutoSnoozeWatcher: broadcast id=%s ещё не имеет "
                "operation_run_id — пропускаем",
                ctx.broadcast_id,
            )
            return

        count = self._count_incidents(
            operation_run_id=ctx.operation_run_id,
            kinds=AUTO_SNOOZE_INCIDENT_KINDS,
            window_minutes=ctx.auto_snooze_window_minutes,
            now=now,
        )

        if count < ctx.auto_snooze_threshold:
            return

        logger.info(
            "AutoSnoozeWatcher: broadcast id=%s достиг порога "
            "(count=%d >= threshold=%d, run_id=%s, window=%dmin) — "
            "запускаю auto-snooze",
            ctx.broadcast_id,
            count,
            ctx.auto_snooze_threshold,
            ctx.operation_run_id,
            ctx.auto_snooze_window_minutes,
        )
        self._auto_snooze(ctx, count=count, now=now)

    # ------------------------------------------------------------------
    # SELECT running broadcasts
    # ------------------------------------------------------------------

    def _fetch_running_with_auto_snooze(self) -> list[AutoSnoozeContext]:
        """SELECT ``scheduled_broadcasts`` со ``status='running'`` AND
        ``auto_snooze_enabled=true`` + their ``operation_run_id``.

        ``operation_run_id`` берётся из последнего running ``operation_runs``
        с ``broadcast_id = scheduled_broadcasts.id``: мы используем
        ``LATERAL`` JOIN, чтобы получить его одним запросом без
        дополнительного round-trip per-broadcast.

        ``ORDER BY id`` обеспечивает детерминированный порядок
        обработки (важно для P17/P18 при property-тестах).
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        rows: list[Mapping[str, Any]] = []
        with closing(self._db_connection_factory()) as conn:
            if psycopg2_extras is not None:
                cur_ctx = conn.cursor(
                    cursor_factory=psycopg2_extras.RealDictCursor
                )
            else:
                cur_ctx = conn.cursor()
            with cur_ctx as cur:
                cur.execute(
                    """
                    SELECT sb.id                         AS broadcast_id,
                           sb.user_id                    AS user_id,
                           sb.auto_snooze_count          AS auto_snooze_count,
                           sb.auto_snooze_threshold      AS auto_snooze_threshold,
                           sb.auto_snooze_minutes        AS auto_snooze_minutes,
                           sb.auto_snooze_window_minutes AS auto_snooze_window_minutes,
                           opr.id                        AS operation_run_id
                      FROM scheduled_broadcasts sb
                      LEFT JOIN LATERAL (
                          SELECT id
                            FROM operation_runs
                           WHERE broadcast_id = sb.id
                             AND status = 'running'
                        ORDER BY started_at DESC
                           LIMIT 1
                      ) opr ON TRUE
                     WHERE sb.status = 'running'
                       AND sb.auto_snooze_enabled = TRUE
                     ORDER BY sb.id ASC
                    """
                )
                rows = list(cur.fetchall())

        return [self._row_to_context(row) for row in rows]

    @staticmethod
    def _row_to_context(row: Mapping[str, Any]) -> AutoSnoozeContext:
        """Конверсия ``RealDictCursor``-row в :class:`AutoSnoozeContext`.

        Отсутствующие/NULL-поля заполняются дефолтами из требований
        (``threshold=3``, ``minutes=30``, ``window_minutes=15``,
        ``count=0``) — это безопасное поведение, если миграция
        Req 9.1 ещё не докатилась до конкретной строки.
        """

        operation_run_id_raw = row.get("operation_run_id")
        return AutoSnoozeContext(
            broadcast_id=int(row["broadcast_id"]),
            user_id=str(row.get("user_id") or ""),
            operation_run_id=(
                int(operation_run_id_raw)
                if operation_run_id_raw is not None
                else None
            ),
            auto_snooze_count=int(row.get("auto_snooze_count") or 0),
            auto_snooze_threshold=int(row.get("auto_snooze_threshold") or 3),
            auto_snooze_minutes=int(row.get("auto_snooze_minutes") or 30),
            auto_snooze_window_minutes=int(
                row.get("auto_snooze_window_minutes") or 15
            ),
        )

    # ------------------------------------------------------------------
    # _count_incidents (Req 9.2, 9.8 / Property P17)
    # ------------------------------------------------------------------

    def _count_incidents(
        self,
        *,
        operation_run_id: int,
        kinds: Iterable[str],
        window_minutes: int,
        now: Optional[datetime] = None,
    ) -> int:
        """Посчитать инциденты в ``incident_log`` строго по
        ``operation_run_id`` (Req 9.8) AND по списку ``kinds`` AND
        в окне ``[now - window_minutes; now]``.

        **Property P17** (Req 9.8): запросы с другим ``operation_run_id``
        НЕ учитываются, даже если относятся к тому же пользователю.
        Это защищает от ложных авто-снузов из-за параллельных
        check-операций или старых broadcast'ов.

        Args:
            operation_run_id: id ``operation_runs``-row рассылки.
                Если ``None``, метод не вызывается (см.
                :meth:`_evaluate_one`).
            kinds: набор incident.kind'ов из
                :data:`AUTO_SNOOZE_INCIDENT_KINDS`. Любые другие
                kinds игнорируются.
            window_minutes: длина окна в минутах (Req 9.1, диапазон
                1–120). На граничных значениях (0 или отрицательных)
                эффективно даёт count=0.
            now: текущее время в UTC. Передаётся снаружи для
                консистентности тика (один ``now`` на все broadcast'ы).
                Если ``None`` — берётся ``self._clock()``.

        Returns:
            Целое число найденных инцидентов в ``incident_log``,
            удовлетворяющих всем трём фильтрам.
        """

        # Защитный гард — пустой набор kinds → count=0 без round-trip.
        kinds_tuple = tuple(sorted({k for k in kinds if k}))
        if not kinds_tuple:
            return 0
        if window_minutes <= 0:
            return 0

        now = now if now is not None else self._clock()
        window_start = now - timedelta(minutes=int(window_minutes))

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        with closing(self._db_connection_factory()) as conn:
            if psycopg2_extras is not None:
                cur_ctx = conn.cursor(
                    cursor_factory=psycopg2_extras.RealDictCursor
                )
            else:
                cur_ctx = conn.cursor()
            with cur_ctx as cur:
                # Используем = (строгое равенство) по operation_run_id,
                # а НЕ IN/LEFT JOIN — это критично для P17:
                # запись с другим run_id никогда не попадает в COUNT.
                cur.execute(
                    """
                    SELECT COUNT(*) AS cnt
                      FROM incident_log
                     WHERE operation_run_id = %s
                       AND kind = ANY(%s)
                       AND created_at >= %s
                       AND created_at <= %s
                    """,
                    (
                        int(operation_run_id),
                        list(kinds_tuple),
                        window_start,
                        now,
                    ),
                )
                row = cur.fetchone()

        if row is None:
            return 0
        # ``RealDictCursor`` отдаёт dict, обычный cursor — tuple.
        if isinstance(row, Mapping):
            return int(row.get("cnt") or 0)
        return int(row[0] or 0)

    # ------------------------------------------------------------------
    # _auto_snooze (Req 9.3, 9.5, 9.6, 9.7 / Property P18)
    # ------------------------------------------------------------------

    def _auto_snooze(
        self,
        ctx: AutoSnoozeContext,
        *,
        count: int,
        now: datetime,
    ) -> None:
        """Применить авто-снуз или эскалацию.

        Транзакционная часть (UPDATE ``scheduled_broadcasts``)
        выполняется в ОДНОМ commit'е, чтобы счётчик и статус не
        рассинхронизировались. Notification — best-effort вне
        транзакции: failure dispatch'а **НЕ откатывает** pause
        (Req 9.5).

        Двухфазная логика по ``auto_snooze_count`` после ``+= 1``:

        * ``new_count > 3`` → эскалация: ``status='failed'``,
          ``last_error='AUTO_SNOOZE_REPEATED'``, kind=``failed``.
          Property P18: после этого NO manual retry endpoint
          вернёт broadcast в ``running``.
        * иначе → пауза: ``status='paused'``, ``next_run_at = now() +
          auto_snooze_minutes*60s`` (Req 9.3), kind=``auto_snoozed``.
        """

        new_count = ctx.auto_snooze_count + 1
        is_failed = new_count > AUTO_SNOOZE_MAX_BEFORE_FAIL

        if is_failed:
            # Эскалация (Req 9.6, P18).
            new_status = "failed"
            next_run_at: Optional[datetime] = None
            last_error = "AUTO_SNOOZE_REPEATED"
            notification_kind = "failed"
        else:
            # Пауза (Req 9.3).
            new_status = "paused"
            next_run_at = now + timedelta(minutes=ctx.auto_snooze_minutes)
            last_error = None
            notification_kind = "auto_snoozed"

        # Phase 1: транзакция — критическое side-effect.
        applied = self._apply_status_change(
            broadcast_id=ctx.broadcast_id,
            new_status=new_status,
            new_count=new_count,
            next_run_at=next_run_at,
            last_error=last_error,
        )
        if not applied:
            # БД отказала на UPDATE — следующий tick попробует снова.
            logger.warning(
                "AutoSnoozeWatcher: UPDATE failed for broadcast id=%s — "
                "tick aborted; retry on next tick",
                ctx.broadcast_id,
            )
            return

        logger.info(
            "AutoSnoozeWatcher: broadcast id=%s → status=%s "
            "(auto_snooze_count=%d → %d, count=%d, threshold=%d)",
            ctx.broadcast_id,
            new_status,
            ctx.auto_snooze_count,
            new_count,
            count,
            ctx.auto_snooze_threshold,
        )

        # Phase 2: Notification — best-effort (Req 9.5).
        self._emit_notification(
            ctx=ctx,
            kind=notification_kind,
            count=count,
            new_count=new_count,
            resume_at=next_run_at,
            now=now,
        )

    def _apply_status_change(
        self,
        *,
        broadcast_id: int,
        new_status: str,
        new_count: int,
        next_run_at: Optional[datetime],
        last_error: Optional[str],
    ) -> bool:
        """Атомарно обновить ``scheduled_broadcasts`` и зафиксировать.

        Все изменения в одном UPDATE — это даёт атомарность без
        BEGIN/COMMIT-обёртки. Возвращает ``True`` при успехе,
        ``False`` при любой ошибке БД (логируется).
        """

        try:
            with closing(self._db_connection_factory()) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE scheduled_broadcasts
                           SET status               = %s,
                               auto_snooze_count    = %s,
                               next_run_at          = %s,
                               last_error           = COALESCE(%s, last_error),
                               last_run_at          = CASE
                                                          WHEN %s = 'failed'
                                                              THEN NOW()
                                                          ELSE last_run_at
                                                      END,
                               updated_at           = NOW()
                         WHERE id = %s
                        """,
                        (
                            new_status,
                            int(new_count),
                            next_run_at,
                            last_error,
                            new_status,
                            int(broadcast_id),
                        ),
                    )
                conn.commit()
            return True
        except Exception:
            logger.exception(
                "AutoSnoozeWatcher: ошибка UPDATE scheduled_broadcasts "
                "id=%s (new_status=%s)",
                broadcast_id,
                new_status,
            )
            return False

    # ------------------------------------------------------------------
    # Notification dispatch (best-effort, Req 9.5)
    # ------------------------------------------------------------------

    def _emit_notification(
        self,
        *,
        ctx: AutoSnoozeContext,
        kind: str,
        count: int,
        new_count: int,
        resume_at: Optional[datetime],
        now: datetime,
    ) -> None:
        """Создать ``Notification`` со снапшотом prefs — best-effort.

        Ошибки на этом этапе **не** влияют на уже применённый pause:
        логируются и игнорируются (Req 9.5). Сам ретрай отправки
        каналам — задача ``Notification_Dispatcher`` (Req 10.11).
        """

        try:
            payload = self._build_payload(
                ctx=ctx,
                kind=kind,
                count=count,
                new_count=new_count,
                resume_at=resume_at,
            )
            preference_snapshot = self._build_preference_snapshot(
                user_id=ctx.user_id,
            )
            self._insert_notification(
                user_id=ctx.user_id,
                kind=kind,
                payload=payload,
                preference_snapshot=preference_snapshot,
            )
        except Exception:
            # Любые ошибки — log + swallow. Pause уже применён, и
            # это критичнее, чем гарантированная доставка
            # уведомления (Req 9.5).
            logger.exception(
                "AutoSnoozeWatcher: best-effort notification create failed "
                "(broadcast id=%s, kind=%s) — pause НЕ откатывается",
                ctx.broadcast_id,
                kind,
            )

    @staticmethod
    def _build_payload(
        *,
        ctx: AutoSnoozeContext,
        kind: str,
        count: int,
        new_count: int,
        resume_at: Optional[datetime],
    ) -> dict[str, Any]:
        """Сформировать ``payload`` JSON под формат из design.md.

        * ``auto_snoozed``: ``{broadcast_id, incident_count,
          threshold, resume_at}``
        * ``failed``: ``{broadcast_id, reason}`` (Req 9.6 — фиксируем
          причину для UI и notification dispatcher'а).
        """

        if kind == "failed":
            return {
                "broadcast_id": ctx.broadcast_id,
                "reason": "AUTO_SNOOZE_REPEATED",
                "auto_snooze_count": new_count,
            }
        # auto_snoozed
        payload: dict[str, Any] = {
            "broadcast_id": ctx.broadcast_id,
            "incident_count": int(count),
            "threshold": int(ctx.auto_snooze_threshold),
        }
        if resume_at is not None:
            payload["resume_at"] = resume_at.isoformat()
        return payload

    def _build_preference_snapshot(
        self,
        *,
        user_id: str,
    ) -> dict[str, dict[str, bool]]:
        """Собрать актуальный ``preference_snapshot`` пользователя.

        Формат (см. design.md, Req 10.4)::

            {event_kind: {channel: enabled}}

        Нечитаемая БД → пустой ``{}``: dispatcher просто не отправит
        ничего по каналам, но запись в ``notifications`` уже
        будет создана (in-app получит её через
        ``GET /api/notifications`` независимо от snapshot'а).
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        snapshot: dict[str, dict[str, bool]] = {}
        try:
            with closing(self._db_connection_factory()) as conn:
                if psycopg2_extras is not None:
                    cur_ctx = conn.cursor(
                        cursor_factory=psycopg2_extras.RealDictCursor
                    )
                else:
                    cur_ctx = conn.cursor()
                with cur_ctx as cur:
                    cur.execute(
                        """
                        SELECT event_kind, channel, enabled
                          FROM notification_preferences
                         WHERE user_id = %s
                        """,
                        (user_id,),
                    )
                    for row in cur.fetchall():
                        if isinstance(row, Mapping):
                            event_kind = str(row.get("event_kind") or "")
                            channel = str(row.get("channel") or "")
                            enabled = bool(row.get("enabled") or False)
                        else:
                            event_kind = str(row[0] or "")
                            channel = str(row[1] or "")
                            enabled = bool(row[2] or False)
                        if not event_kind or not channel:
                            continue
                        snapshot.setdefault(event_kind, {})[channel] = enabled
        except Exception:
            logger.exception(
                "AutoSnoozeWatcher: не удалось прочитать "
                "notification_preferences для user_id=%s — snapshot пуст",
                user_id,
            )
            return {}
        return snapshot

    def _insert_notification(
        self,
        *,
        user_id: str,
        kind: str,
        payload: Mapping[str, Any],
        preference_snapshot: Mapping[str, Any],
    ) -> None:
        """INSERT в ``notifications`` со ``dispatch_status='pending'``.

        ``Notification_Dispatcher`` (задача 6.4) подберёт строку на
        следующем тике и отправит по каналам, прописанным в
        ``preference_snapshot[kind]``.
        """

        payload_json = json.dumps(dict(payload), ensure_ascii=False)
        snapshot_json = json.dumps(dict(preference_snapshot), ensure_ascii=False)

        with closing(self._db_connection_factory()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO notifications
                        (user_id, kind, payload, preference_snapshot)
                    VALUES (%s, %s, %s::jsonb, %s::jsonb)
                    """,
                    (
                        user_id,
                        kind,
                        payload_json,
                        snapshot_json,
                    ),
                )
            conn.commit()
