import os
import csv
import json
import queue
import threading
import logging
import time
import sys
from dataclasses import asdict, fields
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

from bot import MaxBot, QuotaExceededError, Rate429Error
from anti_ban.config import AntiBanConfig, UNHEALTHY
from anti_ban.config_loader import config_loader
from anti_ban.rate_limiter import RateLimiter
from anti_ban.registry import registry, RunHandle
from anti_ban.audit import audit_logger
from anti_ban.payload import deserialize_payload, PayloadValidationError
from anti_ban.watchdog import Watchdog
from anti_ban.state_monitor import StateMonitor
import db

def get_data_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

# ── Инициализация ──────────────────────────────────────────────────────────
env_path = os.path.join(get_data_path(), '.env')
load_dotenv(dotenv_path=env_path)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)


def parse_cors_origins():
    defaults = [
        "http://localhost:3000", "http://localhost:3001",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://localhost:5000",
    ]
    configured = []
    for key in ("FRONTEND_URL", "FRONTEND_ORIGINS"):
        configured.extend(os.getenv(key, "").split(","))

    origins = []
    for origin in [*defaults, *configured]:
        normalized = origin.strip().rstrip("/")
        if normalized and normalized not in origins:
            origins.append(normalized)
    return origins


# Allow Next.js frontend and local development
CORS(app, resources={r"/api/*": {
    "origins": parse_cors_origins(),
    "allow_headers": ["Content-Type", "Authorization", "X-Green-Api-Id", "X-Green-Api-Token", "X-Green-Api-Url"],
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    "supports_credentials": True,
}})


UPLOAD_FOLDER = os.path.join(get_data_path(), 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

FLASK_PORT = int(os.getenv('PORT') or os.getenv('FLASK_PORT', 5000))
FLASK_DEBUG = os.getenv('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes', 'on')


def current_bot() -> MaxBot:
    id_instance = request.headers.get('X-Green-Api-Id', '').strip()
    api_token = request.headers.get('X-Green-Api-Token', '').strip()
    api_url = request.headers.get('X-Green-Api-Url', 'https://api.green-api.com').strip().rstrip('/') or 'https://api.green-api.com'
    if not id_instance or not api_token:
        raise ValueError('GREEN-API credentials are not configured')
    bot = MaxBot(id_instance, api_token)
    bot.base_url = f"{api_url}/waInstance{id_instance}"
    _record_credentials(id_instance, api_token, api_url)
    return bot


def credentials_error_response(exc: Exception):
    return jsonify({'error': str(exc)}), 400


@app.errorhandler(ValueError)
def handle_value_error(exc: ValueError):
    return credentials_error_response(exc)


# ── SSE-очереди ───────────────────────────────────────────────────────────
_sse_clients:   list[queue.Queue] = []
_check_clients: list[queue.Queue] = []
_broadcast_lock  = threading.Lock()
_broadcast_active = False
_check_active     = False


def _push_all(clients: list, data: dict):
    dead = []
    for q in clients:
        try:
            q.put_nowait(data)
        except queue.Full:
            dead.append(q)
    for q in dead:
        clients.remove(q)


def sse_push(data: dict):
    _push_all(_sse_clients, data)


# ── Anti-ban: Watchdog + StateMonitor (Task 15.1) ─────────────────────────
#
# Singletons, запускаемые при старте Flask-приложения. ``Watchdog``
# стартует немедленно и работает как daemon-thread (Requirements 5.3,
# 5.4). ``StateMonitor`` стартует лениво — на первом подключении к
# любому SSE-каналу прогресса (Requirement 3.2 — поллинг во время
# активной подписки), и продолжает жить до остановки процесса.
#
# Между ``anti_ban`` и ``app.py`` нет прямой ссылки на глобальные
# флаги: вместо этого они инжектируются через callback'и
# (``_clear_global_flag`` / ``_publish_to_kind``), чтобы избежать
# циклической зависимости и облегчить тестирование.

_watchdog_lock = threading.Lock()
_watchdog_instance: Watchdog | None = None

_state_monitor_lock = threading.Lock()
_state_monitor_instance: StateMonitor | None = None

# Последние известные креденшелы GREEN-API. ``StateMonitor`` работает
# в фоне без HTTP-контекста и не может прочитать заголовки запроса,
# поэтому мы запоминаем их при каждом успешном вызове ``current_bot()``
# и используем для построения бота в фабрике ``_state_monitor_bot_factory``.
_credentials_lock = threading.Lock()
_last_credentials = {
    'id_instance': None,
    'api_token': None,
    'api_url': 'https://api.green-api.com',
}


def _record_credentials(id_instance: str, api_token: str, api_url: str) -> None:
    """Сохранить последние известные креденшелы для фоновых потоков."""
    with _credentials_lock:
        _last_credentials['id_instance'] = id_instance
        _last_credentials['api_token'] = api_token
        _last_credentials['api_url'] = api_url


def _clear_global_flag(name: str) -> None:
    """Сбросить ``_check_active`` / ``_broadcast_active`` из Watchdog'а.

    Используется как callback для ``Watchdog`` (Requirement 5.4): при
    срабатывании таймаута фоновый поток должен сбросить глобальный
    флаг в ``app.py``, не имея прямой ссылки на модуль (которая бы
    создала циклический импорт).
    """
    global _check_active, _broadcast_active
    if name == '_check_active':
        _check_active = False
    elif name == '_broadcast_active':
        _broadcast_active = False


def _publish_to_kind(kind: str, event: dict) -> None:
    """Опубликовать SSE-событие во все клиенты канала ``kind``.

    ``kind`` соответствует ``RunHandle.kind`` (``"check"`` или
    ``"broadcast"``) и сопоставляется с одним из двух списков
    SSE-клиентов. Используется как callback для ``Watchdog``
    (Requirement 5.4) и ``StateMonitor`` (Requirements 3.1, 3.2).
    """
    if kind == 'check':
        _push_all(_check_clients, event)
    elif kind == 'broadcast':
        _push_all(_sse_clients, event)


def _ensure_watchdog() -> Watchdog:
    """Запустить ``Watchdog`` идемпотентно при старте приложения.

    Watchdog — общесистемный (один на процесс), а не per-user, потому
    что он наблюдает за реестром ``OperationRunRegistry``, который
    тоже общесистемный singleton. Конфигурация по умолчанию
    (``AntiBanConfig()``) используется здесь сознательно: per-user
    параметры применяются на уровне worker'ов через ``RateLimiter``,
    а Watchdog читает только ``watchdog_check_interval_seconds`` /
    ``watchdog_timeout_seconds``, которые целесообразно держать
    общими для всего процесса.
    """
    global _watchdog_instance
    with _watchdog_lock:
        if _watchdog_instance is None:
            cfg = AntiBanConfig()
            _watchdog_instance = Watchdog(
                config=cfg,
                registry=registry,
                audit_logger=audit_logger,
                clear_global_flag=_clear_global_flag,
                publish=_publish_to_kind,
            )
            _watchdog_instance.start()
            logger.info("anti_ban.Watchdog started")
        return _watchdog_instance


def _state_monitor_bot_factory():
    """Фабрика ``MaxBot`` для ``StateMonitor`` без HTTP-контекста.

    ``StateMonitor`` опрашивает ``getStateInstance`` в фоне, не имея
    доступа к заголовкам запроса. Мы используем последние известные
    креденшелы, обновляемые в ``current_bot()``. Если креденшелы
    ещё не сохранялись (пользователь не делал ни одного запроса), —
    возвращаем заглушку, чьё ``get_state()`` бросает исключение;
    ``StateMonitor`` нормализует это в ``UNKNOWN`` (Requirement 3.6).
    """
    with _credentials_lock:
        id_inst = _last_credentials['id_instance']
        api_tok = _last_credentials['api_token']
        api_url = _last_credentials['api_url'] or 'https://api.green-api.com'
    if not id_inst or not api_tok:
        class _NoCredsBot:
            def get_state(self):
                raise RuntimeError("no GREEN-API credentials available yet")
        return _NoCredsBot()
    bot = MaxBot(id_inst, api_tok)
    bot.base_url = f"{api_url.rstrip('/')}/waInstance{id_inst}"
    return bot


def _ensure_state_monitor() -> StateMonitor:
    """Лениво запустить ``StateMonitor`` (Requirement 3.2).

    Стартует при первом подключении к одному из SSE-каналов прогресса.
    Поток-наблюдатель — daemon, поэтому корректно завершится вместе
    с процессом; явной остановки на отключении последнего подписчика
    мы не делаем, чтобы не плодить race'ов между потоками
    подключения/отключения.
    """
    global _state_monitor_instance
    with _state_monitor_lock:
        if _state_monitor_instance is None:
            cfg = AntiBanConfig()
            _state_monitor_instance = StateMonitor(
                config=cfg,
                registry=registry,
                audit_logger=audit_logger,
                bot_factory=_state_monitor_bot_factory,
                publish=_publish_to_kind,
            )
            _state_monitor_instance.start()
            logger.info("anti_ban.StateMonitor started")
        return _state_monitor_instance


# Watchdog запускается немедленно при импорте модуля, чтобы охватывать
# любые операции, стартующие сразу после загрузки приложения.
_ensure_watchdog()


def clean_phone(value) -> str:
    return ''.join(filter(str.isdigit, str(value or '')))


def normalize_csv_field(value) -> str:
    field = str(value or '').strip().lower()
    replacements = {
        'телефон': 'phone',
        'номер': 'phone',
        'номер телефона': 'phone',
        'phone number': 'phone',
        'mobile': 'phone',
        'имя': 'name',
        'город': 'city',
        'компания': 'company',
        'заказ': 'order',
        'дата': 'date',
    }
    field = replacements.get(field, field)
    field = field.replace(' ', '_').replace('-', '_')
    return ''.join(ch for ch in field if ch.isalnum() or ch == '_') or 'field'


def unique_field_names(fields):
    result = []
    counts = {}
    for field in fields:
        normalized = normalize_csv_field(field)
        counts[normalized] = counts.get(normalized, 0) + 1
        result.append(normalized if counts[normalized] == 1 else f"{normalized}_{counts[normalized]}")
    return result


def looks_like_header(row) -> bool:
    normalized = [normalize_csv_field(cell) for cell in row]
    return any(field == 'phone' or 'phone' in field for field in normalized)


def build_contact(row, fields):
    contact = {}
    for field, value in zip(fields, row):
        contact[field] = str(value or '').strip()
    phone = clean_phone(contact.get('phone'))
    if not phone:
        for value in contact.values():
            phone = clean_phone(value)
            if 10 <= len(phone) <= 15:
                break
    if 10 <= len(phone) <= 15:
        contact['phone'] = phone
        return contact
    return None


def normalize_contacts(raw_contacts, phones_fallback=None):
    """Привести `raw_contacts` (list[dict|str]) к списку валидных контактов.

    Если ``raw_contacts`` не список — fallback к ``phones_fallback`` (список телефонов).
    Возвращает список словарей с обязательным ключом ``phone``.
    """
    contacts = []
    if isinstance(raw_contacts, list):
        for item in raw_contacts:
            if isinstance(item, dict):
                contact = {str(k): str(v or '').strip() for k, v in item.items()}
                phone = clean_phone(contact.get('phone'))
                if 10 <= len(phone) <= 15:
                    contact['phone'] = phone
                    contacts.append(contact)
            else:
                phone = clean_phone(item)
                if 10 <= len(phone) <= 15:
                    contacts.append({'phone': phone})
    else:
        for p in (phones_fallback or []):
            phone = clean_phone(p)
            if 10 <= len(phone) <= 15:
                contacts.append({'phone': phone})
    return contacts


# ── Статус инстанса ────────────────────────────────────────────────────────
@app.route('/api/status')
def api_status():
    try:
        state = current_bot().get_state()
    except ValueError as exc:
        return credentials_error_response(exc)
    return jsonify({'state': state, 'broadcast_active': _broadcast_active})


# ── Конфигурация инстанса ─────────────────────────────────────────────────
@app.route('/api/configure', methods=['POST'])
def api_configure():
    return jsonify({'error': 'Configure GREEN-API credentials in dashboard settings'}), 410


# ── QR-код ────────────────────────────────────────────────────────────────
@app.route('/api/qr')
def api_qr():
    return jsonify(current_bot().get_qr_code())


# ── Настройки аккаунта ────────────────────────────────────────────────────
@app.route('/api/account-settings')
def api_account_settings():
    result = current_bot().get_account_settings()
    return jsonify(result or {})


# ── Перезапуск инстанса ───────────────────────────────────────────────────
@app.route('/api/reboot', methods=['POST'])
def api_reboot():
    ok = current_bot().reboot_instance()
    return jsonify({'success': ok})


# ── Проверка одного номера ─────────────────────────────────────────────────
@app.route('/api/check-contact', methods=['POST'])
def api_check_contact():
    data  = request.get_json(force=True)
    phone = data.get('phone', '').strip()
    if not phone:
        return jsonify({'error': 'phone required'}), 400
    exist, chat_id = current_bot().check_contact(phone)
    return jsonify({'phone': phone, 'exists': exist, 'chatId': chat_id})


# ── Загрузка CSV ──────────────────────────────────────────────────────────
@app.route('/api/upload-contacts', methods=['POST'])
def api_upload_contacts():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    if not f.filename.endswith('.csv'):
        return jsonify({'error': 'only CSV files accepted'}), 400
    save_path = os.path.join(UPLOAD_FOLDER, 'contacts.csv')
    f.save(save_path)
    phones = []
    contacts = []
    fields = ['phone']
    warnings = []
    with open(save_path, newline='', encoding='utf-8-sig') as csvfile:
        reader = csv.reader(csvfile)
        rows = [row for row in reader if any(str(cell).strip() for cell in row)]

    if not rows:
        return jsonify({'phones': [], 'contacts': [], 'fields': fields, 'count': 0, 'warnings': ['CSV файл пуст']})

    if looks_like_header(rows[0]):
        fields = unique_field_names(rows[0])
        for index, row in enumerate(rows[1:], start=2):
            contact = build_contact(row, fields)
            if contact:
                contacts.append(contact)
                phones.append(contact['phone'])
            else:
                warnings.append(f'Строка {index}: телефон не найден')
    else:
        for row in rows:
            for cell in row:
                cleaned = clean_phone(cell)
                if 10 <= len(cleaned) <= 15:
                    phones.append(cleaned)
                    contacts.append({'phone': cleaned})

    unique_contacts = []
    seen = set()
    for contact in contacts:
        phone = contact.get('phone')
        if phone and phone not in seen:
            seen.add(phone)
            unique_contacts.append(contact)

    phones = [contact['phone'] for contact in unique_contacts]
    fields = sorted({key for contact in unique_contacts for key in contact.keys()} | set(fields))
    return jsonify({'phones': phones, 'contacts': unique_contacts, 'fields': fields, 'count': len(unique_contacts), 'warnings': warnings})


# ── Рассылка ──────────────────────────────────────────────────────────────
#
# Anti-ban-protected handler по образцу `/api/check-contacts-bulk`
# (см. design.md секцию "Поток выполнения Bulk_Operation" и
# Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 3.3, 3.4, 5.5, 7.1, 7.2).
# Поведение:
#
# 1. Pre-flight: вызывает ``getStateInstance``; при ``state ∈ UNHEALTHY``
#    возвращает HTTP 409 ``{"state": <state>}`` (Requirement 3.3,
#    Property 7).
# 2. Дневной лимит: проверяет ``audit_logger.count_in_window(user_id,
#    "broadcast", "day")`` против ``config.daily_message_limit`` —
#    превышение → HTTP 429 (Requirement 2.4).
# 3. Zero-response-ratio warning (Requirement 2.5): если
#    ``warn_on_zero_response_ratio`` включён, ``incoming == 0`` и
#    ``outgoing >= response_ratio_min_outgoing`` за
#    ``response_ratio_window_hours`` — поле ``warning ==
#    "zero_response_ratio"`` добавляется в ответ старта.
#    Предупреждение информативное и не блокирует запуск.
# 4. Создаёт ``OperationRun`` (status=running, payload) через
#    ``audit_logger.start_run`` и регистрирует worker в ``registry``.
# 5. Worker-thread вызывает ``bot.broadcast(...)`` с ``RateLimiter``
#    (kind="broadcast"), ``cancel_event`` и
#    ``progress_cb_after_each``: rate-limiter сам обеспечивает
#    минимальную паузу ``broadcast_delay_min`` и jitter
#    ``[0, broadcast_jitter_max]`` (Requirements 2.1, 2.2, 2.3),
#    игнорируя пользовательский ``delay``, если он ниже floor.
# 6. ``try/finally``: гарантированный сброс ``_broadcast_active``,
#    ``audit.finish_run``, удаление временного файла и
#    ``registry.deregister`` (Requirement 5.5, Property 18).
# 7. В JSON ответа на старт — ``operation_run_id``, ``broadcast_id``,
#    ``total`` и опциональный ``warning``.


def _count_incoming_in_window(hours: int) -> int:
    """Количество входящих сообщений за последние ``hours`` часов.

    Используется только для проверки zero-response-ratio
    (Requirement 2.5). Считает строки в таблице ``incoming``
    (см. ``db.py``) с ``received_at >= now - hours``. Если таблица
    отсутствует или БД недоступна — возвращает ``0`` (защитное
    поведение: при невозможности измерить входящие мы трактуем
    их как ноль и оставляем решение о warning'е каскаду
    ``incoming == 0 ∧ outgoing >= min``).

    Замечание про TZ: ``incoming.received_at`` записывается через
    ``datetime.now().isoformat(...)`` в локальной TZ (см. ``db.add_incoming``).
    Чтобы лексикографическое сравнение ISO-строк работало корректно,
    порог тоже формируется в локальной TZ.
    """
    try:
        threshold = (datetime.now() - timedelta(hours=int(hours))).isoformat(
            timespec='seconds'
        )
        conn = db.get_conn()
    except Exception:
        return 0
    try:
        with conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM incoming WHERE received_at >= ?",
                (threshold,),
            ).fetchone()
    except Exception:
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if row is None:
        return 0
    try:
        return int(row['cnt'])
    except (TypeError, IndexError, KeyError):
        return int(row[0] or 0)


@app.route('/api/broadcast', methods=['POST'])
def api_broadcast():
    global _broadcast_active

    # Backward-compat защёлка: глобальный флаг защищает от двойного
    # запуска из одного процесса. Watchdog (Requirement 5.4) служит
    # внешней страховкой, если worker зависнет.
    if _broadcast_active:
        return jsonify({'error': 'Рассылка уже запущена'}), 409

    content_type = (request.content_type or '').lower()
    is_multipart = content_type.startswith('multipart/')

    uploaded_path = None        # для multipart — реальный путь в UPLOAD_FOLDER
    uploaded_name = None
    file_url = None             # legacy JSON-ветка
    file_name = None

    if is_multipart:
        form = request.form
        # contacts/phones приходят как JSON-строки
        raw_contacts_str = form.get('contacts') or '[]'
        phones_str = form.get('phones') or '[]'
        try:
            raw_contacts = json.loads(raw_contacts_str)
        except (ValueError, TypeError):
            return jsonify({'error': 'Поле "contacts" содержит некорректный JSON'}), 400
        try:
            phones_list = json.loads(phones_str)
        except (ValueError, TypeError):
            return jsonify({'error': 'Поле "phones" содержит некорректный JSON'}), 400
        if not isinstance(phones_list, list):
            phones_list = []
        phones = [str(p).strip() for p in phones_list if str(p).strip()]

        message = str(form.get('message') or '').strip()
        try:
            user_delay = float(form.get('delay') or 3)
        except (ValueError, TypeError):
            user_delay = 3.0
        use_typing = (str(form.get('use_typing') or '').lower() in ('1', 'true', 'yes', 'on'))
        broadcast_id = form.get('broadcast_id') or 1

        f = request.files.get('file')
        if f and f.filename:
            os.makedirs(UPLOAD_FOLDER, exist_ok=True)
            safe_name = secure_filename(f.filename) or 'attachment'
            uploaded_name = safe_name
            uploaded_path = os.path.join(UPLOAD_FOLDER, f"bcast_{int(time.time())}_{safe_name}")
            f.save(uploaded_path)
    else:
        data = request.get_json(force=True, silent=True) or {}
        raw_contacts = data.get('contacts')
        phones = [str(p).strip() for p in data.get('phones', []) if str(p).strip()]
        message = str(data.get('message') or '').strip()
        try:
            user_delay = float(data.get('delay', 3))
        except (ValueError, TypeError):
            user_delay = 3.0
        use_typing = bool(data.get('use_typing', False))
        broadcast_id = data.get('broadcast_id') or 1
        file_url = str(data.get('file_url') or '').strip() or None
        file_name = str(data.get('file_name') or '').strip() or None
        if file_url and not file_name:
            file_name = file_url.rstrip('/').split('/')[-1] or 'attachment'

    contacts = normalize_contacts(raw_contacts, phones)

    has_attachment = bool(uploaded_path) if is_multipart else bool(file_url)

    def _cleanup_upload():
        if is_multipart and uploaded_path:
            try:
                os.remove(uploaded_path)
            except OSError as exc:
                logger.warning(
                    "Не удалось удалить временный файл %s: %s",
                    uploaded_path, exc,
                )

    if not contacts:
        _cleanup_upload()
        return jsonify({'error': 'Список номеров пуст'}), 400
    if not message and not has_attachment:
        _cleanup_upload()
        return jsonify({'error': 'Укажите сообщение или файл'}), 400

    try:
        request_bot = current_bot()
    except ValueError as exc:
        _cleanup_upload()
        return credentials_error_response(exc)

    user_id = _resolve_user_id()
    config = config_loader.get(user_id)

    # --- Pre-flight: getStateInstance (Requirement 3.3) -----------------
    try:
        current_state = request_bot.get_state()
    except Exception:
        # Если состояние получить не удалось — трактуем как unknown
        # (Requirement 3.6: unknown не блокирует старт).
        logger.warning("Pre-flight getStateInstance failed", exc_info=True)
        current_state = 'unknown'

    if current_state in UNHEALTHY:
        _cleanup_upload()
        return jsonify({
            'error': 'instance_unhealthy',
            'state': current_state,
        }), 409

    # --- Дневной лимит сообщений (Requirement 2.4, Property 4) ----------
    sent_today = audit_logger.count_in_window(user_id, 'broadcast', 'day')
    if sent_today + len(contacts) > config.daily_message_limit:
        _cleanup_upload()
        return jsonify({
            'error': 'daily_limit_exceeded',
            'limit': config.daily_message_limit,
            'current': sent_today,
        }), 429

    # --- Zero-response-ratio warning (Requirement 2.5, Property 6) ------
    warning = None
    if config.warn_on_zero_response_ratio:
        outgoing = audit_logger.count_in_window(user_id, 'broadcast', 'day')
        incoming = _count_incoming_in_window(config.response_ratio_window_hours)
        if incoming == 0 and outgoing >= config.response_ratio_min_outgoing:
            warning = 'zero_response_ratio'

    # --- Создание OperationRun + регистрация worker ---------------------
    payload_params = {
        'message_template': message,
        'use_typing': bool(use_typing),
        'file_url': file_url,
        'file_name': file_name,
        'delay': float(user_delay),
        'broadcast_id': broadcast_id,
    }
    run_id = audit_logger.start_run(
        user_id=user_id,
        kind='broadcast',
        total=len(contacts),
        payload={'contacts': contacts, 'params': payload_params},
    )

    cancel_event = threading.Event()
    handle = RunHandle(
        run_id=run_id,
        cancel_event=cancel_event,
        last_progress_at=time.time(),
        kind='broadcast',
        global_flag_name='_broadcast_active',
    )
    registry.register(run_id, handle)

    rate_limiter = RateLimiter(config)

    # Глобальный флаг ставится синхронно в обработчике, чтобы
    # повторный POST в тот же миг получил 409. Сброс — в worker'е через
    # try/finally (Requirement 5.5).
    _broadcast_active = True

    threading.Thread(
        target=_run_broadcast_worker,
        kwargs={
            'run_id': run_id,
            'contacts': contacts,
            'message': message,
            'user_delay': user_delay,
            'use_typing': use_typing,
            'broadcast_id': broadcast_id,
            'is_multipart': is_multipart,
            'uploaded_path': uploaded_path,
            'uploaded_name': uploaded_name,
            'file_url': file_url,
            'file_name': file_name,
            'user_id': user_id,
            'cancel_event': cancel_event,
            'rate_limiter': rate_limiter,
            'config': config,
            'bot_instance': request_bot,
        },
        name=f'broadcast-worker-{run_id}',
        daemon=True,
    ).start()

    response = {
        'operation_run_id': run_id,
        'broadcast_id': broadcast_id,
        'total': len(contacts),
        'status': 'running',
    }
    if warning is not None:
        response['warning'] = warning
    return jsonify(response), 202


def _run_broadcast_worker(
    *,
    run_id: int,
    contacts: list,
    message: str,
    user_delay: float,
    use_typing: bool,
    broadcast_id,
    is_multipart: bool,
    uploaded_path,
    uploaded_name,
    file_url,
    file_name,
    user_id: str,
    cancel_event: threading.Event,
    rate_limiter: RateLimiter,
    config,
    bot_instance: MaxBot,
    start_index: int = 0,
):
    """Worker-поток `Broadcast_Service`.

    Использует ``bot.broadcast(...)`` (или ``broadcast_with_uploaded_file``
    для multipart) — те уже умеют принимать ``rate_limiter``,
    ``cancel_event`` и ``progress_cb_after_each`` (см. задачу 6.2).
    На любом терминальном событии финализирует ``OperationRun`` и
    аккуратно сбрасывает глобальный флаг ``_broadcast_active``
    (Requirement 5.5).

    Параметр ``start_index`` (Requirement 7.4): для resume worker
    получает полный список ``contacts`` и пропускает первые
    ``start_index`` элементов; в ``bot.broadcast`` передаётся
    ``contacts[start_index:]``, а в ``progress_after_each`` индекс
    смещается на ``start_index``, чтобы ``OperationRun.processed`` и
    ``last_processed_index`` продолжали возрастать монотонно.
    """
    global _broadcast_active

    total = len(contacts)
    counters = {'sent': 0, 'not_found': 0, 'failed': 0}
    final_status: str = 'completed'
    final_reason = None
    # Срез для отправки боту: при свежем старте start_index=0, иначе —
    # резюме с последнего необработанного индекса.
    contacts_slice = contacts[start_index:] if start_index else contacts

    def progress_cb(done, total_, result):
        # Legacy-колбэк: считает per-status счётчики и пушит SSE-событие
        # в формате, который понимает существующий фронтенд. Для resume
        # значения ``done``/``total_`` приходят от ``bot.broadcast`` в
        # терминах ``contacts_slice``; смещаем их на ``start_index``,
        # чтобы прогресс-бар на фронтенде показывал суммарную позицию.
        s = result['status']
        if s == 'sent':
            counters['sent'] += 1
        elif s == 'not_found':
            counters['not_found'] += 1
        else:
            counters['failed'] += 1
        sse_push({
            'done': start_index + done,
            'total': total,
            'phone': result['phone'],
            'status': s,
            'message_id': result.get('message_id'),
            'rendered_message': result.get('rendered_message'),
            'contact_data': result.get('contact_data'),
            'broadcast_id': broadcast_id,
            'operation_run_id': run_id,
        })

    def progress_after_each(index, result):
        # Anti-ban-колбэк: фиксирует прогресс в OperationRun, обновляет
        # heartbeat в реестре. Состояние ``Instance_State`` в течение
        # рассылки опрашивается ``StateMonitor``-ом, который через
        # ``cancel_event`` останавливает worker — здесь делать
        # дополнительный live-state polling не нужно (бы дублировал
        # работу StateMonitor и удвоил RPS на ``getStateInstance``).
        # Index — 0-based внутри ``contacts_slice``; абсолютная
        # позиция в исходном payload — ``start_index + index``.
        absolute_index = start_index + index
        processed = absolute_index + 1
        try:
            audit_logger.update_progress(
                run_id,
                processed=processed,
                last_processed_index=absolute_index,
            )
        except Exception:
            logger.exception(
                "broadcast worker: update_progress failed (run_id=%s)",
                run_id,
            )
        registry.heartbeat(run_id)

    try:
        if is_multipart and uploaded_path:
            bot_instance.broadcast_with_uploaded_file(
                contacts_slice, message, uploaded_path, uploaded_name,
                delay=user_delay, use_typing=use_typing,
                progress_cb=progress_cb,
                rate_limiter=rate_limiter,
                cancel_event=cancel_event,
                progress_cb_after_each=progress_after_each,
            )
        else:
            bot_instance.broadcast(
                contacts_slice, message, delay=user_delay,
                progress_cb=progress_cb,
                use_typing=use_typing,
                file_url=file_url, file_name=file_name,
                rate_limiter=rate_limiter,
                cancel_event=cancel_event,
                progress_cb_after_each=progress_after_each,
            )

        # Если cancel_event сработал внутри bot.broadcast — это не
        # исключение, а штатный выход. Различаем по флагу.
        if cancel_event.is_set():
            final_status = 'aborted'
            final_reason = 'cancelled'
    except QuotaExceededError as exc:
        # Requirement 4.4 / Property 13: HTTP 466 — немедленный abort.
        audit_logger.log_incident(
            user_id=user_id,
            run_id=run_id,
            kind='quota_466',
            details={'error': str(exc)},
        )
        final_status = 'aborted'
        final_reason = 'quota_466'
    except Rate429Error as exc:
        # Requirement 4.3 / Property 12: исчерпан max_retries
        # последовательных 429 → aborted + incident.
        audit_logger.log_incident(
            user_id=user_id,
            run_id=run_id,
            kind='rate_limit_429',
            details={'retry_count': getattr(exc, 'retry_count', None)},
        )
        final_status = 'aborted'
        final_reason = 'rate_limit_429'
    except Exception as exc:
        logger.exception(
            "broadcast worker: unexpected error (run_id=%s)", run_id,
        )
        audit_logger.log_incident(
            user_id=user_id,
            run_id=run_id,
            kind='error',
            details={'error': str(exc)},
        )
        final_status = 'aborted'
        final_reason = 'error'
    finally:
        # --- Cleanup временного файла ----------------------------------
        if is_multipart and uploaded_path:
            try:
                os.remove(uploaded_path)
            except OSError as exc:
                logger.warning(
                    "Не удалось удалить временный файл %s: %s",
                    uploaded_path, exc,
                )

        # --- Финализация Operation_Run (Requirement 7.3) ---------------
        try:
            audit_logger.finish_run(
                run_id,
                status=final_status,
                reason=final_reason,
            )
        except Exception:
            logger.exception(
                "broadcast worker: failed to finalise operation_run %s",
                run_id,
            )

        # --- Финальное SSE-событие -------------------------------------
        sse_push({
            'done': total,
            'total': total,
            'finished': True,
            'reason': final_reason or final_status,
            'broadcast_id': broadcast_id,
            'operation_run_id': run_id,
            **counters,
        })

        # --- Гарантированный сброс глобального флага (Req 5.5) ---------
        _broadcast_active = False
        registry.deregister(run_id)


# ── SSE: прогресс рассылки ────────────────────────────────────────────────
@app.route('/api/broadcast/progress')
def api_broadcast_progress():
    # Lazy-start общесистемного StateMonitor на первой подписке
    # (Requirement 3.2: опрос ``getStateInstance`` пока есть подписчик).
    _ensure_state_monitor()

    client_q: queue.Queue = queue.Queue(maxsize=200)
    _sse_clients.append(client_q)

    def generate():
        try:
            while True:
                try:
                    # Heartbeat ``: ping\n\n`` каждые 15 секунд
                    # (Requirement задачи 15.1; согласовано с
                    # ``sse_client_timeout_seconds`` ≥ 60 на клиенте).
                    data = client_q.get(timeout=15)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get('finished'):
                        break
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            if client_q in _sse_clients:
                _sse_clients.remove(client_q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )


# ── История рассылок ───────────────────────────────────────────────────────
@app.route('/api/history')
def api_history():
    return jsonify([])


@app.route('/api/history/<int:broadcast_id>')
def api_history_detail(broadcast_id):
    return jsonify([])


@app.route('/api/delivery-statuses/<int:broadcast_id>')
def api_delivery_statuses(broadcast_id):
    return jsonify([])


# ── Шаблоны ───────────────────────────────────────────────────────────────
@app.route('/api/templates', methods=['GET'])
def api_templates_get():
    return jsonify([])


@app.route('/api/templates', methods=['POST'])
def api_templates_create():
    data = request.get_json(force=True)
    name = data.get('name', '').strip()
    text = data.get('text', '').strip()
    if not name or not text:
        return jsonify({'error': 'name and text required'}), 400
    tid = 1
    return jsonify({'id': tid, 'name': name, 'text': text}), 201


@app.route('/api/templates/<int:tid>', methods=['DELETE'])
def api_templates_delete(tid):
    pass
    return jsonify({'deleted': tid})


# ── Webhook ───────────────────────────────────────────────────────────────
@app.route('/api/setup-webhook', methods=['POST'])
def api_setup_webhook():
    data = request.get_json(force=True)
    url  = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'URL обязателен'}), 400
    ok = current_bot().setup_webhook(url)
    if ok:
        return jsonify({'success': True, 'url': url})
    return jsonify({'error': 'Не удалось установить Webhook'}), 500


@app.route('/webhook', methods=['POST'])
def webhook():
    payload      = request.get_json(force=True, silent=True) or {}
    type_webhook = payload.get('typeWebhook', '')

    if type_webhook == 'incomingMessageReceived':
        msg_data    = payload.get('messageData', {})
        sender_data = payload.get('senderData', {})
        sender      = sender_data.get('sender', 'unknown')
        sender_name = sender_data.get('senderName', '')
        msg_type    = msg_data.get('typeMessage', 'text')
        text        = ''
        file_url    = None

        if msg_type == 'textMessage':
            text = msg_data.get('textMessageData', {}).get('textMessage', '')
        elif msg_type == 'imageMessage':
            img = msg_data.get('imageMessageData', {})
            text     = img.get('caption', '[изображение]')
            file_url = img.get('downloadUrl')
        elif msg_type == 'documentMessage':
            doc = msg_data.get('documentMessageData', {})
            text     = doc.get('fileName', '[документ]')
            file_url = doc.get('downloadUrl')
        elif msg_type == 'videoMessage':
            vid = msg_data.get('videoMessageData', {})
            text     = vid.get('caption', '[видео]')
            file_url = vid.get('downloadUrl')
        elif msg_type == 'audioMessage':
            text = '[голосовое сообщение]'
        elif msg_type == 'locationMessage':
            loc  = msg_data.get('locationMessageData', {})
            text = f"[геолокация] {loc.get('nameLocation', '')} {loc.get('address', '')}"
        elif msg_type == 'contactMessage':
            cnt  = msg_data.get('contactMessageData', {})
            text = f"[контакт] {cnt.get('displayName', '')}"

        pass
        logger.info(f"Входящее от {sender} ({sender_name}): {text[:80]}")

    elif type_webhook == 'outgoingMessageStatus':
        msg_data   = payload.get('messageData', {})
        msg_id     = msg_data.get('idMessage', '')
        status_raw = msg_data.get('status', '')
        # Нормализуем статус
        status_map = {
            'sent': 'sent', 'delivered': 'delivered',
            'read': 'read', 'failed': 'failed'
        }
        status = status_map.get(status_raw, status_raw)
        if msg_id:
            pass
            logger.info(f"Статус доставки {msg_id}: {status}")

    return jsonify({'status': 'ok'})


# ── Входящие сообщения ────────────────────────────────────────────────────
@app.route('/api/incoming')
def api_incoming():
    return jsonify([])


@app.route('/api/incoming/<int:msg_id>/read', methods=['POST'])
def api_mark_read(msg_id):
    pass
    return jsonify({'marked': msg_id})


# ── Чаты и контакты ───────────────────────────────────────────────────────
@app.route('/api/chats')
def api_chats():
    chats = current_bot().get_chats()
    if not chats:
        return jsonify([])
    # Фильтруем скрытые группы
    hidden = []
    filtered = [c for c in chats if c.get('chatId') not in hidden]
    return jsonify(filtered)


@app.route('/api/contacts')
def api_contacts():
    contacts = current_bot().get_contacts()
    return jsonify(contacts)


@app.route('/api/contact-info', methods=['POST'])
def api_contact_info():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    info = current_bot().get_contact_info(chat_id)
    return jsonify(info or {})


@app.route('/api/chat-history', methods=['POST'])
def api_chat_history():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    count   = int(data.get('count', 50))
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    history = current_bot().get_chat_history(chat_id, count)
    return jsonify(history)


@app.route('/api/read-chat', methods=['POST'])
def api_read_chat():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    result = current_bot().read_chat(chat_id)
    return jsonify({'success': bool(result)})


# ── Отправка текстового сообщения ─────────────────────────────────────────
@app.route('/api/send-message', methods=['POST'])
def api_send_message():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    message = data.get('message', '').strip()
    if not chat_id or not message:
        return jsonify({'error': 'chatId and message required'}), 400
    result = current_bot().send_message(chat_id, message)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить сообщение'}), 500


# ── Отправка файла ────────────────────────────────────────────────────────
@app.route('/api/send-file', methods=['POST'])
def api_send_file():
    chat_id = request.form.get('chatId', '').strip()
    caption = request.form.get('caption', '').strip()
    file_url_input = request.form.get('fileUrl', '').strip()

    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400

    if file_url_input:
        file_name = file_url_input.split('/')[-1] or 'file'
        result = current_bot().send_file_by_url(chat_id, file_url_input, file_name, caption)
    elif 'file' in request.files:
        f = request.files['file']
        if f.filename == '':
            return jsonify({'error': 'no file selected'}), 400
        save_path = os.path.join(UPLOAD_FOLDER, f.filename)
        f.save(save_path)
        result = current_bot().send_file_by_upload(chat_id, save_path, caption)
        try:
            os.remove(save_path)
        except Exception:
            pass
    else:
        return jsonify({'error': 'Укажите файл или URL'}), 400

    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить файл'}), 500


# ── Отправка геолокации ───────────────────────────────────────────────────
@app.route('/api/send-location', methods=['POST'])
def api_send_location():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    lat     = data.get('latitude')
    lon     = data.get('longitude')
    name    = data.get('name', '')
    address = data.get('address', '')

    if not chat_id or lat is None or lon is None:
        return jsonify({'error': 'chatId, latitude, longitude required'}), 400

    result = current_bot().send_location(chat_id, float(lat), float(lon), name, address)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить геолокацию'}), 500


# ── Отправка контакта ─────────────────────────────────────────────────────
@app.route('/api/send-contact', methods=['POST'])
def api_send_contact():
    data          = request.get_json(force=True)
    chat_id       = data.get('chatId', '').strip()
    contact_phone = data.get('contactPhone', '').strip()
    contact_name  = data.get('contactName', '').strip()

    if not chat_id or not contact_phone or not contact_name:
        return jsonify({'error': 'chatId, contactPhone, contactName required'}), 400

    result = current_bot().send_contact(chat_id, contact_phone, contact_name)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить контакт'}), 500


# ── Queue ─────────────────────────────────────────────────────────────────
@app.route('/api/queue')
def api_queue():
    size = current_bot().get_queue_size()
    return jsonify({'size': size, 'status': 'busy' if size > 0 else 'idle'})


@app.route('/api/queue/clear', methods=['POST'])
def api_queue_clear():
    result  = current_bot().clear_queue()
    cleared = bool(result and result.get('clearMessagesQueue'))
    return jsonify({'cleared': cleared})


# ── Массовая проверка номеров ──────────────────────────────────────────────
#
# Anti-ban-protected handler (см. design.md, секция «Поток выполнения
# Bulk_Operation» и Requirements 1.1, 1.3, 1.4, 1.5, 1.7, 3.3, 3.4, 3.5,
# 4.5, 5.5, 7.1, 7.2). Поведение:
#
# 1. Pre-flight: вызывает ``getStateInstance``; при ``state ∈ UNHEALTHY``
#    возвращает HTTP 409 ``{"state": <state>}``. См. Property 7.
# 2. Дневной лимит: проверяет ``audit_logger.count_in_window(user_id,
#    "check", "day")`` против ``config.daily_check_limit``; превышение
#    отвечает HTTP 429. См. Property 4.
# 3. Создаёт ``OperationRun`` (status=running, payload) через
#    ``audit_logger.start_run`` и регистрирует worker в ``registry``.
# 4. Worker-thread в цикле по контактам:
#    * ``rate_limiter.acquire("check")`` (Requirement 1.2);
#    * ``check_contact(phone, rate_limiter=...)`` (Requirement 4.1, 4.4);
#    * ``audit_logger.update_progress`` + heartbeat в реестре после
#      каждого контакта (Requirements 4.5, 5.4);
#    * проверка ``cancel_event`` и текущего ``Instance_State`` после
#      каждого контакта (Requirements 3.4, 3.5, 5.2);
#    * при достижении ``hourly_check_limit`` — ``finish_run("paused")``
#      и выход (Requirement 1.5);
# 5. ``try/finally``: гарантированный сброс ``_check_active`` и
#    ``registry.deregister`` (Requirement 5.5, Property 18).
# 6. В JSON ответа на старт — ``operation_run_id`` (Requirement 7.4
#    подразумевает доступ к id для resume). Поле ``total`` сохранено
#    для backward-compat с существующим фронтендом.
#
# Идентификатор пользователя берётся из заголовка ``X-Green-Api-Id``
# (тот же заголовок, что ``current_bot()`` использует для GREEN-API
# креденшелов): отдельной user-сессии в Flask-бэкенде нет, инстанс
# GREEN-API однозначно идентифицирует пользователя на стороне
# anti_ban-аудита.


def _resolve_user_id() -> str:
    """Идентификатор пользователя для аудита anti_ban.

    Сейчас это GREEN-API id-инстанса — по нему однозначно
    идентифицируется учётка. Когда появится явная Supabase-сессия на
    бэкенде, метод можно заменить на чтение JWT.
    """
    return request.headers.get('X-Green-Api-Id', '').strip() or 'unknown'


@app.route('/api/check-contacts-bulk', methods=['POST'])
def api_check_contacts_bulk():
    global _check_active

    # Backward-compat: глобальный флаг защищает от двойного запуска
    # из одного процесса. Anti-ban Watchdog (Requirement 5.4) служит
    # внешней страховкой, если worker зависнет.
    if _check_active:
        return jsonify({'error': 'Проверка уже запущена'}), 409

    data = request.get_json(force=True) or {}
    phones = [p.strip() for p in data.get('phones', []) if p.strip()]
    if not phones:
        return jsonify({'error': 'Список номеров пуст'}), 400

    try:
        request_bot = current_bot()
    except ValueError as exc:
        return credentials_error_response(exc)

    user_id = _resolve_user_id()
    config = config_loader.get(user_id)

    # --- Pre-flight: getStateInstance (Requirement 3.3) -----------------
    try:
        current_state = request_bot.get_state()
    except Exception:
        # Если состояние получить не удалось — трактуем как unknown
        # (Requirement 3.6: unknown не блокирует старт). Логируем для
        # диагностики, но продолжаем.
        logger.warning("Pre-flight getStateInstance failed", exc_info=True)
        current_state = 'unknown'

    if current_state in UNHEALTHY:
        return jsonify({
            'error': 'instance_unhealthy',
            'state': current_state,
        }), 409

    # --- Дневной лимит (Requirement 1.4, Property 4) --------------------
    processed_today = audit_logger.count_in_window(
        user_id, 'check', 'day'
    )
    if processed_today + len(phones) > config.daily_check_limit:
        return jsonify({
            'error': 'daily_limit_exceeded',
            'limit': config.daily_check_limit,
            'current': processed_today,
        }), 429

    # --- Создание OperationRun + регистрация worker ---------------------
    contacts_payload = [{'phone': p} for p in phones]
    run_id = audit_logger.start_run(
        user_id=user_id,
        kind='check',
        total=len(phones),
        payload={'contacts': contacts_payload, 'params': {}},
    )

    cancel_event = threading.Event()
    handle = RunHandle(
        run_id=run_id,
        cancel_event=cancel_event,
        last_progress_at=time.time(),
        kind='check',
        global_flag_name='_check_active',
    )
    registry.register(run_id, handle)

    rate_limiter = RateLimiter(config)

    # Глобальный флаг ставится синхронно в обработчике, чтобы
    # повторный POST в тот же миг получил 409. Сброс — в worker'е через
    # try/finally (Requirement 5.5).
    _check_active = True

    threading.Thread(
        target=_run_check_worker,
        kwargs={
            'run_id': run_id,
            'phones': phones,
            'user_id': user_id,
            'cancel_event': cancel_event,
            'rate_limiter': rate_limiter,
            'config': config,
            'bot_instance': request_bot,
        },
        name=f'check-worker-{run_id}',
        daemon=True,
    ).start()

    return jsonify({
        'operation_run_id': run_id,
        'total': len(phones),
        'status': 'running',
    }), 202


def _run_check_worker(
    *,
    run_id: int,
    phones: list,
    user_id: str,
    cancel_event: threading.Event,
    rate_limiter: RateLimiter,
    config,
    bot_instance: MaxBot,
    start_index: int = 0,
):
    """Worker-поток `Bulk_Check_Service`.

    Цикл по контактам с rate-limiting, мониторингом состояния и
    проверкой отмены. На любом терминальном событии финализирует
    ``OperationRun`` и аккуратно сбрасывает глобальный флаг
    ``_check_active`` (Requirement 5.5).
    """
    global _check_active

    total = len(phones)
    processed = start_index
    last_idx = start_index - 1
    final_status: str = 'completed'
    final_reason = None

    try:
        for i in range(start_index, total):
            # --- Cancel (Requirement 5.2, Property 15) ------------------
            if cancel_event.is_set():
                final_status = 'aborted'
                final_reason = 'cancelled'
                break

            # --- Live state check (Requirements 3.4, 3.5) ---------------
            # Делается перед каждым контактом, что укладывается в
            # окно ``state_poll_interval_seconds`` (Property 9): мы
            # реагируем не позже одного контакта после смены состояния.
            try:
                live_state = bot_instance.get_state()
            except Exception:
                live_state = None
            if live_state in UNHEALTHY:
                audit_logger.log_incident(
                    user_id=user_id,
                    run_id=run_id,
                    kind=live_state,
                    details={
                        'source': 'check_worker',
                        'index': i,
                        'state': live_state,
                    },
                )
                final_status = 'banned'
                final_reason = live_state
                break

            # --- Hourly limit (Requirement 1.5, Property 4) -------------
            # Считаем перед обработкой следующего контакта: если
            # лимит уже достигнут — переводим run в "paused" и
            # выходим. Возобновление — задача 13.x; здесь только
            # фиксируем граничное состояние.
            hour_count = audit_logger.count_in_window(
                user_id, 'check', 'hour'
            )
            if hour_count >= config.hourly_check_limit:
                final_status = 'paused'
                final_reason = 'hourly_limit'
                break

            # --- Process one contact ------------------------------------
            phone = phones[i]
            try:
                exist, chat_id = bot_instance.check_contact(
                    phone,
                    rate_limiter=rate_limiter,
                    rate_limit_kind='check',
                )
            except QuotaExceededError as exc:
                # Requirement 4.4 / Property 13: HTTP 466 — немедленный abort.
                audit_logger.log_incident(
                    user_id=user_id,
                    run_id=run_id,
                    kind='quota_466',
                    details={
                        'error': str(exc),
                        'index': i,
                        'phone': phone,
                    },
                )
                final_status = 'aborted'
                final_reason = 'quota_466'
                break
            except Rate429Error as exc:
                # Requirement 4.3 / Property 12: исчерпан max_retries
                # последовательных 429 → aborted + incident.
                audit_logger.log_incident(
                    user_id=user_id,
                    run_id=run_id,
                    kind='rate_limit_429',
                    details={
                        'retry_count': getattr(exc, 'retry_count', None),
                        'index': i,
                        'phone': phone,
                    },
                )
                final_status = 'aborted'
                final_reason = 'rate_limit_429'
                break
            except Exception as exc:
                # Любая иная ошибка — фатальная для этого worker.
                # Не передаём stack trace во SSE, чтобы не утечь
                # внутренние детали; подробности уйдут в логи.
                logger.exception(
                    "check worker: unexpected error on phone %s", phone
                )
                audit_logger.log_incident(
                    user_id=user_id,
                    run_id=run_id,
                    kind='error',
                    details={
                        'error': str(exc),
                        'index': i,
                        'phone': phone,
                    },
                )
                final_status = 'aborted'
                final_reason = 'error'
                break

            # --- Persist progress (Requirement 4.5, 7.2) ----------------
            processed = i + 1
            last_idx = i
            audit_logger.update_progress(
                run_id,
                processed=processed,
                last_processed_index=last_idx,
            )
            registry.heartbeat(run_id)

            # --- SSE progress event (формат сохранён для FE) -----------
            _push_all(_check_clients, {
                'phone': phone,
                'exists': bool(exist),
                'chatId': chat_id,
                'done': processed,
                'total': total,
                'operation_run_id': run_id,
            })

    finally:
        # --- Финализация Operation_Run (Requirement 7.3) ----------------
        # "paused" уже записан в hourly-ветке через `return`, поэтому
        # сюда мы попадаем только для остальных терминальных статусов.
        try:
            audit_logger.finish_run(
                run_id,
                status=final_status,
                reason=final_reason,
            )
        except Exception:
            logger.exception(
                "check worker: failed to finalise operation_run %s", run_id
            )

        # --- Финальное SSE-событие --------------------------------------
        _push_all(_check_clients, {
            'finished': True,
            'reason': final_reason or final_status,
            'operation_run_id': run_id,
            'total': total,
            'processed': processed,
        })

        # --- Гарантированный сброс глобального флага (Requirement 5.5) --
        _check_active = False
        registry.deregister(run_id)


@app.route('/api/check-contacts/progress')
def api_check_progress():
    # Lazy-start общесистемного StateMonitor на первой подписке
    # (Requirement 3.2: опрос ``getStateInstance`` пока есть подписчик).
    _ensure_state_monitor()

    client_q: queue.Queue = queue.Queue(maxsize=500)
    _check_clients.append(client_q)

    def generate():
        try:
            while True:
                try:
                    # Heartbeat ``: ping\n\n`` каждые 15 секунд
                    # (Requirement задачи 15.1; согласовано с
                    # ``sse_client_timeout_seconds`` ≥ 60 на клиенте).
                    data = client_q.get(timeout=15)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get('finished'):
                        break
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            if client_q in _check_clients:
                _check_clients.remove(client_q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )


# ── Управление Bulk_Operation ─────────────────────────────────────────────
#
# Эндпойнты управления `Bulk_Operation` (Requirements 5.1, 5.2, 7.4, 7.5,
# 10.4). Семантика:
#
# * ``POST /api/bulk-operation/stop`` — устанавливает ``cancel_event`` для
#   указанного ``operation_run_id``; worker в течение
#   ``cancel_check_interval_seconds`` (дефолт 1 c) увидит флаг и
#   завершится со статусом ``aborted``. Эндпойнт **идемпотентен**:
#   повторные вызовы (включая случай, когда операции уже нет в реестре,
#   потому что worker успел финализироваться) возвращают HTTP 200 с
#   ``cancelled: false`` (см. design.md, Property 15, Requirement 5.1).
#
# * ``POST /api/bulk-operation/resume`` — для `Operation_Run` со
#   статусом ``aborted``/``paused`` запускает новый worker с индексами
#   ``[last_processed_index + 1, total)`` (Requirement 7.4). Перед
#   запуском проверяет финальные статусы (``completed`` → HTTP 409,
#   Requirement 7.5), валидирует payload через
#   :func:`anti_ban.payload.deserialize_payload` (HTTP 422 при
#   ошибке, Requirement 10.4), выполняет тот же pre-flight state-gate,
#   что и обработчики старта (HTTP 409 на ``UNHEALTHY``).


@app.route('/api/bulk-operation/stop', methods=['POST'])
def api_bulk_operation_stop():
    """Идемпотентно остановить активную `Bulk_Operation`.

    Тело запроса: ``{"operation_run_id": <int>}``.

    Возвращает HTTP 200 с ``{"operation_run_id", "cancelled"}``:
    ``cancelled == true`` если флаг отмены был успешно установлен,
    ``false`` если операции уже нет в реестре (например, она успела
    завершиться). Повторные вызовы безопасны (Requirement 5.1) и
    также возвращают 200, что упрощает логику клиента (двойной
    клик по «Стоп» в UI).

    Сам worker завершится со ``status="aborted"`` не позже
    ``Anti_Ban_Config.cancel_check_interval_seconds`` секунд после
    установки флага (Requirement 5.2).
    """
    data = request.get_json(force=True, silent=True) or {}
    try:
        run_id = int(data.get('operation_run_id'))
    except (TypeError, ValueError):
        return jsonify(
            {'error': 'operation_run_id required (integer)'}
        ), 400

    cancelled = registry.cancel(run_id)
    return jsonify({
        'operation_run_id': run_id,
        'cancelled': cancelled,
    }), 200


@app.route('/api/bulk-operation/resume', methods=['POST'])
def api_bulk_operation_resume():
    """Возобновить `Bulk_Operation` с ``last_processed_index + 1``.

    Тело запроса: ``{"operation_run_id": <int>}``.

    Возвращаемые статусы:

    * **HTTP 202** — worker запущен, ответ содержит ``operation_run_id``,
      ``kind``, ``start_index`` и ``remaining`` (количество оставшихся
      контактов). Соответствует Requirement 7.4.
    * **HTTP 400** — ``operation_run_id`` не передан или не целое число;
      также ``kind`` записи не равен ``"check"``/``"broadcast"``.
    * **HTTP 404** — записи с указанным ``id`` нет в БД.
    * **HTTP 409** — ``Operation_Run.status == "completed"``
      (Requirement 7.5) или инстанс в нездоровом состоянии
      (``state ∈ UNHEALTHY``); также возвращается, если operation
      того же ``kind`` уже выполняется.
    * **HTTP 422** — `payload` невалиден (Requirement 10.4); тело
      ответа содержит описание ошибки.
    """
    data = request.get_json(force=True, silent=True) or {}
    try:
        run_id = int(data.get('operation_run_id'))
    except (TypeError, ValueError):
        return jsonify(
            {'error': 'operation_run_id required (integer)'}
        ), 400

    # --- Загрузка Operation_Run из БД --------------------------------
    try:
        conn = db.get_conn()
    except Exception:
        logger.exception("api_bulk_operation_resume: cannot open DB")
        return jsonify({'error': 'database unavailable'}), 500
    try:
        with conn:
            row = conn.execute(
                "SELECT * FROM operation_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
    except Exception:
        logger.exception(
            "api_bulk_operation_resume: query failed (run_id=%s)", run_id
        )
        return jsonify({'error': 'database error'}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if row is None:
        return jsonify({'error': 'operation_run not found'}), 404

    row_dict = dict(row)
    status = row_dict.get('status')
    # Requirement 7.5: completed run возобновлять нельзя.
    if status == 'completed':
        return jsonify({
            'error': 'operation already completed',
            'status': status,
        }), 409

    user_id = row_dict.get('user_id') or 'unknown'
    kind = row_dict.get('kind')
    last_processed_index = int(row_dict.get('last_processed_index') or -1)
    total = int(row_dict.get('total') or 0)
    raw_payload = row_dict.get('payload') or ''

    # --- Десериализация payload (Requirement 10.4) -------------------
    try:
        payload = deserialize_payload(raw_payload)
    except PayloadValidationError as exc:
        return jsonify({
            'error': 'invalid_payload',
            'detail': str(exc),
        }), 422

    contacts = payload['contacts']
    params = payload.get('params') or {}
    start_index = last_processed_index + 1

    if start_index >= total or start_index >= len(contacts):
        # Нечего возобновлять: payload и БД говорят, что все элементы
        # уже обработаны (но статус ≠ completed, например aborted на
        # последнем элементе). Финализируем как completed, чтобы
        # повторные вызовы корректно отвергались Requirement 7.5.
        try:
            audit_logger.finish_run(
                run_id, status='completed', reason='resume_noop'
            )
        except Exception:
            logger.exception(
                "api_bulk_operation_resume: failed to finalise empty resume "
                "(run_id=%s)", run_id
            )
        return jsonify({
            'operation_run_id': run_id,
            'kind': kind,
            'start_index': start_index,
            'remaining': 0,
            'status': 'completed',
        }), 200

    if kind not in ('check', 'broadcast'):
        return jsonify({'error': f'unsupported kind: {kind}'}), 400

    # --- Pre-flight state gate (тот же, что в /start-эндпойнтах) -----
    try:
        request_bot = current_bot()
    except ValueError as exc:
        return credentials_error_response(exc)

    try:
        current_state = request_bot.get_state()
    except Exception:
        logger.warning(
            "api_bulk_operation_resume: pre-flight getStateInstance failed",
            exc_info=True,
        )
        current_state = 'unknown'
    if current_state in UNHEALTHY:
        return jsonify({
            'error': 'instance_unhealthy',
            'state': current_state,
        }), 409

    config = config_loader.get(user_id)

    # --- Регистрация worker'а -----------------------------------------
    cancel_event = threading.Event()
    handle = RunHandle(
        run_id=run_id,
        cancel_event=cancel_event,
        last_progress_at=time.time(),
        kind=kind,
        global_flag_name=(
            '_check_active' if kind == 'check' else '_broadcast_active'
        ),
    )
    registry.register(run_id, handle)
    rate_limiter = RateLimiter(config)

    # --- Reset Operation_Run в running ---------------------------------
    # Та же запись (Requirement 7.4 — без создания новой), сбрасываем
    # finished_at/reason, чтобы worker мог финализировать её повторно.
    try:
        conn = db.get_conn()
    except Exception:
        registry.deregister(run_id)
        logger.exception(
            "api_bulk_operation_resume: cannot reopen DB for status reset "
            "(run_id=%s)", run_id
        )
        return jsonify({'error': 'database unavailable'}), 500
    try:
        with conn:
            conn.execute(
                """UPDATE operation_runs
                      SET status = 'running',
                          finished_at = NULL,
                          reason = NULL
                    WHERE id = ?""",
                (run_id,),
            )
    except Exception:
        registry.deregister(run_id)
        logger.exception(
            "api_bulk_operation_resume: failed to reset status "
            "(run_id=%s)", run_id
        )
        return jsonify({'error': 'database error'}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if kind == 'check':
        global _check_active
        if _check_active:
            registry.deregister(run_id)
            return jsonify(
                {'error': 'check operation already running'}
            ), 409
        _check_active = True
        # Извлекаем телефоны из payload — формат
        # ``{"phone": "..."}`` гарантирован обработчиком старта.
        phones = [
            c.get('phone')
            for c in contacts
            if isinstance(c, dict) and c.get('phone')
        ]
        threading.Thread(
            target=_run_check_worker,
            kwargs={
                'run_id': run_id,
                'phones': phones,
                'user_id': user_id,
                'cancel_event': cancel_event,
                'rate_limiter': rate_limiter,
                'config': config,
                'bot_instance': request_bot,
                'start_index': start_index,
            },
            name=f'check-worker-{run_id}-resume',
            daemon=True,
        ).start()
    else:  # 'broadcast'
        global _broadcast_active
        if _broadcast_active:
            registry.deregister(run_id)
            return jsonify(
                {'error': 'broadcast already running'}
            ), 409
        _broadcast_active = True
        # Multipart-файлы не переживают рестарт сервера; для resume
        # поддерживаем только legacy file_url-ветку или сообщение
        # без вложений. См. design.md «Edge Cases».
        try:
            user_delay = float(params.get('delay', 3.0))
        except (TypeError, ValueError):
            user_delay = 3.0
        threading.Thread(
            target=_run_broadcast_worker,
            kwargs={
                'run_id': run_id,
                'contacts': contacts,
                'message': params.get('message_template', '') or '',
                'user_delay': user_delay,
                'use_typing': bool(params.get('use_typing')),
                'broadcast_id': params.get('broadcast_id'),
                'is_multipart': False,
                'uploaded_path': None,
                'uploaded_name': None,
                'file_url': params.get('file_url'),
                'file_name': params.get('file_name'),
                'user_id': user_id,
                'cancel_event': cancel_event,
                'rate_limiter': rate_limiter,
                'config': config,
                'bot_instance': request_bot,
                'start_index': start_index,
            },
            name=f'broadcast-worker-{run_id}-resume',
            daemon=True,
        ).start()

    return jsonify({
        'operation_run_id': run_id,
        'kind': kind,
        'start_index': start_index,
        'remaining': max(0, total - start_index),
        'status': 'running',
    }), 202


# ── Anti-ban: incidents и конфигурация ────────────────────────────────────
#
# Чтение/запись `Anti_Ban_Config` и `Incident_Log` для UI настроек и
# истории инцидентов (см. design.md секцию "API endpoints" и
# Requirements 8.3, 8.4, 9.1, 9.3).
#
# * ``GET  /api/incidents`` — последние ``incident_history_limit``
#   инцидентов пользователя в порядке убывания ``created_at``
#   (Requirements 8.3, 8.4).
# * ``GET  /api/anti-ban-config`` — текущая конфигурация в виде
#   плоского словаря (dataclass → dict через ``asdict``), включая
#   дефолты для отсутствующих в БД полей (Requirement 9.1, 9.2).
# * ``PUT  /api/anti-ban-config`` — валидирует тело через
#   ``ConfigLoader.validate`` (Requirement 9.3): на ошибках возвращает
#   HTTP 400 с массивом ``violations``; на успехе делает UPSERT в
#   таблицу ``anti_ban_config``, сбрасывает кэш загрузчика и
#   возвращает свежеперечитанную конфигурацию.


# DDL для SQLite-зеркала Prisma-таблицы ``anti_ban_config``. Поля
# совпадают с :class:`AntiBanConfig` и Postgres-миграцией
# ``20260516_add_anti_ban_models``. Создаётся идемпотентно перед
# первым UPSERT, потому что миграция Prisma бьёт только Postgres
# фронтенда, а локальный SQLite-файл бэкенда не покрыт ничем.
_ANTI_BAN_CONFIG_DDL = """
CREATE TABLE IF NOT EXISTS anti_ban_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    delay_min REAL,
    delay_max REAL,
    batch_size INTEGER,
    long_pause_every_n INTEGER,
    long_pause_seconds REAL,
    daily_check_limit INTEGER,
    hourly_check_limit INTEGER,
    daily_message_limit INTEGER,
    broadcast_delay_min REAL,
    broadcast_jitter_max REAL,
    state_poll_interval_seconds INTEGER,
    watchdog_timeout_seconds INTEGER,
    watchdog_check_interval_seconds INTEGER,
    cancel_check_interval_seconds REAL,
    sse_client_timeout_seconds INTEGER,
    max_retries INTEGER,
    max_consecutive_429 INTEGER,
    sliding_window_n INTEGER,
    sliding_window_t INTEGER,
    incident_history_limit INTEGER,
    backoff_base_seconds REAL,
    response_ratio_window_hours INTEGER,
    response_ratio_min_outgoing INTEGER,
    warn_on_zero_response_ratio INTEGER,
    updated_at TEXT NOT NULL
);
"""


@app.route('/api/incidents', methods=['GET'])
def api_incidents_list():
    """Последние инциденты текущего пользователя.

    Возвращает массив словарей в порядке убывания ``created_at``
    (сортировка делегируется ``audit_logger.list_incidents``).
    Лимит — :attr:`AntiBanConfig.incident_history_limit` (по умолчанию
    100). Каждый элемент содержит ключи ``id``, ``user_id``,
    ``operation_run_id``, ``kind``, ``details``, ``created_at``;
    ``details`` уже распарсен из JSON в dict.

    Validates: Requirements 8.3, 8.4
    """
    user_id = _resolve_user_id()
    config = config_loader.get(user_id)
    incidents = audit_logger.list_incidents(
        user_id, limit=config.incident_history_limit
    )
    return jsonify(incidents), 200


@app.route('/api/anti-ban-config', methods=['GET'])
def api_anti_ban_config_get():
    """Текущая `Anti_Ban_Config` пользователя как плоский словарь.

    Если в БД нет записи — возвращаются дефолты Requirement 9.2
    (``ConfigLoader.get`` сам подставляет их).

    Validates: Requirements 9.1, 9.2
    """
    user_id = _resolve_user_id()
    config = config_loader.get(user_id)
    return jsonify(asdict(config)), 200


@app.route('/api/anti-ban-config', methods=['PUT'])
def api_anti_ban_config_put():
    """UPSERT `Anti_Ban_Config` с предварительной валидацией.

    Тело — JSON-объект с подмножеством полей ``AntiBanConfig``.
    Поля, не входящие в dataclass, молча игнорируются (защита от
    лишних ключей с фронтенда). На любых нарушениях Requirement 9.3
    возвращается HTTP 400 ``{"error": "invalid_config",
    "violations": [...]}``.

    После успешного UPSERT кэш ``ConfigLoader`` для пользователя
    сбрасывается, и в ответе возвращается свежеперечитанная
    конфигурация (как dict), чтобы клиент видел применённые дефолты
    для не переданных полей.

    Validates: Requirements 9.1, 9.3
    """
    user_id = _resolve_user_id()
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'body must be a JSON object'}), 400

    violations = config_loader.validate(data)
    if violations:
        return jsonify({
            'error': 'invalid_config',
            'violations': violations,
        }), 400

    # --- Сборка безопасного словаря только из известных полей --------
    # ``bool`` в SQLite пишем как 0/1, чтобы соответствовать
    # int-колонке ``warn_on_zero_response_ratio``.
    field_names = [f.name for f in fields(AntiBanConfig)]
    safe_values: dict = {}
    for name in field_names:
        if name not in data:
            continue
        value = data[name]
        if isinstance(value, bool):
            safe_values[name] = 1 if value else 0
        else:
            safe_values[name] = value

    updated_at = datetime.utcnow().isoformat(timespec='seconds')

    try:
        conn = db.get_conn()
    except Exception:
        logger.exception(
            "api_anti_ban_config_put: cannot open DB (user_id=%s)", user_id
        )
        return jsonify({'error': 'database unavailable'}), 500
    try:
        with conn:
            conn.executescript(_ANTI_BAN_CONFIG_DDL)
        with conn:
            existing = conn.execute(
                "SELECT id FROM anti_ban_config WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if existing is not None:
                # UPDATE: всегда обновляем updated_at, остальные —
                # только переданные клиентом ключи.
                cols = list(safe_values.keys()) + ['updated_at']
                vals = list(safe_values.values()) + [updated_at]
                set_clause = ', '.join(f"{c} = ?" for c in cols)
                conn.execute(
                    f"UPDATE anti_ban_config SET {set_clause} "
                    "WHERE user_id = ?",
                    (*vals, user_id),
                )
            else:
                # INSERT: user_id + переданные ключи + updated_at.
                cols = ['user_id'] + list(safe_values.keys()) + ['updated_at']
                vals = [user_id] + list(safe_values.values()) + [updated_at]
                placeholders = ', '.join(['?'] * len(cols))
                conn.execute(
                    f"INSERT INTO anti_ban_config "
                    f"({', '.join(cols)}) VALUES ({placeholders})",
                    vals,
                )
    except Exception:
        logger.exception(
            "api_anti_ban_config_put: UPSERT failed (user_id=%s)", user_id
        )
        return jsonify({'error': 'database error'}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # Сбросить кэш и вернуть свежую конфигурацию.
    config_loader.invalidate(user_id)
    new_config = config_loader.get(user_id)
    return jsonify(asdict(new_config)), 200


# ── Создание группы ───────────────────────────────────────────────────────
@app.route('/api/create-group', methods=['POST'])
def api_create_group():
    data    = request.get_json(force=True)
    name    = data.get('name', '').strip()
    raw_phones = data.get('phones', [])
    
    # Улучшенный парсинг: если прилетел список строк, объединим и переразберем
    # (на случай если в одной строке несколько номеров через пробел)
    phones = []
    for p in raw_phones:
        # Разбиваем по пробелам, запятым и точкам с запятой
        parts = p.replace(',', ' ').replace(';', ' ').split()
        phones.extend([part.strip() for part in parts if part.strip()])
    
    message = data.get('message', '').strip()

    if not name:
        return jsonify({'error': 'Укажите название группы'}), 400

    chat_ids  = []
    not_found = []
    if phones:
        for phone in phones:
            exist, chat_id = current_bot().check_contact(phone)
            if exist and chat_id:
                chat_ids.append(chat_id)
            else:
                not_found.append(phone)

        if not chat_ids and phones:
            return jsonify({'error': 'Ни один из введенных номеров не найден в WhatsApp'}), 400

    group_id = current_bot().create_group(name, chat_ids)
    if not group_id:
        return jsonify({'error': 'Не удалось создать группу'}), 500

    pass

    result = {
        'group_id': group_id, 'name': name,
        'members': len(chat_ids), 'not_found': not_found,
        'message_sent': False
    }
    if message:
        resp = current_bot().send_message(group_id, message)
        result['message_sent'] = bool(resp and 'idMessage' in resp)

    logger.info(f"Группа '{name}' создана. ID: {group_id}")
    return jsonify(result)


@app.route('/api/group-details', methods=['POST'])
def api_group_details():
    data     = request.get_json(force=True)
    group_id = data.get('groupId', '').strip()
    if not group_id:
        return jsonify({'error': 'groupId required'}), 400
    res = current_bot().get_group_data(group_id)
    return jsonify(res or {})


@app.route('/api/add-participant', methods=['POST'])
def api_add_participant():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = current_bot().add_group_participant(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/remove-participant', methods=['POST'])
def api_remove_participant():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = current_bot().remove_group_participant(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/set-admin', methods=['POST'])
def api_set_admin():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = current_bot().set_group_admin(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/remove-admin', methods=['POST'])
def api_remove_admin():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = current_bot().remove_group_admin(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/leave-group', methods=['POST'])
def api_leave_group():
    data     = request.get_json(force=True)
    group_id = data.get('groupId', '').strip()
    if not group_id:
        return jsonify({'error': 'groupId required'}), 400
    res = current_bot().leave_group(group_id)
    return jsonify({'success': bool(res)})


@app.route('/api/update-group-name', methods=['POST'])
def api_update_group_name():
    data       = request.get_json(force=True)
    group_id   = data.get('groupId', '').strip()
    group_name = data.get('groupName', '').strip()
    if not group_id or not group_name:
        return jsonify({'error': 'groupId and groupName required'}), 400
    res = current_bot().update_group_name(group_id, group_name)
    return jsonify({'success': bool(res)})


@app.route('/api/set-group-picture', methods=['POST'])
def api_set_group_picture():
    group_id = request.form.get('groupId', '').strip()
    if not group_id:
        return jsonify({'error': 'groupId required'}), 400
    if 'file' not in request.files:
        return jsonify({'error': 'file required'}), 400

    file = request.files['file']
    path = os.path.join('temp', file.filename)
    os.makedirs('temp', exist_ok=True)
    file.save(path)

    try:
        res = current_bot().set_group_picture(group_id, path)
        return jsonify({'success': bool(res)})
    finally:
        if os.path.exists(path):
            os.remove(path)


# ── Управление группами ───────────────────────────────────────────────────
@app.route('/api/groups')
def api_groups():
    return jsonify([])

@app.route('/api/groups/delete', methods=['POST'])
def api_delete_group():
    data = request.get_json(force=True)
    group_id = data.get('groupId')
    if not group_id:
        return jsonify({'error': 'groupId is required'}), 400

    logger.info(f"Запрос на удаление группы: {group_id}")
    pass
    # Пытаемся также выйти из группы, если мы в ней состоим
    try:
        current_bot().leave_group(group_id)
    except:
        pass
    return jsonify({'success': True})


@app.route('/api/group/<path:group_id>/data')
def api_group_data(group_id):
    data = current_bot().get_group_data(group_id)
    return jsonify(data or {})


@app.route('/api/group/<path:group_id>/add', methods=['POST'])
def api_group_add(group_id):
    data  = request.get_json(force=True)
    phone = data.get('phone', '').strip()
    if not phone:
        return jsonify({'error': 'phone required'}), 400
    exist, chat_id = current_bot().check_contact(phone)
    if not exist:
        return jsonify({'error': f'Номер {phone} не найден в MAX'}), 400
    result = current_bot().add_group_participant(group_id, chat_id)
    return jsonify({'success': bool(result), 'chatId': chat_id})


@app.route('/api/group/<path:group_id>/add-bulk', methods=['POST'])
def api_group_add_bulk(group_id):
    data = request.get_json(force=True)
    phones_input = data.get('phones', [])

    # Парсинг номеров (если пришла строка, разобьем её)
    phones = []
    if isinstance(phones_input, str):
        parts = phones_input.replace(',', ' ').replace(';', ' ').split()
        phones = [p.strip() for p in parts if p.strip()]
    else:
        phones = phones_input

    results = []
    for phone in phones:
        exist, chat_id = current_bot().check_contact(phone)
        if exist and chat_id:
            ok = current_bot().add_group_participant(group_id, chat_id)
            results.append({'phone': phone, 'success': bool(ok)})
        else:
            results.append({'phone': phone, 'success': False, 'error': 'Not found'})

    return jsonify({'results': results})


@app.route('/api/group/<path:group_id>/remove', methods=['POST'])
def api_group_remove(group_id):
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    result = current_bot().remove_group_participant(group_id, chat_id)
    return jsonify({'success': bool(result)})


@app.route('/api/group/<path:group_id>/admin', methods=['POST'])
def api_group_admin(group_id):
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    action  = data.get('action', 'set')  # 'set' | 'remove'
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    if action == 'remove':
        result = current_bot().remove_group_admin(group_id, chat_id)
    else:
        result = current_bot().set_group_admin(group_id, chat_id)
    return jsonify({'success': bool(result)})


@app.route('/api/group/<path:group_id>/leave', methods=['POST'])
def api_group_leave(group_id):
    logger.info(f"Запрос на выход из группы: {group_id}")
    result = current_bot().leave_group(group_id)
    # В любом случае удаляем и скрываем локально
    pass
    return jsonify({'success': True})


# ── Polling уведомлений ───────────────────────────────────────────────────
@app.route('/api/poll-notifications', methods=['POST'])
def api_poll_notifications():
    """Ручной polling: получить все накопленные уведомления из очереди GREEN-API."""
    notifications = current_bot().poll_all_notifications()
    processed = 0
    for body in notifications:
        type_wh = body.get('typeWebhook', '')
        if type_wh == 'incomingMessageReceived':
            msg_data    = body.get('messageData', {})
            sender_data = body.get('senderData', {})
            sender      = sender_data.get('sender', 'unknown')
            sender_name = sender_data.get('senderName', '')
            msg_type    = msg_data.get('typeMessage', 'text')
            text = ''
            if msg_type == 'textMessage':
                text = msg_data.get('textMessageData', {}).get('textMessage', '')
            pass
            processed += 1
        elif type_wh == 'outgoingMessageStatus':
            msg_data = body.get('messageData', {})
            msg_id   = msg_data.get('idMessage', '')
            status   = msg_data.get('status', '')
            if msg_id:
                pass
                processed += 1
    return jsonify({'polled': len(notifications), 'processed': processed})


# ── Contacts Enrich (имена + аватары) ──────────────────────────────────────
@app.route('/api/contacts/enrich', methods=['POST'])
def contacts_enrich():
    """
    POST { "chatIds": ["79001234567@c.us", ...] }
    Returns { chatId: { name, avatar_url } }
    Fetches from Green API for uncached / stale (>7 days) entries.
    """
    data     = request.get_json(silent=True) or {}
    chat_ids = data.get('chatIds', [])
    if not chat_ids:
        return jsonify({})

    return jsonify({cid: {'name': None, 'avatar_url': None} for cid in chat_ids})


# ── Запуск ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    logger.info(f"MAX Bot Dashboard запущен → http://localhost:{FLASK_PORT}")
    app.run(host='0.0.0.0', port=FLASK_PORT, debug=FLASK_DEBUG, threaded=True)

