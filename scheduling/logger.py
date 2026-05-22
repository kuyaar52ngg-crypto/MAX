"""Общий логгер для пакета ``scheduling``.

Все модули пакета (``engine``, ``window_engine``, ``smart_time_engine``,
``ab_time_engine``, ``burst_engine``, ``activity_analyzer``,
``preflight_calc``, ``auto_snooze_watcher``, ``notification_dispatcher``,
``reschedule_op``) логируют через единый ``logging.getLogger("scheduling")``.

Здесь намеренно НЕ конфигурируется ``basicConfig`` или хэндлеры —
конфигурация логирования лежит на ``app.py`` (см. ``logging.basicConfig``
в начале того модуля). Импорт ``scheduling.logger`` побочных эффектов
не вызывает.
"""

from __future__ import annotations

import logging

#: Корневой логгер пакета. Дочерние логгеры можно получать через
#: ``logger.getChild("window_engine")`` и т.п., все они унаследуют
#: общую конфигурацию из ``app.py``.
logger: logging.Logger = logging.getLogger("scheduling")

__all__ = ["logger"]
