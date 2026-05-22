"""Notification_Dispatcher — daemon thread доставки уведомлений.

Этот модуль реализует ``NotificationDispatcher`` — фоновый поток,
описанный в design.md (раздел «Notification_Dispatcher») и
обоснованный Requirements 10.4 / 10.5 / 10.6 / 10.7 / 10.11 / 10.12
спеки ``broadcast-scheduling-suite``.

Архитектура и контракт
======================

* tick = 5 секунд (``POLL_INTERVAL_SECONDS``);
* SELECT берёт из таблицы ``notifications`` строки с
  ``dispatch_status='pending'`` AND ``dispatch_attempts < MAX_ATTEMPTS``,
  упорядоченные по ``created_at ASC`` LIMIT 50;
* для каждой строки читается ``preference_snapshot`` (НЕ live
  ``NotificationPreference``) — Requirement 10.4: snapshot-at-creation
  семантика, поэтому изменение ``NotificationPreference`` после
  создания уведомления НЕ влияет на доставку;
* для каждого канала из snapshot, не присутствующего в
  ``dispatched_channels``, выполняется попытка ``_send`` —
  Requirement 10.12: после первого 200 OK канал НЕ повторяется;
* in-app — no-op: запись уже доступна через ``GET /api/notifications``,
  Requirement 10.5;
* email — HTTP relay в Next.js ``/api/notifications/email-relay``
  с shared secret в заголовке ``X-Notification-Relay-Secret``
  (env ``NOTIFICATION_RELAY_SECRET``); сам relay-эндпойнт
  реализуется задачей 9.14;
* telegram — прямой ``httpx.post(<bot_api_url>/sendMessage,
  json={chat_id, text})`` с расшифровкой ``Profile.telegram_bot_token``
  через ``INSTANCE_ENCRYPTION_KEY`` (тот же AES-256-GCM, что и для
  ``GreenInstance.api_token``);
* при отсутствии email-провайдера — log warning ОДИН раз per process
  start (Requirement 10.6);
* retry с back-off 15s/60s/240s — Requirement 10.11. Отсчёт ведётся
  от ``created_at`` уведомления: попытка N допустима, когда прошло
  ``BACKOFF_SECONDS[N-1]`` секунд от ``created_at`` (попытка №1
  выполняется без задержки);
* после ``MAX_ATTEMPTS`` неудач (3) — ``dispatch_status='failed'`` +
  ``dispatch_error`` записан;
* per-iteration ``try/except`` на уровне notif и channel: ошибка
  одного уведомления / канала не валит весь tick (Fail-safe rule).

Поток данных
============

Worker → ``Notification_Dispatcher._tick()``:

1. SELECT pending notifications.
2. Для каждой:
   2.1. Проверка backoff window — если рано, пропускаем (вернёмся
        на следующем tick'е).
   2.2. Парсим ``preference_snapshot[kind]`` → ``{channel: enabled}``.
   2.3. Для каждого ``channel`` где ``enabled=true`` AND
        ``channel not in dispatched_channels``:
        - вызываем ``_send(notif, channel)`` → bool;
        - если True — append channel в ``dispatched_channels``,
          сохраняем (Req 10.12);
        - если False — копим last_error.
   2.4. После всех каналов:
        - все требуемые каналы доставлены ⇒ ``dispatch_status='delivered'``;
        - есть провалы ⇒ ``dispatch_attempts += 1``; если
          ``>= MAX_ATTEMPTS`` ⇒ ``dispatch_status='failed'``,
          записать ``dispatch_error`` (последнюю причину).

Тестирование
============

Класс инжектируется через DI: ``db_connection_factory``,
``http_post`` (для email-relay), ``telegram_post`` (для Bot API),
``decrypt_token`` (для AES-256-GCM расшифровки), ``profile_loader``
(для чтения ``telegram_bot_token`` / ``telegram_chat_id`` /
``email``), ``clock`` (``time.time``). Это позволяет unit-тестам
полностью симулировать BD без psycopg2 и HTTP без сети.

Property test P19 (snapshot semantics) и P20 (3 retries) — отдельные
задачи 6.5 и 6.6 в плане; этот модуль обеспечивает корректное
поведение, тесты их закрепляют формально.
"""

from __future__ import annotations

import json
import os
import threading
import time
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

from scheduling.logger import logger


__all__ = [
    "NotificationDispatcher",
    "NotificationRow",
    "EncryptionKeyMissingError",
    "EncryptionKeyInvalidError",
    "decrypt_aes_gcm",
    "BACKOFF_SECONDS",
    "MAX_ATTEMPTS",
    "POLL_INTERVAL_SECONDS",
    "CHANNEL_IN_APP",
    "CHANNEL_EMAIL",
    "CHANNEL_TELEGRAM",
]


# ---------------------------------------------------------------------------
# Constants (per design.md and Req 10.11)
# ---------------------------------------------------------------------------

#: Tick-период в секундах. Зафиксирован в design.md и в задаче 6.4.
POLL_INTERVAL_SECONDS: int = 5

#: Задержки между попытками (sec). Отсчёт идёт от ``created_at``:
#: попытка №1 — сразу (0s), попытка №2 — после 15s, попытка №3 —
#: после 60s, попытка №4 (если бы существовала) — после 240s.
#: ``MAX_ATTEMPTS=3``: после 3-й неудачи ``dispatch_status='failed'``.
BACKOFF_SECONDS: tuple[int, ...] = (15, 60, 240)

#: Максимальное число попыток доставки. Соответствует Req 10.11
#: «retry up to 3 times».
MAX_ATTEMPTS: int = 3

#: Имена каналов как используются в ``preference_snapshot`` и
#: ``dispatched_channels``. Должны совпадать с фронтенд-константами
#: ``Notification_Channel`` из ``frontend/src/lib/scheduling/types.ts``.
CHANNEL_IN_APP: str = "in_app"
CHANNEL_EMAIL: str = "email"
CHANNEL_TELEGRAM: str = "telegram"

#: Лимит batch'а на один tick. Тот же подход, что и в
#: ``BroadcastScheduler._fetch_due_jobs`` и
#: ``ScheduleModeEngine._fetch_due_broadcasts``.
_BATCH_LIMIT: int = 50

#: Имя переменной окружения с base64-encoded 32-byte ключом
#: AES-256-GCM. Тот же ключ, что и у JS-encrypt в
#: ``frontend/src/lib/encryption.ts``.
_ENCRYPTION_KEY_ENV: str = "INSTANCE_ENCRYPTION_KEY"

#: Имя переменной окружения с shared secret для email-relay.
#: Flask добавляет этот заголовок при вызове Next.js эндпойнта.
_RELAY_SECRET_ENV: str = "NOTIFICATION_RELAY_SECRET"

#: Имя env-переменной с базовым URL Next.js фронтенда. Тот же
#: ``FRONTEND_URL``, что используется в ``app.py`` для CORS.
_FRONTEND_URL_ENV: str = "FRONTEND_URL"

#: Дефолтный URL Telegram Bot API.
_TELEGRAM_API_BASE: str = "https://api.telegram.org"

#: Тайм-аут HTTP-запросов в секундах. Достаточно большой для
#: внешних сервисов (Telegram, SMTP relay), но не настолько,
#: чтобы tick подвис на 30+ секунд. Относится только к одному
#: каналу одного notif — на других notif'ах tick не блокируется.
_HTTP_TIMEOUT_SECONDS: float = 10.0


# ---------------------------------------------------------------------------
# Encryption helpers (mirror frontend/src/lib/encryption.ts)
# ---------------------------------------------------------------------------


class EncryptionKeyMissingError(RuntimeError):
    """Поднимается, когда ``INSTANCE_ENCRYPTION_KEY`` не задан.

    Зеркало ``EncryptionKeyMissingError`` из
    ``frontend/src/lib/encryption.ts``. Notification_Dispatcher
    использует это в Telegram-канале: при отсутствии ключа
    дешифровать токен невозможно — записываем
    ``dispatch_error="ENCRYPTION_KEY_MISSING"`` и продолжаем
    обычный retry-цикл (Req 10.11).
    """


class EncryptionKeyInvalidError(RuntimeError):
    """Поднимается, когда ``INSTANCE_ENCRYPTION_KEY`` некорректен.

    Возможные причины: длина ключа после base64-decode не равна
    32 байтам, ciphertext повреждён, GCM-tag не совпал. Зеркалит
    ``EncryptionKeyInvalidError`` поведение JS-encryption: в
    Notification_Dispatcher это маппится на
    ``dispatch_error="ENCRYPTION_KEY_INVALID"`` (см. design.md
    «Encryption key issues»).
    """


def decrypt_aes_gcm(
    encrypted: str,
    key_base64: Optional[str] = None,
) -> str:
    """Расшифровать строку формата ``iv:ciphertext:tag`` (все base64).

    Точное зеркало ``decrypt(encrypted)`` из
    ``frontend/src/lib/encryption.ts``:

    * AES-256-GCM с 12-byte IV (96 bits, рекомендованный размер для
      GCM) и 16-byte authentication tag (128 bits);
    * ключ — 32 байта (256 bits), base64-encoded в env;
    * строка хранения — три base64-сегмента, разделённых ``":"``.

    Args:
        encrypted: зашифрованная строка ``"<iv_b64>:<ct_b64>:<tag_b64>"``.
        key_base64: переопределение ключа для тестов. По умолчанию
            читается из ``INSTANCE_ENCRYPTION_KEY``.

    Returns:
        Расшифрованную UTF-8 строку (plaintext).

    Raises:
        EncryptionKeyMissingError: если ключ не задан в env.
        EncryptionKeyInvalidError: если ключ не 32 байта, формат
            ciphertext неверный, или GCM-тег не совпал. Это
            покрывает оба «ключ ротировался» и «ciphertext
            повреждён» — оба случая для dispatcher'а одинаковы.
    """

    import base64

    raw_key = key_base64
    if raw_key is None:
        raw_key = os.getenv(_ENCRYPTION_KEY_ENV)
    if not raw_key:
        raise EncryptionKeyMissingError(
            f"{_ENCRYPTION_KEY_ENV} is not configured"
        )

    try:
        key = base64.b64decode(raw_key)
    except Exception as exc:  # broad: any base64 decode error
        raise EncryptionKeyInvalidError(
            f"{_ENCRYPTION_KEY_ENV} is not valid base64"
        ) from exc
    if len(key) != 32:
        raise EncryptionKeyInvalidError(
            f"{_ENCRYPTION_KEY_ENV} must be exactly 32 bytes when "
            f"decoded from base64 (got {len(key)})"
        )

    parts = encrypted.split(":")
    if len(parts) != 3:
        raise EncryptionKeyInvalidError(
            "Invalid encrypted format: expected iv:ciphertext:tag"
        )

    try:
        iv = base64.b64decode(parts[0])
        ciphertext = base64.b64decode(parts[1])
        tag = base64.b64decode(parts[2])
    except Exception as exc:
        raise EncryptionKeyInvalidError(
            "Failed to decode iv/ciphertext/tag from base64"
        ) from exc

    if len(iv) != 12:
        raise EncryptionKeyInvalidError(
            f"Invalid IV length: expected 12 bytes (got {len(iv)})"
        )
    if len(tag) != 16:
        raise EncryptionKeyInvalidError(
            f"Invalid auth tag length: expected 16 bytes (got {len(tag)})"
        )

    # Lazy import: cryptography может отсутствовать в slim-окружениях
    # юнит-тестов; в production она в requirements.txt.
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover
        raise EncryptionKeyInvalidError(
            "cryptography package is required to decrypt telegram_bot_token"
        ) from exc

    aes = AESGCM(key)
    # AESGCM ожидает ciphertext + tag склеенными; node.js хранил
    # их отдельно — здесь склеиваем обратно перед decrypt'ом.
    try:
        plaintext = aes.decrypt(iv, ciphertext + tag, associated_data=None)
    except Exception as exc:  # InvalidTag и др.
        raise EncryptionKeyInvalidError(
            "AES-GCM decryption failed (wrong key or corrupt ciphertext)"
        ) from exc

    return plaintext.decode("utf-8")


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


@dataclass
class NotificationRow:
    """Снимок строки ``notifications`` для удобной передачи между
    методами dispatcher'а.

    Поля совпадают со схемой Postgres-таблицы (см. migration
    ``20260601_broadcast_scheduling_suite/migration.sql``). Класс
    мутабельный, потому что dispatcher честно заполняет
    ``dispatched_channels`` / ``dispatch_attempts`` /
    ``dispatch_status`` по ходу tick'а; финальный snapshot
    отправляется в БД одним UPDATE через :meth:`_persist`.
    """

    id: int
    user_id: str
    kind: str
    payload: Mapping[str, Any]
    preference_snapshot: Mapping[str, Any]
    dispatch_status: str
    dispatch_attempts: int
    dispatch_error: Optional[str]
    dispatched_channels: list[str]
    created_at: datetime
    read_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Connection / loader defaults
# ---------------------------------------------------------------------------


def _default_db_connection_factory() -> Any:
    """Фабрика psycopg2-соединений. Зеркально
    ``ScheduleModeEngine._default_db_connection_factory`` /
    ``ActivityAnalyzer._default_db_connection_factory``.
    """

    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not configured — NotificationDispatcher cannot "
            "reach Postgres"
        )
    import psycopg2

    return psycopg2.connect(url)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


@dataclass
class _ProfileRow:
    """Подмножество полей ``profiles``, нужное dispatcher'у."""

    user_id: str
    email: Optional[str] = None
    telegram_bot_token: Optional[str] = None  # encrypted
    telegram_chat_id: Optional[str] = None
    telegram_bot_api_url: str = _TELEGRAM_API_BASE


class NotificationDispatcher:
    """Daemon-thread, доставляющий ``Notification`` по каналам.

    Запускается из ``app.py`` (см. задачу 6.11) рядом с существующим
    ``BroadcastScheduler``. Не имеет публичных методов кроме
    :meth:`start` / :meth:`stop` — всё взаимодействие идёт через БД.

    Args:
        db_connection_factory: фабрика psycopg2-соединений. По
            умолчанию читается ``DATABASE_URL``. В тестах инжектится.
        http_post: callable ``(url, json, headers, timeout) -> (status, body)``
            для email-relay. По умолчанию использует ``httpx``.
        telegram_post: callable ``(url, json, timeout) -> (status, body)``
            для Telegram Bot API. По умолчанию использует ``httpx``.
        decrypt_token: функция расшифровки. По умолчанию —
            :func:`decrypt_aes_gcm`. Инжектится в тестах.
        profile_loader: callable ``(user_id) -> _ProfileRow`` для
            чтения email / telegram credentials оператора. По
            умолчанию SELECT из таблицы ``profiles`` через ту же
            DB-фабрику.
        clock: источник unix-времени; по умолчанию ``time.time``.
        poll_interval_seconds: tick-период; по умолчанию 5s.

    Threading:
        Один daemon-thread с именем ``notification-dispatcher``.
        Внутри ``_tick`` НЕ удерживает БД-блокировок между
        SELECT и UPDATE — это безопасно, потому что
        ``dispatched_channels`` дополняется аддитивно (если другой
        процесс параллельно записал тот же канал, мы заметим это
        на следующем tick и пропустим — Req 10.12 гарантируется
        проверкой ``channel in dispatched_channels``).
    """

    # ---------------------------------------------------------------- ctor

    def __init__(
        self,
        *,
        db_connection_factory: Optional[Callable[[], Any]] = None,
        http_post: Optional[Callable[..., tuple[int, str]]] = None,
        telegram_post: Optional[Callable[..., tuple[int, str]]] = None,
        decrypt_token: Optional[Callable[[str], str]] = None,
        profile_loader: Optional[Callable[[str], Optional[_ProfileRow]]] = None,
        clock: Callable[[], float] = time.time,
        poll_interval_seconds: int = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._db_connection_factory = (
            db_connection_factory or _default_db_connection_factory
        )
        self._http_post = http_post or _default_http_post
        self._telegram_post = telegram_post or _default_http_post
        self._decrypt_token = decrypt_token or decrypt_aes_gcm
        self._profile_loader = profile_loader or self._default_profile_loader
        self._clock = clock
        self._poll_interval = int(poll_interval_seconds)

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._started = False
        self._lock = threading.Lock()

        # Req 10.6: warning «no email provider» один раз per process.
        self._email_provider_warning_emitted = False

    # ----------------------------------------------------------------- run

    def start(self) -> None:
        """Запустить daemon thread. Идемпотентно."""

        with self._lock:
            if self._started:
                return
            if not os.getenv("DATABASE_URL"):
                logger.warning(
                    "NotificationDispatcher не стартует: DATABASE_URL не задан"
                )
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="notification-dispatcher",
                daemon=True,
            )
            self._thread.start()
            self._started = True
            logger.info("NotificationDispatcher started (tick=%ds)", self._poll_interval)

    def stop(self) -> None:
        """Запросить корректную остановку (с join до 5s)."""

        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        with self._lock:
            self._started = False

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:  # never let the thread die
                logger.exception("NotificationDispatcher tick failed")
            # Прерываемый sleep: stop() пробудит поток мгновенно.
            self._stop_event.wait(self._poll_interval)

    # ----------------------------------------------------------------- tick

    def _tick(self) -> None:
        """Один tick: SELECT pending → per-notif dispatch.

        Per-notif ``try/except`` — Fail-safe rule: ошибка одного
        уведомления не валит остальные.
        """

        try:
            rows = self._fetch_pending()
        except Exception:
            logger.exception(
                "NotificationDispatcher: ошибка SELECT pending — tick пропущен"
            )
            return

        if not rows:
            return

        logger.debug(
            "NotificationDispatcher: %d pending notification(s) on this tick",
            len(rows),
        )

        for row in rows:
            try:
                self._dispatch_one(row)
            except Exception:
                logger.exception(
                    "NotificationDispatcher: ошибка обработки notification "
                    "id=%s — продолжаю с остальными",
                    row.id,
                )

    def _dispatch_one(self, notif: NotificationRow) -> None:
        """Обработать одно уведомление.

        Логика (см. модульный docstring и design.md):

        1. Если backoff window для следующей попытки ещё не наступил
           (Req 10.11) — пропускаем, вернёмся на следующем tick'е.
        2. Достаём ``preference_snapshot[kind]`` → ``{channel: enabled}``.
        3. Для каждого ``enabled=true`` канала, не присутствующего
           в ``dispatched_channels``, вызываем ``_send``.
        4. Каналы, отдавшие True, попадают в ``dispatched_channels``
           немедленно (даже если потом другой канал упадёт) — это
           обеспечивает Req 10.12 (нет дублей).
        5. Считаем итог:
           — все требуемые каналы доставлены ⇒ ``dispatch_status='delivered'``;
           — есть провалы, ``attempts >= MAX_ATTEMPTS`` ⇒ ``failed``;
           — провалы, ещё не достигли лимита ⇒ остаётся ``pending``,
             ``dispatch_attempts += 1``.
        """

        # Req 10.11: проверка backoff. Попытка №1 (когда attempts==0)
        # выполняется без задержки.
        if not self._is_backoff_elapsed(notif):
            return

        # Парсим snapshot. Если поле невалидное (порча JSON или
        # отсутствие ключа kind) — считаем, что нет каналов, и
        # сразу помечаем ``delivered`` (нечего доставлять).
        snapshot = notif.preference_snapshot or {}
        if isinstance(snapshot, str):
            try:
                snapshot = json.loads(snapshot)
            except json.JSONDecodeError:
                snapshot = {}
        channels_for_kind = snapshot.get(notif.kind, {}) if isinstance(snapshot, Mapping) else {}
        if not isinstance(channels_for_kind, Mapping):
            channels_for_kind = {}

        # Список каналов, которые надо попытаться доставить на этой
        # попытке. Стабильный порядок (in_app → email → telegram)
        # для повторяемости в тестах.
        required_channels: list[str] = []
        for ch in (CHANNEL_IN_APP, CHANNEL_EMAIL, CHANNEL_TELEGRAM):
            if bool(channels_for_kind.get(ch)) and ch not in notif.dispatched_channels:
                required_channels.append(ch)

        # Список каналов, на которые когда-либо подписывались (включая
        # уже delivered) — нужен, чтобы понять, считается ли уведомление
        # полностью доставленным.
        all_subscribed_channels: list[str] = [
            ch for ch in (CHANNEL_IN_APP, CHANNEL_EMAIL, CHANNEL_TELEGRAM)
            if bool(channels_for_kind.get(ch))
        ]

        if not all_subscribed_channels:
            # snapshot пуст для этого kind — нечего доставлять.
            # Помечаем как delivered, чтобы не висело pending вечно.
            notif.dispatch_status = "delivered"
            self._persist(notif)
            return

        last_error: Optional[str] = None
        any_failure_this_attempt = False

        # Профиль оператора нужен для email и telegram. Загружаем
        # его лениво — если все required_channels это in_app,
        # профиль не понадобится.
        profile_cache: dict[str, Optional[_ProfileRow]] = {}

        def _get_profile() -> Optional[_ProfileRow]:
            if notif.user_id not in profile_cache:
                try:
                    profile_cache[notif.user_id] = self._profile_loader(notif.user_id)
                except Exception:
                    logger.exception(
                        "NotificationDispatcher: profile_loader failed for "
                        "user_id=%s",
                        notif.user_id,
                    )
                    profile_cache[notif.user_id] = None
            return profile_cache[notif.user_id]

        for channel in required_channels:
            try:
                ok, err = self._send(notif, channel, _get_profile)
            except Exception as exc:
                ok, err = False, f"{type(exc).__name__}: {exc}"
                logger.exception(
                    "NotificationDispatcher: unexpected exception sending "
                    "notification id=%s channel=%s",
                    notif.id,
                    channel,
                )

            if ok:
                # Req 10.12: канал больше не повторяется.
                notif.dispatched_channels.append(channel)
            else:
                any_failure_this_attempt = True
                last_error = err or last_error or "unknown error"

        # Финальный учёт по уведомлению.
        delivered_subscribed = [
            ch for ch in all_subscribed_channels if ch in notif.dispatched_channels
        ]
        all_done = len(delivered_subscribed) == len(all_subscribed_channels)

        if all_done:
            notif.dispatch_status = "delivered"
            notif.dispatch_error = None
        elif any_failure_this_attempt:
            notif.dispatch_attempts += 1
            if notif.dispatch_attempts >= MAX_ATTEMPTS:
                notif.dispatch_status = "failed"
                notif.dispatch_error = (last_error or "unknown error")[:500]
            # else: остаётся pending, на следующем tick попробуем снова

        self._persist(notif)

    # ----------------------------------------------------------- backoff

    def _is_backoff_elapsed(self, notif: NotificationRow) -> bool:
        """Прошло ли достаточно времени с ``created_at`` для следующей
        попытки.

        Алгоритм (Req 10.11, design.md «Notification dispatch retry»):

        * attempts=0 — попытка №1, без задержки.
        * attempts=1 — нужна задержка ``BACKOFF_SECONDS[0] = 15s``.
        * attempts=2 — нужна задержка ``BACKOFF_SECONDS[1] = 60s``.
        * attempts=3 — нужна задержка ``BACKOFF_SECONDS[2] = 240s``
          (но при ``attempts >= MAX_ATTEMPTS`` мы уже помечаем
          failed, так что эта ветка обычно не активна).

        Отсчёт от ``created_at``, не от предыдущей попытки. Это
        проще и совпадает с примером в design.md (таблица
        «Notification dispatch retry» считает задержки именно
        от первой попытки).
        """

        if notif.dispatch_attempts <= 0:
            return True
        idx = notif.dispatch_attempts - 1
        if idx >= len(BACKOFF_SECONDS):
            # Защита от состояния, когда attempts > 3 проскочил
            # запись failed (теоретически невозможно, но не блокируем).
            return True
        required_delay = BACKOFF_SECONDS[idx]
        # Сравниваем unix-секунды; ``created_at`` — datetime в UTC.
        try:
            created_ts = notif.created_at.timestamp()
        except Exception:
            return True
        return (self._clock() - created_ts) >= required_delay

    # ----------------------------------------------------------- channels

    def _send(
        self,
        notif: NotificationRow,
        channel: str,
        get_profile: Callable[[], Optional[_ProfileRow]],
    ) -> tuple[bool, Optional[str]]:
        """Отправить одно уведомление через канал.

        Returns:
            ``(ok, error_message)``: ``ok=True`` ⇒ канал считается
            успешно доставленным; ``ok=False, error_message`` ⇒
            будет ретрай / запись в ``dispatch_error`` после
            исчерпания попыток.
        """

        if channel == CHANNEL_IN_APP:
            return self._send_in_app(notif)
        if channel == CHANNEL_EMAIL:
            return self._send_email(notif, get_profile())
        if channel == CHANNEL_TELEGRAM:
            return self._send_telegram(notif, get_profile())
        return False, f"unknown channel: {channel}"

    def _send_in_app(
        self, notif: NotificationRow
    ) -> tuple[bool, Optional[str]]:
        """In-app канал: no-op success.

        Запись ``Notification`` уже доступна через
        ``GET /api/notifications`` (Req 10.5). UI поллит этот
        эндпойнт каждые 15s. Никаких side-effects здесь не нужно —
        достаточно пометить канал доставленным.
        """

        return True, None

    def _send_email(
        self,
        notif: NotificationRow,
        profile: Optional[_ProfileRow],
    ) -> tuple[bool, Optional[str]]:
        """Email канал: HTTP relay в Next.js
        ``/api/notifications/email-relay``.

        Defence:

        * Req 10.6 — если SMTP-провайдер не сконфигурирован, должен
          быть лог warning **один раз** per process start. Реальная
          проверка SMTP-конфигурации выполняется на стороне Next.js
          relay-эндпойнта (он знает SMTP-секреты). С нашей стороны
          мы можем определить «нет провайдера» косвенно:
          если ``FRONTEND_URL`` или ``NOTIFICATION_RELAY_SECRET``
          не задан — relay недоступен, эмулируем тот же warning
          и считаем попытку неудачной.
        * Если у пользователя нет email в profile — попытка фейлится
          без вызова HTTP (нечего отправлять). Это не блокирует
          другие каналы.
        """

        # Backend-side detection of «no email provider» — Req 10.6.
        relay_url = os.getenv(_FRONTEND_URL_ENV)
        relay_secret = os.getenv(_RELAY_SECRET_ENV)
        if not relay_url or not relay_secret:
            self._maybe_warn_no_email_provider()
            return False, "EMAIL_PROVIDER_NOT_CONFIGURED"

        recipient_email = profile.email if profile else None
        if not recipient_email:
            return False, "EMAIL_RECIPIENT_MISSING"

        url = f"{relay_url.rstrip('/')}/api/notifications/email-relay"
        body = {
            "user_id": notif.user_id,
            "kind": notif.kind,
            "payload": dict(notif.payload) if notif.payload else {},
            "to": recipient_email,
        }
        headers = {
            "Content-Type": "application/json",
            "X-Notification-Relay-Secret": relay_secret,
        }

        try:
            status, response_body = self._http_post(
                url=url,
                json_body=body,
                headers=headers,
                timeout=_HTTP_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            return False, f"EMAIL_RELAY_NETWORK_ERROR: {exc}"

        if 200 <= status < 300:
            return True, None
        return False, f"EMAIL_RELAY_HTTP_{status}: {(response_body or '')[:200]}"

    def _send_telegram(
        self,
        notif: NotificationRow,
        profile: Optional[_ProfileRow],
    ) -> tuple[bool, Optional[str]]:
        """Telegram канал: ``httpx.post(<bot>/sendMessage, json={chat_id, text})``.

        Шаги:

        1. Проверяем наличие ``telegram_bot_token`` (encrypted) и
           ``telegram_chat_id`` в профиле — иначе фейл с понятным
           кодом.
        2. Расшифровываем токен через ``INSTANCE_ENCRYPTION_KEY``.
           На любую ошибку расшифровки — фейл с
           ``ENCRYPTION_KEY_INVALID`` / ``ENCRYPTION_KEY_MISSING``,
           который после стандартного retry-cycle упадёт в
           ``failed`` (design.md «Encryption key issues»).
        3. POST на ``https://api.telegram.org/bot<TOKEN>/sendMessage``
           с JSON-телом ``{"chat_id": <id>, "text": <message>}``.
        4. Текст формируется из ``payload.message`` (если есть)
           или fallback ``f"[{kind}] {payload}"``.
        """

        if profile is None or not profile.telegram_bot_token:
            return False, "TELEGRAM_BOT_TOKEN_MISSING"
        if not profile.telegram_chat_id:
            return False, "TELEGRAM_CHAT_ID_MISSING"

        try:
            bot_token = self._decrypt_token(profile.telegram_bot_token)
        except EncryptionKeyMissingError:
            return False, "ENCRYPTION_KEY_MISSING"
        except EncryptionKeyInvalidError:
            return False, "ENCRYPTION_KEY_INVALID"
        except Exception as exc:  # pragma: no cover — defence-in-depth
            return False, f"ENCRYPTION_DECRYPT_FAILED: {exc}"

        text = self._format_telegram_text(notif)
        api_base = profile.telegram_bot_api_url or _TELEGRAM_API_BASE
        url = f"{api_base.rstrip('/')}/bot{bot_token}/sendMessage"
        body = {"chat_id": profile.telegram_chat_id, "text": text}

        try:
            status, response_body = self._telegram_post(
                url=url,
                json_body=body,
                headers={"Content-Type": "application/json"},
                timeout=_HTTP_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            return False, f"TELEGRAM_NETWORK_ERROR: {exc}"

        if 200 <= status < 300:
            return True, None
        # Telegram возвращает 4xx с диагностикой в JSON — пишем
        # её усечённо, чтобы было видно «chat not found» и т.п.
        return False, f"TELEGRAM_HTTP_{status}: {(response_body or '')[:200]}"

    @staticmethod
    def _format_telegram_text(notif: NotificationRow) -> str:
        """Сформировать текст Telegram-сообщения из payload.

        Простейший формат: если в ``payload`` есть ключ
        ``message`` — берём его как есть. Иначе — компактный
        JSON-дамп (полезно при ручной диагностике, не должен
        отвалиться даже на пустом payload).
        """

        payload: Mapping[str, Any] = notif.payload or {}
        if isinstance(payload, Mapping):
            msg = payload.get("message")
            if isinstance(msg, str) and msg.strip():
                return msg
        try:
            payload_repr = json.dumps(payload, ensure_ascii=False, default=str)
        except Exception:
            payload_repr = repr(payload)
        return f"[{notif.kind}] {payload_repr}"

    def _maybe_warn_no_email_provider(self) -> None:
        """Req 10.6: warning «no email provider» один раз per process.

        Под «провайдером» понимаем доступность relay-эндпойнта
        (``FRONTEND_URL`` + ``NOTIFICATION_RELAY_SECRET``); если
        одного из них нет — Flask не может вызвать relay, что
        эквивалентно «провайдер не сконфигурирован».
        """

        if self._email_provider_warning_emitted:
            return
        self._email_provider_warning_emitted = True
        logger.warning(
            "NotificationDispatcher: email provider is not configured "
            "(FRONTEND_URL or NOTIFICATION_RELAY_SECRET is missing); "
            "email channel attempts will fail until configured. This "
            "warning is logged once per process start (Req 10.6)."
        )

    # ----------------------------------------------------------- DB ops

    def _fetch_pending(self) -> list[NotificationRow]:
        """SELECT pending notifications с учётом backoff.

        Фильтр SQL делаем максимально широким (``dispatch_status='pending'``
        AND ``dispatch_attempts < MAX_ATTEMPTS``), а конкретный
        backoff-критерий проверяется в Python — это даёт более
        точные тесты, не зависящие от TZ-семантики Postgres
        ``NOW()`` vs ``self._clock()``.
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        rows: list[NotificationRow] = []
        with closing(self._db_connection_factory()) as conn:
            if psycopg2_extras is not None:
                cur_ctx = conn.cursor(cursor_factory=psycopg2_extras.RealDictCursor)
            else:
                cur_ctx = conn.cursor()
            with cur_ctx as cur:
                cur.execute(
                    """
                    SELECT id, user_id, kind, payload, preference_snapshot,
                           dispatch_status, dispatch_attempts, dispatch_error,
                           dispatched_channels, created_at, read_at
                      FROM notifications
                     WHERE dispatch_status = 'pending'
                       AND dispatch_attempts < %s
                     ORDER BY created_at ASC
                     LIMIT %s
                    """,
                    (MAX_ATTEMPTS, _BATCH_LIMIT),
                )
                for row in cur.fetchall():
                    rows.append(_row_to_notification(row))
        return rows

    def _persist(self, notif: NotificationRow) -> None:
        """UPDATE notifications с актуальными полями диспетчера.

        Меняем только колонки, которые dispatcher честно ведёт:
        ``dispatch_status``, ``dispatch_attempts``, ``dispatch_error``,
        ``dispatched_channels``. ``read_at``, ``payload``,
        ``preference_snapshot`` — read-only для нас.
        """

        try:
            with closing(self._db_connection_factory()) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE notifications
                           SET dispatch_status = %s,
                               dispatch_attempts = %s,
                               dispatch_error = %s,
                               dispatched_channels = %s
                         WHERE id = %s
                        """,
                        (
                            notif.dispatch_status,
                            notif.dispatch_attempts,
                            notif.dispatch_error,
                            list(notif.dispatched_channels),
                            notif.id,
                        ),
                    )
                conn.commit()
        except Exception:
            logger.exception(
                "NotificationDispatcher: ошибка UPDATE notifications id=%s",
                notif.id,
            )

    def _default_profile_loader(
        self, user_id: str
    ) -> Optional[_ProfileRow]:
        """Загрузить профиль оператора из таблицы ``profiles``.

        Возвращает ``None``, если профиль не найден или произошла
        ошибка БД — это безопасный nil-объект: email/telegram-каналы
        просто упадут с понятным кодом и пойдут на ретрай.

        Достаём также email из ``auth.users`` (Supabase): он не
        хранится в ``profiles``, а связан по ``user_id``. Ошибка
        SELECT-а ``auth.users`` (например, в dev без Supabase
        миграций) не валит загрузку — email останется ``None``.
        """

        try:
            import psycopg2.extras as psycopg2_extras
        except ImportError:  # pragma: no cover
            psycopg2_extras = None  # type: ignore[assignment]

        try:
            with closing(self._db_connection_factory()) as conn:
                if psycopg2_extras is not None:
                    cur_ctx = conn.cursor(cursor_factory=psycopg2_extras.RealDictCursor)
                else:
                    cur_ctx = conn.cursor()
                with cur_ctx as cur:
                    cur.execute(
                        """
                        SELECT user_id, telegram_bot_token, telegram_chat_id
                          FROM profiles
                         WHERE user_id = %s
                         LIMIT 1
                        """,
                        (user_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return None
                    profile = _ProfileRow(
                        user_id=str(row["user_id"]),
                        telegram_bot_token=row.get("telegram_bot_token"),
                        telegram_chat_id=row.get("telegram_chat_id"),
                    )

                    # Try to enrich with email from Supabase auth.users.
                    # Best-effort: missing schema in dev is fine.
                    try:
                        cur.execute(
                            """
                            SELECT email
                              FROM auth.users
                             WHERE id = %s
                             LIMIT 1
                            """,
                            (user_id,),
                        )
                        auth_row = cur.fetchone()
                        if auth_row and auth_row.get("email"):
                            profile.email = str(auth_row["email"])
                    except Exception:
                        # Schema без auth.users — просто оставим email=None.
                        pass

                    return profile
        except Exception:
            logger.exception(
                "NotificationDispatcher._default_profile_loader: "
                "не удалось прочитать profile для user_id=%s",
                user_id,
            )
            return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_notification(row: Mapping[str, Any]) -> NotificationRow:
    """Конверсия psycopg2-строки → :class:`NotificationRow`.

    Аккуратно обрабатывает типы:

    * ``payload`` / ``preference_snapshot`` — psycopg2 для JSONB
      возвращает уже dict (если установлен ``register_default_jsonb``,
      что Postgres-binary делает по умолчанию); но если приходит
      строка — парсим.
    * ``dispatched_channels`` — TEXT[]; psycopg2 отдаёт list[str].
      Если NULL — конвертируем в пустой список (защита от
      теоретического case'а).
    * ``created_at`` — psycopg2 отдаёт datetime; если он naive —
      считаем UTC (схема migrate использует TIMESTAMP(3) — naive).
    """

    payload = row.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}

    snapshot = row.get("preference_snapshot") or {}
    if isinstance(snapshot, str):
        try:
            snapshot = json.loads(snapshot)
        except json.JSONDecodeError:
            snapshot = {}

    dispatched_channels = row.get("dispatched_channels") or []
    if not isinstance(dispatched_channels, list):
        dispatched_channels = list(dispatched_channels) if dispatched_channels else []

    created_at = row.get("created_at")
    if isinstance(created_at, datetime) and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    elif not isinstance(created_at, datetime):
        # Defence-in-depth: если БД отдала строку — считаем «сейчас».
        created_at = datetime.now(timezone.utc)

    return NotificationRow(
        id=int(row["id"]),
        user_id=str(row["user_id"]),
        kind=str(row["kind"]),
        payload=payload,
        preference_snapshot=snapshot,
        dispatch_status=str(row.get("dispatch_status") or "pending"),
        dispatch_attempts=int(row.get("dispatch_attempts") or 0),
        dispatch_error=row.get("dispatch_error"),
        dispatched_channels=list(dispatched_channels),
        created_at=created_at,
        read_at=row.get("read_at"),
    )


def _default_http_post(
    *,
    url: str,
    json_body: Mapping[str, Any],
    headers: Mapping[str, str],
    timeout: float,
) -> tuple[int, str]:
    """Дефолтный HTTP POST через ``httpx``. Используется и для
    email-relay, и для Telegram Bot API.

    Возвращает ``(status_code, response_text)``. Сетевые ошибки
    пробрасываются через ``raise`` — вызывающий код в
    ``_send_email`` / ``_send_telegram`` ловит их и преобразует
    в ``(False, "*_NETWORK_ERROR")``.

    Импорт ``httpx`` ленивый: модуль остаётся импортируемым в
    окружениях без httpx (хоть он и в requirements.txt).
    """

    import httpx

    response = httpx.post(
        url,
        json=dict(json_body),
        headers=dict(headers),
        timeout=timeout,
    )
    # httpx не бросает на 4xx/5xx по умолчанию — это удобно, чтобы
    # вернуть status вызывающему и пусть он решает.
    text = ""
    try:
        text = response.text
    except Exception:
        pass
    return response.status_code, text
