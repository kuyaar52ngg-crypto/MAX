import os
import sys
import time
import logging
import requests
import random
import re
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

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


class MaxBot:
    """
    Основной класс для работы с мессенджером MAX через GREEN-API.
    """
    def __init__(self, id_instance, api_token):
        self.id_instance = id_instance
        self.api_token = api_token
        self.base_url = f"{API_URL}/waInstance{self.id_instance}"

    def _make_request(self, method, endpoint, payload=None, timeout=15):
        url = f"{self.base_url}/{endpoint}/{self.api_token}"
        try:
            if method == 'POST':
                response = requests.post(url, json=payload, timeout=timeout)
            else:
                response = requests.get(url, timeout=timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            logger.error(f"HTTP Ошибка [{endpoint}]: {e.response.text}")
            return None
        except requests.exceptions.RequestException as e:
            logger.error(f"Сетевая ошибка [{endpoint}]: {e}")
            return None

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

    def check_contact(self, phone_number):
        """
        Проверка наличия аккаунта MAX по номеру телефона.
        Возвращает (exist: bool, chatId: str|None).
        """
        payload = {"phoneNumber": int(phone_number)}
        result = self._make_request('POST', 'checkAccount', payload)
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
        return result if isinstance(result, list) else []

    def get_contacts(self):
        """Получить список всех контактов."""
        result = self._make_request('GET', 'getContacts')
        return result if isinstance(result, list) else []

    def get_contact_info(self, chat_id):
        """Получить информацию о контакте по chatId."""
        payload = {"chatId": chat_id}
        return self._make_request('POST', 'getContactInfo', payload)

    def get_chat_history(self, chat_id, count=50):
        """Получить историю сообщений чата."""
        payload = {"chatId": chat_id, "count": count}
        result = self._make_request('POST', 'getChatHistory', payload)
        return result if isinstance(result, list) else []

    def read_chat(self, chat_id, id_message=None):
        """Отметить чат как прочитанный."""
        payload = {"chatId": chat_id}
        if id_message:
            payload["idMessage"] = id_message
        return self._make_request('POST', 'readChat', payload)

    # ── ОТПРАВКА СООБЩЕНИЙ ───────────────────────────────────────────────────

    def send_typing(self, chat_id):
        """Имитация набора текста (показывает «печатает…» собеседнику)."""
        payload = {"chatId": chat_id}
        return self._make_request('POST', 'sendTyping', payload)

    def send_message(self, chat_id, message):
        """Отправка текстового сообщения."""
        payload = {"chatId": chat_id, "message": message}
        return self._make_request('POST', 'sendMessage', payload)

    def send_file_by_url(self, chat_id, file_url, file_name, caption=""):
        """Отправка файла по URL."""
        payload = {
            "chatId": chat_id,
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
            "chatId": chat_id,
            "nameLocation": name,
            "address": address,
            "latitude": lat,
            "longitude": lon
        }
        return self._make_request('POST', 'sendLocation', payload)

    def send_contact(self, chat_id, contact_phone, contact_name):
        """Отправка контакта (vCard)."""
        payload = {
            "chatId": chat_id,
            "contact": {
                "phoneContact": int(contact_phone),
                "firstName": contact_name
            }
        }
        return self._make_request('POST', 'sendContact', payload)

    def delete_message(self, chat_id, id_message):
        """Удаление сообщения."""
        payload = {"chatId": chat_id, "idMessage": id_message}
        return self._make_request('POST', 'deleteMessage', payload)

    def forward_messages(self, chat_id, from_chat_id, messages):
        """Пересылка сообщений."""
        payload = {
            "chatId": chat_id,
            "chatIdFrom": from_chat_id,
            "messages": messages
        }
        return self._make_request('POST', 'forwardMessages', payload)

    # ── РАССЫЛКА ─────────────────────────────────────────────────────────────

    def broadcast(self, contacts, message, delay=2.0, max_queue=100,
                  progress_cb=None, use_typing=False,
                  file_url=None, file_name=None):
        """
        Рассылка с контролем очереди.
        use_typing — имитировать набор текста перед отправкой.
        file_url / file_name — если указаны, отправлять файл вместо текста.
        progress_cb(done, total, result) — колбэк прогресса.
        """
        logger.info(f"Рассылка: {len(contacts)} контактов.")
        results = []

        for i, contact in enumerate(contacts):
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

            # Ждём, пока очередь освободится
            while self.get_queue_size() >= max_queue:
                logger.warning("Очередь заполнена. Ожидание 10 сек...")
                time.sleep(10)

            exist, chat_id = self.check_contact(phone)

            if exist and chat_id:
                # Имитация набора текста
                if use_typing:
                    self.send_typing(chat_id)
                    time.sleep(1.5)

                # Отправка файла или текста
                if file_url and file_name:
                    response = self.send_file_by_url(chat_id, file_url, file_name, rendered_message)
                else:
                    response = self.send_message(chat_id, rendered_message)

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

            time.sleep(delay)

        return results

    def broadcast_with_uploaded_file(self, contacts, message, file_path, file_name,
                                     delay=2.0, use_typing=False, progress_cb=None):
        """
        Рассылка с локальным файлом: один раз загружает файл в GREEN-API
        (`uploadFile`) и переиспользует полученный `urlFile` через `broadcast`.

        При сбое загрузки файла (нет ответа или отсутствует `urlFile`)
        для каждого получателя вызывается `progress_cb` со статусом `error`,
        чтобы UI получил по событию на каждый контакт, как и при обычной
        рассылке.
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
            return None

        return self.broadcast(
            contacts,
            message,
            delay=delay,
            progress_cb=progress_cb,
            use_typing=use_typing,
            file_url=upload['urlFile'],
            file_name=file_name,
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
        """Получить данные группы и список участников."""
        # Исправление ID: группы в WhatsApp должны заканчиваться на @g.us
        full_id = group_id if '@' in group_id else f"{group_id}@g.us"
        payload = {"chatId": full_id}
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
