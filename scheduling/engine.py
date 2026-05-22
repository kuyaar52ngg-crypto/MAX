"""Schedule_Mode_Engine — диспетчер «новых» режимов расписания.

Это единый стратегий-диспетчер для значений
``ScheduledBroadcast.schedule_type ∈ {window, smart_time, ab_time,
burst}``. Старые значения (``exact``/``drip``/``recurring``)
обслуживаются существующим ``BroadcastScheduler`` без изменений
(см. ``scheduler.py``); новые режимы — этим модулем
(см. design.md, секция «Architecture → Schedule_Mode_Engine»).

Контракт
========

* :class:`ScheduleModeStrategy` — структурный протокол с одной
  чистой функцией :func:`distribute`. Каждый concrete-engine
  (``WindowEngine``, ``SmartTimeEngine``, ``ABTimeEngine``,
  ``BurstEngine``) реализует её отдельно (задачи 4.3–4.13). Чистота
  стратегий критична для property-тестов P1–P5/P9/P15 (детерминизм
  по ``broadcast.id``) и для PreFlight Preview, который вызывает ту
  же логику без записи в БД.
* :class:`ScheduleModeEngine` — registry + dispatcher. Регистрация
  стратегий идёт в ``app.py`` после старта Flask (см. задачу 6.11):

      engine = ScheduleModeEngine()
      engine.register("window",     WindowEngine())
      engine.register("smart_time", SmartTimeEngine(activity_analyzer))
      engine.register("ab_time",    ABTimeEngine(activity_analyzer))
      engine.register("burst",      BurstEngine())

  Затем :meth:`ScheduleModeEngine.dispatch_due` вызывается на каждом
  tick существующего ``BroadcastScheduler`` (после его текущей
  логики, см. design.md «Потоковая модель Flask backend»).

SELECT due broadcasts
=====================

Контракт SELECT-запроса в :meth:`dispatch_due`:

    schedule_type IN ('window','smart_time','ab_time','burst')
    AND status = 'scheduled'
    AND next_run_at IS NOT NULL AND next_run_at <= NOW()
    AND approval_status != 'pending'

Условие ``approval_status != 'pending'`` явно поддерживает
Requirement 7.4: рассылки в ``status='pending_approval'`` не
дёргаются движком даже при достижении ``next_run_at``. Защита
дублируется defence-in-depth внутри цикла (см. :meth:`_dispatch_one`)
— это нужно для случая, когда ``status`` и ``approval_status``
рассинхронизированы (теоретически невозможно по бизнес-правилам,
но Property 13 требует жёстких гарантий).

Граничные случаи и устойчивость
================================

* Каждая итерация per-broadcast обёрнута в ``try/except`` с
  ``logger.exception`` — exception в одной рассылке не валит весь
  tick и не блокирует остальные due-рассылки (Requirement 7.4 + 8.1).
* Отсутствие ``DATABASE_URL`` или падение psycopg2-соединения
  логируется и приводит к no-op tick: следующий tick попробует
  подключиться снова. Это согласуется с поведением существующего
  ``BroadcastScheduler``.
* Отсутствие зарегистрированной стратегии для ``schedule_type``
  логируется как ``warning`` и пропускается — это «soft failure»
  до завершения задачи 6.11, где регистрируются все стратегии.

Worker enqueue
==============

Задача 4.1 НЕ интегрируется с broadcast worker'ом — это сделает
задача 6.11 (wire-up в ``app.py``). На текущем этапе после
``strategy.distribute(...)`` мы только логируем количество
запланированных отправок и оставляем TODO-маркер для интеграции.
Сами вычисленные ``ScheduledSend``-ы возвращаются из
:meth:`distribute` для PreFlight Preview и unit-тестов.
"""

from __future__ import annotations

import os
import threading
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Mapping, Optional, Protocol, runtime_checkable

from scheduling.logger import logger
from scheduling.types import ScheduledSend, ScheduleType


__all__ = [
    "BroadcastRow",
    "ScheduleModeEngine",
    "ScheduleModeStrategy",
    "DISPATCHED_SCHEDULE_TYPES",
]


#: Множество ``schedule_type``-значений, обслуживаемых этим движком.
#: Старые типы (``exact``/``drip``/``recurring``) сюда НЕ входят —
#: они продолжают обслуживаться существующим ``BroadcastScheduler``.
#: См. design.md, «Architecture → Schedule_Mode_Engine».
DISPATCHED_SCHEDULE_TYPES: tuple[ScheduleType, ...] = (
    "window",
    "smart_time",
    "ab_time",
    "burst",
)


#: Имя переменной окружения с Postgres URL — то же, что и в
#: ``scheduler.py`` и ``activity_analyzer.py``.
_DATABASE_URL_ENV = "DATABASE_URL"

#: Лимит batch'а из SELECT — выбран как у существующего
#: ``BroadcastScheduler._fetch_due_jobs`` (50). Если due-рассылок
#: больше — следующий tick (через 15 секунд) подберёт остальные.
_DUE_BATCH_LIMIT = 50


# ---------------------------------------------------------------------------
# Broadcast row (lightweight DTO for strategies)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BroadcastRow:
    """Снимок строки ``scheduled_broadcasts`` с attribute-access.

    Стратегии (``WindowEngine`` и т.д.) в design.md обращаются к
    полям через атрибуты (``broadcast.send_window_start``,
    ``broadcast.contacts``, ...). ``psycopg2.extras.RealDictCursor``
    отдаёт обычные ``dict``-ы, поэтому диспетчер оборачивает их в
    эту лёгкую dataclass-обёртку перед передачей в стратегию.

    Поле ``raw`` хранит исходный dict — это полезно для стратегий,
    которые могут читать редкие колонки (например, ``ab_test_id``,
    ``personalized_messages``) без расширения dataclass-а.

    Класс **frozen** — стратегии не должны мутировать broadcast,
    это критично для определения «pure function» (Property 3,
    «определённость по ``broadcast.id``»).
    """

    id: int
    user_id: str
    schedule_type: ScheduleType
    status: str
    contacts: list[Any]
    next_run_at: Optional[datetime]
    scheduled_for: Optional[datetime]
    user_tz: str = "UTC"

    # Window-mode columns (Req 1.x). NULL когда schedule_type ≠ window.
    send_window_start: Optional[datetime] = None
    send_window_end: Optional[datetime] = None

    # Smart-Time columns (Req 2.x). NULL когда schedule_type ≠ smart_time.
    smart_time_window_days: Optional[int] = None
    smart_time_top_n: Optional[int] = None

    # AB-Time columns (Req 3.x). NULL когда schedule_type ≠ ab_time.
    ab_time_test_id: Optional[int] = None

    # Quiet hours (общие для всех режимов).
    quiet_hours_enabled: bool = False
    quiet_hours_start: int = 22
    quiet_hours_end: int = 8
    respect_recipient_tz: bool = False

    # Approval (Req 7.x). Дублируется внутри dispatch для defence-in-depth.
    approval_status: str = "none"
    approval_user_id: Optional[str] = None

    # Auto-Snooze — нужно стратегиям только косвенно, но удобно
    # пробрасывать целиком (Req 9.x).
    auto_snooze_enabled: bool = False

    #: Полная исходная строка из ``scheduled_broadcasts`` со всеми
    #: колонками, которые dataclass не объявил явно (например,
    #: ``message``, ``personalized_messages``, ``bot_*`` credentials).
    #: Стратегии могут читать дополнительные поля отсюда.
    raw: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_db_row(cls, row: Mapping[str, Any]) -> "BroadcastRow":
        """Построить ``BroadcastRow`` из dict-строки psycopg2.

        Не выбрасывает исключений на missing-полях — отсутствующие
        колонки заполняются дефолтами dataclass-а. ``contacts``
        нормализуется в список (могут прийти ``list``, JSON-строка,
        ``None``).
        """

        contacts_raw: Any = row.get("contacts")
        if isinstance(contacts_raw, str):
            # psycopg2 для JSONB-колонок без RealDictCursor может
            # вернуть строку. Парсим её один раз здесь, чтобы
            # стратегии не дублировали логику.
            import json

            try:
                contacts_raw = json.loads(contacts_raw)
            except json.JSONDecodeError:
                contacts_raw = []
        if contacts_raw is None:
            contacts_raw = []
        contacts = list(contacts_raw)

        return cls(
            id=int(row["id"]),
            user_id=str(row.get("user_id") or ""),
            schedule_type=str(row.get("schedule_type") or ""),  # type: ignore[arg-type]
            status=str(row.get("status") or ""),
            contacts=contacts,
            next_run_at=row.get("next_run_at"),
            scheduled_for=row.get("scheduled_for"),
            user_tz=str(row.get("user_tz") or "UTC"),
            send_window_start=row.get("send_window_start"),
            send_window_end=row.get("send_window_end"),
            smart_time_window_days=row.get("smart_time_window_days"),
            smart_time_top_n=row.get("smart_time_top_n"),
            ab_time_test_id=row.get("ab_time_test_id"),
            quiet_hours_enabled=bool(row.get("quiet_hours_enabled") or False),
            quiet_hours_start=int(row.get("quiet_hours_start") or 22),
            quiet_hours_end=int(row.get("quiet_hours_end") or 8),
            respect_recipient_tz=bool(row.get("respect_recipient_tz") or False),
            approval_status=str(row.get("approval_status") or "none"),
            approval_user_id=row.get("approval_user_id"),
            auto_snooze_enabled=bool(row.get("auto_snooze_enabled") or False),
            raw=dict(row),
        )


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class ScheduleModeStrategy(Protocol):
    """Структурный протокол стратегии распределения.

    Каждый concrete-engine (``WindowEngine``, ``SmartTimeEngine``,
    ``ABTimeEngine``, ``BurstEngine``) реализует ровно один метод —
    :func:`distribute`. Метод обязан быть pure-функцией:

    * Без обращений к глобальному состоянию или wall-clock-у вне
      входных параметров (исключение: ``ActivityAnalyzer.top_slots``,
      инжектится в конструктор стратегии — это контролируемая
      зависимость).
    * Без побочных эффектов — никаких ``UPDATE``/``INSERT`` в БД,
      никаких ``logger`` с side-effect-ами.
    * Детерминированная: два вызова с теми же ``broadcast``,
      ``anti_ban``, ``exceptions`` дают побитово равный результат
      (Property 3, P3).

    На входе:
        broadcast: :class:`BroadcastRow` — снимок строки
            ``scheduled_broadcasts`` с attribute-access.
        anti_ban:   :class:`anti_ban.config.AntiBanConfig` — limits
            и delays оператора.
        exceptions: список dict-ов из таблицы ``calendar_exceptions``
            пользователя (структура совпадает с design.md).

    Возвращает: список :class:`ScheduledSend`. Длина списка равна
    ``len(broadcast.contacts)`` (Property 1: window distribution
    covers all recipients), кроме AB-Time, где допустимо разделение
    на группы — но сумма групп всё равно равна N.

    Ошибки: в случае невозможности построить расписание (например,
    ``WINDOW_INSUFFICIENT_TIME``) стратегия выбрасывает
    :class:`scheduling.types.SchedulingError` с соответствующим
    кодом. Диспетчер ловит её и логирует, не валит остальные
    рассылки.
    """

    def distribute(
        self,
        broadcast: "BroadcastRow",
        anti_ban: Any,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        ...


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений по умолчанию.

    Зеркально :func:`scheduler._connect` и
    :func:`scheduling.activity_analyzer._default_db_connection_factory`.
    Импорт ``psycopg2`` ленивый, чтобы импорт engine-модуля не падал
    в окружениях без psycopg2 (unit-тесты с инжектированной фабрикой).

    Raises:
        RuntimeError: ``DATABASE_URL`` не задан.
        ImportError:  ``psycopg2`` не установлен.
    """

    url = os.getenv(_DATABASE_URL_ENV)
    if not url:
        raise RuntimeError(
            f"{_DATABASE_URL_ENV} не задан — Schedule_Mode_Engine не может "
            f"обратиться к Postgres"
        )
    import psycopg2  # local import: keep module importable without psycopg2

    return psycopg2.connect(url)


class ScheduleModeEngine:
    """Registry + dispatcher для новых режимов расписания.

    Singleton-инстанс этого класса создаётся в ``app.py`` рядом с
    существующим ``BroadcastScheduler`` (см. задачу 6.11). Все
    стратегии регистрируются в нём через :meth:`register` сразу
    после старта Flask. Затем существующий
    ``BroadcastScheduler._tick()`` вызывает :meth:`dispatch_due`
    на каждом 15-секундном tick'е после своей текущей логики.

    Attributes:
        _strategies: словарь ``{schedule_type → ScheduleModeStrategy}``.
            Изменения защищены ``threading.Lock`` — регистрация
            теоретически возможна и после старта (например, hot-reload
            в dev), хотя в production все регистрации идут один раз.

    Args:
        db_connection_factory: фабрика psycopg2-соединений; по
            умолчанию читается ``DATABASE_URL``. В тестах
            инжектится фейковая фабрика, возвращающая mock-объект
            с ``cursor()`` → ``execute()`` → ``fetchall()``.
        anti_ban_loader: callable, принимающий ``user_id`` и
            возвращающий :class:`AntiBanConfig`. По умолчанию —
            ``anti_ban.config_loader.config_loader.get`` (singleton).
            Инжектится для тестов.
        exceptions_loader: callable, принимающий ``user_id`` и
            возвращающий ``list[CalendarException]``. По умолчанию
            читает таблицу ``calendar_exceptions`` через ту же
            DB-фабрику. В тестах инжектится фейк.
    """

    def __init__(
        self,
        *,
        db_connection_factory: Optional[Callable[[], Any]] = None,
        anti_ban_loader: Optional[Callable[[str], Any]] = None,
        exceptions_loader: Optional[Callable[[str], list[Any]]] = None,
    ) -> None:
        self._db_connection_factory: Callable[[], Any] = (
            db_connection_factory or _default_db_connection_factory
        )
        self._anti_ban_loader: Callable[[str], Any] = (
            anti_ban_loader or _default_anti_ban_loader
        )
        self._exceptions_loader: Callable[[str], list[Any]] = (
            exceptions_loader or self._default_exceptions_loader
        )
        self._lock = threading.Lock()
        self._strategies: dict[str, ScheduleModeStrategy] = {}

    # ------------------------------------------------------------------
    # Registry
    # ------------------------------------------------------------------

    def register(
        self,
        schedule_type: str,
        strategy: ScheduleModeStrategy,
    ) -> None:
        """Зарегистрировать стратегию для ``schedule_type``.

        Контракт:

        * ``schedule_type`` должен быть одним из значений
          :data:`DISPATCHED_SCHEDULE_TYPES` — иначе
          ``ValueError`` (защита от опечаток в ``app.py``).
        * Повторная регистрация того же ``schedule_type`` перезаписывает
          предыдущую запись с предупреждением в лог. Это полезно для
          dev-перезагрузок и не маскирует баги, потому что в production
          regestrations идут один раз.
        * Объект ``strategy`` должен иметь метод ``distribute``.
          Структурная проверка через :func:`isinstance` с
          ``runtime_checkable`` Protocol; на ошибку — ``TypeError``.
        """

        if schedule_type not in DISPATCHED_SCHEDULE_TYPES:
            raise ValueError(
                f"unsupported schedule_type={schedule_type!r}; "
                f"expected one of {DISPATCHED_SCHEDULE_TYPES}"
            )
        if not isinstance(strategy, ScheduleModeStrategy):
            raise TypeError(
                f"strategy must implement ScheduleModeStrategy "
                f"(method distribute), got {type(strategy).__name__}"
            )
        with self._lock:
            if schedule_type in self._strategies:
                logger.warning(
                    "ScheduleModeEngine.register: перезапись стратегии "
                    "schedule_type=%s (%s → %s)",
                    schedule_type,
                    type(self._strategies[schedule_type]).__name__,
                    type(strategy).__name__,
                )
            self._strategies[schedule_type] = strategy

    def is_registered(self, schedule_type: str) -> bool:
        """True, если для данного ``schedule_type`` есть стратегия."""

        with self._lock:
            return schedule_type in self._strategies

    # ------------------------------------------------------------------
    # Distribute (pure entrypoint, used by PreFlight + tests)
    # ------------------------------------------------------------------

    def distribute(
        self,
        broadcast: "BroadcastRow",
        anti_ban: Any,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        """Делегировать в стратегию для ``broadcast.schedule_type``.

        Pure-функция: не читает БД, не пишет, не обращается к
        wall-clock. Используется PreFlight Preview (через mirror
        в ``preflight_calc.py``) и unit-тестами P1/P3/P4/P5.

        Raises:
            ValueError: если стратегия для ``schedule_type`` не
                зарегистрирована.
        """

        with self._lock:
            strategy = self._strategies.get(broadcast.schedule_type)
        if strategy is None:
            raise ValueError(
                f"unsupported schedule_type={broadcast.schedule_type!r}; "
                f"register a ScheduleModeStrategy first"
            )
        return strategy.distribute(broadcast, anti_ban, exceptions)

    # ------------------------------------------------------------------
    # Dispatch loop (called from BroadcastScheduler tick)
    # ------------------------------------------------------------------

    def dispatch_due(self) -> None:
        """Обработать все due-рассылки в новых режимах.

        Вызывается из ``BroadcastScheduler._tick()`` после его
        собственной логики (см. задачу 6.11). Не выбрасывает
        исключений: любые ошибки логируются и не валят tick.

        Алгоритм:

        1. SELECT due-рассылок по фильтру (см. docstring модуля).
           Запрос явно исключает ``approval_status='pending'`` —
           Requirement 7.4.
        2. Для каждой строки — try/except, чтобы exception в одной
           рассылке не прервал обработку остальных (Requirement 8.1).
        3. Внутри обработки одной рассылки:
           a. Defence-in-depth check: ``status != 'pending_approval'``
              и ``approval_status != 'pending'`` — двойная защита от
              рассинхрона. Если защита сработала, рассылка
              пропускается с warning-логом (Requirement 7.4 +
              задача 7.3).
           b. Поиск стратегии по ``schedule_type``. Если стратегии
              нет — warning (стартап ещё не завершён) и пропуск.
           c. Загрузка ``AntiBanConfig`` и ``CalendarException``-ов
              для ``user_id`` через инжектированные loader'ы.
           d. Вызов ``strategy.distribute(...)``. Результат логируется,
              но НЕ enqueue'ится в worker — интеграция в задаче 6.11.
        """

        try:
            rows = self._fetch_due_broadcasts()
        except Exception:
            logger.exception(
                "ScheduleModeEngine.dispatch_due: ошибка SELECT due "
                "broadcasts — tick пропущен"
            )
            return

        if not rows:
            return

        logger.debug(
            "ScheduleModeEngine.dispatch_due: %d due broadcast(s) for new modes",
            len(rows),
        )

        for row in rows:
            broadcast_id = row.get("id")
            try:
                self._dispatch_one(row)
            except Exception:
                # Per-iteration try/except — exception в одной рассылке
                # не должен валить весь tick (Requirement 8.1).
                logger.exception(
                    "ScheduleModeEngine.dispatch_due: ошибка обработки "
                    "broadcast id=%s — продолжаю с остальными",
                    broadcast_id,
                )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _dispatch_one(self, row: Mapping[str, Any]) -> None:
        """Обработать одну due-рассылку.

        Все исключения, которые здесь проброшены, ловятся вызывающим
        :meth:`dispatch_due` — поэтому здесь мы НЕ заворачиваем
        стратегию в ещё один try/except. Это даёт чистый stack-trace
        в логе и единое место обработки ошибок.
        """

        broadcast = BroadcastRow.from_db_row(row)

        # Defence-in-depth approval gate (Req 7.4 + задача 7.3).
        # SELECT-фильтр уже исключил approval_status='pending', но
        # дополнительная проверка здесь закрывает теоретический
        # рассинхрон между ``approval_status`` и ``status``: если по
        # какой-то причине broadcast прошёл SELECT (например, ``approval_status``
        # был сброшен в ``"none"``, а ``status`` остался ``"pending_approval"``
        # из-за ручного UPDATE в БД), мы всё равно его пропустим.
        # Property 13 (Approval bypass is impossible) требует жёстких
        # гарантий, и эта двойная защита их обеспечивает.
        #
        # Note (задача 7.3 verification): эта проверка является
        # авторитетным enforcement-местом approval gate на стороне
        # dispatch. Любой код, который добавляет новые callsite'ы
        # ``ScheduleModeEngine`` (например, future PreFlight через
        # ``distribute(...)``), НЕ ДОЛЖЕН обходить её — для PreFlight
        # это безопасно, потому что он вызывает ``distribute(...)``
        # без записи в БД и без enqueue в worker.
        if (
            broadcast.status == "pending_approval"
            or broadcast.approval_status == "pending"
        ):
            logger.warning(
                "ScheduleModeEngine: skip broadcast id=%s "
                "(status=%s, approval_status=%s) — pending_approval gate",
                broadcast.id,
                broadcast.status,
                broadcast.approval_status,
            )
            return

        with self._lock:
            strategy = self._strategies.get(broadcast.schedule_type)
        if strategy is None:
            logger.warning(
                "ScheduleModeEngine: no strategy for schedule_type=%s "
                "(broadcast id=%s) — skip",
                broadcast.schedule_type,
                broadcast.id,
            )
            return

        # Загрузка зависимостей стратегии. Loader'ы могут падать на
        # missing-таблицах в dev-окружении — пробрасываем exception
        # наверх в dispatch_due, который залогирует и продолжит.
        anti_ban = self._anti_ban_loader(broadcast.user_id)
        exceptions = self._exceptions_loader(broadcast.user_id)

        sends = strategy.distribute(broadcast, anti_ban, exceptions)

        logger.info(
            "ScheduleModeEngine: planned %d send(s) for broadcast id=%s "
            "schedule_type=%s",
            len(sends),
            broadcast.id,
            broadcast.schedule_type,
        )

        # TODO(task 6.11): enqueue `sends` в Broadcast_Worker.
        # На текущем этапе диспетчер только планирует и логирует
        # результат — фактическая отправка интегрируется в задаче
        # 6.11 вместе с регистрацией стратегий в app.py.

    def _fetch_due_broadcasts(self) -> list[dict[str, Any]]:
        """SELECT due-рассылок из ``scheduled_broadcasts``.

        Возвращает обычные dict-строки. Конверсия в
        :class:`BroadcastRow` — на стороне :meth:`_dispatch_one`,
        чтобы тесты могли подавать сырые dict'ы без psycopg2.

        SQL-фильтр сделан так, чтобы:

        * ``schedule_type`` ограничивался множеством новых режимов —
          старые типы (``exact``/``drip``/``recurring``) обслуживает
          ``BroadcastScheduler`` (Requirement 1.1, 2.1, 3.1, 8.1);
        * ``status='scheduled'`` — мы НЕ обрабатываем уже running
          (это делает ``BroadcastScheduler``) и тем более не трогаем
          terminal-статусы (``completed``, ``failed``, ``cancelled``,
          ``rejected``);
        * ``next_run_at <= NOW()`` — стандартный due-критерий;
        * ``approval_status != 'pending'`` — Requirement 7.4 на
          уровне SQL, чтобы pending-approval-рассылки даже не
          доходили до Python-логики.

        ``ORDER BY next_run_at ASC`` — обрабатываем «самые
        просроченные» в первую очередь, как и существующий
        scheduler. ``LIMIT 50`` — защита от резкого пика; следующий
        tick подберёт остальное.
        """

        # Lazy import: тесты с инжектированной фабрикой могут не
        # иметь psycopg2 в окружении.
        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        rows: list[dict[str, Any]] = []
        with closing(self._db_connection_factory()) as conn:
            if psycopg2_extras is not None:
                cur_factory = psycopg2_extras.RealDictCursor
                cur_ctx = conn.cursor(cursor_factory=cur_factory)
            else:
                cur_ctx = conn.cursor()
            with cur_ctx as cur:
                cur.execute(
                    """
                    SELECT *
                      FROM scheduled_broadcasts
                     WHERE schedule_type IN %s
                       AND status = 'scheduled'
                       AND next_run_at IS NOT NULL
                       AND next_run_at <= NOW()
                       AND approval_status <> 'pending'
                     ORDER BY next_run_at ASC
                     LIMIT %s
                    """,
                    (DISPATCHED_SCHEDULE_TYPES, _DUE_BATCH_LIMIT),
                )
                for row in cur.fetchall():
                    rows.append(dict(row))
        return rows

    def _default_exceptions_loader(self, user_id: str) -> list[Any]:
        """Loader ``CalendarException`` по умолчанию.

        Читает таблицу ``calendar_exceptions`` через ту же
        DB-фабрику, что и :meth:`_fetch_due_broadcasts`. Возвращает
        список dict-строк; конкретная стратегия сама интерпретирует
        формат (он зафиксирован в design.md и в Prisma-модели).

        В случае любой ошибки БД (отсутствует таблица в dev-окружении,
        отвалилось соединение) — возвращает пустой список. Это
        безопасный нейтральный элемент: «нет исключений ⇒ всё окно
        usable». Альтернатива (raise) приводила бы к гарантированному
        skip-у broadcast'а на каждом tick, что хуже, чем «временно
        игнорировать exceptions» — последнее закрывается следующим
        успешным tick'ом после восстановления соединения.
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

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
                        SELECT *
                          FROM calendar_exceptions
                         WHERE user_id = %s
                        """,
                        (user_id,),
                    )
                    return [dict(r) for r in cur.fetchall()]
        except Exception:
            logger.exception(
                "ScheduleModeEngine._default_exceptions_loader: "
                "не удалось прочитать calendar_exceptions для "
                "user_id=%s — возвращаю пустой список",
                user_id,
            )
            return []


def _default_anti_ban_loader(user_id: str) -> Any:
    """Loader ``AntiBanConfig`` по умолчанию.

    Делегирует в singleton ``anti_ban.config_loader.config_loader``,
    который уже реализует TTL-кэш и graceful fallback на дефолты при
    проблемах с БД (см. ``anti_ban/config_loader.py``).

    Импорт лениво внутри функции, чтобы избежать циклических
    зависимостей при импорте пакета ``scheduling`` из ``app.py``,
    где ``anti_ban`` подгружается в той же фазе старта.
    """

    from anti_ban.config_loader import config_loader as _config_loader

    return _config_loader.get(user_id)
