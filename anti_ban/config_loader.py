"""ConfigLoader — чтение и валидация ``AntiBanConfig`` per-`user_id`.

Грузит запись из таблицы ``anti_ban_config`` через существующий
коннектор `db.get_conn` (SQLite в текущем рантайме; Prisma/Postgres
используется фронтендом). Если записи для пользователя нет — возвращает
:class:`AntiBanConfig` с дефолтами Requirement 9.2. Если самой таблицы
ещё нет (SQLite до миграций) — операция тоже мягко падает на дефолты,
чтобы запуск Flask не ломался.

Кэш — in-memory, TTL 60 секунд per-`user_id`. Кэш потокобезопасен через
`threading.Lock`. Метод :meth:`ConfigLoader.invalidate` сбрасывает запись
для одного пользователя; используется эндпойнтом
``PUT /api/anti-ban-config`` после успешного сохранения.

Также экспонируется :meth:`ConfigLoader.validate`, возвращающий список
нарушений Requirement 9.3 (пустой список = валидно). Используется
обработчиком ``PUT /api/anti-ban-config`` для возврата HTTP 400.

См. design.md, секцию «Components/Interfaces → ConfigLoader» и
Requirements 9.1, 9.2, 9.3.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import fields
from typing import Any, Callable, Mapping, Optional

import db
from anti_ban.config import AntiBanConfig


__all__ = ["ConfigLoader", "config_loader"]


# Имена обязательных параметров, для которых валидация Requirement 9.3
# применяет численные ограничения. Если ключ отсутствует в `values`,
# это считается отдельным нарушением.
_REQUIRED_KEYS: tuple[str, ...] = (
    "delay_min",
    "delay_max",
    "batch_size",
    "long_pause_seconds",
    "daily_check_limit",
    "hourly_check_limit",
)


class ConfigLoader:
    """Загрузчик и валидатор ``AntiBanConfig`` с in-memory TTL-кэшем.

    Args:
        db_connection_factory: фабрика DB-соединений; по умолчанию
            ``db.get_conn`` (SQLite). Соединение должно поддерживать
            ``with conn:`` и ``conn.execute(...)``; курсор должен
            возвращать строки с доступом по имени колонки (как
            ``sqlite3.Row``).
        clock: функция текущего времени для DI в тестах; по умолчанию
            ``time.time``.
        cache_ttl_seconds: время жизни записи в кэше; дефолт 60 секунд
            (см. design.md, секция ConfigLoader).
    """

    def __init__(
        self,
        *,
        db_connection_factory: Callable[[], Any] = db.get_conn,
        clock: Callable[[], float] = time.time,
        cache_ttl_seconds: float = 60.0,
    ) -> None:
        self._db_connection_factory = db_connection_factory
        self._clock = clock
        self._cache_ttl = float(cache_ttl_seconds)
        self._lock = threading.Lock()
        # user_id → (config, expires_at_unix_ts)
        self._cache: dict[str, tuple[AntiBanConfig, float]] = {}
        # Имена полей AntiBanConfig — используются для фильтрации
        # колонок, прочитанных из БД (схема в БД может содержать
        # дополнительные колонки, которых нет в dataclass, и наоборот).
        self._field_names: frozenset[str] = frozenset(
            f.name for f in fields(AntiBanConfig)
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def get(self, user_id: str) -> AntiBanConfig:
        """Вернуть актуальный ``AntiBanConfig`` для пользователя.

        Сначала проверяется кэш; при попадании и не истёкшем TTL —
        возвращается кэшированный экземпляр без обращения к БД. Иначе
        читается строка из ``anti_ban_config WHERE user_id = ?``. Если
        строки нет (либо таблицы ещё не существует) — возвращается
        :class:`AntiBanConfig` с дефолтами, и эта же дефолтная запись
        кэшируется на TTL, чтобы не бить БД на каждом запросе.

        Validates: Requirements 9.1, 9.2
        """
        now = self._clock()

        # --- Проверка кэша под локом ---------------------------------
        with self._lock:
            cached = self._cache.get(user_id)
            if cached is not None and cached[1] > now:
                return cached[0]

        # --- Чтение из БД вне лока, чтобы не держать блокировку во ----
        # время сетевого/файлового I/O.
        config = self._load_from_db(user_id)

        # --- Запись в кэш --------------------------------------------
        with self._lock:
            self._cache[user_id] = (config, now + self._cache_ttl)

        return config

    def invalidate(self, user_id: str) -> None:
        """Удалить кэшированную запись для пользователя.

        Вызывается из ``PUT /api/anti-ban-config`` после успешного
        UPSERT, чтобы следующий ``get`` прочитал свежие значения.
        Идемпотентно: повторный вызов на уже отсутствующем ключе —
        no-op.
        """
        with self._lock:
            self._cache.pop(user_id, None)

    def validate(self, values: Mapping[str, Any]) -> list[str]:
        """Проверить значения конфигурации против Requirement 9.3.

        Returns:
            Список читаемых строк-нарушений. Пустой список означает,
            что значения валидны и могут быть сохранены в БД.

        Правила Requirement 9.3:

        * ``delay_min >= 1.0``
        * ``delay_max >= delay_min``
        * ``batch_size >= 1``
        * ``long_pause_seconds >= 0``
        * ``daily_check_limit >= 1``
        * ``hourly_check_limit >= 1``

        Если ключ отсутствует в ``values``, возвращается отдельное
        нарушение ``"<key> is required"``. Если значение не приводится к
        числу — возвращается нарушение ``"<key> must be a number, got
        <repr>"``.

        Validates: Requirements 9.3
        """
        violations: list[str] = []

        # 1) Все требуемые ключи должны присутствовать.
        for key in _REQUIRED_KEYS:
            if key not in values:
                violations.append(f"{key} is required")

        # 2) Численные ограничения — применяем только если ключ есть и
        #    валиден как число; иначе — отдельное нарушение типа.
        delay_min = self._coerce_number(values, "delay_min", violations)
        delay_max = self._coerce_number(values, "delay_max", violations)
        batch_size = self._coerce_number(values, "batch_size", violations)
        long_pause_seconds = self._coerce_number(
            values, "long_pause_seconds", violations
        )
        daily_check_limit = self._coerce_number(
            values, "daily_check_limit", violations
        )
        hourly_check_limit = self._coerce_number(
            values, "hourly_check_limit", violations
        )

        if delay_min is not None and delay_min < 1.0:
            violations.append(
                f"delay_min must be >= 1.0, got {delay_min}"
            )
        if (
            delay_min is not None
            and delay_max is not None
            and delay_max < delay_min
        ):
            violations.append(
                f"delay_max must be >= delay_min ({delay_min}), got {delay_max}"
            )
        if batch_size is not None and batch_size < 1:
            violations.append(
                f"batch_size must be >= 1, got {batch_size}"
            )
        if long_pause_seconds is not None and long_pause_seconds < 0:
            violations.append(
                f"long_pause_seconds must be >= 0, got {long_pause_seconds}"
            )
        if daily_check_limit is not None and daily_check_limit < 1:
            violations.append(
                f"daily_check_limit must be >= 1, got {daily_check_limit}"
            )
        if hourly_check_limit is not None and hourly_check_limit < 1:
            violations.append(
                f"hourly_check_limit must be >= 1, got {hourly_check_limit}"
            )

        return violations

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _load_from_db(self, user_id: str) -> AntiBanConfig:
        """Прочитать строку конфига из БД или вернуть дефолты.

        Любые операционные ошибки SQLite (отсутствующая таблица, файл
        БД, locked) трактуются как «записи нет» и возвращают дефолты —
        это предохранитель на случай, когда фронтенд-миграция Prisma
        ещё не выполнена в текущей среде.
        """
        try:
            conn = self._db_connection_factory()
        except Exception:
            # Соединение не удалось получить — мягкая деградация.
            return AntiBanConfig()

        try:
            with conn:
                row = conn.execute(
                    "SELECT * FROM anti_ban_config WHERE user_id = ? LIMIT 1",
                    (user_id,),
                ).fetchone()
        except sqlite3.OperationalError:
            # Таблица anti_ban_config ещё не создана — дефолты.
            return AntiBanConfig()
        except Exception:
            # Любая другая ошибка БД — не падать, отдать дефолты.
            return AntiBanConfig()
        finally:
            try:
                conn.close()
            except Exception:
                pass

        if row is None:
            return AntiBanConfig()

        return self._row_to_config(row)

    def _row_to_config(self, row: Any) -> AntiBanConfig:
        """Сконструировать ``AntiBanConfig`` из DB-строки.

        Принимает ``sqlite3.Row`` или любой mapping-подобный объект.
        Колонки, которых нет среди полей dataclass, игнорируются. Поля
        dataclass, отсутствующие в строке, остаются с дефолтами.
        """
        try:
            row_keys = set(row.keys())  # sqlite3.Row / dict / Mapping
        except AttributeError:
            row_keys = set()

        kwargs: dict[str, Any] = {}
        for name in self._field_names & row_keys:
            value = row[name]
            if value is None:
                # NULL в БД — оставляем дефолт dataclass.
                continue
            kwargs[name] = value

        try:
            return AntiBanConfig(**kwargs)
        except TypeError:
            # На случай, если БД содержит несовместимый тип (например,
            # строку вместо float) — лучше отдать дефолты, чем 500.
            return AntiBanConfig()

    @staticmethod
    def _coerce_number(
        values: Mapping[str, Any],
        key: str,
        violations: list[str],
    ) -> Optional[float]:
        """Привести значение к числу или зарегистрировать нарушение.

        Returns ``None``, если ключ отсутствует или значение не
        приводится к числу. ``bool`` в Python — подкласс ``int``, но в
        контексте конфигурации это явно ошибка типа, поэтому
        отвергается отдельно.
        """
        if key not in values:
            return None
        raw = values[key]
        if isinstance(raw, bool):
            violations.append(f"{key} must be a number, got bool")
            return None
        if isinstance(raw, (int, float)):
            return float(raw)
        violations.append(f"{key} must be a number, got {type(raw).__name__}")
        return None


# Module-level singleton для импорта в `app.py` (Requirement 9.1).
config_loader = ConfigLoader()
