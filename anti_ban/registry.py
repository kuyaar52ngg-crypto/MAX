"""OperationRunRegistry — потокобезопасная in-memory таблица активных
массовых операций (`Bulk_Operation`).

Используется `app.py` (worker-потоками `Bulk_Check_Service` /
`Broadcast_Service`), `Watchdog` и эндпойнтами
`/api/bulk-operation/stop` для координации отмены операций и проверки
их живости.

См. design.md, секцию "Components/Interfaces → OperationRunRegistry"
и Requirements 5.1, 5.5, 7.6.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional


__all__ = ["RunHandle", "OperationRunRegistry", "registry"]


@dataclass
class RunHandle:
    """Дескриптор активной массовой операции в реестре.

    Attributes:
        run_id: идентификатор `OperationRun` в БД.
        cancel_event: флаг отмены; worker проверяет `is_set()` между
            запросами GREEN-API. Установка через `cancel()` или
            `Watchdog`.
        last_progress_at: unix-timestamp последнего прогресса
            (heartbeat); используется `Watchdog` для детекта
            зависших операций.
        kind: тип операции — ``"check"`` или ``"broadcast"``.
        global_flag_name: имя глобального флага в `app.py`
            (``"_check_active"`` или ``"_broadcast_active"``), который
            должен быть сброшен при завершении/отмене операции.
    """

    run_id: int
    cancel_event: threading.Event
    last_progress_at: float
    kind: str
    global_flag_name: str


class OperationRunRegistry:
    """Потокобезопасный реестр активных `Bulk_Operation`.

    Внутренний `threading.Lock` защищает словарь `_handles`. Метод
    `snapshot()` возвращает поверхностную копию значений под локом и
    отдаёт её наружу, чтобы вызывающий мог итерироваться без
    удержания блокировки.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handles: dict[int, RunHandle] = {}

    def register(self, run_id: int, handle: RunHandle) -> None:
        """Зарегистрировать активную операцию.

        Перезаписывает существующий handle для того же `run_id`, если
        он каким-то образом остался в реестре после некорректного
        завершения предыдущего worker-потока.
        """
        with self._lock:
            self._handles[run_id] = handle

    def deregister(self, run_id: int) -> bool:
        """Удалить операцию из реестра.

        Returns:
            ``True`` если запись существовала и удалена, иначе ``False``.
        """
        with self._lock:
            return self._handles.pop(run_id, None) is not None

    def get(self, run_id: int) -> Optional[RunHandle]:
        """Получить handle по `run_id` или ``None``, если нет."""
        with self._lock:
            return self._handles.get(run_id)

    def heartbeat(self, run_id: int, *, now: Optional[float] = None) -> None:
        """Обновить `last_progress_at` для активной операции.

        Если операция уже не в реестре (например, успела
        дерегистрироваться) — тихо игнорируется.

        Args:
            run_id: идентификатор операции.
            now: явное время для DI в тестах; по умолчанию
                ``time.time()``.
        """
        ts = time.time() if now is None else now
        with self._lock:
            handle = self._handles.get(run_id)
            if handle is not None:
                handle.last_progress_at = ts

    def cancel(self, run_id: int) -> bool:
        """Установить `cancel_event` для операции.

        Returns:
            ``True`` если handle найден и событие установлено;
            ``False`` если операции нет в реестре. Идемпотентно: повторный
            вызов на уже отменённой операции возвращает ``True``.
        """
        with self._lock:
            handle = self._handles.get(run_id)
        if handle is None:
            return False
        handle.cancel_event.set()
        return True

    def snapshot(self) -> list[RunHandle]:
        """Вернуть поверхностную копию активных handle-ов.

        Копирование выполняется под локом; итерация по списку
        вызывающим кодом происходит уже без блокировки, поэтому
        длительный проход (например, `Watchdog`) не блокирует
        регистрацию/отмену других операций.
        """
        with self._lock:
            return list(self._handles.values())

    def is_active(self, kind: str) -> bool:
        """Есть ли в реестре хотя бы одна операция указанного `kind`."""
        with self._lock:
            return any(h.kind == kind for h in self._handles.values())


# Singleton-инстанс для импорта из `app.py`, `watchdog.py` и эндпойнтов
# управления (`/api/bulk-operation/stop`, `/api/bulk-operation/resume`).
registry = OperationRunRegistry()
