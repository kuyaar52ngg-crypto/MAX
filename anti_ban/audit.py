"""AuditLogger — запись массовых операций и инцидентов в БД.

Этот модуль покрывает Requirement 7 (`Operation_Run` со статусом и
прогрессом) и Requirement 8 (`Incident_Log` для yellowCard/blocked/
notAuthorized/rate_limit_429/quota_466/watchdog_reset). Также
экспонирует :meth:`AuditLogger.count_in_window`, который используется
обработчиками `/api/check-contacts-bulk` и `/api/broadcast` для
дневных/часовых лимитов (Requirements 1.4, 1.5, 2.4).

Для интеграции с существующим бэкендом используется SQLite через
`db.get_conn` — тот же паттерн, что в `anti_ban.config_loader` и
`db.py`. Prisma-миграция
``frontend/prisma/migrations/20260516_add_anti_ban_models`` создаёт
эквивалентные таблицы в Postgres для фронтенда; здесь же
:meth:`_ensure_schema` создаёт их в SQLite, если они ещё не
существуют (защита от рассинхронизации миграций при первом запуске на
свежей машине).

Источники недетерминизма (`time.time`, фабрика DB-соединений)
внедряются через DI, чтобы тесты могли подменять их на фейки и
in-memory SQLite без касания реального файла БД.

См. design.md, секцию "Components/Interfaces → AuditLogger" и
Requirements 7.1, 7.2, 7.3, 8.1, 8.2, 8.3.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional

import db


__all__ = ["AuditLogger", "audit_logger"]


logger = logging.getLogger(__name__)


# Допустимые финальные статусы `Operation_Run` (Requirement 7.3).
_FinishStatus = Literal["completed", "aborted", "banned", "paused"]
_Window = Literal["day", "hour"]


# DDL для SQLite-эквивалентов Prisma-моделей `OperationRun` и
# `IncidentLog`. Применяется идемпотентно через CREATE TABLE IF NOT
# EXISTS; типы выбраны так, чтобы сравнение `started_at >= ?` работало
# лексикографически на ISO-8601-строках UTC, как и в остальных модулях
# проекта (см. `db.py`).
_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS operation_runs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               TEXT    NOT NULL,
    kind                  TEXT    NOT NULL,
    status                TEXT    NOT NULL DEFAULT 'running',
    total                 INTEGER NOT NULL,
    processed             INTEGER NOT NULL DEFAULT 0,
    last_processed_index  INTEGER NOT NULL DEFAULT -1,
    payload               TEXT    NOT NULL,
    started_at            TEXT    NOT NULL,
    finished_at           TEXT,
    broadcast_id          INTEGER,
    reason                TEXT
);

CREATE INDEX IF NOT EXISTS operation_runs_user_id_status_idx
    ON operation_runs(user_id, status);

CREATE INDEX IF NOT EXISTS operation_runs_user_id_started_at_idx
    ON operation_runs(user_id, started_at);

CREATE TABLE IF NOT EXISTS incident_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT    NOT NULL,
    operation_run_id INTEGER,
    kind             TEXT    NOT NULL,
    details          TEXT    NOT NULL,
    created_at       TEXT    NOT NULL,
    FOREIGN KEY (operation_run_id) REFERENCES operation_runs(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS incident_log_user_id_created_at_idx
    ON incident_log(user_id, created_at);
"""


class AuditLogger:
    """Журналирование запусков `Bulk_Operation` и инцидентов.

    Args:
        db_connection_factory: фабрика DB-соединений; по умолчанию
            ``db.get_conn`` (SQLite). Соединение должно поддерживать
            ``with conn:`` (commit/rollback при выходе из блока) и
            возвращать строки с доступом по имени колонки (как
            ``sqlite3.Row``).
        clock: функция текущего unix-времени для DI в тестах; по
            умолчанию ``time.time``.
    """

    def __init__(
        self,
        *,
        db_connection_factory: Callable[[], Any] = db.get_conn,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db_connection_factory = db_connection_factory
        self._clock = clock
        # Инициализация схемы — ленивая и идемпотентная. Лок защищает
        # от гонки на первом обращении из нескольких worker-потоков.
        self._schema_lock = threading.Lock()
        self._schema_ready: bool = False

    # ------------------------------------------------------------------
    # Operation_Run lifecycle
    # ------------------------------------------------------------------
    def start_run(
        self,
        *,
        user_id: str,
        kind: str,
        total: int,
        payload: dict,
    ) -> int:
        """Создать запись `operation_runs` со статусом ``running``.

        Args:
            user_id: идентификатор пользователя (UUID-строка).
            kind: ``"check"`` или ``"broadcast"``.
            total: общее количество элементов в операции.
            payload: словарь, который будет сериализован в JSON и
                сохранён в колонку ``payload``. Сериализация — через
                ``json.dumps(..., ensure_ascii=False)``, чтобы
                кириллические значения не экранировались.

        Returns:
            Идентификатор созданной записи (``operation_runs.id``).

        Validates: Requirements 7.1
        """
        self._ensure_schema()
        payload_json = json.dumps(payload, ensure_ascii=False)
        started_at = self._now_iso()
        conn = self._db_connection_factory()
        try:
            with conn:
                cur = conn.execute(
                    """INSERT INTO operation_runs
                         (user_id, kind, status, total, processed,
                          last_processed_index, payload, started_at)
                       VALUES (?, ?, 'running', ?, 0, -1, ?, ?)""",
                    (user_id, kind, int(total), payload_json, started_at),
                )
                return int(cur.lastrowid)
        finally:
            self._safe_close(conn)

    def update_progress(
        self,
        run_id: int,
        *,
        processed: int,
        last_processed_index: int,
    ) -> None:
        """Атомарно обновить прогресс операции.

        Один INSERT/UPDATE-запрос в одной транзакции — одна точка
        фиксации, поэтому даже при падении worker-потока между
        вызовами состояние ``operation_runs`` остаётся
        согласованным.

        Worker-код (см. задачи 11.1, 12.1) комбинирует этот вызов с
        вставкой результата (``recipients`` для broadcast или
        ``CheckResult`` для check) внутри одной БД-транзакции, чтобы
        выполнялся инвариант Requirement 7.2:
        ``last_processed_index == processed - 1``.

        Sqlite-ошибки трактуются как преходящие и логируются —
        worker-поток не должен падать из-за временной блокировки БД.

        Validates: Requirements 7.2
        """
        try:
            conn = self._db_connection_factory()
        except Exception:
            logger.exception(
                "AuditLogger.update_progress: failed to obtain DB connection "
                "(run_id=%s)", run_id
            )
            return
        try:
            with conn:
                conn.execute(
                    """UPDATE operation_runs
                          SET processed = ?,
                              last_processed_index = ?
                        WHERE id = ?""",
                    (int(processed), int(last_processed_index), int(run_id)),
                )
        except sqlite3.OperationalError:
            logger.warning(
                "AuditLogger.update_progress: sqlite OperationalError "
                "(run_id=%s); skipping update", run_id, exc_info=True
            )
        finally:
            self._safe_close(conn)

    def finish_run(
        self,
        run_id: int,
        *,
        status: _FinishStatus,
        reason: Optional[str] = None,
    ) -> None:
        """Перевести `operation_runs.id == run_id` в финальный статус.

        Args:
            run_id: id записи `operation_runs`.
            status: один из ``"completed"``, ``"aborted"``, ``"banned"``,
                ``"paused"``. Для прозрачности и совместимости с
                будущим Postgres-бэкендом проверка значения выполняется
                здесь, а не в БД.
            reason: финальная причина (``"watchdog_timeout"``,
                ``"cancelled"``, ``"quota_466"``, …) для UI/аудита.

        Validates: Requirements 7.3, 8.1
        """
        if status not in ("completed", "aborted", "banned", "paused"):
            raise ValueError(
                f"AuditLogger.finish_run: unsupported status {status!r}; "
                "expected 'completed', 'aborted', 'banned', or 'paused'"
            )
        finished_at = self._now_iso()
        try:
            conn = self._db_connection_factory()
        except Exception:
            logger.exception(
                "AuditLogger.finish_run: failed to obtain DB connection "
                "(run_id=%s)", run_id
            )
            return
        try:
            with conn:
                conn.execute(
                    """UPDATE operation_runs
                          SET status = ?,
                              finished_at = ?,
                              reason = ?
                        WHERE id = ?""",
                    (status, finished_at, reason, int(run_id)),
                )
        except sqlite3.OperationalError:
            logger.warning(
                "AuditLogger.finish_run: sqlite OperationalError "
                "(run_id=%s); skipping update", run_id, exc_info=True
            )
        finally:
            self._safe_close(conn)

    # ------------------------------------------------------------------
    # Incident_Log
    # ------------------------------------------------------------------
    def log_incident(
        self,
        *,
        user_id: str,
        run_id: Optional[int],
        kind: str,
        details: dict,
    ) -> Optional[int]:
        """Создать запись в `incident_log`.

        Args:
            user_id: идентификатор пользователя (UUID-строка).
            run_id: id связанной `operation_runs` или ``None``, если
                инцидент произошёл вне контекста активной операции
                (например, watchdog-сброс уже снятой операции).
            kind: одно из значений
                ``{"yellowCard", "blocked", "notAuthorized",
                "rate_limit_429", "quota_466", "watchdog_reset"}``.
            details: произвольный словарь, который будет
                сериализован в JSON и сохранён в колонку ``details``.

        Returns:
            id созданной записи или ``None``, если запись не удалось
            записать (например, sqlite OperationalError) — в этом
            случае ошибка логируется, но worker-поток продолжает
            работу.

        Validates: Requirements 8.1, 8.2
        """
        self._ensure_schema()
        details_json = json.dumps(details, ensure_ascii=False, default=str)
        created_at = self._now_iso()
        try:
            conn = self._db_connection_factory()
        except Exception:
            logger.exception(
                "AuditLogger.log_incident: failed to obtain DB connection "
                "(user_id=%s, kind=%s)", user_id, kind
            )
            return None
        try:
            with conn:
                cur = conn.execute(
                    """INSERT INTO incident_log
                         (user_id, operation_run_id, kind, details, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        user_id,
                        int(run_id) if run_id is not None else None,
                        kind,
                        details_json,
                        created_at,
                    ),
                )
                return int(cur.lastrowid)
        except sqlite3.OperationalError:
            logger.warning(
                "AuditLogger.log_incident: sqlite OperationalError "
                "(user_id=%s, kind=%s); skipping insert",
                user_id, kind, exc_info=True
            )
            return None
        finally:
            self._safe_close(conn)

    def list_incidents(
        self,
        user_id: str,
        limit: int = 100,
    ) -> list[dict]:
        """Вернуть последние инциденты пользователя по убыванию даты.

        Запрос: ``SELECT ... FROM incident_log WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?``.

        Поле ``details`` парсится обратно из JSON в ``dict``;
        некорректный JSON (теоретически невозможно, мы сами его
        пишем) трактуется как ``{}`` и логируется.

        Args:
            user_id: идентификатор пользователя (UUID-строка).
            limit: максимальное количество записей; по умолчанию
                ``100`` — соответствует
                ``Anti_Ban_Config.incident_history_limit``.

        Returns:
            Список словарей с ключами ``id``, ``user_id``,
            ``operation_run_id``, ``kind``, ``details``, ``created_at``.

        Validates: Requirements 8.3
        """
        self._ensure_schema()
        try:
            conn = self._db_connection_factory()
        except Exception:
            logger.exception(
                "AuditLogger.list_incidents: failed to obtain DB connection "
                "(user_id=%s)", user_id
            )
            return []
        try:
            with conn:
                rows = conn.execute(
                    """SELECT id, user_id, operation_run_id, kind, details,
                              created_at
                         FROM incident_log
                        WHERE user_id = ?
                        ORDER BY created_at DESC
                        LIMIT ?""",
                    (user_id, int(limit)),
                ).fetchall()
        except sqlite3.OperationalError:
            logger.warning(
                "AuditLogger.list_incidents: sqlite OperationalError "
                "(user_id=%s); returning empty list", user_id, exc_info=True
            )
            return []
        finally:
            self._safe_close(conn)

        result: list[dict] = []
        for row in rows:
            row_dict = dict(row)
            raw_details = row_dict.get("details")
            try:
                row_dict["details"] = (
                    json.loads(raw_details) if raw_details else {}
                )
            except (TypeError, json.JSONDecodeError):
                logger.warning(
                    "AuditLogger.list_incidents: incident id=%s has "
                    "non-JSON details; returning empty dict",
                    row_dict.get("id")
                )
                row_dict["details"] = {}
            result.append(row_dict)
        return result

    # ------------------------------------------------------------------
    # Volume counters (Requirements 1.4, 1.5, 2.4)
    # ------------------------------------------------------------------
    def count_in_window(
        self,
        user_id: str,
        kind: str,
        window: _Window,
    ) -> int:
        """Сумма ``processed`` по запускам пользователя за окно.

        Используется обработчиками `/api/check-contacts-bulk` и
        `/api/broadcast` для проверки дневного/часового лимита
        (Requirements 1.4, 1.5, 2.4): если возвращённое значение
        больше или равно соответствующему ``daily_*_limit`` /
        ``hourly_*_limit``, новый запуск отвергается с HTTP 429.

        Считаем именно ``SUM(processed)``, а не количество строк,
        потому что Requirements формулируют лимит на число
        выполненных запросов (``checkAccount`` / ``sendMessage``),
        а не на число запусков.

        Args:
            user_id: идентификатор пользователя.
            kind: ``"check"`` или ``"broadcast"``.
            window: ``"day"`` — с начала календарных суток UTC;
                ``"hour"`` — за последний час (sliding 3600-секундное
                окно от текущего момента).

        Returns:
            Неотрицательное целое — сумма ``processed`` по подходящим
            записям. ``0`` если совпадений нет, схема ещё не
            создана или БД недоступна.

        Raises:
            ValueError: если ``window`` не равен ``"day"`` или
                ``"hour"``.

        Validates: Requirements 1.4, 1.5, 2.4
        """
        if window not in ("day", "hour"):
            raise ValueError(
                f"AuditLogger.count_in_window: unsupported window {window!r}; "
                "expected 'day' or 'hour'"
            )
        threshold = self._window_start_iso(window)
        self._ensure_schema()
        try:
            conn = self._db_connection_factory()
        except Exception:
            logger.exception(
                "AuditLogger.count_in_window: failed to obtain DB connection "
                "(user_id=%s, kind=%s, window=%s)", user_id, kind, window
            )
            return 0
        try:
            with conn:
                row = conn.execute(
                    """SELECT COALESCE(SUM(processed), 0) AS total
                         FROM operation_runs
                        WHERE user_id = ?
                          AND kind = ?
                          AND started_at >= ?""",
                    (user_id, kind, threshold),
                ).fetchone()
        except sqlite3.OperationalError:
            logger.warning(
                "AuditLogger.count_in_window: sqlite OperationalError "
                "(user_id=%s, kind=%s, window=%s); returning 0",
                user_id, kind, window, exc_info=True
            )
            return 0
        finally:
            self._safe_close(conn)

        if row is None:
            return 0
        # row может быть sqlite3.Row или tuple — поддерживаем оба.
        try:
            total = row["total"]
        except (TypeError, IndexError, KeyError):
            total = row[0]
        return int(total or 0)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _ensure_schema(self) -> None:
        """Идемпотентно создать таблицы и индексы в SQLite.

        Сетка миграций фронтенда (Prisma → Postgres) не покрывает
        локальный SQLite-файл бэкенда, поэтому первая попытка
        записи может упасть на ``no such table``. Этот метод
        вызывается перед записью; повторные вызовы — no-op после
        первого успешного создания.

        Безопасен на гонке: один лок гарантирует, что DDL
        выполнится один раз.
        """
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            try:
                conn = self._db_connection_factory()
            except Exception:
                logger.exception(
                    "AuditLogger._ensure_schema: failed to obtain DB "
                    "connection; schema not initialised"
                )
                return
            try:
                with conn:
                    conn.executescript(_SCHEMA_DDL)
                self._schema_ready = True
            except sqlite3.OperationalError:
                logger.warning(
                    "AuditLogger._ensure_schema: sqlite OperationalError "
                    "during DDL; will retry on next operation",
                    exc_info=True
                )
            finally:
                self._safe_close(conn)

    def _now_iso(self) -> str:
        """Текущее UTC-время в ISO-8601 с секундной точностью.

        Формат совпадает с используемым в ``db.py`` (например,
        ``recipients.sent_at``), что упрощает кросс-таблицы запросы
        и сортировку.
        """
        return datetime.fromtimestamp(
            self._clock(), tz=timezone.utc
        ).replace(tzinfo=None).isoformat(timespec="seconds")

    def _window_start_iso(self, window: _Window) -> str:
        """Граница окна в ISO-8601 UTC для ``count_in_window``.

        * ``"day"``  → начало текущих UTC-суток.
        * ``"hour"`` → ``now - 1 час`` (sliding window).
        """
        now_dt = datetime.fromtimestamp(
            self._clock(), tz=timezone.utc
        ).replace(tzinfo=None)
        if window == "day":
            start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        else:  # "hour"
            start = now_dt - timedelta(hours=1)
        return start.isoformat(timespec="seconds")

    @staticmethod
    def _safe_close(conn: Any) -> None:
        """Закрыть соединение, не пробрасывая исключений наверх.

        В SQLite ``with conn:`` обрабатывает commit/rollback, но не
        закрывает соединение; явный ``close()`` нужен, чтобы не
        накапливать ресурсы на длительно живущем worker-потоке.
        """
        try:
            conn.close()
        except Exception:
            pass


# Module-level singleton для импорта из `app.py`, worker-потоков
# `Bulk_Operation` и `Watchdog` (Requirements 7.1, 8.1).
audit_logger = AuditLogger()
