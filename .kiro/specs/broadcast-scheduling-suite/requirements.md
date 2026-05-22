# Requirements Document

## Introduction

Фича `broadcast-scheduling-suite` — это **расширение** уже существующей спеки `enhanced-broadcast-scheduling`. Она НЕ переписывает планировщик и НЕ дублирует имеющиеся возможности, а добавляет к нему набор новых режимов планирования и UX-инструментов оператора. Везде, где новая логика опирается на уже существующие сущности (`ScheduledBroadcast`, `FollowUpChain`, `ABTest` для сообщений, `CalendarException`, `ScheduleTemplate`, `AntiBanConfig`, `GreenInstance`, `Incoming`, `DeliveryStatus`), требование ссылается на конкретное поле или таблицу, а не вводит её повторно.

### Что уже есть в `enhanced-broadcast-scheduling` (НЕ дублируется)

- Модель `ScheduledBroadcast` с режимами `schedule_type` (exact / drip / recurring), полями `scheduled_for`, `drip_*`, `recurring_*`, `quiet_hours_*`, `respect_recipient_tz`, `user_tz`, `status`, `next_run_at`, `instance_id`, `adaptive_throttle`, `follow_up_chain_id`, `ab_test_id`.
- Модель `FollowUpChain` с условными триггерами `no_reply` / `read_no_reply` / `time_elapsed`.
- Модель `ABTest` (тест **сообщений**, не времени) с распределением получателей по вариантам.
- Модель `CalendarException` (одиночные / повторяющиеся blackout-периоды).
- Модель `ScheduleTemplate` (сохранённые конфигурации расписаний).
- Модуль `adaptive_throttle` (state machine `normal` / `slowed` / `paused`) и broadcast worker.
- Flask scheduler tick раз в 15 секунд.

### Что добавляется этой спекой

1. **Send Window** — равномерное распределение N сообщений в произвольном временном окне с учётом анти-бан, тихих часов и календарных исключений.
2. **Smart-Time** — выбор оптимального часа отправки **для каждого получателя индивидуально** на основе его истории активности (`Incoming`, `DeliveryStatus`).
3. **A/B Test Send Time** — тест **времени** доставки (а не текста), параллельный к `ABTest`.
4. **Visual Schedule Calendar** — месячный/недельный календарь с drag-and-drop рассылок.
5. **PreFlight Preview** — модалка предпросмотра ETA, гистограммы, предупреждений до запуска.
6. **Snooze** — быстрый перенос запланированной рассылки на пресет («+1 час», «+1 день», ...).
7. **Approval Workflow** — обязательное одобрение крупных рассылок назначенным апрувером.
8. **Burst Mode** — режим максимально быстрой отправки в пределах анти-бан лимитов с auto-tune.
9. **Auto-Snooze on Incident** — автоматическая пауза рассылки при срабатывании watchdog / накоплении инцидентов 429.
10. **Notifications** — уведомления оператору о событиях рассылки по каналам in-app / email / Telegram.
11. **Active Broadcast Controls** — кнопки пауза / возобновить / отменить / перепланировать на странице активной рассылки.

### Источники данных для новых режимов

- `Incoming` (входящие сообщения) — для расчёта гистограммы активности получателя в Smart-Time.
- `DeliveryStatus` (`message_id`, `status`, `timestamp`) — для трекинга прочтений и winner-расчёта в A/B Time Test.
- Существующий `Recipient` (broadcast → recipients) — для связки сообщения с получателем при ретроспективе.

## Glossary

- **Scheduling_Suite**: совокупная подсистема настоящей спеки — дополнения к существующему планировщику (см. `enhanced-broadcast-scheduling/design.md`).
- **Schedule_Mode**: расширенное значение поля `ScheduledBroadcast.schedule_type` — `exact` | `drip` | `recurring` (старые из `enhanced-broadcast-scheduling`) **плюс** новые `window` | `smart_time` | `ab_time` | `burst`. Единое поле, не два.
- **Send_Window**: пара (`send_window_start`, `send_window_end`) — временной интервал, внутри которого `Schedule_Mode_Engine` равномерно распределяет отправку всех сообщений рассылки.
- **Smart_Time_Slot**: вычисленный для конкретного получателя час дня (0–23) с наивысшей вероятностью прочтения, основанный на гистограмме активности из `Incoming` и `DeliveryStatus` за последние 30 дней.
- **Activity_Histogram**: 24-bucket представление активности получателя — массив из 24 целых чисел, каждое — число событий (входящих сообщений или прочтений) в соответствующем часе.
- **Activity_Analyzer**: компонент, который для пары (user_id, recipient_phone) возвращает топ-N `Smart_Time_Slot` или fallback-значение.
- **AB_Time_Test**: новая сущность, параллельная существующей `ABTest`. Тестирует **время отправки**, а не текст. Хранит 2–4 временных слота (часы дня), winner-слот после ожидания, метрики delivery/read/reply.
- **AB_Time_Slot**: один из 2–4 часов дня, между которыми распределяются получатели в `AB_Time_Test`.
- **Visual_Schedule_Calendar**: UI-компонент на `/dashboard/scheduled/calendar`, отображающий все `ScheduledBroadcast` пользователя в виде месячной (по умолчанию) или недельной сетки с цветовым кодированием по статусу.
- **Schedule_Pill**: визуальный элемент-плашка в `Visual_Schedule_Calendar`, представляющий одну запланированную рассылку.
- **PreFlight_Preview**: модальное окно, открывающееся между нажатием «Запланировать» и фактическим созданием/обновлением `ScheduledBroadcast`. Показывает ETA, гистограмму распределения, предупреждения.
- **Snooze_Action**: операция «отложить запланированную рассылку на пресет», изменяющая `scheduled_for` и `next_run_at` в существующей записи `ScheduledBroadcast` без создания новой.
- **Snooze_Preset**: один из фиксированных вариантов сдвига — `+1h` | `+1d` | `+7d` | `next_business_day` | `custom`.
- **Approval_Workflow**: процесс одобрения, в котором `ScheduledBroadcast` со статусом `pending_approval` блокируется до явного действия `Approver`.
- **Approver**: пользователь системы (другой `auth.users.id` в Supabase), назначенный по UUID в `approval_user_id`. На текущем этапе апрувер задаётся вручную; в будущем расширяется через ролевую модель команды.
- **Approval_Threshold**: настройка оператора (`approval_required_above_n`), порог количества получателей, выше которого рассылка автоматически попадает в `pending_approval`.
- **Burst_Mode**: режим работы broadcast worker, активируемый `schedule_mode = "burst"`, при котором базовая пауза равна `delay_min` из `AntiBanConfig`, длинные паузы пропускаются, и `Adaptive_Throttle` авто-настраивается на 429 от GREEN API.
- **Burst_Recipient_Limit**: пользовательский предел числа получателей, при превышении которого `Burst_Mode` запрещён (защита от выстрела в ногу). Хранится как часть глобальной конфигурации оператора.
- **Auto_Snooze_Policy**: политика автоматической паузы рассылки при ухудшении метрик. Состоит из: `auto_snooze_enabled` (bool), `auto_snooze_threshold` (int — число инцидентов), `auto_snooze_minutes` (int — длительность паузы), `auto_snooze_window_minutes` (int — окно подсчёта инцидентов).
- **Incident_Counter**: счётчик инцидентов `429` / `zero_response` / `watchdog_trigger` из `IncidentLog`, отфильтрованный по конкретному `operation_run_id` и временному окну.
- **Notification_Channel**: канал доставки уведомления — `in_app` | `email` | `telegram`.
- **Notification_Event_Kind**: тип события рассылки, на который оператор может подписаться: `scheduled` | `started` | `paused` | `resumed` | `completed` | `failed` | `anti_ban_threshold` | `awaiting_approval` | `auto_snoozed`.
- **Notification_Preference**: подписка пользователя на пару (event_kind, channel) с булевым флагом `enabled`.
- **Notification_Dispatcher**: компонент Flask, вычитывающий неотправленные `Notification` записи и доставляющий их через соответствующие каналы.
- **Active_Broadcast_Control**: набор UI-кнопок и API-эндпойнтов на странице активной рассылки — `pause` / `resume` / `cancel` / `reschedule`.
- **Reschedule_Operation**: специальный case `Active_Broadcast_Control`, который при действии оператора создаёт новую `ScheduledBroadcast` для не отправленных получателей и сохраняет связь с предыдущей через `parent_broadcast_id`, а также наследует `follow_up_chain_id`.

## Requirements

### Requirement 1: Send Window Mode (окно отправки)

**User Story:** Как оператор, я хочу задать временное окно «отправить с 10:00 до 18:00 завтра», чтобы система сама равномерно распределила N сообщений внутри окна с соблюдением анти-бан настроек, тихих часов и календарных исключений.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL extend `ScheduledBroadcast.schedule_type` allowed values with `window` in addition to existing `exact` / `drip` / `recurring`.
2. WHEN the user creates a `ScheduledBroadcast` with `schedule_type = "window"`, THE Scheduling_Suite SHALL require fields `send_window_start` and `send_window_end` (both `DateTime`) and SHALL reject the request with HTTP 400 when either field is missing. WHERE `schedule_type` is any value other than `window`, THE Scheduling_Suite SHALL NOT validate `send_window_start` or `send_window_end` and SHALL accept those fields as `null` or absent.
3. IF `schedule_type = "window"` AND `send_window_end <= send_window_start`, THEN THE Scheduling_Suite SHALL return HTTP 400 with error code `WINDOW_INVALID_RANGE`.
4. IF `schedule_type = "window"` AND `send_window_start` is in the past relative to the server clock, THEN THE Scheduling_Suite SHALL return HTTP 400 with error code `WINDOW_IN_PAST`.
5. WHEN `Schedule_Mode_Engine` schedules a `window`-mode broadcast with N recipients, THE Schedule_Mode_Engine SHALL compute the per-message base interval as `(send_window_end - send_window_start) / N` seconds.
6. WHEN computing the actual send time of message at index `i` (0-based), THE Schedule_Mode_Engine SHALL apply jitter `± min(60 seconds, interval / 4)` derived from a deterministic pseudo-random sequence seeded by `ScheduledBroadcast.id`, so that two evaluations of the same broadcast produce the same schedule.
7. WHERE `quiet_hours_enabled = true` on the `ScheduledBroadcast`, THE Schedule_Mode_Engine SHALL skip any send time falling inside `[quiet_hours_start, quiet_hours_end)` and SHALL re-place the affected messages at the next valid timestamp inside the window.
8. WHERE one or more `CalendarException` records overlap with the window for the broadcast's `user_id`, THE Schedule_Mode_Engine SHALL exclude the overlapping intervals from the distribution and SHALL recompute remaining message slots only over non-excluded time.
9. IF after applying quiet hours and calendar exceptions the remaining usable time inside the window is shorter than `N * delay_min` (where `delay_min` is from `AntiBanConfig`), THEN THE Scheduling_Suite SHALL return HTTP 422 with error code `WINDOW_INSUFFICIENT_TIME` and SHALL NOT create the broadcast. THE `WINDOW_INSUFFICIENT_TIME` error SHALL take precedence over any other validation error in this requirement and SHALL be returned regardless of whether other validations would also have failed.
10. WHILE the broadcast is in status `running`, THE Broadcast_Worker SHALL never send a single message faster than the `delay_min` value from `AntiBanConfig`, even if the computed even distribution suggests a smaller interval.
11. WHEN the user previews a `window`-mode broadcast in the UI, THE Scheduling_Suite SHALL display the derived per-message interval in the form `«N сообщений / окно X часов = одно сообщение каждые Y минут»` where Y is the rounded mean interval after exclusions.

### Requirement 2: Smart-Time Mode (умное время отправки)

**User Story:** Как оператор, я хочу включить «умное время», чтобы каждый получатель получил сообщение в его персонально лучший час (когда он чаще читает и отвечает), без необходимости выставлять время вручную.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL extend `ScheduledBroadcast.schedule_type` allowed values with `smart_time` in addition to existing values.
2. WHEN the user creates a `ScheduledBroadcast` with `schedule_type = "smart_time"`, THE Scheduling_Suite SHALL require field `smart_time_window_days` (integer, range 1–14) and field `smart_time_top_n` (integer, range 1–6, default 3), and SHALL validate both values immediately on form submission and reject the request with HTTP 400 when either is out of range, before any scheduling computation runs. WHERE `schedule_type` is any value other than `smart_time`, THE Scheduling_Suite SHALL NOT validate `smart_time_window_days` or `smart_time_top_n` and SHALL accept those fields as `null` or absent.
3. WHEN computing `Activity_Histogram` for a recipient `(user_id, phone)`, THE Activity_Analyzer SHALL aggregate, over the last 30 days, the count per hour-of-day (0–23) of `Incoming` records with `sender = phone` and `user_id = user_id` plus `DeliveryStatus` records whose `message_id` belongs to a `Recipient` with `phone = phone` of a `Broadcast` belonging to `user_id` and `status` in `{read, played, viewed}`.
4. WHEN the `Activity_Histogram` for a recipient contains fewer than 5 events in total, THE Activity_Analyzer SHALL fallback to the operator's global `Activity_Histogram` computed across all the operator's broadcasts in the same 30-day window.
5. IF the operator's global `Activity_Histogram` also contains fewer than 5 events, THEN THE Activity_Analyzer SHALL fallback to a fixed default histogram peaked at hours `{10, 14, 19}` and SHALL mark the recipient's slot as `default_fallback` in the schedule plan.
6. WHEN producing `Smart_Time_Slot`s for a recipient, THE Activity_Analyzer SHALL select the top `smart_time_top_n` hours by descending count, breaking ties deterministically by ascending hour value.
7. WHEN distributing recipients across the `smart_time_window_days` calendar window, THE Schedule_Mode_Engine SHALL assign each recipient a target hour from that recipient's `Smart_Time_Slot`s using round-robin across the slots, so that the distribution is balanced across the recipient's preferred hours.
8. THE Schedule_Mode_Engine SHALL never schedule a `smart_time` send during quiet hours when `quiet_hours_enabled = true` and SHALL shift such sends to the next preferred hour outside quiet hours.
9. WHEN the hourly send count would exceed `AntiBanConfig.hourly_check_limit`, THE Schedule_Mode_Engine SHALL spill the overflow recipients to the next preferred hour or the next day within the window and SHALL log the overflow in `IncidentLog` with kind `smart_time_overflow`.
10. THE Smart_Time configuration object `{ schedule_type, smart_time_window_days, smart_time_top_n }` SHALL satisfy a JSON round-trip property: serializing to JSON and deserializing back SHALL produce a configuration object equivalent to the original (same keys, same values, same types).
11. THE Activity_Analyzer SHALL expose a read-only API endpoint `/api/recipient-activity?phone=...` returning the recipient's 24-bucket `Activity_Histogram` and the computed top-N slots so the UI can display a per-recipient preview.

### Requirement 3: A/B Time Test Mode (тест времени отправки)

**User Story:** Как оператор, я хочу проверить, в какое время суток моя аудитория лучше реагирует на сообщения, отправив один и тот же текст четырём подгруппам в разные часы и автоматически выбрав «выигравший» слот.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL introduce a new model `ABTimeTest` with fields `id`, `user_id`, `scheduled_broadcast_id`, `slots` (Json — array of integers in range 0–23), `winner_slot` (Int, nullable), `wait_hours` (Int, default 24), `status` (`running` | `waiting` | `completed` | `cancelled`), `started_at`, `completed_at`, distinct from the existing `ABTest` model that tests message variants.
2. WHEN the user creates an `ABTimeTest`, THE Scheduling_Suite SHALL require `slots` to contain between 2 and 4 distinct integer hours and SHALL return HTTP 400 with error code `ABTIME_SLOTS_INVALID` otherwise.
3. WHEN distributing recipients across `ABTimeTest.slots`, THE AB_Time_Test_Coordinator SHALL split the recipient list into equal groups using a deterministic shuffle seeded by `scheduled_broadcast_id`, with the difference between the largest and smallest group being at most 1.
4. WHEN the broadcast for an `ABTimeTest` runs, THE AB_Time_Test_Coordinator SHALL send each recipient at the wall-clock hour matching that recipient's assigned slot in the day defined by `ScheduledBroadcast.scheduled_for`.
5. WHEN `wait_hours` have elapsed since the last group has finished sending, THE AB_Time_Test_Coordinator SHALL compute, for each slot, the percentages `delivery_pct`, `read_pct`, `reply_pct` from `DeliveryStatus` and `Incoming` records and SHALL select as `winner_slot` the slot with the highest `reply_pct`, breaking ties by `read_pct` then by lowest hour.
6. WHEN a winner is selected, THE AB_Time_Test_Coordinator SHALL set `ABTimeTest.status = "completed"`, set `winner_slot`, and SHALL emit a `Notification` of kind `ab_time_completed` containing the winner.
7. WHERE the operator chooses to apply the winner, THE Scheduling_Suite SHALL provide an action that creates a new `ScheduleTemplate` with `config.recurring_hour = winner_slot` derived from the test result. THE apply-winner action SHALL be available ONLY when `ABTimeTest.status = "completed"` AND `winner_slot` is non-null; in any other state THE Scheduling_Suite SHALL hide the action in the UI and SHALL return HTTP 409 with error code `ABTIME_WINNER_NOT_READY` if the action endpoint is called.
8. THE AB_Time_Test_Coordinator SHALL NOT change the message text between slots; the message text SHALL be identical to the parent `ScheduledBroadcast.message`. Variation across slots is restricted to send time only.
9. THE AB_Time_Test configuration `{ slots: number[], wait_hours: number, scheduled_broadcast_id: number }` SHALL satisfy a JSON round-trip property: serializing to JSON and deserializing back SHALL produce an object equivalent to the original.
10. IF the operator attempts to attach both a message-variant `ABTest` (from `enhanced-broadcast-scheduling`) and a time-variant `ABTimeTest` to the same `ScheduledBroadcast`, THEN THE Scheduling_Suite SHALL return HTTP 409 with error code `ABTEST_KIND_CONFLICT`.

### Requirement 4: Visual Schedule Calendar (визуальный календарь)

**User Story:** Как оператор, я хочу видеть все мои запланированные рассылки на месячном календаре с цветовым кодированием по статусу и переносить их перетаскиванием на другой день, чтобы быстро управлять расписанием без открытия списка.

#### Acceptance Criteria

1. THE Visual_Schedule_Calendar SHALL render at the route `/dashboard/scheduled/calendar` and SHALL display all `ScheduledBroadcast` records belonging to the authenticated user grouped by the date of `next_run_at` (fallback to `scheduled_for` when `next_run_at` is null).
2. THE Visual_Schedule_Calendar SHALL provide two view modes — `month` (default, full-month grid) and `week` (7-column grid with hourly rows) — switchable via a control in the calendar header.
3. THE Visual_Schedule_Calendar SHALL render each `ScheduledBroadcast` as a `Schedule_Pill` colour-coded by `status`: `scheduled` → blue, `running` → green, `paused` → amber, `pending_approval` → violet, `completed` → grey, `failed` → red, `cancelled` → strikethrough grey.
4. WHEN the user hovers a `Schedule_Pill`, THE Visual_Schedule_Calendar SHALL show a tooltip containing `name`, `next_run_at` formatted as `HH:MM`, recipient count derived from `length(contacts)`, and `status`.
5. WHEN the user clicks a `Schedule_Pill`, THE Visual_Schedule_Calendar SHALL navigate to the broadcast detail page `/dashboard/scheduled/[id]`.
6. THE Visual_Schedule_Calendar SHALL render the current calendar day with a 2px ring in the accent colour and SHALL render days overlapping any of the user's `CalendarException` records with a dashed background fill.
7. WHEN the user drags a `Schedule_Pill` from one day cell and drops it on another day cell, THE Visual_Schedule_Calendar SHALL issue `PUT /api/scheduled-broadcasts/[id]` with the new `scheduled_for` set to the same wall-clock time on the target date and SHALL update the local view optimistically.
8. IF the drop target date is strictly before the current date, THEN THE Visual_Schedule_Calendar SHALL reject the drag with an inline error and SHALL NOT issue the API call.
9. IF the drop target date overlaps a `CalendarException` for the user, THEN THE Visual_Schedule_Calendar SHALL reject the drag with an inline error containing the exception name and SHALL NOT issue the API call.
10. IF the broadcast's current `status` is not in `{scheduled, paused, pending_approval}`, THEN THE Visual_Schedule_Calendar SHALL disable drag-and-drop on that pill and SHALL show a non-interactive cursor.
11. WHEN the API call from a drag-and-drop fails, THE Visual_Schedule_Calendar SHALL revert the optimistic update and SHALL display an inline error with the server-provided message.

### Requirement 5: PreFlight Preview (предпросмотр перед запуском)

**User Story:** Как оператор, я хочу видеть точное число получателей, ETA первого и последнего сообщения, мини-гистограмму распределения и список предупреждений до того, как нажму «Подтвердить и запланировать», чтобы избежать неожиданных переносов или нарушения лимитов.

#### Acceptance Criteria

1. THE PreFlight_Preview SHALL open as a modal between the moment the user clicks the schedule confirmation button and the moment the `ScheduledBroadcast` is created or updated on the server.
2. THE PreFlight_Engine SHALL compute the deduplicated recipient count from the contacts list, deduplicating by normalised phone number.
3. THE PreFlight_Engine SHALL compute the ETA of the first and the last message as `HH:MM` strings in the operator's `user_tz`, using the same scheduling formula that the `Schedule_Mode_Engine` uses for the selected `Schedule_Mode`.
4. THE PreFlight_Engine SHALL render a 24-bucket histogram showing how many messages will be sent in each hour of the day, derived from the same scheduling computation.
5. WHEN any recipient send time falls inside the broadcast's `quiet_hours_*`, THE PreFlight_Preview SHALL show a warning of kind `quiet_hours_postpone` listing the count of affected messages.
6. WHEN any computed send time overlaps a `CalendarException`, THE PreFlight_Preview SHALL show a warning of kind `calendar_exception_postpone` listing the exception name and the resulting postponement in days.
7. WHEN the projected daily send count exceeds `AntiBanConfig.daily_message_limit`, THE PreFlight_Preview SHALL show a warning of kind `daily_limit_exceeded` listing the overage in messages.
8. WHEN the selected `GreenInstance.status` is not `authorized`, THE PreFlight_Preview SHALL show a warning of kind `instance_unhealthy` containing the instance status.
9. THE PreFlight_Preview SHALL render two action buttons labelled `Подтвердить и запланировать` and `Отменить`.
10. WHEN the user clicks `Отменить`, THE PreFlight_Preview SHALL close without issuing any API call.
11. WHEN the user clicks `Подтвердить и запланировать`, THE PreFlight_Preview SHALL submit the schedule request to the appropriate Next.js API route and SHALL automatically close on a successful create or update response from the server, and SHALL display the server error inline on failure without closing.
12. THE PreFlight_Engine SHALL produce the warning list and the histogram synchronously in the browser without server round-trips, fully completing the computation within 300 ms for a contact list of up to 5000 entries; partial results that miss the deadline SHALL NOT be displayed.

### Requirement 6: Snooze (быстрый перенос)

**User Story:** Как оператор, я хочу одной кнопкой отложить запланированную рассылку на «+1 час», «+1 день», «+неделю» или «следующий рабочий день», чтобы оперативно реагировать на изменение планов.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL expose endpoint `POST /api/scheduled-broadcasts/[id]/snooze` accepting body `{ preset: "1h" | "1d" | "7d" | "next_business_day" | "custom", custom_minutes?: number }`.
2. WHEN the snooze endpoint is called, THE Scheduling_Suite SHALL increase the existing `ScheduledBroadcast.scheduled_for` and `next_run_at` by the offset implied by `preset` (or by `custom_minutes` minutes when `preset = "custom"`) without creating a new record.
3. WHERE `preset = "next_business_day"`, THE Scheduling_Suite SHALL roll `scheduled_for` to the next calendar day that is Monday–Friday in `ScheduledBroadcast.user_tz` and is not within any of the user's `CalendarException` records, preserving the original wall-clock time of day.
4. WHERE `preset = "custom"` and `custom_minutes` is missing, negative, zero, or greater than 43200 (30 days), THE Scheduling_Suite SHALL return HTTP 400 with error code `SNOOZE_CUSTOM_INVALID`.
5. IF `ScheduledBroadcast.status` is not in `{scheduled, paused, pending_approval}`, THEN THE Scheduling_Suite SHALL return HTTP 409 with error code `SNOOZE_INVALID_STATUS`. In particular, broadcasts already in `completed`, `failed`, `cancelled`, or `rejected` status SHALL be rejected because once a broadcast has reached a terminal state it cannot be snoozed.
6. WHEN the new `scheduled_for` falls inside `quiet_hours_*` AND `quiet_hours_enabled = true`, THE Scheduling_Suite SHALL further roll forward to the first instant outside quiet hours and SHALL include the adjusted timestamp in the response body.
7. WHEN the snooze succeeds, THE Scheduling_Suite SHALL emit a `Notification` of kind `scheduled` (re-scheduled) to all subscribed channels for the operator.
8. IF the snooze operation fails for any reason (validation error, invalid status, persistence failure), THEN THE Scheduling_Suite SHALL NOT emit any `Notification` for that snooze attempt.
9. THE UI SHALL render the Snooze action as a single button with a dropdown listing the four presets plus `Своё значение` on every list view that displays scheduled broadcasts.

### Requirement 7: Approval Workflow (одобрение перед отправкой)

**User Story:** Как руководитель, я хочу настроить «требовать одобрения для рассылок более N получателей» и назначить апрувера, чтобы крупные рассылки не уходили без проверки.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL extend `ScheduledBroadcast` with the fields `approval_required` (Boolean, default false), `approval_status` (`none` | `pending` | `approved` | `rejected`, default `none`), `approval_user_id` (UUID, nullable), `approved_at` (DateTime, nullable), `rejection_reason` (Text, nullable).
2. THE Scheduling_Suite SHALL extend the operator-level configuration with the field `approval_required_above_n` (Int, default 0 meaning disabled).
3. WHEN a `ScheduledBroadcast` is created and `length(contacts) > approval_required_above_n` AND `approval_required_above_n > 0`, THE Scheduling_Suite SHALL set `approval_required = true`, `approval_status = "pending"`, and `status = "pending_approval"` automatically.
4. WHEN a `ScheduledBroadcast` has `status = "pending_approval"`, THE Schedule_Mode_Engine SHALL NOT dispatch any messages for that broadcast even if `next_run_at` has been reached.
5. THE Scheduling_Suite SHALL accept `approval_user_id` either as a UUID of an existing user OR as an email string, in which case the server SHALL resolve the email to a UUID via Supabase auth lookup; if the email is not resolvable, THE Scheduling_Suite SHALL return HTTP 422 with error code `APPROVAL_USER_NOT_FOUND`.
6. WHEN a broadcast enters `pending_approval`, THE Scheduling_Suite SHALL create a `Notification` of kind `awaiting_approval` for the resolved `approval_user_id` user.
7. THE Scheduling_Suite SHALL expose endpoint `POST /api/scheduled-broadcasts/[id]/approve` that, when called by a user whose UUID matches `approval_user_id`, sets `approval_status = "approved"`, `approved_at = now()`, `status = "scheduled"` so that the regular scheduler tick can dispatch the broadcast.
8. THE Scheduling_Suite SHALL expose endpoint `POST /api/scheduled-broadcasts/[id]/reject` that, when called by the resolved approver and given a non-empty `rejection_reason` in the body, sets `approval_status = "rejected"`, `status = "rejected"`, and `rejection_reason` accordingly.
9. IF a user other than the resolved approver attempts to call `approve` or `reject`, THEN THE Scheduling_Suite SHALL return HTTP 403 with error code `APPROVAL_FORBIDDEN` and SHALL NOT modify the broadcast in any way.
10. THE Scheduling_Suite SHALL expose a list view at `/dashboard/scheduled/awaiting-approval` showing only broadcasts where the current user is the resolved approver and `approval_status = "pending"`.
11. NOTE — расширение модели команд и ролевой модели апрувера выходит за рамки этой спеки и будет рассмотрено в отдельной фиче; на текущем этапе апрувер задаётся явно UUID или email.

### Requirement 8: Burst Mode (взрывной режим)

**User Story:** Как оператор, я хочу режим максимально быстрой отправки в пределах текущих анти-бан лимитов с авто-настройкой, чтобы оперативные уведомления уходили без ручной перенастройки задержек.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL extend `ScheduledBroadcast.schedule_type` allowed values with `burst` in addition to existing values.
2. WHEN a `ScheduledBroadcast` has `schedule_type = "burst"`, THE Broadcast_Worker SHALL set the per-message delay to the value of `AntiBanConfig.delay_min` ignoring `AntiBanConfig.delay_max` and ignoring jitter.
3. WHEN a `ScheduledBroadcast` has `schedule_type = "burst"`, THE Broadcast_Worker SHALL skip every long pause that would normally be inserted by `AntiBanConfig.long_pause_every_n` and SHALL NOT call the long-pause routine.
4. WHILE running in `burst` mode, THE Broadcast_Worker SHALL enable `Adaptive_Throttle` regardless of the `adaptive_throttle` flag value on the broadcast, so that 429 responses still trigger gradual back-off as defined in `enhanced-broadcast-scheduling/design.md`.
5. WHEN `Adaptive_Throttle` raises the delay due to 429 responses in `burst` mode, THE Broadcast_Worker SHALL gradually decay the delay back toward `delay_min` once consecutive successful sends are observed; the recovery shape is governed by the existing `Adaptive_Throttle` state machine and is not redefined here. WHEN a 429 response is received in `burst` mode, THE Broadcast_Worker SHALL begin the recovery toward `delay_min` immediately on the next iteration of the `Adaptive_Throttle` state machine and SHALL NOT wait for any minimum number of consecutive successful sends before starting recovery.
6. THE Scheduling_Suite SHALL define an operator-level setting `burst_recipient_limit` (Int, default 100) representing `Burst_Recipient_Limit`.
7. IF a user creates a `ScheduledBroadcast` with `schedule_type = "burst"` and `length(contacts) > burst_recipient_limit`, THEN THE Scheduling_Suite SHALL return HTTP 422 with error code `BURST_RECIPIENT_LIMIT_EXCEEDED`.
8. THE Scheduling_Suite SHALL forbid combining `schedule_type = "burst"` with `quiet_hours_enabled = true`, returning HTTP 400 with error code `BURST_INCOMPATIBLE_QUIET_HOURS`.
9. THE Scheduling_Suite SHALL forbid combining `schedule_type = "burst"` with a non-null `follow_up_chain_id` or `ab_test_id` or `ab_time_test_id`, returning HTTP 400 with error code `BURST_INCOMPATIBLE_EXTENSION`.

### Requirement 9: Auto-Snooze on Incident (автопауза при инциденте анти-бан)

**User Story:** Как оператор, я хочу, чтобы рассылка автоматически вставала на паузу при срабатывании watchdog или накоплении инцидентов 429, продолжалась через заданное время с того же места и присылала мне уведомление, чтобы избежать блокировки инстанса.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL extend `ScheduledBroadcast` with the fields `auto_snooze_enabled` (Boolean, default false), `auto_snooze_threshold` (Int, default 3, range 1–20), `auto_snooze_minutes` (Int, default 30, range 5–1440), `auto_snooze_window_minutes` (Int, default 15, range 1–120).
2. WHILE a `ScheduledBroadcast` is in status `running` AND `auto_snooze_enabled = true`, THE Auto_Snooze_Watcher SHALL count over the last `auto_snooze_window_minutes` minutes the number of `IncidentLog` records belonging to the broadcast's `operation_run_id` whose `kind` is in `{rate_limit_429, zero_response, watchdog_trigger, throttle_paused}`.
3. WHEN the count from criterion 9.2 reaches `auto_snooze_threshold`, THE Auto_Snooze_Watcher SHALL set `ScheduledBroadcast.status = "paused"` and SHALL set `next_run_at = now() + auto_snooze_minutes * 60 seconds`.
4. WHEN `next_run_at` is reached on an auto-snoozed broadcast, THE Schedule_Mode_Engine SHALL resume the broadcast for the not-yet-sent recipients, preserving the existing `operation_run_id` so that already-sent recipients are not re-sent.
5. WHEN the Auto_Snooze_Watcher pauses a broadcast, THE Auto_Snooze_Watcher SHALL emit a `Notification` of kind `auto_snoozed` containing the incident count, the threshold, and the resume time. IF the `Notification` dispatch attempt itself fails, THEN THE Auto_Snooze_Watcher SHALL still apply the pause to the broadcast (status change, `next_run_at` update) and SHALL NOT roll back the pause; broadcast protection is the higher-priority outcome and the failed notification SHALL be retried by the `Notification_Dispatcher` per requirement 10.11.
6. IF a single broadcast is auto-snoozed more than 3 times in a single run, THEN THE Auto_Snooze_Watcher SHALL escalate by setting `status = "failed"` with `last_error = "AUTO_SNOOZE_REPEATED"` and SHALL emit a `Notification` of kind `failed`. THE resulting `failed` status SHALL be permanent for that broadcast: THE Scheduling_Suite SHALL NOT expose any manual retry endpoint or UI control to resume an auto-snooze-failed broadcast, and the operator MUST create a new `ScheduledBroadcast` to continue sending to the remaining recipients.
7. THE Auto_Snooze_Watcher SHALL NOT pause broadcasts whose `auto_snooze_enabled = false`, even when incidents accumulate.
8. THE Auto_Snooze_Watcher SHALL only count incidents that are scoped to the broadcast's own `operation_run_id` and SHALL NOT count incidents from other operations of the same user.

### Requirement 10: Notifications (уведомления о статусе)

**User Story:** Как оператор, я хочу получать уведомления о ключевых событиях моих рассылок (запланирована, стартовала, на паузе, завершена, упала, требует одобрения, достигла порога анти-бана) по выбранным каналам — in-app, email, Telegram — и настраивать подписки на странице «Уведомления».

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL introduce a model `Notification` with fields `id`, `user_id`, `kind` (one of `Notification_Event_Kind`), `payload` (Json), `read_at` (DateTime, nullable), `created_at`.
2. THE Scheduling_Suite SHALL introduce a model `NotificationPreference` with fields `id`, `user_id`, `event_kind` (one of `Notification_Event_Kind`), `channel` (one of `Notification_Channel`), `enabled` (Boolean), with a unique constraint on `(user_id, event_kind, channel)`.
3. WHEN a notification-emitting subsystem (Schedule_Mode_Engine, Broadcast_Worker, Auto_Snooze_Watcher, Approval_Coordinator, AB_Time_Test_Coordinator) decides to notify the user, THE subsystem SHALL create a single `Notification` row with the appropriate `kind` and `payload`.
4. THE Notification_Dispatcher SHALL run inside the Flask scheduler tick, picking up unread or unsent `Notification` rows and dispatching each to every channel where the user's `NotificationPreference.enabled = true` for that `event_kind` was true at the moment the `Notification` row was CREATED. THE Notification_Dispatcher SHALL use a snapshot of preferences captured at notification creation time and SHALL NOT re-evaluate `NotificationPreference` at dispatch time, so disabling a preference after a `Notification` row exists SHALL NOT prevent that already-created notification from being dispatched.
5. THE Notification_Dispatcher SHALL deliver `in_app` notifications by exposing them through `GET /api/notifications` and SHALL render an unread-count badge in the dashboard header.
6. WHERE `Notification_Channel = "email"` is enabled, THE Notification_Dispatcher SHALL attempt to send the email via the configured provider regardless of whether environment configuration is present; failures SHALL flow through the retry mechanism in criterion 10.11. WHERE no email provider is configured, THE Notification_Dispatcher SHALL log a single startup warning per process start to make the misconfiguration visible without suppressing dispatch attempts.
7. WHERE `Notification_Channel = "telegram"` is enabled and the user has stored a Telegram bot token plus chat id in their profile, THE Notification_Dispatcher SHALL send the message through that bot.
8. THE supported `Notification_Event_Kind` values SHALL be exactly the set `{scheduled, started, paused, resumed, completed, failed, anti_ban_threshold, awaiting_approval, ab_time_completed, auto_snoozed}`.
9. THE Scheduling_Suite SHALL expose endpoint `POST /api/notifications/[id]/read` that sets `Notification.read_at = now()` for notifications belonging to the calling user.
10. THE Scheduling_Suite SHALL expose CRUD endpoints under `/api/notification-preferences` allowing the user to read and update their `NotificationPreference` rows for any `(event_kind, channel)` pair.
11. THE Notification_Dispatcher SHALL retry failed deliveries up to 3 times with exponential back-off (15 s, 60 s, 240 s) and SHALL mark a notification as `dispatch_failed` ONLY after all 3 retries have been exhausted, recording the failure reason in `payload.dispatch_error`. Failures of intermediate retry attempts SHALL NOT cause the notification to be marked `dispatch_failed`.
12. THE Notification_Dispatcher SHALL NOT send the same `Notification` row to the same `channel` more than once on success; the in-flight bookkeeping is internal to the dispatcher and is not part of `NotificationPreference`.

### Requirement 11: Active Broadcast Controls (управление активной рассылкой)

**User Story:** Как оператор, я хочу на странице активной рассылки одной кнопкой поставить её на паузу, возобновить, отменить или перепланировать остаток получателей на потом, чтобы реагировать на ситуацию без перезапуска с нуля.

#### Acceptance Criteria

1. THE Scheduling_Suite SHALL expose four endpoints under `/api/scheduled-broadcasts/[id]`: `POST .../pause`, `POST .../resume`, `POST .../cancel`, `POST .../reschedule`.
2. WHEN `POST .../pause` is called and `ScheduledBroadcast.status = "running"`, THE Scheduling_Suite SHALL set `status = "paused"`, leave `next_run_at` and `operation_run_id` intact, and emit a `Notification` of kind `paused`.
3. WHEN `POST .../resume` is called and `ScheduledBroadcast.status = "paused"`, THE Scheduling_Suite SHALL set `status = "running"` so the next scheduler tick continues from the same `last_processed_index` of the linked `OperationRun` without re-sending already-sent recipients, and SHALL emit a `Notification` of kind `resumed`.
4. WHEN `POST .../cancel` is called and `ScheduledBroadcast.status` is in `{scheduled, paused, running, pending_approval}`, THE Scheduling_Suite SHALL set `status = "cancelled"`, set `last_run_at = now()`, and stop the worker for that broadcast.
5. WHEN `POST .../reschedule` is called with body `{ scheduled_for: ISOString }` and the broadcast is in `{running, paused}`, THE Reschedule_Operation SHALL: (a) snapshot the list of recipients still in `pending` status from the linked `Recipient` rows, (b) create a new `ScheduledBroadcast` with `contacts = pending_recipients`, `scheduled_for = body.scheduled_for`, copying `message`, `personalized_messages`, `use_typing`, `delay_seconds`, `file_url`, `file_name`, `instance_id`, `adaptive_throttle`, `quiet_hours_*`, `respect_recipient_tz`, `user_tz`, and (c) set the original broadcast `status = "completed"` if there were already-sent recipients or `status = "cancelled"` if there were none.
6. WHEN a Reschedule_Operation creates a new `ScheduledBroadcast`, THE Scheduling_Suite SHALL link the new broadcast to the original via a new field `parent_broadcast_id` (BigInt, nullable) on `ScheduledBroadcast`.
7. WHEN the original broadcast had a non-null `follow_up_chain_id`, THE Reschedule_Operation SHALL inherit that `follow_up_chain_id` onto the new `ScheduledBroadcast` so existing follow-up chains stay attached to the same logical broadcast. THE inherited `follow_up_chain_id` SHALL be the exact same value as on the original `ScheduledBroadcast`, copied by value without any transformation, regeneration, or wrapping.
8. IF `POST .../reschedule` is called with `scheduled_for` less than or equal to the current server time, THEN THE Scheduling_Suite SHALL treat the value as in the past and return HTTP 400 with error code `RESCHEDULE_IN_PAST`.
9. IF `POST .../reschedule` is called and `ScheduledBroadcast.status` is not in `{running, paused}`, THEN THE Scheduling_Suite SHALL reject the request with HTTP 409 and error code `RESCHEDULE_INVALID_STATUS` and SHALL NOT create a new broadcast.
10. THE UI SHALL render the four controls as buttons on the broadcast detail page `/dashboard/scheduled/[id]` and SHALL hide each control whose preconditions on `status` are not met.
11. WHILE the broadcast is in `pending_approval`, THE UI SHALL render only the `cancel` and `snooze` controls; `pause`, `resume`, `reschedule` SHALL be hidden.
