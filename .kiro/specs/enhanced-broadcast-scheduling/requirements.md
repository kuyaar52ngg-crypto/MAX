# Requirements Document

## Introduction

Эта фича расширяет систему MAX тремя направлениями:

1. **Улучшение UX анти-бан настроек** — текущая страница `/dashboard/settings`
   содержит форму `AntiBanSettingsForm` с 24+ техническими полями, которая
   перегружает пользователя. Нужен интуитивный интерфейс с визуальными
   подсказками, группировкой по сценариям использования и интерактивным
   предпросмотром последствий настроек.

2. **Подключение внешнего GREEN API инстанса** — пользователь получает от
   руководителя `idInstance` + `apiTokenInstance` с оплаченной подпиской
   GREEN API, но не имеет доступа к личному кабинету green-api.com. Система
   MAX должна позволить подключить такой инстанс, авторизоваться через QR
   и использовать его для рассылок — без доступа к консоли GREEN API.

3. **Расширенное планирование рассылок** — добавление продвинутых
   возможностей планирования: условные триггеры, A/B-тестирование,
   цепочки сообщений (follow-up), адаптивная скорость на основе
   доставляемости, календарные исключения и шаблоны расписаний.

Фича встраивается в существующую архитектуру: Next.js фронтенд, Prisma ORM,
Supabase/PostgreSQL, Flask бэкенд с GREEN API интеграцией.

## Glossary

- **MAX_System**: вся система (Flask backend, Next.js фронтенд, Prisma/Supabase).
  Используется как корневой actor для ubiquitous-требований.
- **Anti_Ban_Settings_Page**: страница `/dashboard/settings`, секция
  «Анти-бан защита» с формой `AntiBanSettingsForm`.
- **Risk_Indicator**: визуальный элемент (цвет, иконка, текст), показывающий
  уровень риска бана при текущих настройках.
- **Scenario_Card**: интерактивная карточка, описывающая типичный сценарий
  использования (например, «Небольшая рассылка до 100 контактов») и
  предлагающая оптимальные настройки одним кликом.
- **External_Instance**: инстанс GREEN API, принадлежащий другому аккаунту
  (у пользователя MAX нет доступа к консоли green-api.com), но для которого
  предоставлены `idInstance` и `apiTokenInstance`.
- **Instance_Connection_Wizard**: пошаговый мастер подключения External_Instance
  в системе MAX (ввод credentials → проверка → QR-авторизация → готово).
- **Multi_Instance_Selector**: UI-элемент выбора активного инстанса GREEN API
  для операций рассылки и проверки контактов.
- **Scheduled_Broadcast**: запланированная рассылка (существующая модель в Prisma).
- **Follow_Up_Chain**: последовательность сообщений, отправляемых одному
  получателю с заданными интервалами или по условию (например, «если не
  ответил через 24 часа — отправить напоминание»).
- **AB_Test_Variant**: один из вариантов сообщения в A/B-тесте, отправляемый
  подмножеству получателей для сравнения эффективности.
- **Adaptive_Throttle**: механизм автоматической корректировки скорости
  отправки на основе текущего процента доставки и ответов.
- **Schedule_Template**: сохранённый набор параметров расписания, который
  можно переиспользовать при создании новых рассылок.
- **Calendar_Exception**: дата или диапазон дат, в которые запланированная
  рассылка не должна выполняться (праздники, выходные, blackout-периоды).
- **Delivery_Score**: метрика доставляемости рассылки, вычисляемая как
  `(delivered + read) / total_sent * 100`.
- **Condition_Trigger**: условие, при выполнении которого запускается
  следующий шаг Follow_Up_Chain (например, «получатель не ответил»,
  «сообщение прочитано», «прошло N часов»).

## Requirements

### Requirement 1: Визуальные сценарии использования в анти-бан настройках

**User Story:** Как пользователь MAX, я хочу видеть на странице анти-бан
настроек понятные сценарии использования вместо голых числовых полей,
так чтобы выбрать оптимальные параметры без технических знаний.

#### Acceptance Criteria

1. WHEN пользователь открывает Anti_Ban_Settings_Page, THE MAX_System SHALL
   отображать блок Scenario_Card с минимум тремя сценариями: «Маленькая
   рассылка (до 100 контактов)», «Средняя рассылка (100–500 контактов)»,
   «Большая рассылка (500+ контактов)».
2. WHEN пользователь выбирает Scenario_Card, THE MAX_System SHALL
   автоматически заполнить все поля Anti_Ban_Config оптимальными значениями
   для выбранного сценария и отобразить визуальное подтверждение применения.
3. THE Anti_Ban_Settings_Page SHALL отображать Risk_Indicator рядом с каждым
   изменённым параметром, показывающий влияние текущего значения на
   вероятность бана (зелёный — безопасно, жёлтый — умеренный риск,
   красный — высокий риск).
4. WHEN значение любого параметра Anti_Ban_Config изменяется,
   THE Anti_Ban_Settings_Page SHALL обновить Risk_Indicator в течение
   200 миллисекунд без перезагрузки страницы.

### Requirement 2: Интерактивная визуализация последствий настроек

**User Story:** Как пользователь MAX, я хочу видеть в реальном времени,
как мои настройки повлияют на скорость и безопасность рассылки, так чтобы
принимать осознанные решения.

#### Acceptance Criteria

1. THE Anti_Ban_Settings_Page SHALL отображать интерактивную временную шкалу,
   показывающую симуляцию отправки 10 сообщений с текущими настройками
   (визуализация пауз, батчей и длинных пауз).
2. WHEN пользователь наводит курсор на элемент временной шкалы,
   THE Anti_Ban_Settings_Page SHALL показать tooltip с объяснением, почему
   в этом месте возникает пауза и какой параметр за неё отвечает.
3. THE Anti_Ban_Settings_Page SHALL отображать сводную панель с тремя
   метриками: «Время на 100 сообщений», «Время на 500 сообщений» и
   «Уровень безопасности» (процент от максимально безопасной конфигурации).
4. WHEN любой параметр Anti_Ban_Config изменяется, THE MAX_System SHALL
   пересчитать все три метрики сводной панели и обновить временную шкалу
   в течение 300 миллисекунд.

### Requirement 3: Подключение внешнего GREEN API инстанса

**User Story:** Как пользователь MAX, я хочу подключить GREEN API инстанс,
используя только `idInstance` и `apiTokenInstance` (без доступа к консоли
green-api.com), так чтобы использовать оплаченную подписку для рассылок.

#### Acceptance Criteria

1. THE MAX_System SHALL предоставлять Instance_Connection_Wizard на странице
   `/dashboard/settings` с полями ввода `idInstance` и `apiTokenInstance`.
2. WHEN пользователь вводит `idInstance` и `apiTokenInstance` и нажимает
   «Проверить», THE Instance_Connection_Wizard SHALL выполнить запрос
   `getStateInstance` к GREEN API с указанными credentials и отобразить
   текущий статус инстанса.
3. IF GREEN API возвращает ошибку аутентификации на запрос с указанными
   credentials, THEN THE Instance_Connection_Wizard SHALL отобразить
   сообщение «Неверные credentials: проверьте idInstance и apiTokenInstance»
   и не сохранять данные.
4. WHEN статус инстанса равен `notAuthorized`, THE Instance_Connection_Wizard
   SHALL перейти на шаг QR-авторизации и отобразить QR-код для сканирования
   в WhatsApp.
5. WHEN статус инстанса равен `authorized`, THE Instance_Connection_Wizard
   SHALL сохранить credentials в профиле пользователя и отобразить экран
   успешного подключения с номером телефона инстанса.
6. THE MAX_System SHALL хранить credentials External_Instance в таблице
   `profiles` (поля `green_api_id`, `green_api_token`, `green_api_url`)
   с шифрованием `apiTokenInstance` при хранении.

### Requirement 4: Поддержка нескольких инстансов GREEN API

**User Story:** Как пользователь MAX, я хочу подключить несколько инстансов
GREEN API и выбирать, через какой инстанс отправлять рассылку, так чтобы
распределять нагрузку и снижать риск бана.

#### Acceptance Criteria

1. THE MAX_System SHALL хранить список подключённых инстансов GREEN API
   в новой Prisma-модели `GreenInstance` с полями: `id`, `user_id`,
   `name` (пользовательское имя), `id_instance`, `api_token` (зашифрован),
   `api_url`, `status` (last known state), `phone`, `is_primary`,
   `created_at`, `updated_at`.
2. WHEN пользователь открывает страницу рассылки или запланированных рассылок,
   THE MAX_System SHALL отображать Multi_Instance_Selector с перечнем
   подключённых инстансов и их текущим статусом.
3. WHEN пользователь запускает рассылку, THE MAX_System SHALL использовать
   выбранный в Multi_Instance_Selector инстанс для отправки сообщений.
4. IF выбранный инстанс имеет статус из множества `{blocked, notAuthorized}`,
   THEN THE MAX_System SHALL отказать в запуске рассылки и предложить
   выбрать другой инстанс.
5. THE MAX_System SHALL позволять пользователю добавлять до 5 инстансов
   GREEN API на один аккаунт MAX.

### Requirement 5: Follow-up цепочки сообщений

**User Story:** Как маркетолог, я хочу настроить автоматическую цепочку
сообщений (follow-up), так чтобы получатели, не ответившие на первое
сообщение, автоматически получали напоминание через заданное время.

#### Acceptance Criteria

1. THE MAX_System SHALL предоставлять UI для создания Follow_Up_Chain
   с минимум 1 и максимум 5 шагами (сообщениями) в цепочке.
2. WHEN пользователь создаёт шаг Follow_Up_Chain, THE MAX_System SHALL
   позволить задать Condition_Trigger из набора: «не ответил в течение N
   часов», «сообщение прочитано, но нет ответа в течение N часов»,
   «прошло N часов после предыдущего шага».
3. WHEN Condition_Trigger выполняется для получателя, THE MAX_System SHALL
   запланировать отправку следующего шага цепочки с учётом quiet hours и
   анти-бан настроек.
4. IF получатель ответил на любое сообщение в цепочке, THEN THE MAX_System
   SHALL остановить дальнейшую отправку шагов цепочки для этого получателя.
5. THE MAX_System SHALL хранить Follow_Up_Chain в новой Prisma-модели
   `FollowUpChain` с полями: `id`, `user_id`, `scheduled_broadcast_id`,
   `steps` (JSON массив шагов с условиями и текстами), `status`,
   `created_at`.
6. THE MAX_System SHALL отображать прогресс Follow_Up_Chain на странице
   `/dashboard/scheduled`: сколько получателей на каком шаге, сколько
   ответили и вышли из цепочки.

### Requirement 6: A/B-тестирование сообщений

**User Story:** Как маркетолог, я хочу отправить разные варианты сообщения
подгруппам получателей и сравнить результаты, так чтобы выбрать наиболее
эффективный текст для основной рассылки.

#### Acceptance Criteria

1. THE MAX_System SHALL предоставлять UI для создания A/B-теста с 2–4
   вариантами сообщения (AB_Test_Variant).
2. WHEN пользователь создаёт A/B-тест, THE MAX_System SHALL позволить
   задать процент получателей для тестовой группы (от 10% до 50%) и
   равномерно распределить тестовую группу между вариантами.
3. WHEN A/B-тест завершён (все тестовые сообщения отправлены и прошло
   заданное время ожидания ответов), THE MAX_System SHALL отобразить
   сравнительную таблицу с метриками: процент доставки, процент прочтения,
   процент ответов для каждого AB_Test_Variant.
4. WHEN пользователь выбирает победивший вариант, THE MAX_System SHALL
   автоматически запланировать отправку этого варианта оставшимся
   получателям (не участвовавшим в тесте).
5. THE MAX_System SHALL хранить A/B-тест в новой Prisma-модели `ABTest`
   с полями: `id`, `user_id`, `scheduled_broadcast_id`, `variants` (JSON),
   `test_percentage`, `wait_hours`, `winner_variant_id`, `status`,
   `created_at`.

### Requirement 7: Адаптивная скорость отправки

**User Story:** Как пользователь MAX, я хочу, чтобы система автоматически
замедляла отправку при ухудшении доставляемости и ускоряла при хороших
показателях, так чтобы максимизировать скорость без риска бана.

#### Acceptance Criteria

1. WHILE рассылка выполняется и Adaptive_Throttle включён, THE MAX_System
   SHALL вычислять Delivery_Score каждые 20 отправленных сообщений.
2. IF Delivery_Score падает ниже 80%, THEN THE MAX_System SHALL увеличить
   текущую паузу между сообщениями на 50% от базового значения и записать
   событие `throttle_slowdown` в Incident_Log.
3. IF Delivery_Score возвращается выше 95% после замедления,
   THEN THE MAX_System SHALL вернуть паузу к базовому значению и записать
   событие `throttle_restored` в Incident_Log.
4. IF Delivery_Score падает ниже 50%, THEN THE MAX_System SHALL
   приостановить рассылку, установить статус `paused` и уведомить
   пользователя через UI с рекомендацией проверить состояние инстанса.
5. THE MAX_System SHALL отображать текущий Delivery_Score и статус
   Adaptive_Throttle (нормальный / замедлен / приостановлен) в реальном
   времени на странице активной рассылки.
6. WHERE Adaptive_Throttle включён в настройках Scheduled_Broadcast,
   THE MAX_System SHALL применять адаптивную логику к запланированным
   рассылкам так же, как к ручным.

### Requirement 8: Календарные исключения и blackout-периоды

**User Story:** Как маркетолог, я хочу задать даты, в которые рассылки
не должны отправляться (праздники, корпоративные события), так чтобы
не беспокоить получателей в неподходящее время.

#### Acceptance Criteria

1. THE MAX_System SHALL предоставлять UI для управления списком
   Calendar_Exception на странице `/dashboard/scheduled`.
2. WHEN пользователь создаёт Calendar_Exception, THE MAX_System SHALL
   позволить задать: одну дату, диапазон дат или повторяющееся
   исключение (например, «каждое воскресенье»).
3. WHILE текущая дата/время попадает в Calendar_Exception,
   THE MAX_System SHALL откладывать запуск любой Scheduled_Broadcast
   до окончания исключения и обновлять `next_run_at` соответственно.
4. THE MAX_System SHALL хранить Calendar_Exception в новой Prisma-модели
   `CalendarException` с полями: `id`, `user_id`, `name`, `start_date`,
   `end_date`, `recurring_type` (nullable: `weekly`, `monthly`, `yearly`),
   `recurring_value` (nullable), `created_at`.
5. WHEN пользователь просматривает список запланированных рассылок,
   THE MAX_System SHALL визуально отмечать рассылки, чей `next_run_at`
   попадает в Calendar_Exception, предупреждением «Будет отложена».

### Requirement 9: Шаблоны расписаний

**User Story:** Как пользователь MAX, я хочу сохранять часто используемые
настройки расписания как шаблоны и применять их при создании новых рассылок,
так чтобы не настраивать одни и те же параметры каждый раз.

#### Acceptance Criteria

1. THE MAX_System SHALL предоставлять кнопку «Сохранить как шаблон» в
   модальном окне планирования рассылки (ScheduleModal).
2. WHEN пользователь сохраняет Schedule_Template, THE MAX_System SHALL
   сохранить все параметры расписания: `schedule_type`, `recurring_kind`,
   `recurring_hour`, `recurring_minute`, `recurring_day_of_week`,
   `recurring_day_of_month`, `quiet_hours_enabled`, `quiet_hours_start`,
   `quiet_hours_end`, `respect_recipient_tz`, `user_tz`,
   `drip_batch_size`, `drip_interval_minutes`.
3. WHEN пользователь открывает ScheduleModal для новой рассылки,
   THE MAX_System SHALL отображать список сохранённых Schedule_Template
   с возможностью применить любой шаблон одним кликом.
4. THE MAX_System SHALL хранить Schedule_Template в новой Prisma-модели
   `ScheduleTemplate` с полями: `id`, `user_id`, `name`, `config` (JSON
   с параметрами расписания), `created_at`.
5. THE MAX_System SHALL позволять пользователю удалять и переименовывать
   сохранённые Schedule_Template.

### Requirement 10: Сериализация и десериализация Follow_Up_Chain.steps

**User Story:** Как разработчик, я хочу, чтобы шаги цепочки follow-up
сериализовались и десериализовались без потерь, так чтобы планировщик
корректно восстанавливал состояние цепочки после перезапуска.

#### Acceptance Criteria

1. THE MAX_System SHALL сериализовать `Follow_Up_Chain.steps` в JSON и
   сохранять в поле типа `Json` в PostgreSQL при создании цепочки.
2. WHEN планировщик загружает Follow_Up_Chain для обработки,
   THE MAX_System SHALL десериализовать `steps` обратно в массив объектов
   с полями: `step_index` (int), `message` (string),
   `condition_type` (string), `condition_hours` (number),
   `file_url` (nullable string).
3. FOR ALL валидных массивов шагов Follow_Up_Chain, сериализация в JSON
   с последующей десериализацией SHALL возвращать массив, эквивалентный
   исходному: порядок элементов, ключи и значения совпадают (round-trip
   property).
4. IF `Follow_Up_Chain.steps` не парсится как валидный JSON или не
   содержит массив объектов с обязательными полями `step_index`,
   `message`, `condition_type`, `condition_hours`,
   THEN THE MAX_System SHALL вернуть HTTP 422 с описанием ошибки
   валидации и не запускать обработку цепочки.
