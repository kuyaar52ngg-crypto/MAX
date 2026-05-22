"""Burst Mode стратегия для ``Schedule_Mode_Engine``.

Этот модуль реализует ``BurstEngine`` — стратегию режима
``schedule_type = "burst"``, описанную в design.md (раздел
«BurstEngine») и обоснованную в Requirement 8.

Ключевая особенность Burst Mode
================================

В отличие от ``WindowEngine`` / ``SmartTimeEngine`` / ``ABTimeEngine``,
``BurstEngine.distribute(...)`` **не вычисляет** индивидуальные
``send_at`` для каждого получателя. Все ``ScheduledSend``-ы получают
единый «якорный» ``send_at`` (обычно ``broadcast.scheduled_for`` или
``now()``), а фактические задержки между сообщениями определяются
broadcast worker'ом во время выполнения через :meth:`BurstEngine.delay_for`.

Это сделано намеренно по двум причинам:

* Burst Mode пропускает ``long_pause_every_n`` (Req 8.3) и принудительно
  включает ``Adaptive_Throttle`` (Req 8.4). Поэтому реальные интервалы
  между сообщениями зависят от runtime-состояния ``Adaptive_Throttle``
  (``normal`` / ``slowed`` / ``paused``), которое нельзя заранее
  предсказать в pure-функции ``distribute(...)``.
* PreFlight Preview всё же делает «оптимистичную» оценку для UI
  (анкер + ``i * delay_min``), но это сделано внутри
  ``preflight_calc._simulate_burst`` отдельно — оно нужно только для
  первичной визуализации, и, в отличие от записанного расписания,
  не имеет авторитетного значения.

Метаданные ``ScheduledSend.metadata`` содержат:

* ``"burst": True`` — признак режима, который worker использует, чтобы
  отличать burst-отправки от обычных при логировании;
* ``"index": i`` — порядковый номер в очереди отправки (0-based).
  Worker использует ``index`` для:

  - вычисления задержки через :meth:`delay_for` (хотя текущая
    реализация ``delay_for`` не зависит от индекса, мы оставляем
    параметр для будущих расширений);
  - корректного восстановления ``last_processed_index`` при
    pause/resume.

Контракт ``delay_for(message_index, anti_ban, throttle_state)``
================================================================

* ``"normal"`` → ``anti_ban.delay_min`` (без джиттера, без длинной
  паузы) — Req 8.2 и 8.3.
* ``"slowed"`` → ``anti_ban.delay_min * 1.5`` — мягкое торможение,
  которое инициируется ``Adaptive_Throttle`` после серии 429 ответов.
  Множитель 1.5 — компромиссное значение из design.md, не пересекается
  с конкретными ступенями ``Adaptive_Throttle`` state machine
  (там полная остановка инициируется на стадии ``paused``).
* ``"paused"`` — не должен вызываться: worker сам ставит broadcast
  на паузу и не запрашивает delay у движка. На случай защиты от
  бага вызывающего кода метод поднимает ``ValueError`` с явным
  кодом — это лучше, чем тихо вернуть некорректное значение.

Property 15 (см. design.md) требует:
``delay_for(i, anti_ban, ts) >= anti_ban.delay_min`` для любых
``i`` и ``ts ∈ {normal, slowed}``. Реализация явно гарантирует это
через ``max(base, ...)`` — в случае, если property-тест генерирует
``AntiBanConfig`` с экзотическим значением ``delay_min`` (например,
0.0 — теоретически возможно, хотя дефолт 3.0), мы остаёмся на
безопасной стороне, не возвращая значения меньше ``delay_min``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Final, Mapping

from anti_ban.config import AntiBanConfig
from scheduling.engine import BroadcastRow
from scheduling.types import ScheduledSend

__all__ = [
    "BurstEngine",
    "THROTTLE_NORMAL",
    "THROTTLE_SLOWED",
    "THROTTLE_PAUSED",
    "SLOWED_MULTIPLIER",
]


#: Допустимое значение ``throttle_state`` для нормального хода.
THROTTLE_NORMAL: Final[str] = "normal"

#: Допустимое значение ``throttle_state`` после серии 429-ответов —
#: задержка увеличивается умеренно, без полной остановки.
THROTTLE_SLOWED: Final[str] = "slowed"

#: ``throttle_state``, при котором worker сам ставит broadcast на
#: паузу и НЕ должен запрашивать ``delay_for`` (см. модульный
#: docstring). Перечислено как константа для явных тестов /
#: проверок в worker'е.
THROTTLE_PAUSED: Final[str] = "paused"

#: Множитель задержки в режиме ``slowed``. Зафиксирован в design.md,
#: вынесен в константу для прозрачности и потенциального тюнинга
#: без правки тела ``delay_for``.
SLOWED_MULTIPLIER: Final[float] = 1.5


def _extract_phone(contact: Any) -> str:
    """Извлечь номер телефона из элемента ``broadcast.contacts``.

    ``ScheduledBroadcast.contacts`` — JSONB-колонка, в которую
    приходят как сырые строки телефонов (``"79991234567"``), так и
    словари (``{"phone": "79991234567", ...}``). Точно та же логика
    дублируется в :class:`scheduler.BroadcastScheduler` —
    см. ``_partition_by_recipient_tz``.

    Если структура неожиданная (None, число, dict без ключа
    ``phone``), возвращается пустая строка. Валидация на верхнем
    уровне отсечёт пустые телефоны при необходимости — стратегия
    остаётся pure-функцией без побочных эффектов.
    """

    if isinstance(contact, Mapping):
        raw = contact.get("phone")
        return str(raw) if raw is not None else ""
    if contact is None:
        return ""
    return str(contact)


class BurstEngine:
    """Стратегия для ``schedule_type = "burst"``.

    Реализует :class:`scheduling.engine.ScheduleModeStrategy` — pure
    функция :meth:`distribute` (без БД, без wall-clock-побочных
    эффектов) плюс статическая утилита :meth:`delay_for`, которую
    broadcast worker вызывает внутри hot-loop'а на каждое сообщение
    (см. задачу 7.1).

    Регистрация в ``app.py`` (см. задачу 6.11):

        engine.register("burst", BurstEngine())

    Класс не имеет состояния — все экземпляры взаимозаменяемы.
    Однако мы оставляем его именно классом (а не модуль-функцией),
    чтобы он соответствовал ``ScheduleModeStrategy``-протоколу и
    при необходимости позволял позже инжектировать зависимости
    (например, источник «времени сейчас» для тестирования) без
    изменения внешнего API.
    """

    def distribute(
        self,
        broadcast: BroadcastRow,
        anti_ban: AntiBanConfig,
        exceptions: list[Any],
    ) -> list[ScheduledSend]:
        """Вернуть список «виртуальных» ``ScheduledSend`` для burst-режима.

        Все элементы получают:

        * один и тот же ``send_at`` — anchor (``broadcast.scheduled_for``
          если задан, иначе текущее UTC-время);
        * ``metadata = {"burst": True, "index": i}`` для трассировки
          и для будущей совместимости с ``BurstEngine.delay_for``.

        Дополнительные параметры (``anti_ban``, ``exceptions``) на
        этом этапе не используются — anti-ban лимиты применяются
        в worker'е через :meth:`delay_for`, а ``CalendarException``
        несовместим с burst-режимом по Req 8.8 (``quiet_hours_enabled``
        запрещён) и фильтруется на уровне API-валидации, не здесь.
        Параметры всё равно присутствуют в сигнатуре, чтобы класс
        корректно реализовывал :class:`ScheduleModeStrategy`-протокол
        (структурная совместимость с :class:`WindowEngine` и др.).

        Возвращает пустой список, если ``broadcast.contacts`` пуст —
        это валидное состояние (worker увидит 0 элементов и
        сразу закроет рассылку как ``completed``).
        """

        anchor = broadcast.scheduled_for or datetime.now(timezone.utc)

        sends: list[ScheduledSend] = []
        for i, contact in enumerate(broadcast.contacts):
            phone = _extract_phone(contact)
            sends.append(
                ScheduledSend(
                    phone=phone,
                    send_at=anchor,
                    metadata={"burst": True, "index": i},
                )
            )
        return sends

    @staticmethod
    def delay_for(
        message_index: int,
        anti_ban: AntiBanConfig,
        throttle_state: str,
    ) -> float:
        """Вернуть задержку перед отправкой сообщения с индексом ``message_index``.

        Args:
            message_index: 0-based индекс сообщения в очереди отправки.
                В текущей реализации не используется (Burst Mode не
                делает long-pause каждые N сообщений — Req 8.3); параметр
                сохранён для будущих расширений и для совместимости с
                hot-loop API broadcast worker'а.
            anti_ban: ``AntiBanConfig`` оператора. Используется только
                поле ``delay_min``; ``delay_max`` и ``long_pause_*``
                намеренно игнорируются (Req 8.2, 8.3).
            throttle_state: текущее состояние
                :class:`adaptive_throttle.AdaptiveThrottle` —
                ``"normal"`` или ``"slowed"``.

        Returns:
            Длительность паузы в секундах. Гарантируется
            ``>= anti_ban.delay_min`` (Property 15).

        Raises:
            ValueError: при ``throttle_state == "paused"`` (worker
                сам обрабатывает паузу — этот метод вызывается только
                для активных ходов) или при незнакомом значении.
        """

        # Защита от вызова в paused-state. Worker, попадая в
        # ``paused``, обязан перевести broadcast в ``status='paused'``
        # и НЕ запрашивать delay (Req 9.x). Тихо возвращать любой
        # delay в этом случае — значит маскировать баг worker'а.
        if throttle_state == THROTTLE_PAUSED:
            raise ValueError(
                f"BurstEngine.delay_for must not be called in "
                f"throttle_state={THROTTLE_PAUSED!r}; worker is "
                f"responsible for pausing the broadcast"
            )

        base = float(anti_ban.delay_min)

        if throttle_state == THROTTLE_NORMAL:
            delay = base
        elif throttle_state == THROTTLE_SLOWED:
            delay = base * SLOWED_MULTIPLIER
        else:
            # Any unexpected state is treated as a programming error —
            # better fail loudly than silently apply a default delay.
            raise ValueError(
                f"BurstEngine.delay_for: unknown throttle_state="
                f"{throttle_state!r}; expected one of "
                f"{{{THROTTLE_NORMAL!r}, {THROTTLE_SLOWED!r}}}"
            )

        # Property 15 invariant: never return less than delay_min.
        # При корректных значениях anti_ban.delay_min >= 0 и
        # throttle_state ∈ {normal, slowed} оба ветви выше уже дают
        # >= base. ``max`` остаётся для устойчивости к экзотическим
        # AntiBanConfig-инстансам (например, если поле когда-нибудь
        # отрицательное по ошибке конфигурации).
        return max(base, delay)
