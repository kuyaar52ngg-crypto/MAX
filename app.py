import os
import csv
import json
import queue
import threading
import logging
import time
import sys
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

from bot import MaxBot

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
@app.route('/api/broadcast', methods=['POST'])
def api_broadcast():
    global _broadcast_active
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
            delay = float(form.get('delay') or 3)
        except (ValueError, TypeError):
            delay = 3.0
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
            delay = float(data.get('delay', 3))
        except (ValueError, TypeError):
            delay = 3.0
        use_typing = bool(data.get('use_typing', False))
        broadcast_id = data.get('broadcast_id') or 1
        file_url = str(data.get('file_url') or '').strip() or None
        file_name = str(data.get('file_name') or '').strip() or None
        if file_url and not file_name:
            file_name = file_url.rstrip('/').split('/')[-1] or 'attachment'

    contacts = normalize_contacts(raw_contacts, phones)

    has_attachment = bool(uploaded_path) if is_multipart else bool(file_url)

    if not contacts:
        if is_multipart and uploaded_path:
            try:
                os.remove(uploaded_path)
            except OSError as exc:
                logger.warning("Не удалось удалить временный файл %s: %s", uploaded_path, exc)
        return jsonify({'error': 'Список номеров пуст'}), 400
    if not message and not has_attachment:
        if is_multipart and uploaded_path:
            try:
                os.remove(uploaded_path)
            except OSError as exc:
                logger.warning("Не удалось удалить временный файл %s: %s", uploaded_path, exc)
        return jsonify({'error': 'Укажите сообщение или файл'}), 400

    try:
        request_bot = current_bot()
    except ValueError as exc:
        if is_multipart and uploaded_path:
            try:
                os.remove(uploaded_path)
            except OSError as cleanup_exc:
                logger.warning("Не удалось удалить временный файл %s: %s", uploaded_path, cleanup_exc)
        return credentials_error_response(exc)

    counters = {'sent': 0, 'not_found': 0, 'failed': 0}

    def progress_cb(done, total, result):
        s = result['status']
        if s == 'sent':          counters['sent']      += 1
        elif s == 'not_found':   counters['not_found'] += 1
        else:                    counters['failed']    += 1
        sse_push({
            'done': done, 'total': total,
            'phone': result['phone'], 'status': s,
            'message_id': result.get('message_id'),
            'rendered_message': result.get('rendered_message'),
            'contact_data': result.get('contact_data'),
            'broadcast_id': broadcast_id
        })

    def run():
        global _broadcast_active
        _broadcast_active = True
        try:
            if is_multipart and uploaded_path:
                request_bot.broadcast_with_uploaded_file(
                    contacts, message, uploaded_path, uploaded_name,
                    delay=delay, use_typing=use_typing,
                    progress_cb=progress_cb,
                )
            else:
                request_bot.broadcast(
                    contacts, message, delay=delay,
                    progress_cb=progress_cb,
                    use_typing=use_typing,
                    file_url=file_url, file_name=file_name,
                )
        finally:
            if is_multipart and uploaded_path:
                try:
                    os.remove(uploaded_path)
                except OSError as exc:
                    logger.warning(
                        "Не удалось удалить временный файл %s: %s",
                        uploaded_path, exc,
                    )
            sse_push({'done': len(contacts), 'total': len(contacts),
                      'finished': True, 'broadcast_id': broadcast_id,
                      **counters})
            _broadcast_active = False

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'broadcast_id': broadcast_id, 'total': len(contacts)})


# ── SSE: прогресс рассылки ────────────────────────────────────────────────
@app.route('/api/broadcast/progress')
def api_broadcast_progress():
    client_q: queue.Queue = queue.Queue(maxsize=200)
    _sse_clients.append(client_q)

    def generate():
        try:
            while True:
                try:
                    data = client_q.get(timeout=25)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get('finished'):
                        break
                except queue.Empty:
                    yield ": heartbeat\n\n"
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
@app.route('/api/check-contacts-bulk', methods=['POST'])
def api_check_contacts_bulk():
    global _check_active
    if _check_active:
        return jsonify({'error': 'Проверка уже запущена'}), 409

    data   = request.get_json(force=True)
    phones = [p.strip() for p in data.get('phones', []) if p.strip()]
    if not phones:
        return jsonify({'error': 'Список номеров пуст'}), 400

    try:
        request_bot = current_bot()
    except ValueError as exc:
        return credentials_error_response(exc)

    def run():
        global _check_active
        _check_active = True
        try:
            for i, phone in enumerate(phones):
                exist, chat_id = request_bot.check_contact(phone)
                _push_all(_check_clients, {
                    'phone': phone, 'exists': exist, 'chatId': chat_id,
                    'done': i + 1, 'total': len(phones)
                })
                time.sleep(0.3)
        finally:
            _push_all(_check_clients, {'finished': True, 'total': len(phones)})
            _check_active = False

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'total': len(phones)})


@app.route('/api/check-contacts/progress')
def api_check_progress():
    client_q: queue.Queue = queue.Queue(maxsize=500)
    _check_clients.append(client_q)

    def generate():
        try:
            while True:
                try:
                    data = client_q.get(timeout=30)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get('finished'):
                        break
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            if client_q in _check_clients:
                _check_clients.remove(client_q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )


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

