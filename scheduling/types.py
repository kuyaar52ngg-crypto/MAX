"""Базовые типы и исключения пакета ``scheduling``.

Содержит:

* :class:`ScheduledSend` — неизменяемая dataclass-запись об одной
  запланированной отправке (получатель + wall-clock время + произвольные
  метаданные стратегии). Используется как возвращаемое значение
  ``ScheduleModeStrategy.distribute(...)`` (см. design.md, секция
  "Components and Interfaces", ``Schedule_Mode_Engine``).
* :class:`SchedulingError` — общее исключение пакета с кодом ошибки и
  опциональным HTTP-статусом, на которое ориентируются Next.js
  API-роуты при маппинге Python-ошибок в HTTP-ответы (например
  ``WINDOW_INSUFFICIENT_TIME``, ``RESCHEDULE_INVALID_STATUS``).
* Type aliases (:data:`Phone`, :data:`UserId`, :data:`Hour`,
  :data:`Histogram`, :data:`ScheduleType`) — для читаемости сигнатур
  в остальных модулях пакета. Они НЕ влияют на runtime; все алиасы
  задаются через :pep:`613` ``TypeAlias``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Mapping, Optional, TypeAlias

#: Нормализованный номер телефона (только цифры, без префикса ``+``).
#: Длина — 10..15 символов; валидация на этапе нормализации в
#: ``app.py::clean_phone`` (повторно не дублируется здесь).
Phone: TypeAlias = str

#: UUID пользователя из Supabase ``auth.users.id``. Хранится как
#: строка во всех Python-сущностях, чтобы не тащить зависимость от
#: ``uuid.UUID`` в pure-функции распределения.
UserId: TypeAlias = str

#: Час дня в диапазоне 0..23 (включительно). Используется в
#: ``Smart_Time_Slot``, ``ABTimeTest.slots`` и ``Activity_Histogram``.
Hour: TypeAlias = int

#: Гистограмма активности — ровно 24 неотрицательных целых числа,
#: индексируемых часом дня (0..23) в часовом поясе оператора.
#: Шейп проверяется в ``ActivityAnalyzer`` (см. задачу 3.2); алиас
#: даёт читаемость, но не валидирует длину.
Histogram: TypeAlias = list[int]

#: Допустимые значения ``ScheduledBroadcast.schedule_type``. Старые
#: значения (``exact``, ``drip``, ``recurring``) обслуживаются
#: существующим ``BroadcastScheduler``; новые
#: (``window``, ``smart_time``, ``ab_time``, ``burst``) — через
#: ``ScheduleModeEngine`` (см. design.md, Architecture).
ScheduleType: TypeAlias = Literal[
    "exact",
    "drip",
    "recurring",
    "window",
    "smart_time",
    "ab_time",
    "burst",
]


@dataclass(frozen=True)
class ScheduledSend:
    """Одна запланированная отправка в результате работы стратегии.

    Объект иммутабельный (``frozen=True``), чтобы:

    * стратегии распределения (``WindowEngine``, ``SmartTimeEngine``,
      ``ABTimeEngine``, ``BurstEngine``) оставались pure-функциями и
      их выходы можно было свободно сравнивать в property-тестах
      (см. P3 — детерминизм по ``broadcast.id``);
    * вызывающий код не мог случайно перезаписать
      ``send_at``/``metadata`` post-factum после возврата из
      ``distribute(...)``.

    Поле ``metadata`` — словарь произвольной формы, ключи зависят от
    стратегии. Например:

    * Smart-Time: ``{"slot": 14, "fallback": "operator_global"}``;
    * Burst:      ``{"burst": True, "index": 0}``;
    * Window:     ``{}`` (никаких дополнительных меток не требуется).
    """

    phone: Phone
    send_at: datetime
    metadata: Mapping[str, Any] = field(default_factory=dict)


class SchedulingError(Exception):
    """Базовое исключение пакета ``scheduling``.

    Помимо сообщения несёт стабильный ``code`` (например
    ``"WINDOW_INSUFFICIENT_TIME"`` или ``"RESCHEDULE_INVALID_STATUS"``),
    который API-роуты Next.js используют как поле ``error_code`` в
    ответе клиенту, и опциональный ``http_status`` — желаемый HTTP-код
    (400 / 409 / 422 / ...). Если ``http_status`` не задан, вызывающий
    слой выбирает код самостоятельно.

    Конкретные коды перечислены в design.md и требованиях; здесь
    мы намеренно НЕ заводим Enum, чтобы не пришлось трогать общий
    модуль типов на каждый новый код ошибки.
    """

    def __init__(
        self,
        code: str,
        message: Optional[str] = None,
        *,
        http_status: Optional[int] = None,
    ) -> None:
        super().__init__(message or code)
        self.code = code
        self.http_status = http_status

    def __repr__(self) -> str:  # pragma: no cover — для удобной диагностики
        return f"SchedulingError(code={self.code!r}, http_status={self.http_status!r})"


__all__ = [
    "Histogram",
    "Hour",
    "Phone",
    "ScheduleType",
    "ScheduledSend",
    "SchedulingError",
    "UserId",
]
