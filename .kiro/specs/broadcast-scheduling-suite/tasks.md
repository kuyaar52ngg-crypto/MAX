# Implementation Plan: Broadcast Scheduling Suite

## Overview

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

Реализация делится на 11 крупных этапов: установка зависимостей → схема БД → backend distribution engines → backend daemon workers → broadcast worker hook → Next.js API routes → frontend libraries → frontend hooks → frontend компоненты → page routes → wire-up → e2e. После основных этапов идёт финальный чекпойнт. Property-тесты P1–P24 размещены **рядом** с соответствующими реализациями (Python — pytest+hypothesis в `tests/scheduling/`, TypeScript — fast-check в `frontend/src/__tests__/scheduling/properties/`). Cross-language equivalence test для PreFlight живёт отдельной задачей.

Стек: Python/Flask для backend (`scheduling/` рядом с `anti_ban/`), Next.js + TypeScript для frontend, PostgreSQL через Prisma. Drag-and-drop — `@dnd-kit/core`. Property-tests — `hypothesis` и `fast-check`.

## Tasks

- [x] 1.0 Install new dependencies for the suite
  - Frontend: добавить `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (для `Visual_Schedule_Calendar` drag-and-drop), `nodemailer` и `@types/nodemailer` (для email-канала уведомлений), `fast-check` в `devDependencies` (если ещё нет) — изменить `frontend/package.json` и запустить `npm install`
  - Backend: добавить `httpx` (для прямого вызова Telegram Bot API) и `hypothesis` (devDeps, property-tests) в `requirements.txt`
  - Проверить, что `python-telegram-bot` НЕ устанавливается — используем сырые HTTP вызовы через `httpx` для минимизации surface area
  - _Requirements: 4.7, 10.6, 10.7_

- [x] 1. Database schema and Prisma migration

  - [x] 1.1 Extend `ScheduledBroadcast` Prisma model and add 4 new models
    - Открыть `frontend/prisma/schema.prisma` и расширить `ScheduledBroadcast` колонками: `send_window_start`, `send_window_end`, `smart_time_window_days`, `smart_time_top_n`, `ab_time_test_id`, `auto_snooze_enabled`, `auto_snooze_threshold`, `auto_snooze_minutes`, `auto_snooze_window_minutes`, `auto_snooze_count`, `approval_required`, `approval_status`, `approval_user_id`, `approved_at`, `rejection_reason`, `parent_broadcast_id`
    - Добавить индексы `(approval_user_id, approval_status)` и `(parent_broadcast_id)`
    - Добавить модели `ABTimeTest`, `ABTimeTestRecipient`, `Notification`, `NotificationPreference` со всеми полями и индексами из design.md (раздел Data Models)
    - Расширить `Profile` полями `approval_required_above_n`, `burst_recipient_limit`, `telegram_bot_token` (encrypted), `telegram_chat_id`
    - _Requirements: 1.1, 2.1, 3.1, 7.1, 7.2, 8.6, 9.1, 10.1, 10.2, 11.6_

  - [x] 1.2 Generate SQL migration `20260601_broadcast_scheduling_suite/migration.sql`
    - Создать файл `frontend/prisma/migrations/20260601_broadcast_scheduling_suite/migration.sql` со всеми ALTER TABLE и CREATE TABLE согласно design.md (раздел SQL миграция)
    - Все новые колонки с DEFAULT или NULL-able, чтобы миграция была non-destructive
    - Запустить `npx prisma migrate dev` локально и убедиться, что прогоняется чисто
    - _Requirements: 1.1, 2.1, 3.1, 7.1, 7.2, 9.1, 10.1, 10.2, 11.6_

  - [ ]* 1.3 Write smoke test for migration outcome
    - `frontend/src/__tests__/scheduling/integration/migration.test.ts`: проверить, что после `prisma migrate` все 4 новые таблицы существуют, у `scheduled_broadcasts` есть все ожидаемые новые колонки с правильными дефолтами
    - _Requirements: 1.1, 7.1, 9.1, 10.1, 10.2_

- [x] 2. Checkpoint after database schema
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Backend (Python/Flask) — Activity Analyzer and PreFlight calc

  - [x] 3.1 Create `scheduling/` Python package skeleton
    - Создать `scheduling/__init__.py`, `scheduling/types.py` (dataclass `ScheduledSend`, `SchedulingError`, type aliases), общий `scheduling/logger.py` (`logging.getLogger("scheduling")`)
    - Подцепить пакет к `app.py` (импорт без побочных эффектов на этом этапе)
    - _Requirements: 1.1, 2.1, 3.1, 8.1_

  - [x] 3.2 Implement `Activity_Analyzer` with 1-hour LRU cache
    - Создать `scheduling/activity_analyzer.py` с классом `ActivityAnalyzer`: метод `compute_histogram(user_id, phone)` агрегирует `Incoming` (sender=phone, last 30d) + `DeliveryStatus` (joined to Recipient.phone, status ∈ {read, played, viewed}) → 24-bucket массив; кэш `dict[(user_id, phone), (timestamp, list[int])]` c TTL 3600s
    - Метод `top_slots(user_id, phone, top_n) -> tuple[list[int], str]` — fallback chain: recipient hist >= 5 → "recipient"; иначе operator-global hist >= 5 → "operator_global"; иначе фиксированный default peaked at {10,14,19} → "default_fallback"
    - Tie-break при выборе top-N: descending count, ascending hour value (Req 2.6)
    - _Requirements: 2.3, 2.4, 2.5, 2.6_

  - [ ]* 3.3 Property test P7: Smart-Time fallback chain is total
    - `tests/scheduling/test_activity_analyzer_property.py` (pytest + hypothesis), генераторы для history sizes 0..1000 для recipient и operator-global
    - **Property 7: Smart-Time fallback chain is total**
    - **Validates: Requirements 2.4, 2.5, 2.6**

  - [x] 3.4 Implement `preflight_calc.py` (server-side mirror)
    - Создать `scheduling/preflight_calc.py` с `run_preflight(draft, anti_ban, exceptions, instance, activity_analyzer) -> PreFlightServerResult`: дедупликация контактов, расчёт `first_send_eta`/`last_send_eta`/24-bucket histogram через те же distribution-функции, что и `Schedule_Mode_Engine`
    - Функция `validate_window(...)` возвращающая `WINDOW_INSUFFICIENT_TIME` когда `usable_seconds < N * delay_min` — этот error имеет приоритет над всеми другими window-валидациями
    - Warnings: `quiet_hours_postpone`, `calendar_exception_postpone`, `daily_limit_exceeded`, `instance_unhealthy`
    - _Requirements: 1.9, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ]* 3.5 Property test P6: WINDOW_INSUFFICIENT_TIME takes precedence
    - `tests/scheduling/test_preflight_calc_property.py`, генератор drafts которые провалили бы и 1.2/1.3/1.4 и 1.9 одновременно — assert что возвращается именно `WINDOW_INSUFFICIENT_TIME`
    - **Property 6: WINDOW_INSUFFICIENT_TIME takes precedence**
    - **Validates: Requirements 1.9**

- [x] 4. Backend (Python/Flask) — Schedule Mode Engine and strategies

  - [x] 4.1 Implement `Schedule_Mode_Engine` dispatcher
    - `scheduling/engine.py`: `class ScheduleModeStrategy(Protocol)`, `class ScheduleModeEngine` со словарём `{schedule_type → strategy}`, методами `register(schedule_type, strategy)`, `distribute(broadcast, anti_ban, exceptions)`, `dispatch_due()` (выбирает `schedule_type ∈ {window, smart_time, ab_time, burst}` AND `status='scheduled'` AND `next_run_at <= now` AND `approval_status != 'pending'`)
    - В `dispatch_due()` явно пропускать broadcasts со `status='pending_approval'` (Req 7.4)
    - Each-iteration `try/except` с логированием — exception в одной рассылке не валит весь tick
    - _Requirements: 1.1, 2.1, 3.1, 7.4, 8.1_

  - [ ]* 4.2 Property test P13: Approval bypass is impossible
    - `tests/scheduling/test_engine_property.py`: hypothesis-генератор `(broadcast in pending_approval, wall_clock_time)` — assert что `dispatch_due()` не enqueue'ит ни одного send и не меняет `Recipient.status`
    - **Property 13: Approval bypass is impossible**
    - **Validates: Requirements 7.4**

  - [x] 4.3 Implement `WindowEngine.distribute(...)` as a pure function
    - `scheduling/window_engine.py`: `class WindowEngine` с методом `distribute(broadcast, anti_ban, exceptions) -> list[ScheduledSend]`
    - `_compute_usable_intervals(start, end, qh_*, tz, exceptions)` — список `(datetime, datetime)` с вычетом quiet hours и `CalendarException`
    - Жёсткая проверка `usable_seconds < N * anti_ban.delay_min` → `raise SchedulingError("WINDOW_INSUFFICIENT_TIME")`
    - Базовый interval `usable_seconds / N`, jitter `± min(60s, interval/4)` через seeded RNG `seeded_rng(broadcast.id)` (детерминизм)
    - `_project_offset_into_intervals(...)` — пройтись по usable интервалам, потребив offset_seconds, вернуть wall-clock
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [ ]* 4.4 Property test P1: Window distribution covers all recipients
    - `tests/scheduling/test_window_engine_property.py`: hypothesis-генератор `(start, end, N, delay_min)` где `usable_seconds >= N * delay_min` — assert ровно N уникальных получателей в результате
    - **Property 1: Window distribution covers all recipients**
    - **Validates: Requirements 1.5**

  - [ ]* 4.5 Property test P2: Window distribution respects delay_min
    - `tests/scheduling/test_window_engine_property.py`: для любого успешного output размер >= 2, sorted by `send_at`, разница соседних `send_at[i+1] - send_at[i] >= delay_min`
    - **Property 2: Window distribution respects delay_min**
    - **Validates: Requirements 1.10**

  - [x] 4.6 Implement `SmartTimeEngine.distribute(...)`
    - `scheduling/smart_time_engine.py`: depends on `ActivityAnalyzer`. Per recipient — `top_slots(user_id, phone, smart_time_top_n)`, round-robin pointer, `_place_in_window(target_hour, anchor, window_days, hourly_limit, per_hour_count, qh_*, exceptions)`
    - При нарушении `hourly_check_limit` — spill на следующий preferred hour или следующий день, INSERT `IncidentLog` kind=`smart_time_overflow`
    - При попадании в quiet hours — сдвиг на следующий valid hour
    - Метаданные: `{"slot": target_hour, "fallback": source}`
    - _Requirements: 2.3, 2.7, 2.8, 2.9_

  - [x] 4.7 Implement `ABTimeEngine.distribute(...)` and `compute_winner(...)`
    - `scheduling/ab_time_engine.py`: `distribute` берёт `ABTimeTest` по broadcast_id, делает `deterministic_split(contacts, len(slots), seed=broadcast.id)` — max-min <= 1; для каждой группы все sends на час из `slots[idx]` в день `broadcast.scheduled_for`; upsert `ABTimeTestRecipient`
    - `compute_winner(test_id)`: агрегация `DeliveryStatus` + `Incoming` per slot, выбор по max `reply_pct` → ties по max `read_pct` → ties по min hour value
    - `compute_winner` возвращает None если test ещё в `running`/`waiting`
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.8_

  - [ ]* 4.8 Property test P3: Schedule_Mode_Engine determinism by broadcast id
    - `tests/scheduling/test_engine_property.py`: для режимов window/smart_time/ab_time два вызова `distribute` с одинаковыми инпутами — strict equality результата
    - **Property 3: Schedule_Mode_Engine determinism by broadcast id**
    - **Validates: Requirements 1.6, 3.3**

  - [ ]* 4.9 Property test P4: No scheduled send overlaps quiet hours
    - `tests/scheduling/test_engine_property.py`: hypothesis-генератор `(qh_start, qh_end, broadcast in mode m ∈ {window, smart_time, ab_time})` — assert no `send_at ∈ [qh_start, qh_end)` в `user_tz`
    - **Property 4: No scheduled send overlaps quiet hours**
    - **Validates: Requirements 1.7, 2.8**

  - [ ]* 4.10 Property test P5: No scheduled send overlaps a CalendarException
    - `tests/scheduling/test_engine_property.py`: генератор `(exceptions[], broadcast)` — assert no `send_at` ∈ exception range (включая weekly/monthly/yearly recurring expansions)
    - **Property 5: No scheduled send overlaps a CalendarException**
    - **Validates: Requirements 1.8, 2.8**

  - [ ]* 4.11 Property test P9: AB Time recipient distribution is balanced and deterministic
    - `tests/scheduling/test_ab_time_engine_property.py`: hypothesis-генератор `(T, slots[2..4])` — assert `max_size − min_size <= 1`, каждый recipient в одной группе, повторный вызов с тем же seed — идентичные группы
    - **Property 9: AB Time recipient distribution is balanced and deterministic**
    - **Validates: Requirements 3.3, 3.4**

  - [ ]* 4.12 Property test P10: AB Time winner selection rule
    - `tests/scheduling/test_ab_time_engine_property.py`: hypothesis-генератор `{slot_hour → (delivery_pct, read_pct, reply_pct)}` — assert winner = max reply_pct, ties → max read_pct, ties → min hour
    - **Property 10: AB Time winner selection rule**
    - **Validates: Requirements 3.5**

  - [x] 4.13 Implement `BurstEngine` distribute and `delay_for`
    - `scheduling/burst_engine.py`: `distribute()` возвращает все sends с одним `anchor` send_at и `metadata={"burst": True, "index": i}` — фактический schedule делает worker
    - `delay_for(message_index, anti_ban, throttle_state) -> float`: `normal → anti_ban.delay_min`, `slowed → delay_min * 1.5`, `paused` — не вызывается (worker сам ставит на паузу)
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

  - [ ]* 4.14 Property test P15: Burst respects delay_min
    - `tests/scheduling/test_burst_engine_property.py`: hypothesis-генератор `(AntiBanConfig, throttle_state ∈ {normal, slowed}, message_index)` — assert `delay_for(...) >= anti_ban.delay_min`
    - **Property 15: Burst respects delay_min**
    - **Validates: Requirements 8.2, 8.3**

- [x] 5. Checkpoint after distribution engines
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Backend (Python/Flask) — Daemon workers (Auto-Snooze, Notifications, Reschedule)

  - [x] 6.1 Implement `Auto_Snooze_Watcher` daemon thread
    - `scheduling/auto_snooze_watcher.py`: класс `AutoSnoozeWatcher` с `start()`/`stop()`, daemon thread tick=30s
    - `_tick()`: SELECT broadcasts со `status='running'` AND `auto_snooze_enabled=true`; per broadcast — `_count_incidents(operation_run_id, kinds={rate_limit_429, zero_response, watchdog_trigger, throttle_paused}, window_minutes)` со строгой фильтрацией только по своему `operation_run_id`
    - Если `count >= auto_snooze_threshold`: транзакционно `auto_snooze_count += 1`, если `> 3` → `status=failed`, `last_error="AUTO_SNOOZE_REPEATED"`, иначе `status=paused`, `next_run_at=now + auto_snooze_minutes*60`
    - Создание `Notification` (kind=`auto_snoozed` или `failed`) — best-effort: failure dispatcher'а не откатывает pause (Req 9.5)
    - _Requirements: 9.2, 9.3, 9.5, 9.6, 9.7, 9.8_

  - [ ]* 6.2 Property test P17: Auto-Snooze counts only same-run incidents
    - `tests/scheduling/test_auto_snooze_property.py`: hypothesis-генератор mixed `IncidentLog` records с разными `operation_run_id` — assert count == ровно записей с совпадающим `operation_run_id` AND правильным kind AND в окне
    - **Property 17: Auto-Snooze counts only same-run incidents**
    - **Validates: Requirements 9.8**

  - [ ]* 6.3 Property test P18: Auto-Snooze escalation is permanent
    - `tests/scheduling/test_auto_snooze_property.py`: симуляция последовательности 4+ incident bursts — после 3-го snooze любой следующий триггер ставит `status=failed`, попытки `POST /resume` не возвращают broadcast в `running`
    - **Property 18: Auto-Snooze escalation is permanent**
    - **Validates: Requirements 9.6**

  - [x] 6.4 Implement `Notification_Dispatcher` daemon thread
    - `scheduling/notification_dispatcher.py`: класс `NotificationDispatcher` с tick=5s, `BACKOFF_SECONDS=[15, 60, 240]`, `MAX_ATTEMPTS=3`
    - `_tick()`: SELECT pending notifications, читает `preference_snapshot` (НЕ live `NotificationPreference`), per channel — `_send`. После успеха пишет в `dispatched_channels`. Не дублирует канал после первого 200 OK (Req 10.12)
    - `_send_email`: HTTP relay в Next.js `/api/notifications/email-relay` (см. этап 7)
    - `_send_telegram`: `httpx.post(bot_api_url/sendMessage, json={chat_id, text})` с decrypt токена через `INSTANCE_ENCRYPTION_KEY`
    - `_send_in_app`: no-op (запись в `Notification` уже доступна через GET `/api/notifications`)
    - После 3 неудачных попыток (с backoff 15s/60s/240s) — `dispatch_status='failed'`, `dispatch_error` записан
    - При отсутствии email-провайдера — log warning один раз per process start (Req 10.6)
    - _Requirements: 10.4, 10.5, 10.6, 10.7, 10.11, 10.12_

  - [ ]* 6.5 Property test P19: Notification snapshot semantics
    - `tests/scheduling/test_notification_dispatcher_property.py`: hypothesis-генератор `(snapshot at T0, current_pref at T1)` — assert dispatcher честен к `preference_snapshot[kind][channel]` независимо от текущих `NotificationPreference`
    - **Property 19: Notification snapshot semantics**
    - **Validates: Requirements 10.4**

  - [ ]* 6.6 Property test P20: Notification dispatch_failed only after 3 retries
    - `tests/scheduling/test_notification_dispatcher_property.py`: симуляция k неудачных попыток для `0 <= k <= 3`, проверить переходы `dispatch_status` (`pending`→`pending`→`pending`→`failed`); проверить что между попытками задержки 15/60/240 секунд
    - **Property 20: Notification dispatch_failed only after 3 retries**
    - **Validates: Requirements 10.11**

  - [x] 6.7 Implement `Reschedule_Operation`
    - `scheduling/reschedule_op.py`: функция `execute(original_id, scheduled_for, user_id) -> RescheduleResult`
    - Атомарно: `lock_for_update(original_id)`, проверка `status ∈ {running, paused}` (иначе `RESCHEDULE_INVALID_STATUS` 409), проверка `scheduled_for > now()` (иначе `RESCHEDULE_IN_PAST` 400)
    - Snapshot pending recipients из `Recipient`. Если пусто — `original.status='cancelled'`, новая не создаётся. Иначе — INSERT нового `ScheduledBroadcast` с `contacts=pending`, `parent_broadcast_id=original.id`, `follow_up_chain_id=original.follow_up_chain_id` (exact-value copy, no transformation)
    - Скопировать: `message`, `personalized_messages`, `use_typing`, `delay_seconds`, `file_url`, `file_name`, `instance_id`, `adaptive_throttle`, `quiet_hours_*`, `respect_recipient_tz`, `user_tz`. Original → `status='completed'`, `last_run_at=now()`
    - _Requirements: 11.5, 11.6, 11.7, 11.8, 11.9_

  - [ ]* 6.8 Property test P21: Reschedule preserves follow_up_chain_id exactly
    - `tests/scheduling/test_reschedule_property.py`: hypothesis-генератор `original.follow_up_chain_id` (включая null) — assert bit-for-bit copy в новый broadcast
    - **Property 21: Reschedule preserves follow_up_chain_id exactly**
    - **Validates: Requirements 11.7**

  - [ ]* 6.9 Property test P22: Reschedule excludes already-sent recipients
    - `tests/scheduling/test_reschedule_property.py`: hypothesis-генератор `(R_sent, R_pending)` — assert `new.contacts == phones(R_pending)`, intersection пуста; при `R_pending == ∅` оригинал → `cancelled` без новой записи
    - **Property 22: Reschedule excludes already-sent recipients**
    - **Validates: Requirements 11.5**

  - [ ]* 6.10 Property test P23: Reschedule rejects past timestamps
    - `tests/scheduling/test_reschedule_property.py`: hypothesis-генератор wall-clock `t` — assert `t <= now() ⟹ RESCHEDULE_IN_PAST` и обе записи неизменны
    - **Property 23: Reschedule rejects past timestamps**
    - **Validates: Requirements 11.8**

  - [x] 6.11 Wire up daemon threads in `app.py`
    - В точке инициализации Flask (рядом с существующим `BroadcastScheduler`) — eager-start `AutoSnoozeWatcher().start()` и `NotificationDispatcher().start()`
    - Регистрация всех стратегий в `ScheduleModeEngine`: `engine.register("window", WindowEngine())`, `engine.register("smart_time", SmartTimeEngine(activity_analyzer))`, `engine.register("ab_time", ABTimeEngine(activity_analyzer))`, `engine.register("burst", BurstEngine())`
    - `atexit.register(...)` для graceful stop обоих threads
    - Существующий `BroadcastScheduler._tick()` дополнить вызовом `schedule_mode_engine.dispatch_due()` сразу после своей текущей логики
    - _Requirements: 1.1, 2.1, 3.1, 7.4, 8.1, 9.2, 10.4_

- [x] 7. Backend (Python/Flask) — Broadcast Worker hook for Burst Mode

  - [x] 7.1 Hook `BurstEngine.delay_for` into existing Broadcast_Worker
    - В существующем broadcast worker (там, где сейчас вычисляется delay между сообщениями): если `broadcast.schedule_type == "burst"` — использовать `BurstEngine.delay_for(message_index, anti_ban, throttle_state)` вместо стандартного `random.uniform(delay_min, delay_max)`
    - В burst-режиме пропустить вызов `long_pause_every_n` routine (Req 8.3)
    - Принудительно включить `Adaptive_Throttle` независимо от `broadcast.adaptive_throttle` флага (Req 8.4)
    - При получении 429 в burst режиме — recovery toward `delay_min` сразу на следующей итерации `Adaptive_Throttle` state machine (Req 8.5)
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

  - [x] 7.2 Add hot-loop hook for Auto-Snooze incident counter
    - В существующем broadcast worker: после каждого `IncidentLog` insert (rate_limit_429 / zero_response / watchdog_trigger / throttle_paused) — простой `INCREMENT broadcast.in_memory_incident_count` или просто полагаться на следующий tick `AutoSnoozeWatcher` (он сам читает `IncidentLog`). Документировать в комментарии решение
    - _Requirements: 9.2, 9.8_

  - [x] 7.3 Verify approval gate at dispatch
    - В `Schedule_Mode_Engine.dispatch_due()`: SELECT-фильтр уже исключает `approval_status='pending'`. Дополнительно — defence-in-depth: внутри `dispatch()` для конкретного broadcast перед enqueue проверить `broadcast.status != 'pending_approval'`, иначе skip
    - _Requirements: 7.4_

- [x] 8. Checkpoint after backend daemon and worker hooks
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Next.js API routes (14 new endpoints)

  - [x] 9.1 Implement `POST /api/scheduled-broadcasts/[id]/snooze`
    - `frontend/src/app/api/scheduled-broadcasts/[id]/snooze/route.ts`
    - Body: `{ preset: "1h"|"1d"|"7d"|"next_business_day"|"custom", custom_minutes?: number }`
    - Validate `status ∈ {scheduled, paused, pending_approval}` иначе 409 `SNOOZE_INVALID_STATUS`. Validate `custom_minutes` ∈ [1, 43200] иначе 400 `SNOOZE_CUSTOM_INVALID`
    - Compute new `scheduled_for`: presets → +1h/+1d/+7d/next business day (Mon–Fri в `user_tz`, не в `CalendarException`); если попадает в quiet hours — roll forward
    - На успех — INSERT `Notification` kind=`scheduled` с `preference_snapshot`. На любой error — НЕ создавать notification (Req 6.8)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 9.2 Property test P11: Snooze status guard
    - `frontend/src/__tests__/scheduling/properties/p11-snooze-status-guard.test.ts` (fast-check): `fc.constantFrom(...allStatuses) × fc.constantFrom(...allPresets)` — assert 200 iff `status ∈ {scheduled, paused, pending_approval}`, иначе 409 `SNOOZE_INVALID_STATUS`
    - **Property 11: Snooze status guard**
    - **Validates: Requirements 6.5**

  - [ ]* 9.3 Property test P12: Snooze custom_minutes range
    - `frontend/src/__tests__/scheduling/properties/p12-snooze-custom-minutes.test.ts` (fast-check): `fc.oneof(fc.integer(), fc.constant(null), fc.constant(undefined))` — assert принимается iff integer ∈ [1, 43200]
    - **Property 12: Snooze custom_minutes range**
    - **Validates: Requirements 6.4**

  - [x] 9.4 Implement `POST /api/scheduled-broadcasts/[id]/approve` and `.../reject`
    - `frontend/src/app/api/scheduled-broadcasts/[id]/approve/route.ts` + `.../reject/route.ts`
    - Approve: assert `caller.user_id == broadcast.approval_user_id`, иначе 403 `APPROVAL_FORBIDDEN`. На успех — `approval_status='approved'`, `approved_at=now()`, `status='scheduled'`
    - Reject: те же проверки caller. Body требует non-empty `rejection_reason`. На успех — `approval_status='rejected'`, `status='rejected'`, `rejection_reason` записан
    - На FORBIDDEN — НЕ менять никакие поля (Req 7.9)
    - _Requirements: 7.7, 7.8, 7.9_

  - [ ]* 9.5 Property test P14: Approval endpoints enforce caller identity
    - `frontend/src/__tests__/scheduling/properties/p14-approval-caller-identity.test.ts` (fast-check): `fc.uuid() × fc.uuid()` — assert success iff caller=approver, иначе 403 + все approval поля unchanged
    - **Property 14: Approval endpoints enforce caller identity**
    - **Validates: Requirements 7.9**

  - [x] 9.6 Implement `POST /api/scheduled-broadcasts/[id]/pause` and `.../resume` and `.../cancel`
    - `.../pause`: `running` → `paused`, leave `next_run_at` and `operation_run_id` intact, INSERT `Notification` kind=`paused`
    - `.../resume`: `paused` → `running`, scheduler tick подхватит с `last_processed_index`, INSERT `Notification` kind=`resumed`
    - `.../cancel`: из `{scheduled, paused, running, pending_approval}` → `cancelled`, `last_run_at=now()`
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 9.7 Implement `POST /api/scheduled-broadcasts/[id]/reschedule`
    - `frontend/src/app/api/scheduled-broadcasts/[id]/reschedule/route.ts`
    - Body: `{ scheduled_for: ISOString }`. Делегирует в Python `Reschedule_Operation.execute(...)` через RPC/HTTP к Flask или прямой Prisma transaction (выбрать единый паттерн с `enhanced-broadcast-scheduling`)
    - Validate `status ∈ {running, paused}` иначе 409 `RESCHEDULE_INVALID_STATUS`. Validate `scheduled_for > now()` иначе 400 `RESCHEDULE_IN_PAST`
    - Response: `{ new_broadcast_id, original_status_after }`
    - _Requirements: 11.5, 11.6, 11.7, 11.8, 11.9_

  - [x] 9.8 Implement `GET /api/recipient-activity?phone=...`
    - `frontend/src/app/api/recipient-activity/route.ts`: вызывает Flask endpoint (или прямую Prisma агрегацию `Incoming` + `DeliveryStatus`) и возвращает `{ phone, histogram: number[24], top_slots: number[], source }`
    - _Requirements: 2.11_

  - [x] 9.9 Implement Notification API routes
    - `GET /api/notifications` (`frontend/src/app/api/notifications/route.ts`): возвращает `{ items: NotificationView[], unread_count }`, фильтрация по `auth.user_id`
    - `POST /api/notifications/[id]/read` (`frontend/src/app/api/notifications/[id]/read/route.ts`): `read_at=now()` если notification принадлежит caller
    - _Requirements: 10.1, 10.5, 10.9_

  - [x] 9.10 Implement Notification Preferences API routes
    - `GET /api/notification-preferences`: список с дефолтами (upsert defaults на первом обращении: `in_app=true` для всех `event_kind`, `email/telegram=false`)
    - `PUT /api/notification-preferences`: upsert по `(user_id, event_kind, channel)`, body `{ event_kind, channel, enabled }`
    - При попытке включить telegram-канал без настроенного `INSTANCE_ENCRYPTION_KEY` — 503 «Encryption not configured»
    - _Requirements: 10.2, 10.10_

  - [x] 9.11 Implement AB Time Test API routes
    - `POST /api/ab-time-tests`: body `{ scheduled_broadcast_id, slots: number[], wait_hours }`. Validate `len(slots) ∈ [2,4]`, distinct, all in [0,23] иначе 400 `ABTIME_SLOTS_INVALID`. Если broadcast уже имеет `ab_test_id` — 409 `ABTEST_KIND_CONFLICT`
    - `GET /api/ab-time-tests/[id]`: возвращает `{ id, slots, winner_slot, status, metrics: [{hour, delivery_pct, read_pct, reply_pct}] }`
    - `POST /api/ab-time-tests/[id]/apply-winner`: только при `status=completed AND winner_slot != null`, иначе 409 `ABTIME_WINNER_NOT_READY`. Создаёт новый `ScheduleTemplate` с `config.recurring_hour=winner_slot`
    - _Requirements: 3.1, 3.2, 3.7, 3.10_

  - [ ] 9.12 Implement validation gate in `POST /api/scheduled-broadcasts` for new modes
    - Расширить существующий `frontend/src/app/api/broadcasts/route.ts` или соответствующий endpoint scheduled-broadcasts: для каждого нового `schedule_type` валидация полей
    - `window`: required `send_window_start`, `send_window_end`, `end > start` иначе 400 `WINDOW_INVALID_RANGE`, `start > now()` иначе 400 `WINDOW_IN_PAST`. Затем серверный mirror `preflight_calc.run_preflight` — `WINDOW_INSUFFICIENT_TIME` 422 имеет приоритет
    - `smart_time`: required `smart_time_window_days ∈ [1,14]`, `smart_time_top_n ∈ [1,6]`, валидация на form submission ДО любых scheduling вычислений
    - `burst`: `len(contacts) > Profile.burst_recipient_limit` → 422 `BURST_RECIPIENT_LIMIT_EXCEEDED`; `quiet_hours_enabled=true` → 400 `BURST_INCOMPATIBLE_QUIET_HOURS`; `follow_up_chain_id`/`ab_test_id`/`ab_time_test_id` non-null → 400 `BURST_INCOMPATIBLE_EXTENSION`
    - approval gate: `length(contacts) > Profile.approval_required_above_n` AND `approval_required_above_n > 0` → `approval_required=true`, `approval_status='pending'`, `status='pending_approval'`, INSERT `Notification` kind=`awaiting_approval`. Если `approval_user_id` передан как email — резолв через Supabase, иначе 422 `APPROVAL_USER_NOT_FOUND`
    - _Requirements: 1.2, 1.3, 1.4, 2.2, 7.3, 7.5, 7.6, 8.7, 8.8, 8.9_

  - [ ]* 9.13 Property test P16: Burst incompatibility validations
    - `frontend/src/__tests__/scheduling/properties/p16-burst-incompatibility.test.ts` (fast-check): `fc.record({quiet_hours_enabled, follow_up_chain_id, ab_test_id, ab_time_test_id, recipient_count, burst_recipient_limit})` — assert exactly один из `BURST_*` codes возвращается
    - **Property 16: Burst incompatibility validations**
    - **Validates: Requirements 8.7, 8.8, 8.9**

  - [x] 9.14 Implement email relay endpoint for Notification_Dispatcher
    - `frontend/src/app/api/notifications/email-relay/route.ts`: принимает `{ user_id, kind, payload, to }` от Flask `Notification_Dispatcher`, отправляет email через `nodemailer` (SMTP-конфиг из env)
    - Защита: shared secret в headers (env `NOTIFICATION_RELAY_SECRET`), Flask добавляет тот же secret
    - _Requirements: 10.6_

- [ ] 10. Checkpoint after API routes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Frontend libraries (TypeScript)

  - [x] 11.1 Define TypeScript types for the suite
    - `frontend/src/lib/scheduling/types.ts`: `BroadcastStatus`, `Notification_Event_Kind`, `Notification_Channel`, `ScheduledBroadcastDraft`, `PreFlightWarning`, `PreFlightResult`, `AntiBanConfig`, `CalendarException`, `GreenInstance` re-exports — все из design.md (раздел Components and Interfaces)
    - _Requirements: 5.2, 5.3, 5.4, 5.5_

  - [x] 11.2 Implement TypeScript PreFlight engine (mirror of Python)
    - `frontend/src/lib/scheduling/preflightEngine.ts`: pure function `runPreFlight(input: PreFlightInput): PreFlightResult`
    - `dedupePhones(contacts)`: нормализация и дедупликация (та же логика что в Python — strip non-digits, leading-zero, country code defaults)
    - `simulateDistribution(input)`: внутренний switch по `schedule_type` — для каждого режима собственная функция (window/smart_time/ab_time/burst)
    - `computeHistogram(sends, userTz)`: 24-bucket
    - `buildWarnings(input, sends)`: четыре kinds (`quiet_hours_postpone`, `calendar_exception_postpone`, `daily_limit_exceeded`, `instance_unhealthy`)
    - Жёсткий бюджет 280ms timer-check, при превышении — return `null` (UI покажет fallback message)
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.12_

  - [ ]* 11.3 Property test P8: Schedule_Mode config JSON round-trip
    - `frontend/src/__tests__/scheduling/properties/p08-schedule-mode-json-roundtrip.test.ts` (fast-check): `fc.record({...smart_time_config})` и `fc.record({...ab_time_config})` — assert `parse(stringify(x))` структурно равно `x`
    - **Property 8: Schedule_Mode config JSON round-trip**
    - **Validates: Requirements 2.10, 3.9**

  - [ ]* 11.4 Cross-language property test: TS↔PY PreFlight equivalence
    - `tests/scheduling/test_preflight_cross_language.py`: запускает frontend `runPreFlight` через `node` subprocess с фиксированным input, вызывает Python `run_preflight`, сравнивает `histogram` поэлементно и `warnings.kind` + `warnings.affectedCount`
    - **Cross-language equivalence (helper for Property 8 and Req 5.3)**
    - **Validates: Requirements 5.3, 5.4**

  - [x] 11.5 Implement helper utilities
    - `frontend/src/lib/scheduling/calendarHelpers.ts`: `expandRecurringExceptions(exceptions, monthStart, monthEnd)` (weekly/monthly/yearly), `isInException(date, exceptions)`, `nextBusinessDay(date, tz, exceptions)`
    - `frontend/src/lib/scheduling/snoozePresets.ts`: `applySnoozePreset(scheduledFor, preset, customMinutes?, tz, exceptions)` — pure function, та же логика что и backend
    - _Requirements: 4.6, 4.9, 6.3, 6.6_

- [ ] 12. Frontend hooks

  - [ ] 12.1 Implement `useNotifications` hook
    - `frontend/src/hooks/useNotifications.ts`: `setInterval(fetch, 15000)` `GET /api/notifications`. Возвращает `{ items, unreadCount, markRead, refetch }`
    - `markRead(id)` делает POST к `/api/notifications/[id]/read` и optimistic-обновляет state
    - _Requirements: 10.5, 10.9_

  - [ ] 12.2 Implement `useScheduleCalendar` hook
    - `frontend/src/hooks/useScheduleCalendar.ts`: для месяца — `byDay: Map<string, ScheduledBroadcastSummary[]>` (key `yyyy-mm-dd`), сгруппирован по `next_run_at ?? scheduled_for`
    - `reschedule(id, target)`: optimistic update local state, `PUT /api/scheduled-broadcasts/[id]`; при error — revert local state, surface error
    - _Requirements: 4.1, 4.7, 4.11_

  - [ ] 12.3 Implement `usePreflight` hook
    - `frontend/src/hooks/usePreflight.ts`: `useMemo` + `AbortController`, синхронный вызов `runPreFlight`, жёсткий 300ms бюджет
    - При истечении бюджета — `result: null` и UI покажет fallback-message (Req 5.12)
    - _Requirements: 5.12_

- [ ] 13. Frontend components

  - [ ] 13.1 Implement `Visual_Schedule_Calendar` component
    - `frontend/src/components/scheduling/VisualScheduleCalendar.tsx`: `DndContext` из `@dnd-kit/core`, ячейки дня — `useDroppable({id: yyyy-mm-dd})`, pills — `useDraggable({id: broadcast.id, disabled: !isDraggableStatus(status)})`
    - View modes `month` (default) и `week` toggleable из header
    - Цветовое кодирование: scheduled→blue, running→green, paused→amber, pending_approval→violet, completed→grey, failed→red, cancelled→strikethrough grey
    - Hover-tooltip с `name`, `next_run_at` HH:MM, recipient count, status
    - Click pill → router push `/dashboard/scheduled/[id]`
    - Today cell — 2px ring accent. CalendarException-day — dashed background
    - `onDragEnd`: assert `target >= today` иначе inline error «Нельзя планировать в прошлое»; assert no exception overlap иначе inline error с exception name; иначе optimistic update + `PUT`; на API fail — revert + inline error
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

  - [ ]* 13.2 Property test P24: Calendar drag rejects past dates and exception days
    - `frontend/src/__tests__/scheduling/properties/p24-calendar-drag-validation.test.ts` (fast-check): `fc.record({today, target_date, exceptions, status})` — assert PUT не вызывается если `target < today` ИЛИ overlap exception ИЛИ status not in {scheduled, paused, pending_approval}; вызывается ровно один раз во всех остальных случаях
    - **Property 24: Calendar drag rejects past dates and exception days**
    - **Validates: Requirements 4.8, 4.9, 4.10**

  - [ ] 13.3 Implement `PreFlight_Modal` component
    - `frontend/src/components/scheduling/PreFlightModal.tsx`: вызывает `usePreflight(draft, antiBan, exceptions, instance)`; рендерит recipient count, ETA first/last (HH:MM in `user_tz`), 24-bar histogram, warnings list
    - Отображает дополнительный текст «N сообщений / окно X часов = одно сообщение каждые Y минут» для window-режима (Req 1.11)
    - Кнопки `Подтвердить и запланировать` / `Отменить`. Cancel — close без API. Confirm — `onConfirm()`; auto-close on success, inline error on failure
    - Если `result === null` (превышение бюджета) — fallback message «Слишком много получателей для предпросмотра. Сократите список или продолжите без preview»
    - _Requirements: 1.11, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12_

  - [ ] 13.4 Implement `SnoozeButton` component
    - `frontend/src/components/scheduling/SnoozeButton.tsx`: dropdown с пресетами `+1h | +1d | +7d | следующий рабочий день | Своё значение`. Disabled для terminal статусов
    - `Своё значение` — модалка с number input, валидация `1..43200` (UI mirror серверной валидации)
    - На успех — `onSnoozed(newScheduledFor)`. На server error — toast c кодом
    - _Requirements: 6.1, 6.4, 6.5, 6.9_

  - [ ] 13.5 Implement `ApprovalDashboard` page
    - `frontend/src/app/dashboard/scheduled/awaiting-approval/page.tsx`: server component fetching broadcasts where `current_user.id == approval_user_id AND approval_status='pending'`
    - Каждая строка — `name`, `message preview`, `recipientCount`, `scheduledFor`, `requestedBy`, `createdAt`, кнопки `Approve` / `Reject (с reason)`
    - Reject открывает modal с textarea (non-empty validation), POST `.../reject`. Approve — POST `.../approve`. На success — refresh list
    - _Requirements: 7.7, 7.8, 7.10_

  - [ ] 13.6 Implement `NotificationCenter` header component
    - `frontend/src/components/header/NotificationCenter.tsx`: использует `useNotifications`. Бэйдж с `unreadCount` если > 0
    - Click open dropdown с last 20 notifications, per-item `markRead` on click
    - Поддерживаемые `kind`: scheduled, started, paused, resumed, completed, failed, anti_ban_threshold, awaiting_approval, ab_time_completed, auto_snoozed
    - _Requirements: 10.5, 10.8, 10.9_

  - [ ] 13.7 Implement `BroadcastControls` component
    - `frontend/src/components/scheduling/BroadcastControls.tsx`: условный рендер по `status`:
      - `scheduled` → Snooze | Cancel
      - `pending_approval` → Cancel | Snooze (БЕЗ pause/resume/reschedule, Req 11.11)
      - `running` → Pause | Cancel | Reschedule
      - `paused` → Resume | Cancel | Reschedule
      - terminal → ничего
    - Каждая кнопка вызывает соответствующий API (`/pause`, `/resume`, `/cancel`, `/reschedule`, `/snooze`); reschedule открывает modal с DateTime picker
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.10, 11.11_

  - [ ] 13.8 Implement `AB_Time_Test_Creator` component
    - `frontend/src/components/scheduling/ABTimeTestCreator.tsx`: select-multi для slots (2..4 distinct hours 0-23, UI guard), number input `wait_hours` (1..168)
    - На submit — POST `/api/ab-time-tests`. Server-error inline (`ABTIME_SLOTS_INVALID`, `ABTEST_KIND_CONFLICT`)
    - _Requirements: 3.1, 3.2, 3.10_

  - [ ] 13.9 Extend existing `ScheduleModal` with new mode pickers
    - В существующем `frontend/src/components/scheduling/ScheduleModal.tsx` (или его аналоге) — добавить radio/select для `schedule_type`: existing `exact|drip|recurring` + new `window|smart_time|ab_time|burst`
    - Условные поля per mode:
      - `window` → DateTime pickers `send_window_start`, `send_window_end`
      - `smart_time` → number `smart_time_window_days` (1..14), `smart_time_top_n` (1..6, default 3)
      - `ab_time` → render `AB_Time_Test_Creator` встроенным
      - `burst` → checkbox confirmation «Я понимаю что это режим максимально быстрой отправки» + warning если len(contacts) > burst_recipient_limit
    - Перед submit — open `PreFlight_Modal` (Req 5.1)
    - _Requirements: 1.2, 2.2, 3.1, 8.1_

- [ ] 14. Page routes (extend / create dashboard pages)

  - [ ] 14.1 Create `/dashboard/scheduled/calendar/page.tsx`
    - Server component, fetch broadcasts for current user; render `<VisualScheduleCalendar/>`
    - Добавить ссылку «Календарь» в существующий sidebar/scheduled-list header
    - _Requirements: 4.1_

  - [ ] 14.2 Extend `/dashboard/scheduled/[id]/page.tsx` with `BroadcastControls`
    - В существующем broadcast detail page — добавить `<BroadcastControls broadcastId status approvalStatus onChange/>` в header панели
    - Если режим `ab_time` — показать секцию «AB Time Test Result» с метриками и кнопкой `Apply Winner` (если `status=completed AND winner_slot != null`)
    - _Requirements: 3.7, 11.10, 11.11_

- [ ] 15. Wire-up integration

  - [ ] 15.1 Add `NotificationCenter` to dashboard header layout
    - В `frontend/src/app/dashboard/layout.tsx` (или его эквиваленте) — встроить `<NotificationCenter/>` в header. Бэйдж рядом с user-menu
    - _Requirements: 10.5_

  - [ ] 15.2 Add «Календарь» link to dashboard sidebar
    - В существующем sidebar component — пункт меню «Календарь рассылок» → `/dashboard/scheduled/calendar`
    - Пункт «На одобрение» → `/dashboard/scheduled/awaiting-approval` (показывается только если у пользователя есть pending broadcasts с `approval_user_id == current_user.id`)
    - _Requirements: 4.1, 7.10_

  - [ ] 15.3 Wire approval/snooze buttons in scheduled-list table
    - В существующем `/dashboard/scheduled` list view — добавить per-row `SnoozeButton` (Req 6.9: на каждом list view)
    - _Requirements: 6.9_

  - [ ] 15.4 Add `Profile` settings UI for new fields
    - В существующих profile settings — добавить inputs `approval_required_above_n` (number), `burst_recipient_limit` (number), `telegram_bot_token` (password input, encrypted on save), `telegram_chat_id` (text)
    - При сохранении telegram-полей без `INSTANCE_ENCRYPTION_KEY` — показать ошибку «Encryption not configured»
    - _Requirements: 7.2, 8.6, 10.7_

- [ ] 16. Checkpoint after frontend wire-up
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. End-to-end test (Playwright)

  - [ ]* 17.1 Implement happy-path E2E scenario
    - `frontend/tests/e2e/broadcast-scheduling-suite.spec.ts`: один scenario из design.md (раздел Testing Strategy → E2E Test):
      1. Login as operator → /dashboard/broadcast
      2. Upload 50 contacts, enter message
      3. Click «Запланировать», select `schedule_type=window`, set `send_window_start=tomorrow 10:00`, `send_window_end=tomorrow 18:00`
      4. Click «Подтвердить» → PreFlight modal opens
      5. Assert histogram visible (24 bars), warnings list visible, ETA shown
      6. Click «Подтвердить и запланировать» → modal closes, redirect to /dashboard/scheduled
      7. Click «Календарь» → /dashboard/scheduled/calendar opens
      8. Assert pill on tomorrow's day cell, blue color (status=scheduled)
      9. Hover pill — tooltip shows recipient count = 50
      10. Click «Snooze» → dropdown → select «+1d»
      11. Assert pill moves to day-after-tomorrow cell
      12. Reload page — assert pill still on day-after-tomorrow
    - _Requirements: 1.1, 4.1, 4.7, 5.1, 5.4, 6.1, 6.2, 6.9_

- [ ] 18. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Verify P1–P24 each have a corresponding test file referenced
  - Verify migration round-trips cleanly (`npx prisma migrate reset` + `migrate dev`)

## Notes

- Tasks marked with `*` (включая все P1–P24 property-tests) являются опциональными и могут быть пропущены для ускорения MVP. Core implementation tasks (без `*`) — обязательны.
- Каждая задача ссылается на конкретные granular sub-requirements (X.Y), не только на user story номер.
- Property-тесты P1–P24 размещены **рядом** с соответствующими реализациями: backend (hypothesis) — в `tests/scheduling/test_*_property.py`, frontend (fast-check) — в `frontend/src/__tests__/scheduling/properties/p{N}-*.test.ts`.
- Cross-language property test (TS↔PY PreFlight equivalence) — отдельная задача 11.4, использует subprocess `node` для запуска TS-кода из Python и сравнения output'ов.
- Stack: Python/Flask backend (`scheduling/` рядом с `anti_ban/`), Next.js + TypeScript frontend, PostgreSQL через Prisma. `@dnd-kit/core` для drag-and-drop. `nodemailer` для email, `httpx` для Telegram Bot API.
- Чекпойнты `[~]` (задачи 2, 5, 8, 10, 16, 18) — точки синхронизации между крупными этапами; на каждом — прогон полного test-suite и пауза для пользовательского ревью.
- Encryption: `telegram_bot_token` шифруется тем же `INSTANCE_ENCRYPTION_KEY`, что и `GreenInstance.api_token` (общая утилита `frontend/src/lib/encryption.ts` уже существует).
- Schedule_Mode_Engine — strategy pattern. Старые режимы (`exact`/`drip`/`recurring`) обслуживаются существующим `BroadcastScheduler` без изменений; новые (`window`/`smart_time`/`ab_time`/`burst`) делегируют новым стратегиям через единый dispatcher.
- Snooze переиспользует существующее `next_run_at` поле — ни одной новой таблицы не вводится для snooze.
- Approval — расширение `ScheduledBroadcast` (новые `approval_*` колонки), без отдельной таблицы.
- `Notification.preference_snapshot` — снимок prefs на момент создания записи; dispatcher не перечитывает live `NotificationPreference` (Req 10.4 / Property 19).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.0"] },
    { "id": 1, "tasks": ["1.1"] },
    { "id": 2, "tasks": ["1.2"] },
    { "id": 3, "tasks": ["1.3", "3.1", "11.1"] },
    { "id": 4, "tasks": ["3.2", "11.5"] },
    { "id": 5, "tasks": ["3.3", "3.4", "11.2"] },
    { "id": 6, "tasks": ["3.5", "4.1", "11.3"] },
    { "id": 7, "tasks": ["4.2", "4.3", "4.6", "4.7", "4.13"] },
    { "id": 8, "tasks": ["4.4", "4.5", "4.8", "4.9", "4.10", "4.11", "4.12", "4.14", "11.4"] },
    { "id": 9, "tasks": ["6.1", "6.4", "6.7"] },
    { "id": 10, "tasks": ["6.2", "6.3", "6.5", "6.6", "6.8", "6.9", "6.10"] },
    { "id": 11, "tasks": ["6.11"] },
    { "id": 12, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 13, "tasks": ["9.1", "9.4", "9.6", "9.7", "9.8", "9.9", "9.10", "9.11", "9.12", "9.14"] },
    { "id": 14, "tasks": ["9.2", "9.3", "9.5", "9.13"] },
    { "id": 15, "tasks": ["12.1", "12.2", "12.3"] },
    { "id": 16, "tasks": ["13.1", "13.3", "13.4", "13.5", "13.6", "13.7", "13.8"] },
    { "id": 17, "tasks": ["13.2", "13.9"] },
    { "id": 18, "tasks": ["14.1", "14.2"] },
    { "id": 19, "tasks": ["15.1", "15.2", "15.3", "15.4"] },
    { "id": 20, "tasks": ["17.1"] }
  ]
}
```
