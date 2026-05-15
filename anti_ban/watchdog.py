"""Watchdog — фоновый поток-страховка для зависших ``Bulk_Operation``.

Поведение (см. design.md, секция "Components/Interfaces → Watchdog" и
"Watchdog" sequence diagram, Requirements 5.3, 5.4, 5.5):

* Стартует один раз при инициализации Flask-приложения (см. задачу 15.1)
  и работает как daemon-thread, чтобы не мешать корректному завершению
  процесса.
* На каждом такте интервалом ``watchdog_check_interval_seconds`` берёт
  поверхностный снимок реестра ``OperationRunRegistry.snapshot()`` и
  для каждого ``RunHandle`` проверяет, не превысила ли «тишина»
  (отсутствие прогресса) порог ``watchdog_timeout_seconds``.
* При срабатывании выполняет четыре действия в строго определённом
  порядке:

  1. ``handle.cancel_event.set()`` — мгновенно блокирует worker от
     отправки следующего запроса GREEN-API. Это самое важное действие,
     поэтому оно идёт первым и не оборачивается в try/except.
  2. Сброс глобального флага в ``app.py`` (``_check_active`` /
     ``_broadcast_active``) через инжектированный callback.
  3. SSE-broadcast события ``{"finished": true, "reason":
     "watchdog_timeout"}`` всем подписчикам соответствующего
     progress-канала, чтобы фронтенд мог корректно сбросить
     ``massChecking`` / ``broadcasting`` без ожидания таймаута на
     стороне клиента.
  4. Запись ``Incident_Log(kind="watchdog_reset")`` и финализация
     ``OperationRun.status = "aborted"`` через ``AuditLogger``.

* После всех side-effects handle снимается из реестра
  (``registry.deregister``), чтобы повторное срабатывание watchdog для
  той же операции было невозможным.
* Между тиками используется ``self._stop.wait(timeout=...)`` вместо
  ``sleep()``, чтобы вызов :meth:`Watchdog.stop` гарантированно
  пробуждал поток в пределах одного оставшегося интервала проверки.

Все источники недетерминизма (``time.time``, ``time.sleep`` через
``Event.wait``) инжектируются через DI, что позволяет
property-тестам (см. задачи 7.2, 7.3) подменять их на ``FakeClock``
и быстро прокручивать сотни тиков без реальных пауз.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Optional

from anti_ban.config import AntiBanConfig
from anti_ban.registry import OperationRunRegistry, RunHandle


__all__ = ["Watchdog"]


# Тип callback-а для сброса глобальных флагов в ``app.py``. Принимает
# имя глобала (``"_check_active"`` либо ``"_broadcast_active"``) и
# должен установить его в ``False``. Передаётся через DI, чтобы модуль
# ``anti_ban`` не зависел напрямую от ``app.py``.
ClearGlobalFlag = Callable[[str], None]

# Тип callback-а для рассылки SSE-события всем подписчикам канала.
# Сигнатура согласована со ``StateMonitor``: ``(channel, event)``,
# где ``channel`` соответствует ``RunHandle.kind`` (``"check"`` или
# ``"broadcast"``).
PublishCallback = Callable[[str, dict], None]


class Watchdog(threading.Thread):
    """Фоновый поток-страховка от зависших ``Bulk_Operation``.

    Параметры конструктора передаются как keyword-only, чтобы исключить
    путаницу при множественных DI-аргументах.

    Args:
        config: иммутабельная конфигурация ``AntiBanConfig``. Watchdog
            читает из неё ``watchdog_check_interval_seconds`` и
            ``watchdog_timeout_seconds``.
        registry: реестр активных ``Bulk_Operation``; на каждом такте
            снимается ``snapshot()`` и проверяется ``last_progress_at``
            каждого handle.
        audit_logger: объект с методами ``log_incident`` и
            ``finish_run`` (контракт см. design.md, ``AuditLogger``).
            Может быть ``None`` — тогда инциденты не логируются (это
            полезно в ранних property-тестах до интеграции БД).
        clear_global_flag: callback ``(global_flag_name) -> None`` для
            сброса ``app._check_active`` / ``app._broadcast_active``
            в ``False``. Используется именно callback, а не прямой
            импорт ``app``, чтобы избежать циклической зависимости
            ``anti_ban`` ↔ ``app.py``. ``None`` пропускает сброс
            (например, в unit-тестах, где глобалы не используются).
        publish: callback ``(channel: str, event: dict) -> None`` для
            рассылки SSE-события всем подписчикам канала. ``None``
            отключает публикацию.
        clock: источник текущего времени для DI; по умолчанию
            ``time.time``. Используется для вычисления возраста
            ``last_progress_at``.
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
        audit_logger: Any = None,
        clear_global_flag: Optional[ClearGlobalFlag] = None,
        publish: Optional[PublishCallback] = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__(name="anti_ban.Watchdog", daemon=True)
        self._config = config
        self._registry = registry
        self._audit = audit_logger
        self._clear_global_flag = clear_global_flag
        self._publish = publish
        self._clock = clock
        self._sleep = sleep  # noqa: F841 — kept for DI symmetry; see docstring.
        self._stop = threading.Event()

    # ------------------------------------------------------------------ run --

    def run(self) -> None:
        """Цикл проверки: snapshot → detect timeouts → react → wait.

        Каждая итерация:

        1. Берёт ``clock()`` один раз и использует его как «now» для
           всех проверок в текущем такте — это исключает дрейф между
           разными handle-ами при медленных side-effects.
        2. Получает ``registry.snapshot()`` (поверхностная копия под
           локом) и итерируется по списку без удержания блокировки —
           это позволяет worker-потокам параллельно регистрировать
           или дерегистрировать другие операции.
        3. Для каждого handle с просроченным ``last_progress_at``
           выполняет полный набор side-effects через
           :meth:`_handle_timeout`.
        4. Ждёт ``watchdog_check_interval_seconds`` через
           ``Event.wait``; досрочно выходит, если запрошен ``stop``.
        """
        interval = float(self._config.watchdog_check_interval_seconds)
        timeout = float(self._config.watchdog_timeout_seconds)

        while not self._stop.is_set():
            now = self._clock()
            handles = self._registry.snapshot()
            for handle in handles:
                if now - handle.last_progress_at > timeout:
                    self._handle_timeout(handle, now=now)

            # ``Event.wait`` возвращает True, если событие установили в
            # процессе ожидания; в этом случае выходим без лишнего такта.
            if self._stop.wait(timeout=interval):
                break

    def stop(self) -> None:
        """Запросить корректную остановку потока.

        Пробуждает спящий ``Event.wait`` и заставляет ``run`` выйти из
        цикла не позже одного оставшегося интервала проверки.
        """
        self._stop.set()

    # --------------------------------------------------------------- helpers --

    def _handle_timeout(self, handle: RunHandle, *, now: float) -> None:
        """Реализует Requirement 5.4 для одного просроченного handle.

        Порядок действий важен: сначала ставим ``cancel_event``, чтобы
        worker гарантированно перестал отправлять запросы GREEN-API
        (это критичное side-effect, требуемое Requirement 5.4 в
        течение ``state_poll_interval_seconds`` после смены
        состояния). Остальные действия — best-effort и оборачиваются
        в ``try/except``: одиночный сбой БД или отвалившийся
        SSE-подписчик не должен мешать снятию следующих зависших
        операций в этом же такте.

        Замечание о ``user_id``: ``RunHandle`` сейчас не содержит
        ``user_id`` владельца операции, а ``Watchdog`` работает в
        фоне без HTTP-контекста. Публиковать инцидент без поля
        ``user_id`` нельзя (требование схемы), поэтому передаётся
        пустая строка как явный маркер «owner-less системного
        инцидента»; та же договорённость, что в
        ``StateMonitor._cancel_handle``. Когда ``RunHandle`` получит
        поле ``user_id`` (см. design.md, "Components/Interfaces →
        OperationRunRegistry"), оно будет проброшено сюда и в
        ``IncidentLog``.
        """
        # 1. Главное — мгновенно блокировать дальнейшие запросы GREEN-API.
        handle.cancel_event.set()

        # 2. Сброс глобального флага в ``app.py``. Любая ошибка
        # callback-а не должна мешать остальным side-effects.
        if self._clear_global_flag is not None:
            try:
                self._clear_global_flag(handle.global_flag_name)
            except Exception:
                pass

        # 3. Уведомить SSE-подписчиков, чтобы фронтенд не ждал
        # heartbeat-таймаута. Канал совпадает с ``handle.kind``.
        if self._publish is not None:
            try:
                self._publish(
                    handle.kind,
                    {"type": "finished", "reason": "watchdog_timeout"},
                )
            except Exception:
                pass

        # 4. Зафиксировать инцидент и финальный статус операции.
        if self._audit is not None:
            details = {
                "source": "watchdog",
                "kind": handle.kind,
                "last_progress_at": handle.last_progress_at,
                "now": now,
                "watchdog_timeout_seconds": float(
                    self._config.watchdog_timeout_seconds
                ),
            }
            try:
                self._audit.log_incident(
                    user_id="",
                    run_id=handle.run_id,
                    kind="watchdog_reset",
                    details=details,
                )
            except Exception:
                pass

            try:
                self._audit.finish_run(
                    handle.run_id,
                    status="aborted",
                    reason="watchdog_timeout",
                )
            except Exception:
                pass

        # 5. Снять handle из реестра, чтобы повторного срабатывания
        # на следующем такте не произошло. ``deregister`` идемпотентен.
        self._registry.deregister(handle.run_id)
