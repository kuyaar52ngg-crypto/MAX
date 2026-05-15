"""Сериализация и десериализация payload для `OperationRun`.

Формат payload (см. design.md, секция «`OperationRun.payload` — формат»)::

    {
        "contacts": [
            {"phone": "79991234567", "name": "Alice", "_message": "..."}
        ],
        "params": {
            "message_template": "Hi {name}",
            "use_typing": true,
            "file_url": null,
            "file_name": null,
            "delay": 5.0
        }
    }

`Operation_Run.payload` хранится как JSON в Postgres (Prisma `Json`) и должен
сериализоваться/десериализоваться без потерь (round-trip property —
Requirement 10.3). При невалидном payload (не JSON / нет ключа `contacts`
со списком) возбуждается :class:`PayloadValidationError`, чтобы вызывающий
код мог вернуть HTTP 422 (Requirement 10.4).
"""

from __future__ import annotations

import json
from typing import Any


class PayloadValidationError(Exception):
    """Возбуждается, когда `Operation_Run.payload` невалиден.

    Используется обработчиком `/api/bulk-operation/resume` для возврата
    HTTP 422 (Requirement 10.4): payload не парсится как JSON или не
    содержит ключ ``contacts`` со списком.
    """


def serialize_payload(contacts: list[dict], params: dict) -> str:
    """Сериализовать payload в JSON-строку.

    Использует ``ensure_ascii=False``, чтобы кириллические имена и
    сообщения не экранировались в ``\\uXXXX`` и payload оставался
    читаемым в БД и логах.

    Args:
        contacts: список контактов (каждый — ``dict`` с обязательным
            ключом ``phone`` и опциональными строковыми полями).
        params: словарь параметров запуска (``message_template``,
            ``use_typing``, ``file_url``, ``file_name``, ``delay`` и т.п.).

    Returns:
        JSON-строка вида ``{"contacts": [...], "params": {...}}``.

    Validates: Requirements 10.1
    """
    return json.dumps(
        {"contacts": contacts, "params": params},
        ensure_ascii=False,
    )


def deserialize_payload(raw: str) -> dict:
    """Распарсить и провалидировать payload `Operation_Run`.

    Args:
        raw: исходная JSON-строка из ``Operation_Run.payload``.

    Returns:
        Словарь с ключами ``contacts`` (``list[dict]``) и ``params``
        (``dict``; ``{}`` если поле отсутствовало в исходном payload).

    Raises:
        PayloadValidationError: если ``raw`` не является валидным JSON,
            если результат не ``dict``, если ключ ``contacts`` отсутствует
            или его значение не ``list``.

    Validates: Requirements 10.2, 10.4
    """
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PayloadValidationError(f"invalid json: {exc}") from exc

    if not isinstance(parsed, dict):
        raise PayloadValidationError(
            f"payload must be a JSON object, got {type(parsed).__name__}"
        )

    if "contacts" not in parsed:
        raise PayloadValidationError("payload missing required key 'contacts'")

    contacts = parsed["contacts"]
    if not isinstance(contacts, list):
        raise PayloadValidationError(
            f"payload 'contacts' must be a list, got {type(contacts).__name__}"
        )

    params = parsed.get("params", {})
    if not isinstance(params, dict):
        raise PayloadValidationError(
            f"payload 'params' must be an object, got {type(params).__name__}"
        )

    return {"contacts": contacts, "params": params}
