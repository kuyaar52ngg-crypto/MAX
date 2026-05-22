"""scheduling package: distribution engines, daemon workers and helper
modules for the broadcast-scheduling-suite feature.

Этот пакет — расширение к уже существующему планировщику
(``scheduler.py``) и broadcast worker'у. На этом этапе он экспортирует
только базовые типы и общий логгер; распределяющие движки
(``WindowEngine``, ``SmartTimeEngine``, ``ABTimeEngine``, ``BurstEngine``),
``Schedule_Mode_Engine``, ``Auto_Snooze_Watcher`` и
``Notification_Dispatcher`` подключаются последующими задачами и
регистрируются в ``app.py`` рядом с существующими singletonами
``BroadcastScheduler`` и ``Watchdog``.

Импорт пакета не имеет побочных эффектов — он только подгружает
определения типов и фабрику логгера. Фоновые потоки запускаются
явно из ``app.py`` (см. задачу 6.11).
"""

from scheduling.burst_engine import BurstEngine
from scheduling.engine import (
    BroadcastRow,
    DISPATCHED_SCHEDULE_TYPES,
    ScheduleModeEngine,
    ScheduleModeStrategy,
)
from scheduling.logger import logger
from scheduling.types import (
    Histogram,
    Hour,
    Phone,
    ScheduledSend,
    ScheduleType,
    SchedulingError,
    UserId,
)
from scheduling.window_engine import WindowEngine

__all__ = [
    "BroadcastRow",
    "BurstEngine",
    "DISPATCHED_SCHEDULE_TYPES",
    "Histogram",
    "Hour",
    "Phone",
    "ScheduleModeEngine",
    "ScheduleModeStrategy",
    "ScheduleType",
    "ScheduledSend",
    "SchedulingError",
    "UserId",
    "WindowEngine",
    "logger",
]


def __getattr__(name: str):
    """Lazy re-exports of optional submodules.

    ``preflight_calc`` импортирует :class:`ActivityAnalyzer`, который в
    свою очередь требует ``DATABASE_URL`` через psycopg2. Чтобы
    ``import scheduling`` оставался "import without side effects" даже
    в окружениях без psycopg2, выгружаем тяжёлые символы по требованию.
    """

    if name in {"PreFlightServerResult", "run_preflight", "validate_window"}:
        from scheduling import preflight_calc  # local import: lazy

        return getattr(preflight_calc, name)
    if name in {
        "NotificationDispatcher",
        "NotificationRow",
        "decrypt_aes_gcm",
        "EncryptionKeyMissingError",
        "EncryptionKeyInvalidError",
    }:
        # Lazy: notification_dispatcher вытаскивает ``cryptography`` и
        # ``httpx`` лениво, но сам модуль импортируется без побочек.
        # Лениво экспонируем символ, чтобы порядок импорта в ``app.py``
        # не зависел от готовности cryptography в окружении.
        from scheduling import notification_dispatcher  # local import: lazy

        return getattr(notification_dispatcher, name)
    if name in {"RescheduleResult", "RESCHEDULE_VALID_STATUSES"} or name == "reschedule_execute":
        # Lazy: reschedule_op требует psycopg2 в production, поэтому
        # экспонируем символы по требованию. ``reschedule_execute`` —
        # alias для функции ``execute``, чтобы избежать коллизии с
        # потенциальной встроенной ``execute`` в неймспейсе пакета.
        from scheduling import reschedule_op  # local import: lazy

        if name == "reschedule_execute":
            return reschedule_op.execute
        return getattr(reschedule_op, name)
    raise AttributeError(f"module 'scheduling' has no attribute {name!r}")
