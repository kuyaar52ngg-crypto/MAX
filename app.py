import os
import csv
import json
import queue
import threading
import logging
import time
import sys
from functools import wraps

import requests
from flask import Flask, request, jsonify, Response, stream_with_context, g
from flask_cors import CORS
from dotenv import load_dotenv

from bot import MaxBot
import prisma_db as db

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

# Allow Next.js frontend and local development
CORS(app, resources={r"/api/*": {
    "origins": [
        "http://localhost:3000", "http://localhost:3001",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://localhost:5000",
    ],
    "allow_headers": ["Content-Type", "Authorization"],
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    "supports_credentials": True,
}})


UPLOAD_FOLDER = os.path.join(get_data_path(), 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

ID_INSTANCE  = os.getenv('ID_INSTANCE', '')
API_TOKEN    = os.getenv('API_TOKEN_INSTANCE', '')
GREEN_API_URL = os.getenv('GREEN_API_URL', 'https://api.green-api.com')
FLASK_PORT   = int(os.getenv('FLASK_PORT', 5000))

bot = MaxBot(ID_INSTANCE, API_TOKEN)
bot.base_url = f"{GREEN_API_URL}/waInstance{ID_INSTANCE}"

# ── Supabase Auth helpers ─────────────────────────────────────────────────
SUPABASE_URL     = os.getenv('SUPABASE_URL', '')
SUPABASE_ANON_KEY = os.getenv('SUPABASE_ANON_KEY', '')
_token_cache: dict[str, dict] = {}


def get_current_user() -> str | None:
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:]
    now = time.time()
    cached = _token_cache.get(token)
    if cached and cached['expires'] > now:
        return cached['user_id']
    try:
        resp = requests.get(
            f'{SUPABASE_URL}/auth/v1/user',
            headers={'apikey': SUPABASE_ANON_KEY, 'Authorization': f'Bearer {token}'},
            timeout=10,
        )
        if resp.status_code == 200:
            user_id = resp.json().get('id')
            _token_cache[token] = {'user_id': user_id, 'expires': now + 60}
            return user_id
    except Exception:
        pass
    return None


def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user_id = get_current_user()
        if not user_id:
            return jsonify({'error': 'Unauthorized'}), 401
        g.user_id = user_id
        return f(*args, **kwargs)
    return wrapper


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


# ── Статус инстанса ────────────────────────────────────────────────────────
@app.route('/api/status')
@require_auth
def api_status():
    state = bot.get_state()
    stats = db.get_total_stats(g.user_id)
    sent  = stats['sent']
    total = stats['total']
    unread = db.get_unread_count(g.user_id)
    return jsonify({
        'state': state,
        'stats': {
            **stats,
            'success_rate': round(sent / total * 100, 1) if total else 0
        },
        'broadcast_active': _broadcast_active,
        'unread_count': unread
    })


# ── Конфигурация инстанса ─────────────────────────────────────────────────
@app.route('/api/configure', methods=['POST'])
def api_configure():
    """Принимает id_instance / api_token / api_url, перенастраивает бота и сохраняет в .env."""
    global bot
    data      = request.get_json(force=True)
    id_inst   = data.get('id_instance', '').strip()
    api_tok   = data.get('api_token', '').strip()
    api_url   = data.get('api_url', '').strip() or 'https://api.green-api.com'

    if not id_inst or not api_tok:
        return jsonify({'error': 'id_instance and api_token are required'}), 400

    # Пересоздаём бота с новыми credentials
    import importlib
    import bot as bot_module
    # Обновляем API_URL в модуле bot на лету
    bot_module.API_URL = api_url
    bot = MaxBot(id_inst, api_tok)

    # Сохраняем в .env чтобы пережить перезапуск
    _save_to_env('ID_INSTANCE', id_inst)
    _save_to_env('API_TOKEN_INSTANCE', api_tok)
    _save_to_env('GREEN_API_URL', api_url)

    logger.info(f"Bot reconfigured: instance={id_inst}, url={api_url}")
    return jsonify({'success': True, 'id_instance': id_inst})


def _save_to_env(key: str, value: str):
    """Обновляет или добавляет переменную в .env файл."""
    env_file = os.path.join(get_data_path(), '.env')
    lines = []
    found = False
    if os.path.exists(env_file):
        with open(env_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        for i, line in enumerate(lines):
            if line.startswith(f'{key}=') or line.startswith(f'{key} ='):
                lines[i] = f'{key}={value}\n'
                found = True
                break
    if not found:
        lines.append(f'{key}={value}\n')
    with open(env_file, 'w', encoding='utf-8') as f:
        f.writelines(lines)


# ── QR-код ────────────────────────────────────────────────────────────────
@app.route('/api/qr')
@require_auth
def api_qr():
    return jsonify(bot.get_qr_code())


# ── Настройки аккаунта ────────────────────────────────────────────────────
@app.route('/api/account-settings')
@require_auth
def api_account_settings():
    result = bot.get_account_settings()
    return jsonify(result or {})


# ── Перезапуск инстанса ───────────────────────────────────────────────────
@app.route('/api/reboot', methods=['POST'])
@require_auth
def api_reboot():
    ok = bot.reboot_instance()
    return jsonify({'success': ok})


# ── Проверка одного номера ─────────────────────────────────────────────────
@app.route('/api/check-contact', methods=['POST'])
@require_auth
def api_check_contact():
    data  = request.get_json(force=True)
    phone = data.get('phone', '').strip()
    if not phone:
        return jsonify({'error': 'phone required'}), 400
    exist, chat_id = bot.check_contact(phone)
    return jsonify({'phone': phone, 'exists': exist, 'chatId': chat_id})


# ── Загрузка CSV ──────────────────────────────────────────────────────────
@app.route('/api/upload-contacts', methods=['POST'])
@require_auth
def api_upload_contacts():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    if not f.filename.endswith('.csv'):
        return jsonify({'error': 'only CSV files accepted'}), 400
    save_path = os.path.join(UPLOAD_FOLDER, 'contacts.csv')
    f.save(save_path)
    phones = []
    with open(save_path, newline='', encoding='utf-8-sig') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            for cell in row:
                cleaned = ''.join(filter(str.isdigit, cell))
                if 10 <= len(cleaned) <= 15:
                    phones.append(cleaned)
    return jsonify({'phones': phones, 'count': len(phones)})


# ── Рассылка ──────────────────────────────────────────────────────────────
@app.route('/api/broadcast', methods=['POST'])
@require_auth
def api_broadcast():
    global _broadcast_active
    if _broadcast_active:
        return jsonify({'error': 'Рассылка уже запущена'}), 409

    data       = request.get_json(force=True)
    phones     = [p.strip() for p in data.get('phones', []) if p.strip()]
    message    = data.get('message', '').strip()
    delay      = float(data.get('delay', 3))
    use_typing = bool(data.get('use_typing', False))
    file_url   = data.get('file_url', '').strip() or None
    file_name  = data.get('file_name', '').strip() or None

    if not phones:
        return jsonify({'error': 'Список номеров пуст'}), 400
    if not message and not file_url:
        return jsonify({'error': 'Укажите сообщение или файл'}), 400

    broadcast_id = db.create_broadcast(
        g.user_id, message, len(phones),
        file_url=file_url, file_name=file_name, use_typing=use_typing
    )
    counters = {'sent': 0, 'not_found': 0, 'failed': 0}

    def progress_cb(done, total, result):
        s = result['status']
        if s == 'sent':          counters['sent']      += 1
        elif s == 'not_found':   counters['not_found'] += 1
        else:                    counters['failed']    += 1
        db.add_recipient(broadcast_id, result['phone'], s, result.get('message_id'))
        sse_push({
            'done': done, 'total': total,
            'phone': result['phone'], 'status': s,
            'broadcast_id': broadcast_id
        })

    def run():
        global _broadcast_active
        _broadcast_active = True
        try:
            bot.broadcast(
                phones, message, delay=delay,
                progress_cb=progress_cb,
                use_typing=use_typing,
                file_url=file_url, file_name=file_name
            )
        finally:
            db.update_broadcast_stats(
                broadcast_id,
                counters['sent'], counters['not_found'], counters['failed'],
                status='done'
            )
            sse_push({'done': len(phones), 'total': len(phones),
                      'finished': True, 'broadcast_id': broadcast_id})
            _broadcast_active = False

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'broadcast_id': broadcast_id, 'total': len(phones)})


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
@require_auth
def api_history():
    return jsonify(db.get_broadcasts(g.user_id))


@app.route('/api/history/<int:broadcast_id>')
@require_auth
def api_history_detail(broadcast_id):
    return jsonify(db.get_broadcast_recipients(broadcast_id))


@app.route('/api/delivery-statuses/<int:broadcast_id>')
@require_auth
def api_delivery_statuses(broadcast_id):
    return jsonify(db.get_delivery_statuses_for_broadcast(broadcast_id))


# ── Шаблоны ───────────────────────────────────────────────────────────────
@app.route('/api/templates', methods=['GET'])
@require_auth
def api_templates_get():
    return jsonify(db.get_templates(g.user_id))


@app.route('/api/templates', methods=['POST'])
@require_auth
def api_templates_create():
    data = request.get_json(force=True)
    name = data.get('name', '').strip()
    text = data.get('text', '').strip()
    if not name or not text:
        return jsonify({'error': 'name and text required'}), 400
    tid = db.create_template(g.user_id, name, text)
    return jsonify({'id': tid, 'name': name, 'text': text}), 201


@app.route('/api/templates/<int:tid>', methods=['DELETE'])
@require_auth
def api_templates_delete(tid):
    db.delete_template(g.user_id, tid)
    return jsonify({'deleted': tid})


# ── Webhook ───────────────────────────────────────────────────────────────
@app.route('/api/setup-webhook', methods=['POST'])
@require_auth
def api_setup_webhook():
    data = request.get_json(force=True)
    url  = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'URL обязателен'}), 400
    ok = bot.setup_webhook(url)
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

        db.add_incoming(sender, text, msg_type,
                        sender_name=sender_name, file_url=file_url)
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
            db.upsert_delivery_status(msg_id, status)
            logger.info(f"Статус доставки {msg_id}: {status}")

    return jsonify({'status': 'ok'})


# ── Входящие сообщения ────────────────────────────────────────────────────
@app.route('/api/incoming')
@require_auth
def api_incoming():
    return jsonify(db.get_incoming(g.user_id))


@app.route('/api/incoming/<int:msg_id>/read', methods=['POST'])
@require_auth
def api_mark_read(msg_id):
    db.mark_incoming_read(g.user_id, msg_id)
    return jsonify({'marked': msg_id})


# ── Чаты и контакты ───────────────────────────────────────────────────────
@app.route('/api/chats')
@require_auth
def api_chats():
    chats = bot.get_chats()
    if not chats:
        return jsonify([])
    # Фильтруем скрытые группы
    hidden = db.get_hidden_groups(g.user_id)
    filtered = [c for c in chats if c.get('chatId') not in hidden]
    return jsonify(filtered)


@app.route('/api/contacts')
@require_auth
def api_contacts():
    contacts = bot.get_contacts()
    return jsonify(contacts)


@app.route('/api/contact-info', methods=['POST'])
@require_auth
def api_contact_info():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    info = bot.get_contact_info(chat_id)
    return jsonify(info or {})


@app.route('/api/chat-history', methods=['POST'])
@require_auth
def api_chat_history():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    count   = int(data.get('count', 50))
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    history = bot.get_chat_history(chat_id, count)
    return jsonify(history)


@app.route('/api/read-chat', methods=['POST'])
@require_auth
def api_read_chat():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    result = bot.read_chat(chat_id)
    return jsonify({'success': bool(result)})


# ── Отправка текстового сообщения ─────────────────────────────────────────
@app.route('/api/send-message', methods=['POST'])
@require_auth
def api_send_message():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    message = data.get('message', '').strip()
    if not chat_id or not message:
        return jsonify({'error': 'chatId and message required'}), 400
    result = bot.send_message(chat_id, message)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить сообщение'}), 500


# ── Отправка файла ────────────────────────────────────────────────────────
@app.route('/api/send-file', methods=['POST'])
@require_auth
def api_send_file():
    chat_id = request.form.get('chatId', '').strip()
    caption = request.form.get('caption', '').strip()
    file_url_input = request.form.get('fileUrl', '').strip()

    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400

    if file_url_input:
        file_name = file_url_input.split('/')[-1] or 'file'
        result = bot.send_file_by_url(chat_id, file_url_input, file_name, caption)
    elif 'file' in request.files:
        f = request.files['file']
        if f.filename == '':
            return jsonify({'error': 'no file selected'}), 400
        save_path = os.path.join(UPLOAD_FOLDER, f.filename)
        f.save(save_path)
        result = bot.send_file_by_upload(chat_id, save_path, caption)
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
@require_auth
def api_send_location():
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    lat     = data.get('latitude')
    lon     = data.get('longitude')
    name    = data.get('name', '')
    address = data.get('address', '')

    if not chat_id or lat is None or lon is None:
        return jsonify({'error': 'chatId, latitude, longitude required'}), 400

    result = bot.send_location(chat_id, float(lat), float(lon), name, address)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить геолокацию'}), 500


# ── Отправка контакта ─────────────────────────────────────────────────────
@app.route('/api/send-contact', methods=['POST'])
@require_auth
def api_send_contact():
    data          = request.get_json(force=True)
    chat_id       = data.get('chatId', '').strip()
    contact_phone = data.get('contactPhone', '').strip()
    contact_name  = data.get('contactName', '').strip()

    if not chat_id or not contact_phone or not contact_name:
        return jsonify({'error': 'chatId, contactPhone, contactName required'}), 400

    result = bot.send_contact(chat_id, contact_phone, contact_name)
    if result and 'idMessage' in result:
        return jsonify({'success': True, 'idMessage': result['idMessage']})
    return jsonify({'error': 'Не удалось отправить контакт'}), 500


# ── Queue ─────────────────────────────────────────────────────────────────
@app.route('/api/queue')
@require_auth
def api_queue():
    size = bot.get_queue_size()
    return jsonify({'size': size, 'status': 'busy' if size > 0 else 'idle'})


@app.route('/api/queue/clear', methods=['POST'])
@require_auth
def api_queue_clear():
    result  = bot.clear_queue()
    cleared = bool(result and result.get('clearMessagesQueue'))
    return jsonify({'cleared': cleared})


# ── Массовая проверка номеров ──────────────────────────────────────────────
@app.route('/api/check-contacts-bulk', methods=['POST'])
@require_auth
def api_check_contacts_bulk():
    global _check_active
    if _check_active:
        return jsonify({'error': 'Проверка уже запущена'}), 409

    data   = request.get_json(force=True)
    phones = [p.strip() for p in data.get('phones', []) if p.strip()]
    if not phones:
        return jsonify({'error': 'Список номеров пуст'}), 400

    def run():
        global _check_active
        _check_active = True
        try:
            for i, phone in enumerate(phones):
                exist, chat_id = bot.check_contact(phone)
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
            exist, chat_id = bot.check_contact(phone)
            if exist and chat_id:
                chat_ids.append(chat_id)
            else:
                not_found.append(phone)

        if not chat_ids and phones:
            return jsonify({'error': 'Ни один из введенных номеров не найден в WhatsApp'}), 400

    group_id = bot.create_group(name, chat_ids)
    if not group_id:
        return jsonify({'error': 'Не удалось создать группу'}), 500

    db.save_group(g.user_id, group_id, name)

    result = {
        'group_id': group_id, 'name': name,
        'members': len(chat_ids), 'not_found': not_found,
        'message_sent': False
    }
    if message:
        resp = bot.send_message(group_id, message)
        result['message_sent'] = bool(resp and 'idMessage' in resp)

    logger.info(f"Группа '{name}' создана. ID: {group_id}")
    return jsonify(result)


@app.route('/api/group-details', methods=['POST'])
@require_auth
def api_group_details():
    data     = request.get_json(force=True)
    group_id = data.get('groupId', '').strip()
    if not group_id:
        return jsonify({'error': 'groupId required'}), 400
    res = bot.get_group_data(group_id)
    return jsonify(res or {})


@app.route('/api/add-participant', methods=['POST'])
@require_auth
def api_add_participant():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = bot.add_group_participant(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/remove-participant', methods=['POST'])
@require_auth
def api_remove_participant():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = bot.remove_group_participant(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/set-admin', methods=['POST'])
@require_auth
def api_set_admin():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = bot.set_group_admin(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/remove-admin', methods=['POST'])
@require_auth
def api_remove_admin():
    data        = request.get_json(force=True)
    group_id    = data.get('groupId', '').strip()
    participant = data.get('participantId', '').strip()
    if not group_id or not participant:
        return jsonify({'error': 'groupId and participantId required'}), 400
    res = bot.remove_group_admin(group_id, participant)
    return jsonify({'success': bool(res)})


@app.route('/api/leave-group', methods=['POST'])
@require_auth
def api_leave_group():
    data     = request.get_json(force=True)
    group_id = data.get('groupId', '').strip()
    if not group_id:
        return jsonify({'error': 'groupId required'}), 400
    res = bot.leave_group(group_id)
    return jsonify({'success': bool(res)})


@app.route('/api/update-group-name', methods=['POST'])
@require_auth
def api_update_group_name():
    data       = request.get_json(force=True)
    group_id   = data.get('groupId', '').strip()
    group_name = data.get('groupName', '').strip()
    if not group_id or not group_name:
        return jsonify({'error': 'groupId and groupName required'}), 400
    res = bot.update_group_name(group_id, group_name)
    return jsonify({'success': bool(res)})


@app.route('/api/set-group-picture', methods=['POST'])
@require_auth
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
        res = bot.set_group_picture(group_id, path)
        return jsonify({'success': bool(res)})
    finally:
        if os.path.exists(path):
            os.remove(path)


# ── Управление группами ───────────────────────────────────────────────────
@app.route('/api/groups')
@require_auth
def api_groups():
    groups = db.get_groups(g.user_id)
    hidden = db.get_hidden_groups(g.user_id)
    filtered = [g for g in groups if g.get('group_id') not in hidden]
    return jsonify(filtered)

@app.route('/api/groups/delete', methods=['POST'])
@require_auth
def api_delete_group():
    data = request.get_json(force=True)
    group_id = data.get('groupId')
    if not group_id:
        return jsonify({'error': 'groupId is required'}), 400

    logger.info(f"Запрос на удаление группы: {group_id}")
    db.delete_group(g.user_id, group_id)
    db.hide_group(g.user_id, group_id)
    # Пытаемся также выйти из группы, если мы в ней состоим
    try:
        bot.leave_group(group_id)
    except:
        pass
    return jsonify({'success': True})


@app.route('/api/group/<path:group_id>/data')
@require_auth
def api_group_data(group_id):
    data = bot.get_group_data(group_id)
    return jsonify(data or {})


@app.route('/api/group/<path:group_id>/add', methods=['POST'])
@require_auth
def api_group_add(group_id):
    data  = request.get_json(force=True)
    phone = data.get('phone', '').strip()
    if not phone:
        return jsonify({'error': 'phone required'}), 400
    exist, chat_id = bot.check_contact(phone)
    if not exist:
        return jsonify({'error': f'Номер {phone} не найден в MAX'}), 400
    result = bot.add_group_participant(group_id, chat_id)
    return jsonify({'success': bool(result), 'chatId': chat_id})


@app.route('/api/group/<path:group_id>/add-bulk', methods=['POST'])
@require_auth
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
        exist, chat_id = bot.check_contact(phone)
        if exist and chat_id:
            ok = bot.add_group_participant(group_id, chat_id)
            results.append({'phone': phone, 'success': bool(ok)})
        else:
            results.append({'phone': phone, 'success': False, 'error': 'Not found'})

    return jsonify({'results': results})


@app.route('/api/group/<path:group_id>/remove', methods=['POST'])
@require_auth
def api_group_remove(group_id):
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    result = bot.remove_group_participant(group_id, chat_id)
    return jsonify({'success': bool(result)})


@app.route('/api/group/<path:group_id>/admin', methods=['POST'])
@require_auth
def api_group_admin(group_id):
    data    = request.get_json(force=True)
    chat_id = data.get('chatId', '').strip()
    action  = data.get('action', 'set')  # 'set' | 'remove'
    if not chat_id:
        return jsonify({'error': 'chatId required'}), 400
    if action == 'remove':
        result = bot.remove_group_admin(group_id, chat_id)
    else:
        result = bot.set_group_admin(group_id, chat_id)
    return jsonify({'success': bool(result)})


@app.route('/api/group/<path:group_id>/leave', methods=['POST'])
@require_auth
def api_group_leave(group_id):
    logger.info(f"Запрос на выход из группы: {group_id}")
    result = bot.leave_group(group_id)
    # В любом случае удаляем и скрываем локально
    db.delete_group(g.user_id, group_id)
    db.hide_group(g.user_id, group_id)
    return jsonify({'success': True})


# ── Polling уведомлений ───────────────────────────────────────────────────
@app.route('/api/poll-notifications', methods=['POST'])
@require_auth
def api_poll_notifications():
    """Ручной polling: получить все накопленные уведомления из очереди GREEN-API."""
    notifications = bot.poll_all_notifications()
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
            db.add_incoming(g.user_id, sender, text, msg_type, sender_name=sender_name)
            processed += 1
        elif type_wh == 'outgoingMessageStatus':
            msg_data = body.get('messageData', {})
            msg_id   = msg_data.get('idMessage', '')
            status   = msg_data.get('status', '')
            if msg_id:
                db.upsert_delivery_status(msg_id, status)
                processed += 1
    return jsonify({'polled': len(notifications), 'processed': processed})


# ── Contacts Enrich (имена + аватары) ──────────────────────────────────────
@app.route('/api/contacts/enrich', methods=['POST'])
@require_auth
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

    STALE_SECONDS = 7 * 24 * 3600  # 7 дней
    now           = int(time.time())

    # Получить из кэша
    cached = db.get_contacts_cache(g.user_id, chat_ids)

    result = {}
    to_fetch = []

    for cid in chat_ids:
        c = cached.get(cid)
        if c and (now - (c.get('updated_at') or 0)) < STALE_SECONDS:
            # Свежий кэш
            result[cid] = {'name': c.get('name'), 'avatar_url': c.get('avatar_url')}
        else:
            to_fetch.append(cid)

    # Загрузить недостающие из Green API
    for cid in to_fetch:
        try:
            info = bot.get_contact_info(cid) or {}
            name       = (info.get('name') or info.get('contactName') or
                          info.get('pushname') or '').strip() or None
            avatar_url = info.get('avatar') or None
            db.upsert_contact_cache(g.user_id, cid, name=name, avatar_url=avatar_url)
            result[cid] = {'name': name, 'avatar_url': avatar_url}
        except Exception as e:
            logger.debug(f"enrich {cid}: {e}")
            result[cid] = {'name': None, 'avatar_url': None}

    return jsonify(result)


# ── Запуск ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    logger.info(f"MAX Bot Dashboard запущен → http://localhost:{FLASK_PORT}")
    app.run(host='0.0.0.0', port=FLASK_PORT, debug=True, threaded=True)

