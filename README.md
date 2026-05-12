# MAX Bot

Веб-интерфейс для управления аккаунтом WhatsApp через [GREEN-API](https://green-api.com/).

**Backend** — Flask (Python)  
**Frontend** — Next.js 15 + Tailwind CSS + Supabase Auth

---

## Возможности

| Раздел | Что умеет |
|---|---|
| **Мессенджер** | Чаты, отправка сообщений / файлов / геолокации / контакта |
| **Рассылка** | Массовая отправка по CSV-списку с прогресс-баром |
| **Группы** | Создание, управление участниками и правами, смена названия / аватара |
| **Контакты** | Просмотр, поиск, проверка номеров |
| **История** | Журнал рассылок и статусы доставки |
| **Шаблоны** | Сохранённые тексты для быстрой отправки |
| **Настройки** | QR-подключение, вебхук, перезагрузка инстанса |

---

## Стек

### Backend
- Python 3.10+
- Flask 3, Flask-CORS
- python-dotenv
- Supabase PostgreSQL / Prisma через Next.js API

### Frontend
- Next.js 15 (Turbopack)
- React 19, TypeScript
- Tailwind CSS
- Supabase (аутентификация)

---

## Быстрый старт

### 1. Клонировать репозиторий

```bash
git clone https://github.com/kuyaar52ngg-crypto/MAX.git
cd MAX
```

### 2. Backend

```bash
# Создать виртуальное окружение
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Linux / macOS

# Установить зависимости
pip install -r requirements.txt

# Настроить переменные окружения
cp .env.example .env
# Открыть .env и при необходимости изменить FLASK_PORT, FRONTEND_URL
```

Запуск:
```bash
python app.py
# Flask стартует на http://localhost:5000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
# Next.js стартует на http://localhost:3000
```

Открыть браузер: **http://localhost:3000**

### 4. Google OAuth

Авторизация через Google работает через Supabase Auth.

1. В Google Cloud Console создайте OAuth Client ID для Web application.
2. В Google Cloud в **Authorized redirect URIs** добавьте Supabase callback: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. В Supabase Dashboard откройте **Authentication → Providers → Google**, включите провайдер и вставьте Google Client ID / Client Secret.
4. В Supabase **Authentication → URL Configuration** добавьте app callback `http://localhost:3000/auth/callback` в Redirect URLs и укажите Site URL `http://localhost:3000`.

---

## Переменные окружения

Файл `.env` в корне проекта для Flask backend (не коммитить):

```env
FLASK_PORT=5000
FLASK_DEBUG=0
FRONTEND_URL=http://localhost:3000
FRONTEND_ORIGINS=
```

Файл `frontend/.env.local` для Next.js frontend (не коммитить):

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
DATABASE_URL="postgresql://postgres.your-project:your-password@host:6543/postgres"
NEXT_PUBLIC_API_URL=http://localhost:5000
```

Шаблоны: [`.env.example`](.env.example), [`frontend/.env.example`](frontend/.env.example)

GREEN-API credentials задаются пользователем в разделе **Настройки** внутри dashboard.

---

## VPS деплой

Пример для Ubuntu VPS без домена: frontend на `http://SERVER_IP:3000`, backend на `http://SERVER_IP:5000`.

### 1. Установить системные пакеты

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Скачать проект

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/kuyaar52ngg-crypto/MAX.git max
sudo chown -R $USER:$USER /var/www/max
cd /var/www/max
```

### 3. Backend

Создать `/var/www/max/.env`:

```env
FLASK_PORT=5000
FLASK_DEBUG=0
FRONTEND_URL=http://SERVER_IP:3000
```

Установить и запустить:

```bash
cd /var/www/max
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pm2 start "venv/bin/gunicorn -w 1 --threads 8 -b 0.0.0.0:5000 app:app --timeout 300" --name max-backend
```

### 4. Frontend

Создать `/var/www/max/frontend/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://imugyplwampsqwsxhjgw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
DATABASE_URL="postgresql://..."
NEXT_PUBLIC_API_URL=http://SERVER_IP:5000
```

Собрать и запустить:

```bash
cd /var/www/max/frontend
npm install
npm run build
pm2 start "npm run start -- -H 0.0.0.0 -p 3000" --name max-frontend
pm2 save
pm2 startup
```

### 5. Firewall

```bash
sudo ufw allow 22
sudo ufw allow 3000
sudo ufw allow 5000
sudo ufw enable
```

### 6. Supabase и Google OAuth

В Supabase **Authentication → URL Configuration**:

```text
Site URL: http://SERVER_IP:3000
Redirect URLs:
http://SERVER_IP:3000/auth/callback
http://localhost:3000/auth/callback
```

В Google Cloud OAuth Client в **Authorized redirect URIs** должен быть Supabase callback:

```text
https://imugyplwampsqwsxhjgw.supabase.co/auth/v1/callback
```

---

## Структура проекта

```
MAX/
├── app.py              # Flask API (~50 endpoints)
├── bot.py              # Обёртка над GREEN-API
├── db.py               # SQLite: история, шаблоны, контакты
├── requirements.txt
├── .env.example
└── frontend/
    └── src/
        ├── app/
        │   ├── dashboard/
        │   │   ├── messenger/
        │   │   ├── groups/
        │   │   ├── broadcast/
        │   │   ├── contacts/
        │   │   ├── history/
        │   │   ├── templates/
        │   │   └── settings/
        │   └── login/
        └── lib/
            ├── api.ts          # HTTP-клиент (JWT)
            └── supabase/       # Auth helpers
```

---

## Требования

- Python 3.10+
- Node.js 20+
- Активный инстанс GREEN-API
- Проект в Supabase (для аутентификации)
- .
