# Requirements Document

## Introduction

Эта фича добавляет в проект MAX Bot (Flask `app.py` + `bot.py` + Next.js фронтенд)
защиту от банов GREEN-API инстанса при массовых операциях (`checkAccount`,
рассылка сообщений) и устраняет связанные с массовыми операциями баги UI и
бэкенда («залипшая» кнопка «Проверить», нет кнопки «Стоп», флаги
`_check_active` / `_broadcast_active` не сбрасываются при обрыве SSE).

Фича покрывает:

1. Поведенческий rate-limiting массовых вызовов GREEN-API (батчи, jitter,
   длинные паузы, дневные/часовые лимиты).
2. Мониторинг `stateInstance` и автостоп при ухудшении состояния
   (`yellowCard`, `blocked`, `notAuthorized`).
3. Корректную обработку ответов GREEN-API `429 Too Many Requests` и
   `466 Quota Exceeded` с экспоненциальной задержкой.
4. Кнопку «Стоп», серверный watchdog и автосброс активных флагов и UI-флагов
   при обрыве SSE / ошибке / таймауте.
5. Pre-flight предупреждение в UI (расчёт времени и риска перед запуском).
6. Сохранение прогресса батчевой операции в Postgres (Prisma) и возможность
   возобновить с места обрыва.
7. Аудит-логирование массовых операций и инцидентов
   (`yellowCard`, HTTP 429, HTTP 466).
8. Конфигурируемые параметры лимитов с безопасными дефолтами,
   соответствующими [рекомендациям GREEN-API](https://green-api.com/v3/docs/faq/how-to-reduce-risk-of-blocking/).

Фича встраивается в существующую структуру (`app.py`, `bot.py`, Next.js
фронтенд, Prisma-схема), без введения новых сервисов или изменения архитектуры.

## Glossary

- **MAX_Bot**: вся система (Flask backend `app.py` + `bot.py`, Next.js
  фронтенд, GREEN-API клиент). Используется как корневой actor для
  ubiquitous-требований.
- **Rate_Limiter**: модуль на стороне `bot.py` (`MaxBot` или его помощник),
  который вычисляет паузы и решает, разрешён ли следующий вызов
  GREEN-API в текущий момент.
- **Bulk_Check_Service**: серверный обработчик `/api/check-contacts-bulk`
  (поток в `app.py`), выполняющий массовый `checkAccount`.
- **Broadcast_Service**: серверный обработчик `/api/broadcast` (поток в
  `app.py`), выполняющий рассылку сообщений.
- **Bulk_Operation**: общая абстракция для `Bulk_Check_Service` и
  `Broadcast_Service`. Любое требование, начинающееся с
  `THE Bulk_Operation`, применяется к обоим сервисам.
- **State_Monitor**: компонент, периодически опрашивающий
  GREEN-API `getStateInstance` и публикующий статус в SSE и UI.
- **Instance_State**: значение поля `stateInstance` от GREEN-API. Допустимые
  значения: `authorized`, `notAuthorized`, `yellowCard`, `blocked`,
  `starting`, `sleepMode` и любые другие, возвращаемые API. Состояния
  `authorized` считаются «здоровыми»; `yellowCard`, `blocked`,
  `notAuthorized` — «нездоровыми» (Unhealthy_State).
- **Unhealthy_State**: множество значений `Instance_State`, при которых
  любая массовая операция должна быть остановлена:
  `{yellowCard, blocked, notAuthorized}`.
- **Anti_Ban_Config**: набор параметров (delay min, delay max, batch size,
  long pause every N, daily limit, hourly limit), хранимый в Prisma и/или
  `.env`. Каждый параметр имеет безопасный дефолт.
- **Pre_Flight_Modal**: модальное окно фронтенда, показываемое перед
  запуском массовой операции с расчётом ETA и риска и обязательным
  чекбоксом «я понимаю риски».
- **Watchdog**: серверный таймер, который сбрасывает флаги
  `_check_active` / `_broadcast_active`, если в течение
  `Watchdog_Timeout` секунд не было прогресса.
- **Watchdog_Timeout**: настраиваемый порог в секундах для Watchdog.
  Дефолт: 120 секунд.
- **Operation_Run**: сущность в Prisma (новая модель), описывающая один
  запуск `Bulk_Operation` (массовая проверка или рассылка) с прогрессом,
  статусом (`running`, `paused`, `completed`, `aborted`, `banned`) и
  списком обработанных номеров.
- **Incident_Log**: сущность в Prisma (новая модель) для записей
  инцидентов: `yellowCard`, HTTP 429, HTTP 466, watchdog reset.
- **Audit_Logger**: компонент в `app.py`, записывающий старт, завершение
  и инциденты массовых операций в `Operation_Run` и `Incident_Log`.
- **Backoff_Function**: функция `backoff(retry_count) = base * 2^retry_count + jitter`,
  где `base` — настраиваемая база (дефолт 5 секунд), `jitter` — случайная
  добавка в диапазоне `[0, base]`. Используется для повторов после HTTP 429.
- **Sliding_Window_Limit**: пара `(N, T)`, где не более `N` запросов
  GREEN-API разрешено в любом скользящем окне длительностью `T` секунд.
  Дефолты заданы в Anti_Ban_Config.

## Requirements

### Requirement 1: Защита массового checkAccount от поведенческих банов

**User Story:** Как владелец инстанса GREEN-API, я хочу, чтобы массовая
проверка номеров не выглядела для платформы как автоматизированный спайк,
так чтобы инстанс не получал `yellowCard`/`blocked` после одной операции.

#### Acceptance Criteria

1. WHEN пользователь запускает массовую проверку через `/api/check-contacts-bulk`,
   THE Bulk_Check_Service SHALL обрабатывать номера батчами размером
   `Anti_Ban_Config.batch_size` (дефолт 50) с длинной паузой
   `Anti_Ban_Config.long_pause_seconds` (дефолт 60) между батчами.
2. WHEN Bulk_Check_Service отправляет запрос `checkAccount` к GREEN-API,
   THE Rate_Limiter SHALL применить случайную паузу в диапазоне
   `[Anti_Ban_Config.delay_min, Anti_Ban_Config.delay_max]` секунд
   (дефолт `[3.0, 7.0]`) перед следующим запросом.
3. THE Rate_Limiter SHALL гарантировать, что в любом скользящем окне
   длительностью `Sliding_Window_Limit.T` секунд количество запросов
   GREEN-API не превышает `Sliding_Window_Limit.N`
   (дефолт `N=20`, `T=60`).
4. WHILE текущее количество выполненных проверок за календарные сутки
   достигло `Anti_Ban_Config.daily_check_limit` (дефолт 1000),
   THE Bulk_Check_Service SHALL отказывать в запуске новых массовых
   проверок и возвращать HTTP 429 с описанием лимита.
5. WHILE текущее количество выполненных проверок за последний час
   достигло `Anti_Ban_Config.hourly_check_limit` (дефолт 200),
   THE Bulk_Check_Service SHALL приостанавливать текущую операцию
   до начала следующего часа и обновлять `Operation_Run.status`
   на `paused`.
6. THE Rate_Limiter SHALL генерировать паузы с ненулевой выборочной
   дисперсией: для последовательности из 10 пауз стандартное отклонение
   SHALL быть не менее 0.3 секунды.
7. WHERE параметр `Anti_Ban_Config.long_pause_every_n` задан и не равен 0,
   THE Bulk_Check_Service SHALL вставлять «человеческую» паузу
   `Anti_Ban_Config.long_pause_seconds` секунд после каждых N выполненных
   запросов (дефолт `N=50`, `long_pause_seconds=60`).

### Requirement 2: Защита broadcast от поведенческих банов

**User Story:** Как маркетолог, я хочу, чтобы рассылка была защищена тем же
набором правил, что и массовая проверка, так чтобы исходящие сообщения не
выглядели как автоматизация.

#### Acceptance Criteria

1. WHEN пользователь запускает рассылку через `/api/broadcast`,
   THE Broadcast_Service SHALL применять `Rate_Limiter` к каждому вызову
   `sendMessage`/`sendFileByUrl`/`uploadFile` так же, как
   `Bulk_Check_Service` применяет его к `checkAccount`.
2. THE Broadcast_Service SHALL использовать минимальную межсообщенческую
   паузу не менее `Anti_Ban_Config.broadcast_delay_min` секунд
   (дефолт 5.0), даже если пользователь указал в форме меньшее значение.
3. WHEN Broadcast_Service вызывает GREEN-API в рамках одной рассылки,
   THE Rate_Limiter SHALL добавлять случайный jitter в
   `[0, Anti_Ban_Config.broadcast_jitter_max]` секунд (дефолт 3.0)
   к базовой паузе.
4. WHILE количество отправленных сообщений за календарные сутки
   достигло `Anti_Ban_Config.daily_message_limit` (дефолт 500),
   THE Broadcast_Service SHALL отказывать в запуске новых рассылок
   и возвращать HTTP 429 с описанием лимита.
5. WHERE `Anti_Ban_Config.warn_on_zero_response_ratio` равен `true` и за
   последние `Anti_Ban_Config.response_ratio_window_hours` часов (дефолт 24)
   ноль входящих сообщений на N исходящих (где N >=
   `Anti_Ban_Config.response_ratio_min_outgoing`, дефолт 50),
   THE Broadcast_Service SHALL включать поле
   `warning: "zero_response_ratio"` в ответ при запуске рассылки.

### Requirement 3: Мониторинг состояния инстанса и автостоп

**User Story:** Как владелец инстанса, я хочу видеть текущее состояние
инстанса в UI и автоматически останавливать любую массовую операцию,
если состояние ухудшилось, так чтобы не получить полный бан после первого
предупреждения.

#### Acceptance Criteria

1. WHEN пользователь открывает страницу `/dashboard/contacts`,
   `/dashboard/broadcast` или `/dashboard/settings`, THE State_Monitor
   SHALL опросить `getStateInstance` и отобразить badge со значением
   `Instance_State` (`authorized`, `yellowCard`, `blocked`,
   `notAuthorized`, `starting`, `sleepMode`).
2. WHILE на одной из указанных страниц активен SSE-канал
   `/api/check-contacts/progress` или `/api/broadcast/progress`,
   THE State_Monitor SHALL опрашивать `getStateInstance` каждые
   `Anti_Ban_Config.state_poll_interval_seconds` секунд (дефолт 30) и
   обновлять badge.
3. WHEN пользователь нажимает «Проверить» или «Начать рассылку»,
   THE Bulk_Operation SHALL вызвать `getStateInstance` перед стартом и
   IF возвращённое значение принадлежит Unhealthy_State,
   THEN THE Bulk_Operation SHALL отказать в запуске и вернуть HTTP 409
   с полем `state` равным полученному значению.
4. WHILE Bulk_Operation выполняется и `Instance_State` переходит в
   Unhealthy_State, THE Bulk_Operation SHALL остановить отправку новых
   запросов GREEN-API в течение
   `Anti_Ban_Config.state_poll_interval_seconds` секунд после смены
   состояния и завершить операцию со статусом
   `Operation_Run.status = "banned"`.
5. WHEN Bulk_Operation останавливается из-за Unhealthy_State,
   THE Audit_Logger SHALL записать инцидент в `Incident_Log` с типом,
   равным значению `Instance_State`, временной меткой и идентификатором
   `Operation_Run`.
6. IF GREEN-API вернул ошибку или отсутствие ответа на `getStateInstance`,
   THEN THE State_Monitor SHALL отобразить badge со значением `unknown`
   и не блокировать запуск новых операций (UI отвечает за дополнительное
   подтверждение пользователем).

### Requirement 4: Обработка HTTP 429 и HTTP 466 от GREEN-API

**User Story:** Как разработчик, я хочу, чтобы при превышении rate-limit
или квоты система не повторяла запросы вслепую, а корректно отступала и
сохраняла прогресс, так чтобы операцию можно было возобновить.

#### Acceptance Criteria

1. WHEN GREEN-API возвращает HTTP 429 на любой запрос внутри
   Bulk_Operation, THE Rate_Limiter SHALL вычислить паузу
   `Backoff_Function(retry_count)` и не отправлять следующий запрос
   GREEN-API до истечения этой паузы.
2. THE Rate_Limiter SHALL ограничивать `retry_count` сверху значением
   `Anti_Ban_Config.max_retries` (дефолт 5).
3. IF количество последовательных HTTP 429 для одной Bulk_Operation
   превысило `Anti_Ban_Config.max_consecutive_429` (дефолт 3),
   THEN THE Bulk_Operation SHALL остановиться, обновить
   `Operation_Run.status` на `aborted` и записать инцидент типа
   `rate_limit_429` в `Incident_Log`.
4. IF GREEN-API возвращает HTTP 466 на любой запрос внутри Bulk_Operation,
   THEN THE Bulk_Operation SHALL немедленно остановиться, обновить
   `Operation_Run.status` на `aborted` и записать инцидент типа
   `quota_466` в `Incident_Log`.
5. WHEN Bulk_Operation остановилась по причине HTTP 429 или HTTP 466,
   THE Operation_Run SHALL содержать поле `last_processed_index`,
   указывающее на индекс последнего успешно обработанного номера, чтобы
   операцию можно было возобновить (Requirement 7).

### Requirement 5: Кнопка «Стоп», watchdog и автосброс флагов

**User Story:** Как пользователь, я хочу иметь возможность остановить
зависшую массовую операцию и быть уверенным, что кнопка «Проверить»
не залипнет навсегда после обрыва SSE или сетевой ошибки.

#### Acceptance Criteria

1. THE MAX_Bot SHALL предоставлять endpoint `POST /api/bulk-operation/stop`,
   который принимает `operation_run_id` и устанавливает флаг отмены для
   соответствующего потока Bulk_Operation.
2. WHEN флаг отмены установлен, THE Bulk_Operation SHALL прекратить
   отправку новых запросов GREEN-API в течение
   `Anti_Ban_Config.cancel_check_interval_seconds` секунд (дефолт 1) и
   завершить операцию со статусом `Operation_Run.status = "aborted"`.
3. THE Watchdog SHALL проверять время последнего прогресса каждой активной
   Bulk_Operation каждые `Anti_Ban_Config.watchdog_check_interval_seconds`
   секунд (дефолт 10).
4. IF активная Bulk_Operation не имела прогресса в течение
   `Anti_Ban_Config.watchdog_timeout_seconds` секунд (дефолт 120),
   THEN THE Watchdog SHALL сбросить соответствующий глобальный флаг
   (`_check_active` или `_broadcast_active`), отправить SSE-событие
   `{ "finished": true, "reason": "watchdog_timeout" }` всем подписчикам
   и записать инцидент типа `watchdog_reset` в `Incident_Log`.
5. WHEN поток Bulk_Operation завершается по любой причине (нормальное
   завершение, исключение, `KeyboardInterrupt`, watchdog),
   THE Bulk_Operation SHALL гарантировать, что соответствующий
   глобальный флаг установлен в `False` (через конструкцию `try/finally`
   и атомарную проверку Watchdog-ом).
6. WHEN фронтенд получает SSE-событие с полем `finished` равным `true` или
   SSE-соединение закрывается с ошибкой, THE UI_Dashboard SHALL сбросить
   локальный флаг (`massChecking` для страницы контактов и
   `broadcasting` для страницы рассылки) в `false` в течение 1 секунды.
7. IF SSE-соединение `/api/check-contacts/progress` или
   `/api/broadcast/progress` не получает ни сообщения, ни heartbeat в
   течение `Anti_Ban_Config.sse_client_timeout_seconds` секунд
   (дефолт 60), THEN THE UI_Dashboard SHALL закрыть соединение, сбросить
   локальный флаг и показать пользователю сообщение об ошибке таймаута.

### Requirement 6: Pre-flight предупреждение перед массовой операцией

**User Story:** Как пользователь, я хочу до запуска видеть оценку
длительности и риска массовой операции и подтвердить, что я понимаю
последствия, так чтобы случайно не запустить операцию на несколько часов
с риском бана.

#### Acceptance Criteria

1. WHEN пользователь нажимает «Проверить N номеров» или «Начать рассылку»,
   THE UI_Dashboard SHALL открыть Pre_Flight_Modal до отправки запроса
   на сервер.
2. THE Pre_Flight_Modal SHALL отображать расчётную длительность
   операции, вычисленную как
   `total_count * average_seconds_per_request + long_pause_count * long_pause_seconds`,
   где `average_seconds_per_request` равен среднему по
   `[Anti_Ban_Config.delay_min, Anti_Ban_Config.delay_max]` плюс 1 секунда
   на сетевой round-trip.
3. THE Pre_Flight_Modal SHALL отображать категорию риска (`low`,
   `medium`, `high`), вычисленную по правилам:
   `low` если `total_count < 200`, `medium` если `200 <= total_count < 1000`,
   `high` если `total_count >= 1000`.
4. THE Pre_Flight_Modal SHALL содержать чекбокс
   «Я понимаю риски», изначально не отмеченный.
5. WHILE чекбокс «Я понимаю риски» не отмечен, THE Pre_Flight_Modal
   SHALL держать кнопку «Запустить» отключённой.
6. WHEN пользователь нажимает «Отмена» в Pre_Flight_Modal,
   THE UI_Dashboard SHALL закрыть модалку и не отправлять запрос на сервер.

### Requirement 7: Сохранение и возобновление прогресса

**User Story:** Как пользователь, я хочу, чтобы прогресс массовой операции
сохранялся в БД, так чтобы после обрыва соединения или перезапуска
бэкенда я мог возобновить операцию с того места, где она остановилась.

#### Acceptance Criteria

1. WHEN запускается Bulk_Operation, THE Audit_Logger SHALL создать запись
   `Operation_Run` с полями `id`, `user_id`, `kind` (`check` или
   `broadcast`), `total`, `processed = 0`, `last_processed_index = -1`,
   `status = "running"`, `started_at`.
2. WHEN Bulk_Operation обрабатывает каждый элемент, THE Bulk_Operation
   SHALL обновлять `Operation_Run.processed` и
   `Operation_Run.last_processed_index` атомарно вместе с записью
   результата (для рассылки — `Recipient`, для проверки — новая запись
   в `CheckResult`).
3. WHEN Bulk_Operation завершается, THE Audit_Logger SHALL установить
   `Operation_Run.status` в одно из значений
   `{completed, aborted, banned}` и `Operation_Run.finished_at`
   в текущее время.
4. THE MAX_Bot SHALL предоставлять endpoint
   `POST /api/bulk-operation/resume` с телом
   `{ "operation_run_id": ... }`, который запускает новый поток
   Bulk_Operation, начинающий с `Operation_Run.last_processed_index + 1`
   и использующий тот же исходный список элементов
   (`Operation_Run.payload`).
5. IF переданный `operation_run_id` относится к Operation_Run со статусом
   `completed`, THEN THE MAX_Bot SHALL вернуть HTTP 409 с описанием
   ошибки.
6. WHILE существует Operation_Run со статусом `running` или `paused`,
   принадлежащий текущему пользователю, THE UI_Dashboard SHALL
   отображать на странице `/dashboard/history` карточку этой операции
   с кнопкой «Возобновить» (для `paused`/`aborted` после обрыва) или
   «Стоп» (для `running`).

### Requirement 8: Аудит и история инцидентов

**User Story:** Как администратор, я хочу видеть журнал всех массовых
операций и инцидентов (yellowCard, 429, 466, watchdog), так чтобы
анализировать причины проблем и доказывать GREEN-API, что инстанс не
использовался для спама.

#### Acceptance Criteria

1. WHEN Bulk_Operation стартует, завершается или останавливается по
   любой причине, THE Audit_Logger SHALL записать соответствующее
   событие в `Operation_Run` с временной меткой и итоговым статусом.
2. WHEN происходит инцидент типа `yellowCard`, `blocked`,
   `notAuthorized`, `rate_limit_429`, `quota_466` или
   `watchdog_reset`, THE Audit_Logger SHALL создать запись в
   `Incident_Log` с полями `id`, `user_id`, `operation_run_id`
   (nullable), `kind`, `details` (JSON), `created_at`.
3. THE MAX_Bot SHALL предоставлять endpoint `GET /api/incidents`,
   возвращающий последние `Anti_Ban_Config.incident_history_limit`
   записей `Incident_Log` (дефолт 100), отсортированных по
   `created_at desc`.
4. WHEN пользователь открывает страницу `/dashboard/history`,
   THE UI_Dashboard SHALL отображать раздел «Инциденты» со списком
   записей `Incident_Log`, сгруппированных по дате.

### Requirement 9: Конфигурация и безопасные дефолты

**User Story:** Как администратор, я хочу управлять параметрами
анти-бан-защиты через UI настроек, так чтобы не редактировать `.env`
вручную, при этом дефолтные значения должны быть безопасными.

#### Acceptance Criteria

1. THE MAX_Bot SHALL хранить `Anti_Ban_Config` в Prisma-модели
   `AntiBanConfig` с полями: `delay_min` (float), `delay_max` (float),
   `batch_size` (int), `long_pause_every_n` (int),
   `long_pause_seconds` (float), `daily_check_limit` (int),
   `hourly_check_limit` (int), `daily_message_limit` (int),
   `broadcast_delay_min` (float), `broadcast_jitter_max` (float),
   `state_poll_interval_seconds` (int), `watchdog_timeout_seconds` (int),
   `max_retries` (int), `max_consecutive_429` (int).
2. WHEN пользователь не имеет записи `AntiBanConfig`, THE MAX_Bot SHALL
   использовать следующие дефолты: `delay_min=3.0`, `delay_max=7.0`,
   `batch_size=50`, `long_pause_every_n=50`, `long_pause_seconds=60`,
   `daily_check_limit=1000`, `hourly_check_limit=200`,
   `daily_message_limit=500`, `broadcast_delay_min=5.0`,
   `broadcast_jitter_max=3.0`, `state_poll_interval_seconds=30`,
   `watchdog_timeout_seconds=120`, `max_retries=5`,
   `max_consecutive_429=3`.
3. WHEN пользователь сохраняет настройки на странице
   `/dashboard/settings`, THE MAX_Bot SHALL валидировать значения и
   IF любое значение нарушает условие
   (`delay_min >= 1.0 AND delay_max >= delay_min AND batch_size >= 1
   AND long_pause_seconds >= 0 AND daily_check_limit >= 1
   AND hourly_check_limit >= 1`),
   THEN THE MAX_Bot SHALL отказать в сохранении и вернуть HTTP 400
   с описанием конкретного нарушения.
4. WHILE значение `delay_min` в сохранённой `AntiBanConfig` меньше 1.0
   секунды, THE UI_Dashboard SHALL показывать предупреждение
   «Текущее значение `delay_min` повышает риск блокировки. Рекомендуется
   значение не ниже 3.0 секунды.» на странице `/dashboard/settings`.

### Requirement 10: Парсер и сериализация Operation_Run.payload

**User Story:** Как разработчик, я хочу, чтобы payload (список номеров и
параметров) Operation_Run сериализовался и десериализовался без потерь,
так чтобы возобновление операции после рестарта работало корректно.

Объяснение применимости: Operation_Run хранит список входных номеров и
параметры запуска как JSON в Postgres. Это парсер/сериализатор данных, и
по требованиям спеки парсеры должны иметь требование round-trip.

#### Acceptance Criteria

1. THE Audit_Logger SHALL сериализовывать `payload` в JSON и сохранять в
   поле `Operation_Run.payload` (тип `Json` в Prisma) при создании
   Operation_Run.
2. WHEN запрос на возобновление Operation_Run приходит на
   `/api/bulk-operation/resume`, THE MAX_Bot SHALL десериализовать
   `Operation_Run.payload` обратно в исходную структуру
   (список контактов и параметры).
3. FOR ALL валидных входных списков контактов
   (`list[dict]` с обязательным ключом `phone` и опциональными
   строковыми полями), сериализация в JSON с последующей
   десериализацией SHALL возвращать список контактов, эквивалентный
   исходному (round-trip property): порядок элементов, ключи и значения
   совпадают.
4. IF `Operation_Run.payload` не парсится как валидный JSON или не
   содержит ключ `contacts` со списком,
   THEN THE MAX_Bot SHALL вернуть HTTP 422 с описанием ошибки и не
   запускать поток возобновления.
