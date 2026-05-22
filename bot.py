import os
import sys
import threading
import time
import logging
import requests
import random
import re
from typing import Callable, Optional
from dotenv import load_dotenv

from anti_ban.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)


class QuotaExceededError(Exception):
    """Raised on GREEN-API HTTP 466 (quota exceeded).

    The caller (Bulk_Operation worker) should abort the operation
    immediately and log a ``quota_466`` incident — see Requirement 4.4
    of the ``anti-ban-protection`` spec.
    """


class Rate429Error(Exception):
    """Raised when consecutive HTTP 429 retries are exhausted.

    Attribute ``retry_count`` holds the number of retries that already
    happened (0-based). The caller can use it to decide whether to abort
    the run as ``aborted`` and write a ``rate_limit_429`` incident — see
    Requirements 4.2 and 4.3 of the ``anti-ban-protection`` spec.
    """

    def __init__(self, retry_count: int) -> None:
        self.retry_count = retry_count
        super().__init__(f"HTTP 429 retried {retry_count} times")

def get_data_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

env_path = os.path.join(get_data_path(), '.env')
load_dotenv(dotenv_path=env_path)
API_URL = os.getenv('GREEN_API_URL', 'https://api.green-api.com')


def render_message_template(template, contact):
    def replace_block(match):
        value = match.group(1)
        if '|' in value:
            variants = [part.strip() for part in value.split('|')]
            variants = [part for part in variants if part]
            return random.choice(variants) if variants else ''
        return str(contact.get(value.strip(), '') or '')

    return re.sub(r'\{([^{}]+)\}', replace_block, template or '')


def _normalize_chat_id(chat_id):
    """Pass-through helper kept for explicit-intent call sites.

    GREEN-API supports several transports (WhatsApp / MAX / etc.) and
    each has its own chatId conventions. Adding domain suffixes
    automatically (``@c.us``/``@g.us``) breaks MAX, where group IDs
    arrive as bare signed integers (e.g. ``-74158757142706``) and must
    NOT be modified — see Railway logs from 2026-05-18 where every
    suffix-augmented call returned 400 ``Validation failed``.

    The function therefore returns the value as-is. It exists only so
    call sites read consistently and we have a single place to revisit
    if a future transport actually requires per-call rewriting (which
    would then have to be transport-aware, not heuristic).
    """
    return chat_id


class MaxBot:
    """
    Основной класс для работы с мессенджером MAX через GREEN-API.
    """
    def __init__(self, id_instance, api_token):
        self.id_instance = id_instance
        self.api_token = api_token
        self.base_url = f"{API_URL}/waInstance{self.id_instance}"

    def _make_request(
        self,
        method,
        endpoint,
        payload=None,
        timeout=15,
        *,
        rate_limiter: Optional[RateLimiter] = None,
        rate_limit_kind: str = "check",
        burst_mode: bool = False,
        burst_throttle_state: str = "normal",
        burst_message_index: int = 0,
    ):
        """Выполнить HTTP-запрос к GREEN-API с опциональным rate limiting.

        Args:
            method: ``"GET"`` / ``"POST"`` / ``"DELETE"``.
            endpoint: путь после ``waInstance{id}/``.
            payload: тело JSON для POST.
            timeout: таймаут одного HTTP-запроса.
            rate_limiter: опциональный :class:`RateLimiter`. Если задан,
                перед каждым HTTP-запросом вызывается ``acquire(kind=...)``,
                после успешного ответа — ``record_request()``. На HTTP 429
                выполняется ``on_http_429(retry)`` и повтор до
                ``config.max_retries``; при исчерпании повторов
                поднимается :class:`Rate429Error`. На HTTP 466 поднимается
                :class:`QuotaExceededError`. Если ``rate_limiter is None``,
                поведение совместимо с прежним: 466 транслируется в
                ``QuotaExceededError`` (чтобы caller мог корректно
                остановить операцию), остальные ошибки логируются и
                возвращается ``None``.
            rate_limit_kind: ``"check"`` для ``checkAccount``-подобных
                запросов или ``"broadcast"`` для отправки сообщений.
            burst_mode: True, когда вызов идёт из burst-режима
                ``ScheduledBroadcast`` (Req 8.2/8.3, задача 7.1).
                Пробрасывается в :meth:`RateLimiter.acquire`, который
                заменяет случайный jitter на
                :meth:`scheduling.burst_engine.BurstEngine.delay_for`
                и пропускает ``long_pause_every_n``. Применяется только
                для ``rate_limit_kind="broadcast"``; для ``"check"``
                игнорируется (checkAccount-вызовы не относятся к
                burst-pacing).
            burst_throttle_state: ``"normal"``/``"slowed"`` — текущее
                состояние ``Adaptive_Throttle`` (Req 8.4). Игнорируется
                при ``burst_mode=False``.
            burst_message_index: 0-based индекс сообщения в очереди
                (для будущих расширений ``BurstEngine.delay_for``).

        Returns:
            Распарсенный JSON-ответ или ``None`` при сетевой/HTTP ошибке
            (кроме 429/466, см. выше).
        """
        url = f"{self.base_url}/{endpoint}/{self.api_token}"
        max_retries = (
            rate_limiter._config.max_retries
            if rate_limiter is not None
            else 5
        )

        retry = 0
        while True:
            if rate_limiter is not None:
                rate_limiter.acquire(
                    kind=rate_limit_kind,
                    burst_mode=burst_mode,
                    burst_throttle_state=burst_throttle_state,
                    burst_message_index=burst_message_index,
                )
            try:
                if method == 'POST':
                    response = requests.post(url, json=payload, timeout=timeout)
                else:
                    response = requests.get(url, timeout=timeout)
                response.raise_for_status()
            except requests.exceptions.HTTPError as e:
                status = e.response.status_code if e.response is not None else None
                # HTTP 466 — превышение квоты GREEN-API: операцию
                # необходимо остановить немедленно (Requirement 4.4).
                if status == 466:
                    logger.error(
                        f"HTTP 466 (quota exceeded) [{endpoint}]: "
                        f"{e.response.text}"
                    )
                    raise QuotaExceededError(
                        f"GREEN-API quota exceeded on {endpoint}: "
                        f"{e.response.text}"
                    ) from e
                # HTTP 429 — rate limit. Backoff + retry до max_retries
                # (Requirement 4.1, 4.2).
                if status == 429:
                    logger.warning(
                        f"HTTP 429 [{endpoint}], retry {retry + 1}/"
                        f"{max_retries}"
                    )
                    if rate_limiter is not None:
                        if retry >= max_retries:
                            raise Rate429Error(retry_count=retry) from e
                        rate_limiter.on_http_429(retry)
                        retry += 1
                        continue
                    # Без rate_limiter сохраняем прежнее поведение —
                    # просто логируем и возвращаем None.
                    logger.error(
                        f"HTTP Ошибка [{endpoint}]: {e.response.text}"
                    )
                    return None
                logger.error(
                    f"HTTP Ошибка [{endpoint}]: {e.response.text} | "
                    f"payload={payload!r}"
                )
                return None
            except requests.exceptions.RequestException as e:
                logger.error(f"Сетевая ошибка [{endpoint}]: {e}")
                return None
            if rate_limiter is not None:
                rate_limiter.record_request()
            return response.json()

    def _make_multipart_request(self, endpoint, files, data=None):
        """POST-запрос с multipart/form-data (для загрузки файлов)."""
        url = f"{self.base_url}/{endpoint}/{self.api_token}"
        try:
            response = requests.post(url, files=files, data=data, timeout=60)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            logger.error(f"HTTP Ошибка [{endpoint}]: {e.response.text}")
            return None
        except requests.exceptions.RequestException as e:
            logger.error(f"Сетевая ошибка [{endpoint}]: {e}")
            return None

    # ── АВТОРИЗАЦИЯ ──────────────────────────────────────────────────────────

    def get_state(self):
        """Текущий статус инстанса."""
        result = self._make_request('GET', 'getStateInstance')
        return result.get('stateInstance', 'unknown') if result else 'error'

    def get_qr_code(self):
        """Получение QR-кода (base64) для авторизации."""
        result = self._make_request('GET', 'qr')
        if result:
            if result.get('type') == 'qrCode':
                return {'type': 'qrCode', 'data': result.get('message')}
            elif result.get('type') == 'alreadyLogged':
                return {'type': 'alreadyLogged'}
        return {'type': 'error'}

    def logout(self):
        """Деавторизация инстанса."""
        result = self._make_request('GET', 'logout')
        return result.get('isLogout', False) if result else False

    def reboot_instance(self):
        """Перезапуск инстанса."""
        result = self._make_request('GET', 'reboot')
        return result.get('isReboot', False) if result else False

    # ── НАСТРОЙКИ И АККАУНТ ──────────────────────────────────────────────────

    def get_account_settings(self):
        """Получение настроек инстанса (номер телефона, имя и т.д.)."""
        return self._make_request('GET', 'getSettings')

    def setup_webhook(self, webhook_url):
        """Настройка Webhook для получения уведомлений в реальном времени."""
        payload = {
            "webhookUrl": webhook_url,
            "outgoingWebhook": "yes",
            "stateWebhook": "yes",
            "incomingWebhook": "yes",
            "outgoingMessageWebhook": "yes",
        }
        result = self._make_request('POST', 'setSettings', payload)
        return result.get('saveSettings', False) if result else False

    # ── СЕРВИСНЫЕ ФУНКЦИИ ────────────────────────────────────────────────────

    def check_contact(
        self,
        phone_number,
        *,
        rate_limiter: Optional[RateLimiter] = None,
        rate_limit_kind: str = "check",
    ):
        """Проверка наличия аккаунта MAX по номеру телефона.

        Args:
            phone_number: номер телефона (строка из цифр).
            rate_limiter: опциональный :class:`RateLimiter`. Если задан,
                пробрасывается в ``_make_request`` для обеспечения
                поведенческого rate-limiting (Requirement 1.2). При HTTP 466
                будет поднят :class:`QuotaExceededError`, при исчерпании
                ретраев на HTTP 429 — :class:`Rate429Error`. Без
                ``rate_limiter`` поведение совместимо с прежним: 466
                по-прежнему транслируется в ``QuotaExceededError`` (см.
                ``_make_request``), сетевые/прочие HTTP ошибки приводят к
                ответу ``(False, None)``.
            rate_limit_kind: ``"check"`` (по умолчанию) или ``"broadcast"``
                для случая, когда ``checkAccount`` вызывается в рамках
                рассылки.

        Returns:
            Кортеж ``(exist: bool, chatId: str | None)``.
        """
        payload = {"phoneNumber": int(phone_number)}
        result = self._make_request(
            'POST', 'checkAccount', payload,
            rate_limiter=rate_limiter,
            rate_limit_kind=rate_limit_kind,
        )
        if result:
            return result.get('exist', False), result.get('chatId')
        return False, None

    def get_queue_size(self) -> int:
        """Возвращает размер очереди сообщений."""
        result = self._make_request('GET', 'showMessagesQueue')
        if isinstance(result, list):
            return len(result)
        return 0

    def clear_queue(self) -> dict | None:
        """Очищает очередь сообщений."""
        return self._make_request('GET', 'clearMessagesQueue')

    # ── ПОЛУЧЕНИЕ ДАННЫХ ─────────────────────────────────────────────────────

    def get_chats(self):
        """Получить список всех чатов."""
        result = self._make_request('GET', 'getChats')
        chats = result if isinstance(result, list) else []
        # Diagnostic: log how chatIds are shaped on this instance.
        # Different GREEN-API transports return different formats
        # (WhatsApp vs MAX), and we need real samples to support each
        # correctly. Sampled at INFO level so it surfaces in Railway
        # logs without enabling debug-level globally.
        if chats:
            sample_ids = [
                str(c.get('chatId') or c.get('id') or '')[:80]
                for c in chats[:5]
            ]
            logger.info("get_chats: %d chats, sample chatIds=%r", len(chats), sample_ids)
        return chats

    def get_contacts(self):
        """Получить список всех контактов."""
        result = self._make_request('GET', 'getContacts')
        return result if isinstance(result, list) else []

    def get_contact_info(self, chat_id):
        """Получить информацию о контакте по chatId."""
        payload = {"chatId": _normalize_chat_id(chat_id)}
        return self._make_request('POST', 'getContactInfo', payload)

    def get_chat_history(self, chat_id, count=50):
        """Получить историю сообщений чата.

        Returns:
            * ``list`` — успешный ответ (может быть пустым для нового чата).
            * ``None`` — запрос провалился (HTTP-ошибка, сетевая ошибка).
              В отличие от прошлой реализации, ``None`` НЕ заменяется на
              ``[]``: вызывающий код (``/api/chat-history``) обязан
              различать «пустая история» и «не удалось получить»,
              чтобы фронтенд не стирал уже отрисованные сообщения при
              транзиентном сбое (Requirement: Messenger UX).
        """
        payload = {"chatId": _normalize_chat_id(chat_id), "count": count}
        result = self._make_request('POST', 'getChatHistory', payload)
        if result is None:
            return None
        return result if isinstance(result, list) else []

    def read_chat(self, chat_id, id_message=None):
        """Отметить чат как прочитанный."""
        payload = {"chatId": _normalize_chat_id(chat_id)}
        if id_message:
            payload["idMessage"] = id_message
        return self._make_request('POST', 'readChat', payload)

    # ── ОТПРАВКА СООБЩЕНИЙ ───────────────────────────────────────────────────

    def send_typing(self, chat_id):
        """Имитация набора текста (показывает «печатает…» собеседнику)."""
        payload = {"chatId": _normalize_chat_id(chat_id)}
        return self._make_request('POST', 'sendTyping', payload)

    def send_message(self, chat_id, message):
        """Отправка текстового сообщения."""
        payload = {"chatId": _normalize_chat_id(chat_id), "message": message}
        return self._make_request('POST', 'sendMessage', payload)

    def send_file_by_url(self, chat_id, file_url, file_name, caption=""):
        """Отправка файла по URL."""
        payload = {
            "chatId": _normalize_chat_id(chat_id),
            "urlFile": file_url,
            "fileName": file_name,
            "caption": caption
        }
        return self._make_request('POST', 'sendFileByUrl', payload)

    def _upload_local_file(self, file_path):
        """
        Загрузка локального файла в GREEN-API (`uploadFile`).
        Возвращает разобранный JSON-ответ (включая `urlFile`) или None при ошибке.
        """
        file_name = os.path.basename(file_path)
        with open(file_path, 'rb') as f:
            files = {'file': (file_name, f)}
            upload_result = self._make_multipart_request('uploadFile', files)
        if not upload_result or 'urlFile' not in upload_result:
            logger.error(f"Ошибка загрузки файла: {file_path}")
            return None
        return upload_result

    def send_file_by_upload(self, chat_id, file_path, caption=""):
        """Загрузка и отправка файла с диска."""
        upload_result = self._upload_local_file(file_path)
        if not upload_result:
            return None
        # Затем отправляем по полученному URL
        return self.send_file_by_url(
            chat_id,
            upload_result['urlFile'],
            os.path.basename(file_path),
            caption
        )

    def send_location(self, chat_id, lat, lon, name="", address=""):
        """Отправка геолокации."""
        payload = {
            "chatId": _normalize_chat_id(chat_id),
            "nameLocation": name,
            "address": address,
            "latitude": lat,
            "longitude": lon
        }
        return self._make_request('POST', 'sendLocation', payload)

    def send_contact(self, chat_id, contact_phone, contact_name):
        """Отправка контакта (vCard)."""
        payload = {
            "chatId": _normalize_chat_id(chat_id),
            "contact": {
                "phoneContact": int(contact_phone),
                "firstName": contact_name
            }
        }
        return self._make_request('POST', 'sendContact', payload)

    def delete_message(self, chat_id, id_message):
        """Удаление сообщения."""
        payload = {"chatId": _normalize_chat_id(chat_id), "idMessage": id_message}
        return self._make_request('POST', 'deleteMessage', payload)

    def forward_messages(self, chat_id, from_chat_id, messages):
        """Пересылка сообщений."""
        payload = {
            "chatId": _normalize_chat_id(chat_id),
            "chatIdFrom": _normalize_chat_id(from_chat_id),
            "messages": messages
        }
        return self._make_request('POST', 'forwardMessages', payload)

    # ── РАССЫЛКА ─────────────────────────────────────────────────────────────

    def broadcast(self, contacts, message, delay=2.0, max_queue=100,
                  progress_cb=None, use_typing=False,
                  file_url=None, file_name=None,
                  *,
                  rate_limiter: Optional[RateLimiter] = None,
                  cancel_event: Optional[threading.Event] = None,
                  progress_cb_after_each: Optional[
                      Callable[[int, dict], None]
                  ] = None,
                  burst_mode: bool = False,
                  burst_throttle_state_provider: Optional[
                      Callable[[], str]
                  ] = None):
        """Рассылка с контролем очереди и опциональной анти-бан-защитой.

        Args:
            contacts: список контактов (dict с ключом ``phone`` или строка).
            message: общий шаблон текста; может быть переопределён полем
                ``_message`` отдельного контакта.
            delay: пользовательский delay между сообщениями. Игнорируется,
                если в ``rate_limiter`` задан более высокий floor —
                см. Requirement 2.1, 2.2.
            max_queue: размер очереди, при превышении worker ждёт.
            progress_cb: legacy-колбэк ``progress_cb(done, total, result)``.
            use_typing: имитировать набор текста перед отправкой.
            file_url / file_name: если заданы, отправлять файл вместо
                текста.
            rate_limiter: опциональный :class:`RateLimiter`. Когда задан,
                пробрасывается во все вызовы ``_make_request`` (включая
                ``checkAccount``, ``sendMessage``, ``sendFileByUrl``,
                ``uploadFile``) с ``rate_limit_kind="broadcast"`` —
                Requirement 2.1.
            cancel_event: опциональный :class:`threading.Event`. Перед
                обработкой каждого контакта worker проверяет
                ``cancel_event.is_set()`` и при установленном флаге
                прекращает обработку — Requirement 5.2.
            progress_cb_after_each: опциональный колбэк
                ``(index, result_dict) -> None``, вызывается после
                обработки каждого контакта (``index`` 0-based). Не
                заменяет ``progress_cb``, а дополняет его — нужен
                ``Bulk_Operation`` worker'у в ``app.py`` для записи
                прогресса в ``OperationRun`` и heartbeat.
            burst_mode: True для ``ScheduledBroadcast.schedule_type ==
                "burst"`` (broadcast-scheduling-suite Req 8.2/8.3,
                задача 7.1). Когда True, ``RateLimiter.acquire``
                заменяет случайный jitter на
                :meth:`scheduling.burst_engine.BurstEngine.delay_for`
                и пропускает ``long_pause_every_n``.
                Поскольку Req 8.4 требует обязательно включённого
                ``Adaptive_Throttle`` в burst-режиме, caller (worker
                в ``app.py``) обязан передать действующий ``rate_limiter``
                независимо от ``broadcast.adaptive_throttle`` флага.
            burst_throttle_state_provider: callable без аргументов,
                возвращающий текущее состояние ``Adaptive_Throttle``
                (``"normal"`` или ``"slowed"``). Опрашивается перед
                каждым отправляемым сообщением, чтобы реализовать
                Req 8.5: при появлении 429 state переходит в slowed,
                а после серии успешных — обратно в normal, что даёт
                «recovery toward delay_min на следующей итерации»
                state machine. Если ``None``, считается ``"normal"``.

        Returns:
            Список словарей ``{phone, status, message_id,
            rendered_message, contact_data}`` по обработанным контактам
            (включая прерванные по ``cancel_event``).

        Raises:
            QuotaExceededError: при HTTP 466 от GREEN-API
                (Requirement 4.4). Прокидывается наружу для caller'а.
            Rate429Error: когда исчерпан лимит ретраев на HTTP 429
                (Requirement 4.3). Прокидывается наружу.
        """
        logger.info(
            "Рассылка: %d контактов%s.",
            len(contacts),
            " (burst mode)" if burst_mode else "",
        )
        results = []

        # Burst Mode требует rate_limiter (Req 8.4: Adaptive_Throttle
        # принудительно включён). Без него BurstEngine.delay_for не
        # будет вызван — это нарушит инвариант. Логируем warning и
        # продолжаем как обычная рассылка, чтобы не сломать legacy
        # вызовы; правильная плумба идёт через worker в app.py.
        if burst_mode and rate_limiter is None:
            logger.warning(
                "broadcast(burst_mode=True) вызван без rate_limiter — "
                "burst-pacing проигнорирован, поведение совместимо с "
                "legacy режимом"
            )

        for i, contact in enumerate(contacts):
            # Requirement 5.2: проверка отмены перед каждым контактом.
            if cancel_event is not None and cancel_event.is_set():
                logger.info(
                    f"Рассылка отменена на контакте {i}/{len(contacts)}"
                )
                break

            contact_data = contact if isinstance(contact, dict) else {'phone': str(contact)}
            phone = str(contact_data.get('phone', '')).strip()
            # Если в контакте есть персональное поле `_message` (например,
            # сгенерированный AI текст под этого получателя) — оно имеет
            # приоритет над общим `message`. Это позволяет одной рассылкой
            # отправить уникальный текст каждому контакту.
            per_contact_template = contact_data.get('_message')
            if isinstance(per_contact_template, str) and per_contact_template.strip():
                effective_template = per_contact_template
            else:
                effective_template = message
            rendered_message = render_message_template(effective_template, contact_data)

            # В burst-mode опрашиваем Adaptive_Throttle перед каждым
            # сообщением — это даёт правильную реакцию на 429 (Req 8.5):
            # после 429 state становится "slowed", следующий acquire
            # увеличит паузу; после серии успехов state вернётся в
            # "normal", и burst recovery toward delay_min завершится
            # на той же итерации state machine.
            current_throttle_state = "normal"
            if burst_mode and burst_throttle_state_provider is not None:
                try:
                    current_throttle_state = (
                        burst_throttle_state_provider() or "normal"
                    )
                except Exception:
                    logger.exception(
                        "burst_throttle_state_provider failed, defaulting "
                        "to 'normal'"
                    )
                    current_throttle_state = "normal"

            # Ждём, пока очередь освободится
            while self.get_queue_size() >= max_queue:
                logger.warning("Очередь заполнена. Ожидание 10 сек...")
                time.sleep(10)
                if cancel_event is not None and cancel_event.is_set():
                    logger.info(
                        "Рассылка отменена во время ожидания очереди"
                    )
                    break
            if cancel_event is not None and cancel_event.is_set():
                break

            # Проверка существования контакта. Используем низкоуровневый
            # _make_request, чтобы пробросить rate_limiter с
            # kind="broadcast" — сам факт обращения к GREEN-API учитывается
            # в едином sliding-window рассылки (Requirement 2.1).
            check_resp = self._make_request(
                'POST', 'checkAccount',
                {"phoneNumber": int(phone)} if phone else None,
                rate_limiter=rate_limiter,
                rate_limit_kind="broadcast",
                burst_mode=burst_mode,
                burst_throttle_state=current_throttle_state,
                burst_message_index=i,
            )
            exist = bool(check_resp.get('exist')) if check_resp else False
            chat_id = check_resp.get('chatId') if check_resp else None

            if exist and chat_id:
                # Имитация набора текста
                if use_typing:
                    self._make_request(
                        'POST', 'sendTyping',
                        {"chatId": chat_id},
                        rate_limiter=rate_limiter,
                        rate_limit_kind="broadcast",
                        burst_mode=burst_mode,
                        burst_throttle_state=current_throttle_state,
                        burst_message_index=i,
                    )
                    time.sleep(1.5)

                # Отправка файла или текста
                if file_url and file_name:
                    response = self._make_request(
                        'POST', 'sendFileByUrl',
                        {
                            "chatId": chat_id,
                            "urlFile": file_url,
                            "fileName": file_name,
                            "caption": rendered_message,
                        },
                        rate_limiter=rate_limiter,
                        rate_limit_kind="broadcast",
                        burst_mode=burst_mode,
                        burst_throttle_state=current_throttle_state,
                        burst_message_index=i,
                    )
                else:
                    response = self._make_request(
                        'POST', 'sendMessage',
                        {"chatId": chat_id, "message": rendered_message},
                        rate_limiter=rate_limiter,
                        rate_limit_kind="broadcast",
                        burst_mode=burst_mode,
                        burst_throttle_state=current_throttle_state,
                        burst_message_index=i,
                    )

                if response and 'idMessage' in response:
                    status = 'sent'
                    msg_id = response['idMessage']
                    logger.info(f"[+] {phone} → отправлено. ID: {msg_id}")
                else:
                    status = 'error'
                    msg_id = None
                    logger.error(f"[-] {phone} — ошибка отправки.")
            else:
                status = 'not_found'
                msg_id = None
                logger.info(f"[?] {phone} — не найден в MAX.")

            result = {
                'phone': phone,
                'status': status,
                'message_id': msg_id,
                'rendered_message': rendered_message,
                'contact_data': contact_data,
            }
            results.append(result)

            if progress_cb:
                progress_cb(i + 1, len(contacts), result)
            if progress_cb_after_each is not None:
                progress_cb_after_each(i, result)

            # Если задан rate_limiter — он сам управляет паузами через
            # acquire() в _make_request. Дополнительный sleep(delay)
            # нужен только для legacy-вызовов без rate_limiter.
            if rate_limiter is None:
                time.sleep(delay)

        return results

    def broadcast_with_uploaded_file(self, contacts, message, file_path, file_name,
                                     delay=2.0, use_typing=False, progress_cb=None,
                                     *,
                                     rate_limiter: Optional[RateLimiter] = None,
                                     cancel_event: Optional[threading.Event] = None,
                                     progress_cb_after_each: Optional[
                                         Callable[[int, dict], None]
                                     ] = None,
                                     burst_mode: bool = False,
                                     burst_throttle_state_provider: Optional[
                                         Callable[[], str]
                                     ] = None):
        """
        Рассылка с локальным файлом: один раз загружает файл в GREEN-API
        (`uploadFile`) и переиспользует полученный `urlFile` через `broadcast`.

        При сбое загрузки файла (нет ответа или отсутствует `urlFile`)
        для каждого получателя вызывается `progress_cb` со статусом `error`,
        чтобы UI получил по событию на каждый контакт, как и при обычной
        рассылке.

        Дополнительные kwargs (``rate_limiter``, ``cancel_event``,
        ``progress_cb_after_each``) пробрасываются в :meth:`broadcast` для
        анти-бан-защиты — Requirements 2.1, 5.2.
        Параметры ``burst_mode`` и ``burst_throttle_state_provider``
        пробрасываются для broadcast-scheduling-suite Req 8.2/8.3/8.5
        (задача 7.1).
        """
        upload = self._upload_local_file(file_path)
        if not upload or 'urlFile' not in upload:
            total = len(contacts)
            for i, c in enumerate(contacts):
                contact_data = c if isinstance(c, dict) else {'phone': str(c)}
                phone = str(contact_data.get('phone', '')).strip()
                result = {
                    'phone': phone,
                    'status': 'error',
                    'message_id': None,
                    'rendered_message': message,
                    'contact_data': c,
                }
                if progress_cb:
                    progress_cb(i + 1, total, result)
                if progress_cb_after_each is not None:
                    progress_cb_after_each(i, result)
            return None

        return self.broadcast(
            contacts,
            message,
            delay=delay,
            progress_cb=progress_cb,
            use_typing=use_typing,
            file_url=upload['urlFile'],
            file_name=file_name,
            rate_limiter=rate_limiter,
            cancel_event=cancel_event,
            progress_cb_after_each=progress_cb_after_each,
            burst_mode=burst_mode,
            burst_throttle_state_provider=burst_throttle_state_provider,
        )

    # ── УПРАВЛЕНИЕ ГРУППАМИ ───────────────────────────────────────────────────

    def create_group(self, group_name, chat_ids):
        """Создание группы в MAX."""
        payload = {"groupName": group_name, "chatIds": chat_ids}
        result = self._make_request('POST', 'createGroup', payload)
        if result and 'chatId' in result:
            logger.info(f"Группа '{group_name}' создана. ID: {result['chatId']}")
            return result['chatId']
        return None

    def get_group_data(self, group_id):
        """Получить данные группы и список участников.

        ``group_id`` отдаётся в GREEN-API без модификаций — формат
        зависит от транспорта (WhatsApp возвращает ``<id>@g.us``,
        MAX — голый числовой ID), и принудительный суффикс ломает
        второй случай.
        """
        payload = {"chatId": group_id}
        return self._make_request('POST', 'getGroupData', payload)

    def add_group_participant(self, group_id, participant_chat_id):
        """Добавление участника в группу."""
        payload = {"chatId": group_id, "participantChatId": participant_chat_id}
        return self._make_request('POST', 'addGroupParticipant', payload)

    def remove_group_participant(self, group_id, participant_chat_id):
        """Удаление участника из группы."""
        payload = {"chatId": group_id, "participantChatId": participant_chat_id}
        return self._make_request('POST', 'removeGroupParticipant', payload)

    def set_group_admin(self, group_id, participant_chat_id):
        """Назначить участника администратором группы."""
        payload = {"chatId": group_id, "participantChatId": participant_chat_id}
        return self._make_request('POST', 'setGroupAdmin', payload)

    def remove_group_admin(self, group_id, participant_chat_id):
        """Снять роль администратора с участника группы."""
        payload = {"groupId": group_id, "participantChatId": participant_chat_id}
        return self._make_request('POST', 'removeGroupAdmin', payload)

    def leave_group(self, group_id):
        """Покинуть группу."""
        payload = {"chatId": group_id}
        return self._make_request('POST', 'leaveGroup', payload)

    def update_group_name(self, group_id, group_name):
        """Изменить название группы."""
        payload = {"groupId": group_id, "groupName": group_name}
        return self._make_request('POST', 'updateGroupName', payload)

    def set_group_picture(self, group_id, file_path):
        """Установить аватар группы."""
        file_name = os.path.basename(file_path)
        with open(file_path, 'rb') as f:
            files = {'file': (file_name, f)}
            return self._make_multipart_request('setGroupPicture', files, {'groupId': group_id})

    # ── УВЕДОМЛЕНИЯ (POLLING) ─────────────────────────────────────────────────

    def receive_notification(self):
        """Получить одно уведомление из очереди (polling-режим)."""
        return self._make_request('GET', 'receiveNotification')

    def delete_notification(self, receipt_id):
        """Удалить уведомление из очереди после обработки."""
        result = self._make_request('DELETE', f'deleteNotification/{receipt_id}', None)
        return result

    def poll_all_notifications(self):
        """Получить и обработать все накопленные уведомления."""
        notifications = []
        while True:
            notif = self.receive_notification()
            if not notif or 'receiptId' not in notif:
                break
            receipt_id = notif['receiptId']
            body = notif.get('body', {})
            notifications.append(body)
            # Удаляем обработанное уведомление
            url = f"{self.base_url}/deleteNotification/{receipt_id}/{self.api_token}"
            try:
                requests.delete(url, timeout=10)
            except Exception as e:
                logger.error(f"Ошибка удаления уведомления {receipt_id}: {e}")
        return notifications
