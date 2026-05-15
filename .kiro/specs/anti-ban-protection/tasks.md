# Implementation Plan: Anti-Ban Protection

## Overview

Реализуем фичу `anti-ban-protection` инкрементально: сначала
data layer (Prisma) и новый Python-пакет `anti_ban/` (конфиг,
rate limiter, registry, audit, watchdog, state monitor, payload),
затем интеграция в `bot.py` и `app.py`, после — фронтенд (утилиты,
хуки, компоненты, интеграция в дашборд) и финальные интеграционные
тесты. Property-тесты идут как опциональные sub-задачи рядом с
кодом, который они валидируют (по одной property-тесту = один файл,
чтобы избежать конфликтов параллельной записи).

Convert the feature design into a series of prompts for a code-generation LLM
that will implement each step with incremental progress. Make sure that each
prompt builds on the previous prompts, and ends with wiring things together.
There should be no hanging or orphaned code that isn't integrated into a
previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Tasks

- [x] 1. Подготовить data layer (Prisma)
  - [x] 1.1 Добавить модели `AntiBanConfig`, `OperationRun`, `IncidentLog` в `frontend/prisma/schema.prisma`
    - Скопировать схему из секции Data Models дизайна (поля, дефолты, индексы, `@@map`)
    - Добавить связь `OperationRun` ↔ `IncidentLog` (FK `operation_run_id`)
    - _Requirements: 7.1, 8.2, 9.1, 10.1_
  - [x] 1.2 Сгенерировать и применить Prisma-миграцию
    - Создать новый каталог `frontend/prisma/migrations/<timestamp>_add_anti_ban_models/migration.sql`
    - Выполнить `npx prisma migrate dev --name add_anti_ban_models` и зафиксировать сгенерированный SQL
    - Запустить `npx prisma generate` для обновления клиента
    - _Requirements: 7.1, 8.2, 9.1_

- [x] 2. Реализовать конфигурационный слой `anti_ban`
  - [x] 2.1 Создать `anti_ban/config.py` с dataclass `AntiBanConfig`
    - Описать все поля и дефолты, перечисленные в Requirement 9.2 (frozen dataclass)
    - Добавить набор констант `HEALTHY`, `UNHEALTHY`, `NEUTRAL`, `UNKNOWN` для `Instance_State`
    - _Requirements: 9.1, 9.2, 3.1, 3.6_
  - [x] 2.2 Создать `anti_ban/config_loader.py` с `ConfigLoader`
    - Метод `get(user_id) -> AntiBanConfig`, чтение из таблицы `anti_ban_config` через Prisma
    - Если записи нет — вернуть `AntiBanConfig()` с дефолтами
    - In-memory кэш на 60 секунд per-`user_id`
    - Метод `validate(values: dict) -> list[str]`, возвращающий список нарушений по Requirement 9.3
    - _Requirements: 9.1, 9.2, 9.3_
  - [ ]* 2.3 Property test 28: дефолтный конфиг для отсутствующей записи
    - Файл `tests/properties/test_property_28_default_config.py`
    - **Property 28: Default config returned for missing record**
    - **Validates: Requirements 9.2**

- [x] 3. Реализовать `RateLimiter`
  - [x] 3.1 Создать `anti_ban/rate_limiter.py` с классом `RateLimiter`
    - Конструктор принимает `config`, `clock`, `sleep`, `rng` (DI)
    - Метод `acquire(kind)` — sleep с jitter, sliding-window проверка, long-pause каждые N
    - Метод `record_request()` — добавление timestamp в `deque`, удаление протухших
    - Метод `on_http_429(retry_count)` — `backoff = base * 2^retry + uniform(0, base)`
    - Потокобезопасность через `threading.Lock`
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.7, 2.1, 2.2, 2.3, 4.1, 4.2_
  - [ ]* 3.2 Property test 1: распределение пауз
    - Файл `tests/properties/test_property_01_pause_distribution.py`
    - **Property 1: Pause distribution**
    - **Validates: Requirements 1.2, 1.6, 2.3**
  - [ ]* 3.3 Property test 2: каденс длинных пауз
    - Файл `tests/properties/test_property_02_long_pause_cadence.py`
    - **Property 2: Long pause cadence**
    - **Validates: Requirements 1.1, 1.7**
  - [ ]* 3.4 Property test 3: инвариант скользящего окна
    - Файл `tests/properties/test_property_03_sliding_window.py`
    - **Property 3: Sliding window invariant**
    - **Validates: Requirements 1.3**
  - [ ]* 3.5 Property test 5: минимальная пауза для broadcast
    - Файл `tests/properties/test_property_05_broadcast_min_delay.py`
    - **Property 5: Broadcast minimum delay floor**
    - **Validates: Requirements 2.1, 2.2**
  - [ ]* 3.6 Property test 11: границы backoff и retry-cap
    - Файл `tests/properties/test_property_11_backoff_bounds.py`
    - **Property 11: Backoff bounds and retry cap**
    - **Validates: Requirements 4.1, 4.2**

- [x] 4. Реализовать `OperationRunRegistry`
  - [x] 4.1 Создать `anti_ban/registry.py`
    - Dataclass `RunHandle` (`cancel_event`, `last_progress_at`, `kind`, `global_flag_name`)
    - Класс `OperationRunRegistry` с `register/deregister/get/heartbeat/cancel/snapshot/is_active`
    - Внутренний `threading.Lock`, копирование `snapshot()` без удержания блокировки во время прохода
    - Singleton-инстанс `registry = OperationRunRegistry()` для импорта в `app.py` / watchdog
    - _Requirements: 5.1, 5.5, 7.6_
  - [ ]* 4.2 Unit-тесты на регистратор
    - Файл `tests/test_registry.py`: register → heartbeat → cancel → deregister, конкуренция двух потоков
    - _Requirements: 5.1, 5.5_

- [x] 5. Реализовать `AuditLogger`
  - [x] 5.1 Создать `anti_ban/audit.py` с классом `AuditLogger`
    - `start_run(user_id, kind, total, payload) -> int` — INSERT в `operation_runs`
    - `update_progress(run_id, processed, last_processed_index)` — UPDATE атомарно с записью результата
    - `finish_run(run_id, status)` — UPDATE статуса и `finished_at`
    - `log_incident(...)` — INSERT в `incident_log`
    - `list_incidents(user_id, limit)` — SELECT с `ORDER BY created_at DESC LIMIT`
    - `count_in_window(user_id, kind, window: "day"|"hour")` — для дневных/часовых лимитов
    - Использовать Prisma client (через subprocess вызов фронтенд-процесса или прямой `psycopg2` к Postgres — следовать существующему паттерну в `db.py`)
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_
  - [ ]* 5.2 Property test 27: API инцидентов отсортирован по убыванию
    - Файл `tests/properties/test_property_27_incidents_order.py`
    - **Property 27: Incidents API returns last N desc-sorted**
    - **Validates: Requirements 8.3, 8.4**

- [x] 6. Интегрировать rate limiting и обработку ошибок в `bot.py`
  - [x] 6.1 Расширить `MaxBot._make_request` опциональным `rate_limiter`
    - Перед HTTP-запросом — `rate_limiter.acquire(kind)`, после успешного ответа — `record_request()`
    - На HTTPError 429 — `on_http_429(retry)` и повтор до `max_retries`; счётчик последовательных 429 пробрасывается наружу
    - На HTTP 466 — поднять кастомный `QuotaExceededError`
    - _Requirements: 1.2, 4.1, 4.2, 4.4_
  - [x] 6.2 Расширить `MaxBot.broadcast` параметрами `cancel_event`, `progress_cb_after_each`
    - Проверка `cancel_event.is_set()` после каждого контакта
    - Проброс `rate_limiter` во все вызовы `_make_request`
    - _Requirements: 2.1, 5.2_
  - [ ]* 6.3 Unit-тесты обработки 429/466 в `bot.py`
    - Файл `tests/test_bot_429_466.py`: с моками `requests` проверить retry/abort-семантику
    - _Requirements: 4.1, 4.2, 4.4_

- [x] 7. Реализовать `Watchdog`
  - [x] 7.1 Создать `anti_ban/watchdog.py`
    - `Watchdog(threading.Thread, daemon=True)` с интервалом `watchdog_check_interval_seconds`
    - На каждом такте: `registry.snapshot()` → для каждого handle проверка `now - last_progress_at > watchdog_timeout_seconds`
    - При срабатывании: `cancel_event.set()`, сброс глобального флага в `app`, SSE broadcast `{finished, reason: "watchdog_timeout"}`, `audit.log_incident(kind="watchdog_reset")`, `registry.deregister`
    - DI `clock`, `sleep` для тестируемости
    - _Requirements: 5.3, 5.4, 5.5_
  - [ ]* 7.2 Property test 16: каденс Watchdog
    - Файл `tests/properties/test_property_16_watchdog_cadence.py`
    - **Property 16: Watchdog cadence**
    - **Validates: Requirements 5.3**
  - [ ]* 7.3 Property test 17: побочные эффекты таймаута Watchdog
    - Файл `tests/properties/test_property_17_watchdog_timeout.py`
    - **Property 17: Watchdog timeout side-effects**
    - **Validates: Requirements 5.4**

- [x] 8. Реализовать `StateMonitor`
  - [x] 8.1 Создать `anti_ban/state_monitor.py`
    - `StateMonitor(threading.Thread, daemon=True)` с интервалом `state_poll_interval_seconds`
    - Опрос `bot.get_state()`, публикация SSE-события `state` всем подписчикам progress-каналов
    - При получении значения из `UNHEALTHY` — пометка активных `Bulk_Operation` через `cancel_event.set()` + `audit.log_incident(kind=state)` + установка финального `OperationRun.status="banned"`
    - При исключении / `None` — публикация значения `unknown`, не блокирующее новые операции
    - DI `clock`, `sleep`, `bot_factory`
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6_
  - [ ]* 8.2 Property test 8: каденс опроса состояния
    - Файл `tests/properties/test_property_08_state_polling_cadence.py`
    - **Property 8: State polling cadence**
    - **Validates: Requirements 3.2**
  - [ ]* 8.3 Property test 10: unknown-состояние не блокирует
    - Файл `tests/properties/test_property_10_unknown_state.py`
    - **Property 10: Unknown state does not block**
    - **Validates: Requirements 3.6**

- [x] 9. Реализовать сериализацию payload
  - [x] 9.1 Создать `anti_ban/payload.py`
    - `serialize_payload(contacts: list[dict], params: dict) -> str` — `json.dumps(..., ensure_ascii=False)`
    - `deserialize_payload(raw: str) -> dict` — `json.loads`, валидация наличия ключа `contacts: list`
    - `PayloadValidationError` — кастомное исключение для невалидных payload
    - _Requirements: 10.1, 10.2, 10.4_
  - [ ]* 9.2 Property test 31: round-trip payload
    - Файл `tests/properties/test_property_31_payload_roundtrip.py`
    - **Property 31: Payload JSON round-trip**
    - **Validates: Requirements 10.1, 10.2, 10.3**

- [x] 10. Checkpoint - ядро `anti_ban` готово
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Рефакторить `/api/check-contacts-bulk` под `Bulk_Operation`
  - [x] 11.1 Переписать обработчик в `app.py`
    - Pre-flight `getStateInstance`: при `state ∈ UNHEALTHY` вернуть HTTP 409 `{state}`
    - Проверить `audit.count_in_window(user_id, "check", "day")` против `daily_check_limit` → HTTP 429
    - Создать `OperationRun` (status=running, payload), `registry.register(run_id, handle)`
    - Worker thread: цикл по контактам с `rate_limiter.acquire("check")`, `registry.heartbeat`, `audit.update_progress`, проверка `cancel_event` и текущего `Instance_State` после каждого батча
    - Часовой лимит: при достижении `hourly_check_limit` — `audit.finish_run(status="paused")`, ждать следующего часа
    - При `Instance_State ∈ UNHEALTHY` во время выполнения — `finish_run(status="banned")` + `log_incident(kind=state)` не позже `state_poll_interval_seconds` после смены
    - `try/finally`: гарантированный сброс `_check_active = False` и `registry.deregister`
    - В JSON ответа на старт — `operation_run_id`
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.7, 3.3, 3.4, 3.5, 4.5, 5.5, 7.1, 7.2_
  - [ ]* 11.2 Property test 4: соблюдение дневных и часовых лимитов
    - Файл `tests/properties/test_property_04_daily_hourly_limits.py`
    - **Property 4: Daily/hourly limits enforce caps**
    - **Validates: Requirements 1.4, 1.5, 2.4**
  - [ ]* 11.3 Property test 7: предстартовая проверка состояния
    - Файл `tests/properties/test_property_07_pre_start_state_gate.py`
    - **Property 7: Pre-start state gate**
    - **Validates: Requirements 3.3**
  - [ ]* 11.4 Property test 9: автостоп при unhealthy state
    - Файл `tests/properties/test_property_09_unhealthy_state_aborts.py`
    - **Property 9: Unhealthy state aborts within poll interval**
    - **Validates: Requirements 3.4, 3.5**
  - [ ]* 11.5 Property test 14: корректность `last_processed_index`
    - Файл `tests/properties/test_property_14_last_processed_index.py`
    - **Property 14: last_processed_index correctness**
    - **Validates: Requirements 4.5, 7.2**
  - [ ]* 11.6 Property test 18: инвариант глобального флага после worker
    - Файл `tests/properties/test_property_18_global_flag_invariant.py`
    - **Property 18: Global flag invariant after worker termination**
    - **Validates: Requirements 5.5**

- [x] 12. Рефакторить `/api/broadcast` под `Bulk_Operation`
  - [x] 12.1 Переписать обработчик в `app.py` по образцу 11.1
    - Pre-flight state gate, ежедневный лимит сообщений (`daily_message_limit`)
    - `RateLimiter` с `kind="broadcast"`: floor `broadcast_delay_min`, jitter `[0, broadcast_jitter_max]`, игнорировать пользовательский `delay`, если он ниже floor
    - При `warn_on_zero_response_ratio == true` и `incoming == 0 ∧ outgoing >= response_ratio_min_outgoing` за `response_ratio_window_hours` часов — добавить `warning: "zero_response_ratio"` в ответ старта
    - Использовать `bot.broadcast(rate_limiter, cancel_event, progress_cb_after_each)` из 6.2
    - `try/finally` гарантирует `_broadcast_active = False` и `registry.deregister`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.3, 3.4, 5.5, 7.1, 7.2_
  - [ ]* 12.2 Property test 6: предупреждение о zero_response_ratio
    - Файл `tests/properties/test_property_06_zero_response_ratio.py`
    - **Property 6: Zero response ratio warning**
    - **Validates: Requirements 2.5**

- [x] 13. Добавить эндпойнты управления `Bulk_Operation`
  - [x] 13.1 Реализовать `POST /api/bulk-operation/stop` и `POST /api/bulk-operation/resume` в `app.py`
    - `stop`: `registry.cancel(run_id)` ставит `cancel_event`; worker завершается со `status="aborted"` не позже `cancel_check_interval_seconds`
    - `resume`: загрузить `OperationRun`, проверить `status` (если `completed` → HTTP 409), вызвать `payload.deserialize_payload` (HTTP 422 на ошибку), запустить новый worker с индексами `[last_processed_index + 1, total)`
    - Идемпотентность `stop` (повторные вызовы возвращают 200)
    - _Requirements: 5.1, 5.2, 7.4, 7.5, 10.4_
  - [ ]* 13.2 Property test 15: распространение отмены
    - Файл `tests/properties/test_property_15_cancel_propagation.py`
    - **Property 15: Cancel propagation**
    - **Validates: Requirements 5.1, 5.2**
  - [ ]* 13.3 Property test 23: resume стартует с `last_processed_index + 1`
    - Файл `tests/properties/test_property_23_resume_continues.py`
    - **Property 23: Resume continues from last_processed_index + 1**
    - **Validates: Requirements 7.4**
  - [ ]* 13.4 Property test 24: resume завершённого run отвергнут
    - Файл `tests/properties/test_property_24_resume_completed_rejected.py`
    - **Property 24: Resume of completed run rejected**
    - **Validates: Requirements 7.5**
  - [ ]* 13.5 Property test 32: невалидный payload отвергается с 422
    - Файл `tests/properties/test_property_32_invalid_payload.py`
    - **Property 32: Invalid payload rejected with 422**
    - **Validates: Requirements 10.4**

- [x] 14. Добавить эндпойнты наблюдаемости и конфигурации
  - [x] 14.1 Реализовать `GET /api/incidents`, `GET/PUT /api/anti-ban-config` в `app.py`
    - `GET /api/incidents` — `audit.list_incidents(user_id, limit=incident_history_limit)`
    - `GET /api/anti-ban-config` — `config_loader.get(user_id)` (как dict)
    - `PUT /api/anti-ban-config` — `config_loader.validate(values)` → HTTP 400 с описанием при нарушении, иначе UPSERT в Prisma + сброс кэша
    - _Requirements: 8.3, 8.4, 9.1, 9.3_
  - [ ]* 14.2 Property test 29: валидация конфига принимает iff valid
    - Файл `tests/properties/test_property_29_config_validation.py`
    - **Property 29: Config validation accepts iff valid**
    - **Validates: Requirements 9.3**

- [x] 15. Расширить SSE-каналы прогресса
  - [x] 15.1 Расширить `/api/check-contacts/progress` и `/api/broadcast/progress` в `app.py`
    - Добавить событие `state` с текущим `Instance_State` (приходит от `StateMonitor`)
    - Гарантированно отправлять финальное `{ "finished": true, "reason": ... }` (`completed`, `cancelled`, `watchdog_timeout`, `banned`, `quota_466`, `rate_limit_429`, `error`)
    - Heartbeat `: ping\n\n` каждые 15 секунд
    - При старте Flask-приложения — старт `Watchdog` и lazy-старт `StateMonitor` на первой подписке
    - _Requirements: 3.1, 3.2, 5.4, 5.6_

- [ ] 16. Сквозные backend property-тесты
  - [ ]* 16.1 Property test 12: последовательные 429 → aborted + incident
    - Файл `tests/properties/test_property_12_consecutive_429.py`
    - **Property 12: Consecutive 429 → aborted + incident**
    - **Validates: Requirements 4.3**
  - [ ]* 16.2 Property test 13: HTTP 466 немедленно прерывает
    - Файл `tests/properties/test_property_13_http_466_aborts.py`
    - **Property 13: HTTP 466 aborts immediately**
    - **Validates: Requirements 4.4**
  - [ ]* 16.3 Property test 26: полнота аудит-журнала
    - Файл `tests/properties/test_property_26_audit_completeness.py`
    - **Property 26: Audit log completeness**
    - **Validates: Requirements 3.5, 7.1, 7.3, 8.1, 8.2**

- [x] 17. Checkpoint - backend готов
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Создать утилиты фронтенда (ETA / risk)
  - [x] 18.1 Создать `frontend/src/lib/anti-ban.ts`
    - Функция `computeEta(config, total)` по формуле из Requirement 6.2
    - Функция `computeRisk(total): "low" | "medium" | "high"` по правилам Requirement 6.3
    - Тип `AntiBanConfig` (зеркалирует Python dataclass) и `InstanceState`
    - _Requirements: 6.2, 6.3_
  - [ ]* 18.2 Property test 20: формула ETA
    - Файл `frontend/src/lib/__tests__/property-20-eta.test.ts` (fast-check)
    - **Property 20: ETA formula correctness**
    - **Validates: Requirements 6.2**
  - [ ]* 18.3 Property test 21: маппинг категории риска
    - Файл `frontend/src/lib/__tests__/property-21-risk.test.ts` (fast-check)
    - **Property 21: Risk category mapping**
    - **Validates: Requirements 6.3**

- [x] 19. Создать хук `useBulkOperation`
  - [x] 19.1 Реализовать `frontend/src/lib/hooks/useBulkOperation.ts`
    - State: `active`, `progress`, `state`, `operationRunId`
    - `start(payload)` — POST на `/api/check-contacts-bulk` или `/api/broadcast`, открыть SSE
    - `stop()` — POST на `/api/bulk-operation/stop`
    - На событие `{finished:true}`, `error`, закрытие SSE или таймаут heartbeat (`sse_client_timeout_seconds`) — `setActive(false)` в течение 1 секунды + сообщение об ошибке при таймауте
    - На событие `state` — обновить `state`
    - _Requirements: 5.6, 5.7_
  - [ ]* 19.2 Property test 19: сброс active-флага по окончании SSE
    - Файл `frontend/src/lib/hooks/__tests__/property-19-sse-reset.test.tsx` (fast-check + RTL)
    - **Property 19: Frontend resets active flag on SSE end**
    - **Validates: Requirements 5.6, 5.7**

- [x] 20. Создать `<StateBadge>` компонент
  - [x] 20.1 Реализовать `frontend/src/components/anti-ban/StateBadge.tsx`
    - Цветовая схема: `authorized` зелёный, `yellowCard` жёлтый, `blocked`/`notAuthorized` красный, `starting`/`sleepMode` синий, `unknown` серый
    - Доступность: `role="status"`, `aria-label`
    - _Requirements: 3.1, 3.6_
  - [ ]* 20.2 Unit-тесты `<StateBadge>`
    - Файл `frontend/src/components/anti-ban/__tests__/StateBadge.test.tsx` — снапшот цветов и aria
    - _Requirements: 3.1_

- [x] 21. Создать `<PreFlightModal>` компонент
  - [x] 21.1 Реализовать `frontend/src/components/anti-ban/PreFlightModal.tsx`
    - Получает `kind`, `total`, `config`, `onConfirm`, `onCancel`
    - Показывает `computeEta(config, total)` (форматированно), `computeRisk(total)`, чекбокс «Я понимаю риски» (изначально не отмечен), кнопки «Запустить»/«Отмена»
    - Кнопка «Запустить» отключена, пока чекбокс не отмечен
    - На «Отмена» вызывает `onCancel` и не отправляет запросов
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - [ ]* 21.2 Property test 22: кнопка «Запустить» отключена до отметки
    - Файл `frontend/src/components/anti-ban/__tests__/property-22-launch-disabled.test.tsx` (fast-check + RTL)
    - **Property 22: PreFlight launch button disabled until checked**
    - **Validates: Requirements 6.4, 6.5**

- [x] 22. Создать `<StopButton>` компонент
  - [x] 22.1 Реализовать `frontend/src/components/anti-ban/StopButton.tsx`
    - Кнопка вызывает `useBulkOperation.stop()`
    - Дизейблится после клика, разблокировка по `finished` или таймауту 5 секунд (двойной клик безопасен — endpoint идемпотентен)
    - _Requirements: 5.1, 5.2_
  - [ ]* 22.2 Unit-тест идемпотентности `<StopButton>`
    - Файл `frontend/src/components/anti-ban/__tests__/StopButton.test.tsx`
    - _Requirements: 5.1_

- [x] 23. Создать `<AntiBanSettingsForm>` и обновить страницу настроек
  - [x] 23.1 Реализовать `frontend/src/components/anti-ban/AntiBanSettingsForm.tsx`
    - Поля для всех параметров `AntiBanConfig`, валидация Requirement 9.3 на клиенте
    - Предупреждающий блок «Текущее значение `delay_min` повышает риск блокировки. Рекомендуется значение не ниже 3.0 секунды.» при `delay_min < 1.0`
    - Сабмит через `PUT /api/anti-ban-config`, обработка HTTP 400 (показ списка нарушений)
    - _Requirements: 9.1, 9.3, 9.4_
  - [x] 23.2 Встроить форму в `frontend/src/app/dashboard/settings/page.tsx`
    - Загрузить текущий конфиг через `GET /api/anti-ban-config` при монтировании
    - _Requirements: 9.1_
  - [ ]* 23.3 Property test 30: предупреждение iff `delay_min` ниже порога
    - Файл `frontend/src/components/anti-ban/__tests__/property-30-warning.test.tsx` (fast-check + RTL)
    - **Property 30: Settings warning iff delay_min below safe threshold**
    - **Validates: Requirements 9.4**

- [x] 24. Создать `<IncidentList>` и обновить страницу истории
  - [x] 24.1 Реализовать `frontend/src/components/anti-ban/IncidentList.tsx`
    - Группировка записей по дате (`created_at` → `YYYY-MM-DD`)
    - Иконки/цвета по `kind`
    - _Requirements: 8.4_
  - [x] 24.2 Обновить `frontend/src/app/dashboard/history/page.tsx`
    - Раздел «Активные операции» с кнопками «Стоп» (для `running`) и «Возобновить» (для `paused`/`aborted`)
    - Раздел «Инциденты» с `<IncidentList>` (данные через `GET /api/incidents`)
    - _Requirements: 7.6, 8.3, 8.4_
  - [ ]* 24.3 Property test 25: страница показывает только активные и возобновляемые
    - Файл `frontend/src/app/dashboard/history/__tests__/property-25-history.test.tsx` (fast-check + RTL)
    - **Property 25: History page renders active and resumable runs**
    - **Validates: Requirements 7.6**

- [x] 25. Подключить компоненты в дашборд
  - [x] 25.1 Интегрировать `<PreFlightModal>` + `useBulkOperation` + `<StopButton>` в `frontend/src/app/dashboard/contacts/page.tsx`
    - Открытие модалки на «Проверить N номеров», старт через `useBulkOperation` после подтверждения, кнопка «Стоп» рядом с прогрессом
    - _Requirements: 5.1, 5.6, 6.1, 6.6_
  - [x] 25.2 Интегрировать `<PreFlightModal>` + `useBulkOperation` + `<StopButton>` в `frontend/src/app/dashboard/broadcast/page.tsx`
    - Аналогично для рассылки
    - _Requirements: 5.1, 5.6, 6.1, 6.6_
  - [x] 25.3 Добавить `<StateBadge>` в `frontend/src/app/dashboard/layout.tsx`
    - Бейдж в шапке дашборда, обновление через SSE-событие `state`
    - _Requirements: 3.1, 3.2_

- [ ] 26. Интеграционные тесты
  - [ ]* 26.1 Integration test: полный цикл массовой проверки
    - Файл `tests/integration/test_bulk_check_full_cycle.py`
    - Старт → 3 контакта → finish; проверка `OperationRun` и `CheckResult` строк
    - _Requirements: 1.1, 7.1, 7.2, 7.3_
  - [ ]* 26.2 Integration test: возобновление рассылки
    - Файл `tests/integration/test_broadcast_resume.py`
    - Старт, abort на середине, resume, завершение; нет повторных контактов
    - _Requirements: 7.4, 10.2_
  - [ ]* 26.3 Integration test: автостоп при unhealthy state
    - Файл `tests/integration/test_state_unhealthy_aborts.py`
    - Мок `getStateInstance` → `yellowCard` в середине; abort + IncidentLog
    - _Requirements: 3.4, 3.5_

- [x] 27. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP, но они критичны для подтверждения 32 correctness properties из дизайна.
- Каждая property-тест-задача — отдельный файл, чтобы избежать конфликтов параллельной записи и упростить параллельное исполнение.
- Все источники недетерминизма (`time.time`, `time.sleep`, `random`) внедряются через DI; в тестах подменяются на `FakeClock`/`FakeSleep`/`Random(seed)` (см. Testing Strategy дизайна).
- `try/finally` в worker-потоках гарантирует сброс глобальных флагов; Watchdog — внешняя страховка.
- `app.py` модифицируется множеством задач — они сериализованы по волнам в графе зависимостей, чтобы избежать конфликтов записи в один файл.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "9.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "4.2", "9.2"] },
    { "id": 2, "tasks": ["2.3", "3.2", "3.3", "3.4", "3.5", "3.6", "5.1", "6.1", "8.1"] },
    { "id": 3, "tasks": ["5.2", "6.2", "7.1", "8.2", "8.3"] },
    { "id": 4, "tasks": ["6.3", "7.2", "7.3", "11.1"] },
    { "id": 5, "tasks": ["11.2", "11.3", "11.4", "11.5", "11.6", "12.1"] },
    { "id": 6, "tasks": ["12.2", "13.1"] },
    { "id": 7, "tasks": ["13.2", "13.3", "13.4", "13.5", "14.1"] },
    { "id": 8, "tasks": ["14.2", "15.1"] },
    { "id": 9, "tasks": ["16.1", "16.2", "16.3", "18.1"] },
    { "id": 10, "tasks": ["18.2", "18.3", "19.1", "20.1", "21.1", "22.1", "23.1", "24.1"] },
    { "id": 11, "tasks": ["19.2", "20.2", "21.2", "22.2", "23.2", "23.3", "24.2", "24.3", "25.3"] },
    { "id": 12, "tasks": ["25.1", "25.2", "26.1", "26.2", "26.3"] }
  ]
}
```
