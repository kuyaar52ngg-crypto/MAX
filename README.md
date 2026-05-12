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
- SQLite (через `db.py`)

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
# Открыть .env и вписать реальные значения ID_INSTANCE, API_TOKEN_INSTANCE
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

---

## Переменные окружения

Файл `.env` в корне проекта (не коммитить):

```env
ID_INSTANCE=ваш_id_инстанса
API_TOKEN_INSTANCE=ваш_токен
GREEN_API_URL=https://api.green-api.com
```

Шаблон: [`.env.example`](.env.example)

Получить credentials: [console.green-api.com](https://console.green-api.com)

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
- Node.js 18+
- Активный инстанс GREEN-API
- Проект в Supabase (для аутентификации)
