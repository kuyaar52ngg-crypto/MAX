# Requirements Document

## Introduction

Эта фича — UX-надстройка над уже существующим движком анти-бана,
описанным в спеке `anti-ban-protection` (`requirements.md`,
`design.md`, `tasks.md`). Движок (rate limiter, watchdog, sliding
window, retry/backoff, audit, state monitor) уже реализован в пакете
`anti_ban/` и интегрирован в Flask-обработчики `/api/check-contacts-bulk`
и `/api/broadcast`. Параметры хранятся в Prisma-модели `AntiBanConfig`,
инциденты — в `IncidentLog`, прогресс операций — в `OperationRun`.

**Эта спека НЕ переписывает движок и НЕ вводит новые политики
анти-бана.** Все требования к поведению защиты (паузы, jitter, лимиты,
watchdog, обработка 429/466, мониторинг состояния, аудит) остаются
определёнными в `anti-ban-protection`. Здесь — только UX-слой поверх:
визуализация, упрощение управления, обучение, обмен профилями.

Текущее состояние UI настроек анти-бана — «панель управления
самолётом»: 25+ числовых полей в семи группах, одна кнопка «Сохранить»,
без подсказок, без видимых последствий настройки, без пресетов, без
текущего статуса и истории инцидентов на той же странице. Оператор-
непрограммист не может работать с такой формой без доверенного эксперта
рядом.

Фича делает страницу анти-бана пригодной для оператора:

1. **Пресеты профилей** — настройка одним кликом вместо ручного ввода
   25+ значений.
2. **Inline-подсказки** возле каждого поля — что значит и что
   произойдёт при изменении.
3. **Live-индикатор статуса** — текущая нагрузка, % использования
   лимитов, статус watchdog, прогноз достижения лимита.
4. **Лента инцидентов** на той же странице с фильтром по типу.
5. **Симулятор рассылки** — расчёт ETA и риска до запуска без
   отправки реальных сообщений.
6. **Обучающий тур** при первом заходе на страницу.
7. **Импорт/экспорт профиля** в JSON для обмена рабочими конфигами.
8. **Безопасное переключение пресета** — без потери ручных правок без
   подтверждения.
9. **Применение настроек без рестарта** Python-движка.

Фича опирается на существующие данные и эндпойнты
`anti-ban-protection`: `GET/PUT /api/anti-ban-config`,
`GET /api/incidents`, Prisma-модели `AntiBanConfig`, `OperationRun`,
`IncidentLog`. Где требуются новые данные (метрики live-статуса, флаг
прохождения тура), они описаны в этой спеке.

## Glossary

- **Anti_Ban_UX_Page**: страница настроек анти-бана в Next.js
  дашборде (текущий путь `/dashboard/settings`, может быть выделена
  в отдельный путь `/dashboard/settings/anti-ban` на этапе design).
  Целевая аудитория — оператор-непрограммист.
- **Profile**: полный набор значений `AntiBanConfig` (25+ полей,
  схема описана в `anti-ban-protection/requirements.md` Requirement 9.1
  и Prisma-модели `AntiBanConfig`). В контексте этой спеки `Profile` —
  редактируемая сущность UX-слоя.
- **Preset**: именованный предустановленный `Profile` с
  фиксированным набором значений. Множество встроенных пресетов:
  `Safe_Preset`, `Balanced_Preset`, `Aggressive_Preset`. Пользовательские
  пресеты в этой итерации не вводятся.
- **Preset_Catalog**: набор `{Safe_Preset, Balanced_Preset,
  Aggressive_Preset}`, поставляемый вместе с фронтендом. Значения
  пресетов фиксированы и версионируются вместе с кодом.
- **Active_Preset**: одно из значений `{Safe, Balanced, Aggressive,
  Custom}`, отражающее, откуда взяты текущие значения формы.
  `Custom` означает, что пользователь правил поля после применения
  пресета или загрузил профиль через импорт.
- **Custom_Profile_Label**: строка вида `"Свой (на основе
  Сбалансированный)"`, отображаемая в `Active_Preset_Indicator`,
  когда `Active_Preset == Custom`. «На основе X» равно последнему
  применённому пресету; если пресет ни разу не применялся — равно
  `Balanced_Preset` (значения по умолчанию из
  `anti-ban-protection` Requirement 9.2 совпадают со
  `Balanced_Preset`).
- **Active_Preset_Indicator**: визуальный элемент на
  `Anti_Ban_UX_Page`, показывающий текущее значение `Active_Preset`
  (включая `Custom_Profile_Label`).
- **Field_Tooltip**: всплывающая раскрывающаяся подсказка возле поля
  ввода, активируемая по клику на иконку `i`. Содержит
  `Field_Description` и `Field_Impact_Hint`.
- **Field_Description**: краткое объяснение, что означает параметр
  (одно предложение).
- **Field_Impact_Hint**: объяснение последствий изменения параметра
  («увеличение → медленнее, безопаснее; уменьшение → быстрее,
  выше риск»).
- **Live_Status_Banner**: баннер сверху `Anti_Ban_UX_Page`,
  отображающий `Live_Metric` в реальном времени.
- **Live_Metric**: набор показателей `{current_rps, hourly_usage_pct,
  daily_usage_pct, watchdog_state, recent_429_count,
  hourly_limit_eta_minutes, daily_limit_eta_minutes}`. Источник —
  Flask-бэкенд, агрегирующий данные из `OperationRun`,
  `IncidentLog` и in-memory счётчиков `RateLimiter`.
- **Live_Status_Endpoint**: `GET /api/anti-ban/status` (новый),
  возвращающий снимок `Live_Metric`. Источник истины для
  `Live_Status_Banner`.
- **Live_Refresh_Interval_Seconds**: интервал обновления
  `Live_Status_Banner` через polling. Дефолт 5 секунд.
- **Watchdog_State**: одно из `{ok, warning, alarm}`, рассчитанное
  бэкендом по правилам:
  - `ok` — нет инцидентов за последний час и нет активных операций
    с просроченным watchdog timeout;
  - `warning` — за последний час был хотя бы один инцидент типа
    `rate_limit_429` или `zero_response_ratio`;
  - `alarm` — за последний час был хотя бы один инцидент типа
    `yellowCard`, `blocked`, `notAuthorized`, `quota_466` или
    `watchdog_reset`.
- **Limit_Forecast**: расчётное число минут до достижения часового
  или дневного лимита при текущей `current_rps`. Считается как
  `(limit - used) / current_rps / 60`. Если `current_rps == 0` —
  значение `null` (отображается как «—»).
- **Incident_Feed**: панель/вкладка на `Anti_Ban_UX_Page`,
  отображающая записи из `IncidentLog` (источник —
  `GET /api/incidents` из `anti-ban-protection`).
- **Incident_Filter**: фильтр `Incident_Feed` по полю `kind`
  (`yellowCard`, `blocked`, `notAuthorized`, `rate_limit_429`,
  `quota_466`, `watchdog_reset`, `zero_response_ratio`,
  `broadcast_started`, `broadcast_finished`, или «все типы»).
- **Incident_Page_Size**: количество инцидентов на одну страницу
  `Incident_Feed`. Дефолт 20.
- **Simulator**: модальное окно на `Anti_Ban_UX_Page`, считающее
  ETA, число длинных пауз, ожидаемое число retry и риск превышения
  лимитов на основе текущих значений формы и введённых
  `Simulation_Input` (количество сообщений, размер батча).
  Симулятор не отправляет реальных запросов к GREEN-API.
- **Simulation_Input**: пара `(message_count: int >= 1, batch_size:
  int >= 1)`. `batch_size` опционален; при отсутствии берётся
  значение `batch_size` из текущей формы.
- **Simulation_Result**: набор `{eta_seconds, long_pause_count,
  expected_retry_count, hourly_limit_breach_risk,
  daily_limit_breach_risk}`. Поля `*_breach_risk` имеют значения
  `{none, low, high}`.
- **Onboarding_Tour**: пошаговый онбординг (5–7 шагов), показываемый
  при первом заходе пользователя на `Anti_Ban_UX_Page`. Каждый шаг
  подсвечивает один элемент страницы overlay-выделением и
  показывает короткое описание.
- **Tour_Step**: один шаг `Onboarding_Tour`. Описывается селектором
  целевого элемента, заголовком и текстом.
- **Tour_Completion_Marker**: новое поле в Prisma-модели `Profile`,
  имя `anti_ban_tour_completed_at` (паттерн совпадает с существующим
  `welcomed_at`). Тип `DateTime?`. Заполнено — тур пройден или
  пропущен; null — тур ещё не показывался.
- **Profile_Export_File**: JSON-файл, скачиваемый при экспорте.
  Содержит поля `{schema_version: string, preset_name: string,
  values: <все поля AntiBanConfig>, exported_at: ISO8601}`.
- **Profile_Import_File**: JSON-файл, загружаемый при импорте.
  Структурно совпадает с `Profile_Export_File`.
- **Schema_Version**: строка вида `"1.0"` (semver-major.minor),
  идентифицирующая совместимость формата экспорта/импорта.
- **Schema_Version_Current**: текущее значение `Schema_Version` для
  этой версии фронтенда. Версионируется вместе с фронтендом.
- **Import_Diff_Modal**: модальное окно, показывающее различия
  между текущим `Profile` и значениями из `Profile_Import_File`,
  с обязательным подтверждением «Применить» перед записью.
- **Hot_Reload**: механизм, при котором изменения `AntiBanConfig`,
  сохранённые через `PUT /api/anti-ban-config`, начинают применяться
  работающим Python-бэкендом без рестарта. Реализуется через
  существующий `anti_ban.config_loader.ConfigLoader.invalidate`
  (см. `anti-ban-protection/design.md`, секция
  «Components/Interfaces → ConfigLoader»).
- **Preset_Switch_Confirmation**: модальное окно, появляющееся при
  клике на пресет, если в форме есть несохранённые ручные правки.
  Содержит две кнопки: «Применить пресет» (правки теряются) и
  «Отменить» (форма не меняется).

## Requirements

### Requirement 1: Пресеты профилей

**User Story:** Как оператор-непрограммист, я хочу настроить
анти-бан одним кликом через пресет, так чтобы не вникать в 25+
числовых полей.

#### Acceptance Criteria

1. THE Anti_Ban_UX_Page SHALL отображать ровно три встроенных
   `Preset` из `Preset_Catalog`: `Safe_Preset`, `Balanced_Preset`,
   `Aggressive_Preset`, в фиксированном порядке.
2. WHEN пользователь кликает на `Preset` и форма не содержит
   несохранённых ручных правок относительно последних применённых
   значений, THE Anti_Ban_UX_Page SHALL заполнить все поля формы
   значениями этого `Preset` и установить `Active_Preset` равным id
   выбранного пресета.
3. THE Safe_Preset SHALL содержать значения `delay_min >= 5.0`,
   `delay_max >= 10.0`, `daily_check_limit <= 500`,
   `hourly_check_limit <= 100`, `daily_message_limit <= 250`,
   `sliding_window_n <= 15`, `sliding_window_t >= 60`.
4. THE Balanced_Preset SHALL содержать значения, равные дефолтам
   из `anti-ban-protection` Requirement 9.2 (`delay_min=3.0`,
   `delay_max=7.0`, `daily_check_limit=1000`,
   `hourly_check_limit=200`, `daily_message_limit=500`,
   `sliding_window_n=20`, `sliding_window_t=60`, и т.д.).
5. THE Aggressive_Preset SHALL содержать значения `delay_min >= 1.0`,
   `delay_max <= 4.0`, `daily_check_limit >= 1500`,
   `hourly_check_limit >= 300`, `daily_message_limit >= 800`,
   при этом каждое значение SHALL соответствовать ограничениям
   валидации из `anti-ban-protection` Requirement 9.3
   (`delay_min >= 1.0`, `delay_max >= delay_min`, `batch_size >= 1`,
   `long_pause_seconds >= 0`, `daily_check_limit >= 1`,
   `hourly_check_limit >= 1`).
6. WHEN пользователь меняет любое поле формы после применения
   `Preset`, THE Anti_Ban_UX_Page SHALL установить `Active_Preset`
   равным `Custom` и отобразить `Custom_Profile_Label` со ссылкой
   на последний применённый `Preset`.
7. THE Active_Preset_Indicator SHALL быть видимым на
   `Anti_Ban_UX_Page` всегда, когда `Anti_Ban_UX_Page` смонтирована.
8. WHEN пользователь открывает `Anti_Ban_UX_Page` впервые в сессии
   и текущие значения `AntiBanConfig` совпадают со значениями одного
   из встроенных `Preset`, THE Anti_Ban_UX_Page SHALL установить
   `Active_Preset` равным id этого пресета.
9. WHEN пользователь открывает `Anti_Ban_UX_Page` и текущие значения
   `AntiBanConfig` не совпадают ни с одним встроенным `Preset`,
   THE Anti_Ban_UX_Page SHALL установить `Active_Preset` равным
   `Custom` с базой `Balanced_Preset`.

### Requirement 2: Inline-подсказки для полей

**User Story:** Как оператор-непрограммист, я хочу видеть рядом с
каждым полем что оно значит и что произойдёт при изменении, так чтобы
понимать последствия настройки без чтения документации.

#### Acceptance Criteria

1. THE Anti_Ban_UX_Page SHALL отображать иконку `i` рядом с каждым
   полем формы `AntiBanConfig` (минимум 24 поля, перечисленные в
   Prisma-модели `AntiBanConfig`).
2. WHEN пользователь кликает на иконку `i` поля,
   THE Anti_Ban_UX_Page SHALL раскрыть `Field_Tooltip` рядом с этим
   полем без открытия модального окна.
3. THE Field_Tooltip SHALL содержать `Field_Description` (одно
   предложение) и `Field_Impact_Hint` (одно предложение, формат:
   «увеличение → ...; уменьшение → ...»).
4. WHEN пользователь кликает повторно на иконку `i` уже раскрытого
   `Field_Tooltip` или на любую область вне него,
   THE Anti_Ban_UX_Page SHALL свернуть `Field_Tooltip`.
5. THE Anti_Ban_UX_Page SHALL группировать поля минимум в семь
   секций с человекочитаемыми заголовками: «Темп проверки и
   рассылки», «Лимиты», «Батчи и длинные паузы», «Jitter и
   отказоустойчивость», «Сторожевые интервалы», «Скользящее окно и
   аудит», «Предупреждение об отсутствии ответов».
6. THE Field_Tooltip SHALL отображаться без сдвига разметки соседних
   полей: раскрытие подсказки SHALL использовать absolute/floating
   позиционирование. THE Field_Tooltip SHALL сохранять позиции соседних
   элементов даже если содержимое подсказки выходит за границы
   видимой области экрана (в этом случае подсказка может быть
   обрезана viewport-ом, но соседние поля не сдвигаются).

### Requirement 3: Live-индикатор статуса

**User Story:** Как оператор, я хочу видеть текущую нагрузку и
прогноз достижения лимита в реальном времени, так чтобы понимать,
безопасно ли запускать рассылку прямо сейчас.

#### Acceptance Criteria

1. THE MAX_Bot SHALL предоставлять `Live_Status_Endpoint`
   `GET /api/anti-ban/status`, возвращающий JSON с полями
   `current_rps` (float, запросов в секунду за последние 60
   секунд), `hourly_usage_pct` (float, 0–100, процент использования
   `hourly_check_limit` за последний час), `daily_usage_pct` (float,
   0–100, процент использования максимума из `daily_check_limit` и
   `daily_message_limit` за календарные сутки UTC),
   `watchdog_state` (одно из `{ok, warning, alarm}`),
   `recent_429_count` (integer, количество HTTP 429 за последний
   час), `hourly_limit_eta_minutes` (float или null),
   `daily_limit_eta_minutes` (float или null).
2. THE Anti_Ban_UX_Page SHALL отображать `Live_Status_Banner`
   сверху страницы, содержащий все поля `Live_Metric` из
   `Live_Status_Endpoint`.
3. WHILE `Anti_Ban_UX_Page` смонтирована, THE Anti_Ban_UX_Page
   SHALL опрашивать `Live_Status_Endpoint` каждые
   `Live_Refresh_Interval_Seconds` секунд (дефолт 5).
4. WHEN `Watchdog_State == ok`, THE Live_Status_Banner SHALL
   отображать индикатор зелёным цветом.
5. WHEN `Watchdog_State == warning`, THE Live_Status_Banner SHALL
   отображать индикатор жёлтым цветом и текст с количеством
   инцидентов «warning»-уровня за последний час.
6. WHEN `Watchdog_State == alarm`, THE Live_Status_Banner SHALL
   отображать индикатор красным цветом и текст с типом последнего
   инцидента «alarm»-уровня.
7. WHILE `current_rps > 0` и `hourly_limit_eta_minutes` не равен
   null, THE Live_Status_Banner SHALL отображать строку
   «При текущей скорости часовой лимит будет достигнут через N
   минут», где N = `round(hourly_limit_eta_minutes)`.
8. IF `Live_Status_Endpoint` возвращает HTTP-ошибку или сеть
   недоступна, THEN THE Anti_Ban_UX_Page SHALL отобразить в
   `Live_Status_Banner` нейтральный плейсхолдер «Статус
   недоступен» и продолжить попытки опроса каждые
   `Live_Refresh_Interval_Seconds` секунд.

### Requirement 4: Лента инцидентов

**User Story:** Как оператор, я хочу видеть журнал недавних
инцидентов прямо на странице анти-бана, так чтобы быстро понимать,
что недавно ломалось.

#### Acceptance Criteria

1. THE Anti_Ban_UX_Page SHALL отображать `Incident_Feed` как
   отдельную вкладку или секцию на той же странице.
2. THE Incident_Feed SHALL получать данные от существующего
   эндпойнта `GET /api/incidents` (см.
   `anti-ban-protection/requirements.md` Requirement 8.3).
3. THE Incident_Feed SHALL отображать для каждого инцидента: время
   (локальное), тип (`kind`), краткое описание (одно предложение,
   соответствующее `kind`) и кнопку/ссылку «Подробнее»,
   раскрывающую полный `details` из `IncidentLog`.
4. THE Incident_Feed SHALL пагинировать записи по
   `Incident_Page_Size` штук на странице (дефолт 20) с навигацией
   «Предыдущая»/«Следующая».
5. THE Incident_Feed SHALL предоставлять `Incident_Filter` — выпадающий
   список значений `kind` со значением «все типы» по умолчанию.
6. WHEN пользователь выбирает значение в `Incident_Filter`,
   THE Incident_Feed SHALL отображать только записи с совпадающим
   `kind` и сбрасывать пагинацию на первую страницу.
7. WHEN записей в `IncidentLog` нет (для пользователя или после
   применения фильтра), THE Incident_Feed SHALL отображать пустое
   состояние с текстом «Инцидентов не зарегистрировано».

### Requirement 5: Симулятор рассылки

**User Story:** Как оператор, я хочу прогнать симуляцию «что будет
если разослать N сообщений с такими настройками», так чтобы оценить
ETA и риск до запуска без отправки реальных сообщений.

#### Acceptance Criteria

1. THE Anti_Ban_UX_Page SHALL предоставлять кнопку «Симулировать
   рассылку», открывающую `Simulator` модальное окно.
2. THE Simulator SHALL принимать `Simulation_Input` с полями
   `message_count` (целое >= 1, обязательное) и `batch_size`
   (целое >= 1, опциональное).
3. WHEN `batch_size` не задан в `Simulation_Input`,
   THE Simulator SHALL использовать значение поля `batch_size`
   текущей формы `Profile`.
4. THE Simulator SHALL вычислять `Simulation_Result` целиком на
   стороне фронтенда без обращения к Flask-бэкенду и без отправки
   запросов к GREEN-API.
5. THE Simulator SHALL вычислять `eta_seconds` по формуле,
   эквивалентной формуле ETA из `anti-ban-protection`
   Requirement 6.2: `message_count * ((delay_min + delay_max) / 2 +
   1.0) + (message_count // long_pause_every_n) *
   long_pause_seconds`, где `long_pause_every_n == 0` означает 0
   длинных пауз.
6. THE Simulator SHALL вычислять `long_pause_count` как
   `floor(message_count / long_pause_every_n)` при
   `long_pause_every_n > 0`, иначе 0.
7. THE Simulator SHALL вычислять `expected_retry_count` как
   `ceil(message_count * 0.02)` (упрощённая модель: ожидаем 2%
   повторов; конкретный коэффициент зафиксирован для детерминизма).
8. THE Simulator SHALL вычислять `hourly_limit_breach_risk` как
   `high`, если `message_count > hourly_check_limit`; `low`, если
   `message_count > hourly_check_limit * 0.7` и
   `message_count <= hourly_check_limit`; иначе `none`.
9. THE Simulator SHALL вычислять `daily_limit_breach_risk` как
   `high`, если `message_count > daily_message_limit`; `low`, если
   `message_count > daily_message_limit * 0.7` и
   `message_count <= daily_message_limit`; иначе `none`.
10. THE Simulator SHALL отображать `Simulation_Result` с цветовой
    индикацией: `none` — серый, `low` — жёлтый, `high` — красный.
11. THE Simulator SHALL отображать форматированное `eta_seconds` в
    виде «N часов M минут» при `eta_seconds >= 3600`, иначе
    «N минут».

### Requirement 6: Обучающий тур при первом заходе

**User Story:** Как оператор, который первый раз зашёл на страницу
анти-бана, я хочу пройти короткий тур, так чтобы понять основные
элементы страницы без чтения документации.

#### Acceptance Criteria

1. THE MAX_Bot SHALL хранить `Tour_Completion_Marker` в Prisma-модели
   `Profile` с именем поля `anti_ban_tour_completed_at` и типом
   `DateTime?`.
2. WHEN пользователь открывает `Anti_Ban_UX_Page` и
   `Profile.anti_ban_tour_completed_at` равно null,
   THE Anti_Ban_UX_Page SHALL запустить `Onboarding_Tour`.
3. THE Onboarding_Tour SHALL содержать от 5 до 7 `Tour_Step`,
   подсвечивающих по одному элементу страницы:
   `Live_Status_Banner`, блок `Preset` (`Preset_Catalog`),
   первая группа полей с `Field_Tooltip`, кнопка «Симулировать
   рассылку», секция `Incident_Feed`, кнопки «Экспорт настроек» и
   «Импорт настроек», кнопка «Сохранить». IF a tour configuration
   contains fewer than 5 or more than 7 `Tour_Step` entries, THEN
   THE Anti_Ban_UX_Page SHALL reject the configuration at build/load
   time and SHALL NOT render the `Onboarding_Tour`.
4. THE Onboarding_Tour SHALL отображать на каждом `Tour_Step`
   кнопки «Далее», «Назад» (кроме первого шага) и «Пропустить».
5. WHEN пользователь нажимает «Пропустить» или завершает последний
   `Tour_Step` через «Готово»,
   THE Anti_Ban_UX_Page SHALL отправить `POST
   /api/profile/anti-ban-tour-completed` и закрыть `Onboarding_Tour`.
6. WHEN сервер получает `POST /api/profile/anti-ban-tour-completed`,
   THE MAX_Bot SHALL установить
   `Profile.anti_ban_tour_completed_at` равным текущему UTC-времени
   и вернуть HTTP 200. Повторные вызовы SHALL быть идемпотентными:
   значение `anti_ban_tour_completed_at` сохраняется неизменным.
7. WHEN пользователь открывает `Anti_Ban_UX_Page` и
   `Profile.anti_ban_tour_completed_at` не равно null,
   THE Anti_Ban_UX_Page SHALL не запускать `Onboarding_Tour`.
8. THE Anti_Ban_UX_Page SHALL предоставлять кнопку «Запустить тур
   снова» в подвале страницы или в меню действий, по клику на
   которую `Onboarding_Tour` запускается заново независимо от
   значения `anti_ban_tour_completed_at`.

### Requirement 7: Импорт и экспорт профиля как JSON

**User Story:** Как оператор, я хочу скачать рабочий профиль как
JSON и поделиться им с коллегой, так чтобы не диктовать 25 чисел
голосом.

Объяснение применимости: экспорт/импорт — это сериализация и парсинг
JSON-структуры. По требованиям спеки парсеры обязаны иметь требование
round-trip; criterion 7 ниже это покрывает.

#### Acceptance Criteria

1. THE Anti_Ban_UX_Page SHALL предоставлять кнопку «Экспорт
   настроек».
2. WHEN пользователь нажимает «Экспорт настроек»,
   THE Anti_Ban_UX_Page SHALL сформировать `Profile_Export_File`
   с полями `schema_version` равным `Schema_Version_Current`,
   `preset_name` равным значению `Active_Preset`, `values`
   содержащим все поля текущего `Profile` (как они хранятся в
   `AntiBanConfig`), `exported_at` равным текущему UTC-времени в
   ISO 8601, и инициировать скачивание файла с расширением `.json`
   и именем вида `anti-ban-profile-<YYYY-MM-DD>.json`.
3. THE Anti_Ban_UX_Page SHALL предоставлять кнопку «Импорт
   настроек».
4. WHEN пользователь выбирает файл через «Импорт настроек» и файл
   парсится как JSON со структурой `Profile_Import_File`,
   THE Anti_Ban_UX_Page SHALL открыть `Import_Diff_Modal`,
   показывающий список полей, чьи значения отличаются от текущих,
   с парами «было → станет».
5. WHEN пользователь подтверждает импорт через `Import_Diff_Modal`,
   THE Anti_Ban_UX_Page SHALL применить импортированные значения
   к форме (но не сохранять автоматически — сохранение остаётся
   за кнопкой «Сохранить»), установить `Active_Preset` равным
   значению `preset_name` из файла (если оно совпадает с одним из
   встроенных пресетов и значения совпадают) или `Custom` иначе.
6. IF `Profile_Import_File.schema_version` не равен
   `Schema_Version_Current`, THEN THE Import_Diff_Modal SHALL
   отображать предупреждение «Версия схемы файла отличается от
   текущей: ожидается X, получено Y. Применение возможно, но
   некоторые поля могут отсутствовать или иметь другое значение
   по умолчанию».
7. FOR ALL валидных `Profile`-объектов сериализация в
   `Profile_Export_File` с последующим парсингом обратно в
   `Profile` SHALL давать структуру, эквивалентную исходной по полю
   `values` (round-trip property): порядок ключей значения не
   имеет, типы и числовые значения совпадают.
8. IF выбранный файл не парсится как JSON или не содержит
   обязательного поля `values` со словарём, THEN THE Anti_Ban_UX_Page
   SHALL отобразить ошибку «Файл не является валидным профилем
   анти-бана» и не открывать `Import_Diff_Modal`.
9. IF любое значение в `Profile_Import_File.values` нарушает
   валидацию `anti-ban-protection` Requirement 9.3 (`delay_min >=
   1.0`, `delay_max >= delay_min`, `batch_size >= 1` и др.),
   THEN THE Import_Diff_Modal SHALL отобразить список нарушений и
   запретить нажатие кнопки «Применить» до устранения нарушений
   вручную после применения значений.

### Requirement 8: Безопасное переключение пресета

**User Story:** Как оператор, я хочу не потерять ручные правки при
случайном клике на пресет, так чтобы быстрая попытка «посмотреть»
другой пресет не уничтожала час моей настройки.

#### Acceptance Criteria

1. WHEN пользователь кликает на `Preset` и форма содержит
   несохранённые ручные правки относительно последних применённых
   значений (`Active_Preset == Custom` и значения отличаются от
   последнего применённого пресета),
   THE Anti_Ban_UX_Page SHALL открыть `Preset_Switch_Confirmation`.
2. THE Preset_Switch_Confirmation SHALL содержать заголовок
   «Применить пресет «X»?» и текст «Текущие ручные изменения будут
   потеряны».
3. THE Preset_Switch_Confirmation SHALL содержать две кнопки:
   «Применить пресет» и «Отменить».
4. WHEN пользователь нажимает «Применить пресет» в
   `Preset_Switch_Confirmation`, THE Anti_Ban_UX_Page SHALL
   заполнить форму значениями выбранного пресета и установить
   `Active_Preset` равным id пресета.
5. WHEN пользователь нажимает «Отменить» в
   `Preset_Switch_Confirmation`, THE Anti_Ban_UX_Page SHALL
   закрыть модалку и оставить значения формы и `Active_Preset` без
   изменений.

### Requirement 9: Применение настроек без рестарта движка

**User Story:** Как оператор, я хочу, чтобы новая конфигурация
анти-бана начала применяться сразу после сохранения, так чтобы не
ждать перезапуска бэкенда.

#### Acceptance Criteria

1. WHEN пользователь сохраняет форму через `PUT
   /api/anti-ban-config` с валидными значениями,
   THE MAX_Bot SHALL вызвать `ConfigLoader.invalidate(user_id)`
   (см. `anti-ban-protection/design.md`, секция «Components/
   Interfaces → ConfigLoader»), чтобы следующий вызов
   `ConfigLoader.get(user_id)` прочёл свежие значения из БД.
2. WHEN сохранение успешно, THE Anti_Ban_UX_Page SHALL отобразить
   индикатор успеха «Настройки сохранены» и текст «Применятся в
   течение N секунд», где N = TTL кэша `ConfigLoader` (60 секунд
   согласно `anti-ban-protection/design.md` секция ConfigLoader).
3. THE MAX_Bot SHALL не требовать рестарта Flask-приложения для
   применения сохранённых значений `AntiBanConfig` к новым
   запускаемым `Bulk_Operation`.
4. WHILE существует активная `Bulk_Operation` пользователя на
   момент сохранения, THE Anti_Ban_UX_Page SHALL отобразить
   подсказку «Изменения применятся к новым операциям; текущая
   операция продолжит работать с прежними настройками».
