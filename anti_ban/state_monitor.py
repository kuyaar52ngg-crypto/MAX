"""StateMonitor — фоновый поток, опрашивающий ``getStateInstance``
GREEN-API и публикующий результат в SSE-каналы прогресса.

Поведение (см. design.md, секция "Components/Interfaces" и
Requirements 3.1, 3.2, 3.4, 3.5, 3.6):

* Запускается как daemon-thread, чтобы не мешать корректному завершению
  Flask-приложения. Поток сам прерывается, когда событие ``_stop``
  установлено внешним кодом (например, при остановке всех SSE-подписок).
* Стартует лениво — при первом подключении к ``/api/check-contacts/progress``
  или ``/api/broadcast/progress`` (см. design.md, "Поток выполнения" и
  таблицу "Потоковая модель"). Здесь модуль не управляет жизненным
  циклом — это делает ``app.py``.
* Между тиками используется ``self._stop.wait(timeout=...)`` вместо
  ``sleep()``, чтобы вызов :meth:`StateMonitor.stop` гарантированно
  пробуждал поток в пределах одного интервала опроса.

Все источники недетерминизма (``time.time``, ``time.sleep`` через
``Event.wait``) и фабрика ``MaxBot`` инжектируются через DI, что
позволяет property-тестам подменять их на ``FakeClock``/``FakeSleep``
и моки бота (см. design.md, секцию "Testing Strategy").
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Optional

from anti_ban.config import (
    AntiBanConfig,
    HEALTHY,
    NEUTRAL,
    UNHEALTHY,
    UNKNOWN,
)
from anti_ban.registry import OperationRunRegistry, RunHandle


__all__ = ["StateMonitor"]


# Каналы SSE, в которые публикуется событие ``state``. Каналы по
# именам совпадают с полем ``RunHandle.kind`` и с путями
# ``/api/check-contacts/progress`` / ``/api/broadcast/progress``.
_CHANNELS: tuple[str, ...] = ("check", "broadcast")


class StateMonitor(threading.Thread):
    """Фоновый поток-наблюдатель за ``Instance_State``.

    Параметры конструктора передаются как keyword-only, чтобы
    исключить путаницу при множественных DI-аргументах.

    Args:
        config: иммутабельная конфигурация ``AntiBanConfig`` (берёт
            ``state_poll_interval_seconds`` из неё).
        registry: реестр активных ``Bulk_Operation``; при переходе в
            ``UNHEALTHY`` поток ставит ``cancel_event.set()`` для всех
            handle-ов в реестре.
        audit_logger: объект с методами ``log_incident`` и
            ``finish_run`` (контракт см. design.md, ``AuditLogger``).
            Может быть ``None`` — тогда инциденты не логируются (это
            полезно в ранних property-тестах до интеграции БД).
        bot_factory: callable без аргументов, возвращающий объект с
            методом ``get_state() -> str | None``. Используется
            фабрика, а не конкретный инстанс, потому что учётные
            данные пользователя могут меняться между тиками.
        publish: callable ``(channel: str, event: dict) -> None`` для
            рассылки SSE-события всем подписчикам канала. ``None``
            отключает публикацию (например, в unit-тестах).
        clock: источник текущего времени для DI; по умолчанию
            ``time.time``. Зарезервирован для будущего использования
            (например, для логирования времени тика).
        sleep: совместимый со ``time.sleep`` callable. Не используется
            напрямую — вместо него ``Event.wait`` обеспечивает
            прерываемый sleep, — но принимается для совместимости с
            интерфейсом DI остальных компонентов ``anti_ban``.
    """

    def __init__(
        self,
        *,
        config: AntiBanConfig,
        registry: OperationRunRegistry,
        bot_factory: Callable[[], Any],
        audit_logger: Any = None,
        publish: Optional[Callable[[str, dict], None]] = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__(name="anti_ban.StateMonitor", daemon=True)
        self._config = config
        self._registry = registry
        self._audit = audit_logger
        self._bot_factory = bot_factory
        self._publish = publish
        self._clock = clock
        self._sleep = sleep  # noqa: F841 — kept for DI symmetry; see docstring.
        self._stop = threading.Event()
        # Последнее опубликованное значение state. Используется только для
        # отладки/логирования; решение «что делать при UNHEALTHY» принимается
        # на каждом тике независимо, чтобы ни один handle, добавленный после
        # перехода в нездоровое состояние, не был пропущен.
        self.last_state: Optional[str] = None

    # ------------------------------------------------------------------ run --

    def run(self) -> None:
        """Цикл опроса: poll → publish → react → wait.

        Каждая итерация:

        1. Получает свежий инстанс бота через ``bot_factory`` и
           вызывает ``get_state()``. Любое исключение нормализуется в
           ``UNKNOWN``.
        2. Нормализует значение: если оно не входит ни в одно из
           множеств ``HEALTHY``/``UNHEALTHY``/``NEUTRAL`` (включая
           ``None`` и нестроковые ответы) — заменяет на ``UNKNOWN``.
           Это поведение реализует Requirement 3.6.
        3. Публикует событие ``{"type": "state", "value": state}`` во
           все каналы прогресса.
        4. Если ``state`` входит в ``UNHEALTHY``, помечает все
           активные операции как отменённые и фиксирует инцидент
           (Requirements 3.4, 3.5).
        5. Ждёт ``state_poll_interval_seconds`` (с возможностью
           прерывания через :meth:`stop`).
        """
        interval = float(self._config.state_poll_interval_seconds)

        while not self._stop.is_set():
            state = self._poll_state()
            self.last_state = state

            self._broadcast_state(state)

            if state in UNHEALTHY:
                self._react_unhealthy(state)

            # ``Event.wait`` возвращает True, если событие установили в
            # процессе ожидания; в этом случае выходим без лишнего тика.
            if self._stop.wait(timeout=interval):
                break

    def stop(self) -> None:
        """Запросить корректную остановку потока.

        Пробуждает спящий ``Event.wait`` и заставляет ``run`` выйти из
        цикла не позже одного оставшегося интервала опроса.
        """
        self._stop.set()

    # --------------------------------------------------------------- helpers --

    def _poll_state(self) -> str:
        """Получить текущее значение ``Instance_State`` или ``UNKNOWN``.

        Любое исключение в ``bot_factory`` или ``get_state`` молча
        переводит результат в ``UNKNOWN`` (Requirement 3.6: ошибки
        опроса не должны блокировать новые операции).
        """
        try:
            bot = self._bot_factory()
            raw = bot.get_state()
        except Exception:
            return UNKNOWN

        if not isinstance(raw, str):
            return UNKNOWN
        if raw in HEALTHY or raw in UNHEALTHY or raw in NEUTRAL:
            return raw
        return UNKNOWN

    def _broadcast_state(self, state: str) -> None:
        """Опубликовать SSE-событие ``state`` во все каналы прогресса.

        Канал передаётся первым параметром в ``publish``; формат
        события согласован с расширением SSE из design.md
        (Requirements 3.1, 3.2). Если ``publish`` не задан — no-op.
        """
        if self._publish is None:
            return
        event = {"type": "state", "value": state}
        for channel in _CHANNELS:
            try:
                self._publish(channel, event)
            except Exception:
                # Подписчик мог отключиться между тиками; такая ошибка
                # не должна валить мониторинг и не должна мешать
                # обработке UNHEALTHY ниже по стеку.
                continue

    def _react_unhealthy(self, state: str) -> None:
        """Реакция на переход в ``UNHEALTHY`` (Requirements 3.4, 3.5).

        Для каждой активной ``Bulk_Operation`` в реестре:

        * выставить ``cancel_event`` — worker увидит флаг между
          запросами GREEN-API и завершит цикл;
        * записать инцидент с ``kind == state``;
        * перевести ``OperationRun.status`` в ``"banned"`` с указанием
          конкретного нездорового состояния в ``reason``.

        Замечание о ``user_id``: ``RunHandle`` сейчас не содержит
        ``user_id`` владельца операции, а ``StateMonitor`` работает в
        фоне без HTTP-контекста. Публиковать инцидент без поля
        ``user_id`` нельзя (требование схемы), поэтому передаётся
        пустая строка как явный маркер «owner-less системного
        инцидента»; компоненты, обрабатывающие инциденты на стороне
        worker (``app.py`` в задачах 11.x/12.x), могут продублировать
        запись с корректным ``user_id``. Этот компромисс
        зафиксирован в design.md и будет уточнён, когда `RunHandle`
        получит поле ``user_id``.
        """
        handles = self._registry.snapshot()
        for handle in handles:
            self._cancel_handle(handle, state)

    def _cancel_handle(self, handle: RunHandle, state: str) -> None:
        """Отменить одну операцию и записать сопутствующие артефакты.

        Любая ошибка ``audit_logger`` логируется как no-op (через
        перехват ``Exception``), чтобы один сбой БД не мешал отмене
        остальных активных операций — это обязательное свойство для
        Property 9 ("Unhealthy state aborts within poll interval").
        """
        # Главное — мгновенно блокировать дальнейшие запросы GREEN-API.
        handle.cancel_event.set()

        if self._audit is None:
            return

        details = {
            "state": state,
            "source": "state_monitor",
            "kind": handle.kind,
        }
        try:
            self._audit.log_incident(
                user_id="",
                run_id=handle.run_id,
                kind=state,
                details=details,
            )
        except Exception:
            pass

        try:
            self._audit.finish_run(
                handle.run_id,
                status="banned",
                reason=state,
            )
        except Exception:
            pass
