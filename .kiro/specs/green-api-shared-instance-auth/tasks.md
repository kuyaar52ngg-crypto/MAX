# Implementation Plan: green-api-shared-instance-auth

## Overview

Реализация выполняется в восемь этапов: сначала серверные helpers
(`frontend/src/lib/green-api/`), затем четыре новых API route и
расширение существующего `POST /api/green-instances`, далее Python
Health_Check_Job, после — фронтовые хуки, компоненты, страница настроек,
wire-up и один E2E-сценарий. Каждое property из design.md (P1–P12)
превращается в отдельную property-тестовую подзадачу с явной ссылкой
на номер property и валидируемое требование.

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Tasks

- [ ] 1. Server-side helpers в `frontend/src/lib/green-api/`
  - [ ] 1.1 Определить типы и контракты в `types/contracts.ts`
    - Создать файл `frontend/src/lib/green-api/types/contracts.ts`
    - Экспортировать `InstanceStatus`, `DiagnosticErrorCode`, `DiagnosticError`, `ClientResult<T>`
    - Экспортировать request/response shape для всех 4 новых routes (`GetStateResponse`, `GetQRResponse`, `PostReauthRequest/Response`, `PostCredentialsRequest/Response`, `ApiErrorResponse`)
    - Экспортировать data shapes GREEN API (`GetStateInstanceData`, `GetQRData`, `GetSettingsData`, `LogoutData`)
    - _Requirements: 6.3, 6.4, 6.5_

  - [ ] 1.2 Реализовать `ThrottleGate` в `throttle.ts`
    - Создать файл `frontend/src/lib/green-api/throttle.ts`
    - Реализовать класс `ThrottleGate` с методом `withGate<T>(instanceId, fn)`
    - Поддержать инжекцию `nowFn` и `sleepFn` для тестируемости
    - Минимальный интервал 1500ms, max queue wait 5000ms, бросать `ThrottleTimeoutError`
    - Сериализовать вызовы для одного `instanceId`, не блокировать разные `instanceId`
    - _Requirements: 6.6, 6.7_

  - [ ]* 1.3 Property test для интервала Throttle_Gate
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p2-throttle-interval.test.ts`
    - **Property 2: Throttle_Gate enforces minimum 1.5s interval per instance**
    - Использовать `vi.useFakeTimers`, `fast-check` (≥100 итераций) с `fc.array(fc.bigInt({min:1n,max:5n}))`
    - Запускать последовательность `withGate` на одном id, проверять pairwise diff ≥ 1500ms
    - Проверять, что разные id не блокируются друг другом
    - **Validates: Requirements 6.7**

  - [ ]* 1.4 Property test для сериализации Throttle_Gate
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p3-throttle-serialize.test.ts`
    - **Property 3: Throttle_Gate serializes concurrent requests per instance**
    - Параллельный launch N async-вызовов на одном `instanceId`, инструментировать `fn` счётчиком inflight
    - Проверить `max(inflight[id]) === 1` для каждого id
    - Проверить, что вызовы для разных id выполняются параллельно
    - **Validates: Requirements 6.6**

  - [ ] 1.5 Реализовать `mapHttpToDiagnostic` и `diagnosticTextFor` в `diagnostic.ts`
    - Создать файл `frontend/src/lib/green-api/diagnostic.ts`
    - `mapHttpToDiagnostic(upstreamHttpStatus, upstreamBody, cause?)` — тотальная функция: 401/403→`invalid_credentials`/HTTP 400, 466→`quota_exceeded`/HTTP 402, 429→`rate_limited`/HTTP 429, 404→`not_found`/HTTP 404, 5xx→`server_error`/HTTP 502, `timeout`→HTTP 504, `network`→HTTP 503, default→`unknown`/HTTP 500
    - `diagnosticTextFor(status: InstanceStatus)` — русский текст для каждого из 7 значений `InstanceStatus`
    - Все сообщения — русские, непустые, точные тексты из Requirement 8
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ]* 1.6 Property test для тотальности диагностического маппинга
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p4-diagnostic-total.test.ts`
    - **Property 4: Diagnostic mapping is total**
    - `fc.constantFrom(401, 403, 404, 429, 466, ...rangeOfFiveHundreds)` × `fc.constantFrom("timeout","network","abort", undefined)` → `mapHttpToDiagnostic` возвращает `DiagnosticError` с непустым русским `message`, `httpStatus ∈ [400, 599]`, валидным `code`
    - Для всех 7 `InstanceStatus` — `diagnosticTextFor(status)` непустой
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8**

  - [ ] 1.7 Реализовать `GreenAPIClient` в `client.ts`
    - Создать файл `frontend/src/lib/green-api/client.ts`
    - Класс `GreenAPIClient` с методами `getStateInstance`, `getQR`, `getSettings`, `logout`
    - Каждый метод: `throttleGate.withGate(instanceDbId, fn)` → `fetch` с `AbortSignal.timeout(15000)` → `mapHttpToDiagnostic` на ошибки
    - Никогда не возвращать и не логировать расшифрованный токен; redact в `toString`
    - _Requirements: 6.2, 6.6, 6.7, 8.1, 8.2, 8.3, 8.4_

  - [ ]* 1.8 Unit-тесты для `GreenAPIClient`
    - Файл: `frontend/src/lib/green-api/__tests__/client.test.ts`
    - Mock `fetch`, для каждого из 4 методов: 200 success, 401, 466, 429, timeout, 5xx
    - Проверить корректный `ClientResult` shape и отсутствие токена в логах
    - _Requirements: 6.2, 8.1, 8.2, 8.3, 8.4_

  - [ ] 1.9 Реализовать `Audit_Logger` в `audit.ts`
    - Создать файл `frontend/src/lib/green-api/audit.ts`
    - Экспортировать `AuditEventKind` union, `AuditEventDetails` interface, async `auditLog(eventKind, userId, details)`
    - Внутри — `prisma.incidentLog.create({ data: { user_id, kind, details, operation_run_id: null } })`
    - На исключение Prisma — `console.warn("audit_log_write_failed", { eventKind, userId, error })`, не пробрасывать
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ] 1.10 Singleton-обёртка в `index.ts`
    - Создать файл `frontend/src/lib/green-api/index.ts`
    - Экспортировать `throttleGate = new ThrottleGate()` и `greenApiClient = new GreenAPIClient(throttleGate)`
    - Реэкспортировать `auditLog`, `mapHttpToDiagnostic`, `diagnosticTextFor`, все типы из `types/contracts.ts`
    - _Requirements: 6.6, 6.7_

- [ ] 2. Чекпойнт — server-side helpers готовы
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. API routes (4 новых + расширение POST)
  - [ ] 3.1 Реализовать `GET /api/green-instances/[id]/state`
    - Файл: `frontend/src/app/api/green-instances/[id]/state/route.ts`
    - Prelude: `ensureEncryptionKey` → `auth.getUser` → `findUnique` + ownership → `decrypt(api_token)`
    - Вызвать `greenApiClient.getStateInstance` через Throttle_Gate
    - На `authorized` дополнительно `getSettings`: извлечь `phone` из `wid`, посчитать `shared_instance_warning = !!webhookUrl || outgoingWebhook === "yes"`
    - `prisma.greenInstance.update({ status, phone? })`
    - Вернуть `{ status, phone, shared_instance_warning }` без поля `api_token` и без url, содержащего токен
    - _Requirements: 4.7, 6.2, 6.5, 10.1, 10.2_

  - [ ] 3.2 Реализовать `GET /api/green-instances/[id]/qr`
    - Файл: `frontend/src/app/api/green-instances/[id]/qr/route.ts`
    - Prelude (как 3.1) + `greenApiClient.getQR` через Throttle_Gate
    - На `type === "alreadyLogged"`: дополнительно `getStateInstance` + `getSettings`, обновить БД
    - Вернуть `{ type, message, server_timestamp }` без поля `api_token`/url с токеном
    - _Requirements: 3.1, 3.2, 3.4, 6.2, 6.4_

  - [ ] 3.3 Реализовать `POST /api/green-instances/[id]/reauth`
    - Файл: `frontend/src/app/api/green-instances/[id]/reauth/route.ts`
    - Prelude + сохранить `previousStatus = row.status`
    - `greenApiClient.logout` → `getStateInstance` → на `authorized` ещё `getSettings`
    - `prisma.greenInstance.update({ status, phone? })` — НЕ трогать `is_primary`, `name`
    - Если новый статус `authorized` и `previousStatus !== "authorized"` → `auditLog("instance_reauthorized", user.id, { ..., previous_status, new_status: "authorized" })`
    - Вернуть `{ status, phone, shared_instance_warning }`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 9.2, 9.4, 9.5_

  - [ ] 3.4 Реализовать `POST /api/green-instances/[id]/credentials`
    - Файл: `frontend/src/app/api/green-instances/[id]/credentials/route.ts`
    - Prelude + валидация body: `id_instance` и `api_token` непустые после trim → 400 «Поле ... обязательно»
    - **До** записи в БД: `greenApiClient.getStateInstance(newId, newToken, newApiUrl)` — на `invalid_credentials` 400 «Неверные credentials», на другие ошибки — пробросить
    - На `authorized` ещё `getSettings` для phone и shared
    - В `prisma.$transaction`: `update({ id_instance, api_token: encrypt(newToken), api_url, status, phone })` — `is_primary` и `name` не трогать
    - После транзакции `auditLog("instance_credentials_changed", ...)` с `previous_id_instance`
    - Вернуть `{ status, phone, id_instance, api_url }` без `api_token`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3, 9.4, 9.5_

  - [ ] 3.5 Расширить существующий `POST /api/green-instances`
    - Файл: `frontend/src/app/api/green-instances/route.ts`
    - Заменить inline `fetch` на `greenApiClient.getStateInstance` через Throttle_Gate
    - На `authorized` дополнительно `getSettings`, посчитать `shared_instance_warning`, добавить в response body
    - После `prisma.greenInstance.create` для статусов `authorized`/`notAuthorized`/`starting` → `auditLog("instance_connected", user.id, { green_instance_id, id_instance, new_status, shared_instance_warning })`
    - Сохранить существующее поведение лимита 5 инстансов и валидации
    - _Requirements: 1.5, 1.7, 9.1, 9.4, 9.5, 10.1, 10.2_

  - [ ]* 3.6 Property test «никаких токенов в response»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p1-no-token-leak.test.ts`
    - **Property 1: Backend never returns decrypted token**
    - Генерировать `apiToken = fc.string({minLength: 30})`, mock GREEN API так, чтобы upstream URL содержал токен
    - Прогнать все 5 routes (`POST /api/green-instances`, `GET /state`, `GET /qr`, `POST /reauth`, `POST /credentials`)
    - Проверить, что `JSON.stringify(response.body)` и все response headers НЕ содержат decrypted token и не содержат поле `api_token`
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  - [ ]* 3.7 Property test «reauth сохраняет is_primary и name»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p5-reauth-preserves.test.ts`
    - **Property 5: Reauth_Flow preserves is_primary and name**
    - `fc.record` для GreenInstance `R0`, mock prisma + GREEN-API client
    - Прогнать reauth handler, проверить `R1.is_primary === R0.is_primary && R1.name === R0.name`; меняются только `status`, `phone`, `updated_at`
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

  - [ ]* 3.8 Property test «credentials update атомарен»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p6-credentials-atomic.test.ts`
    - **Property 6: Credentials_Update_Endpoint is atomic and preserves is_primary/name**
    - Случай успеха: все 4 поля `{id_instance, api_token, api_url, status}` обновлены согласованно; `R1.is_primary === R0.is_primary && R1.name === R0.name`; `R1.api_token !== R0.api_token` (свежий IV)
    - Случай падения `prisma.$transaction`: ни одно из 4 полей не изменилось
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.6**

  - [ ]* 3.9 Property test «audit_log пишется всегда»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p8-audit-always.test.ts`
    - **Property 8: Audit_Logger always writes for state-changing actions**
    - Прогнать `POST /api/green-instances` (3 терминальных статуса), `POST /reauth` (→authorized), `POST /credentials` (200) — после успеха ровно одна новая строка в `incident_log` с правильным `kind`, `user_id`, `green_instance_id`
    - Инжектировать сбой `incidentLog.create` — originating action всё равно возвращает success, console.warn зарегистрирован
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**

  - [ ]* 3.10 Property test «детектор Shared_Instance_Warning»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p12-shared-detection.test.ts`
    - **Property 12: Shared_Instance_Warning detection is a pure function of getSettings**
    - `fc.record({ webhookUrl: fc.option(fc.string()), outgoingWebhook: fc.constantFrom("yes","no", undefined) })` → `flag === ((webhookUrl is non-empty string) || (outgoingWebhook === "yes"))`
    - Проверить присутствие поля `shared_instance_warning` в ответах `POST /api/green-instances`, `POST /reauth`, `GET /state` (на authorized), `POST /credentials` (на authorized)
    - **Validates: Requirements 10.1, 10.2, 10.3**

  - [ ]* 3.11 Integration-тесты для 4 новых routes
    - Файлы: `frontend/src/lib/green-api/__tests__/integration/state.test.ts`, `qr.test.ts`, `reauth.test.ts`, `credentials.test.ts`
    - Mock GREEN API через `msw`, реальный prisma на тестовой БД
    - `state.test.ts`: 200 authorized, 200 notAuthorized, 401, 466, timeout
    - `qr.test.ts`: qrCode, alreadyLogged (с побочным БД-обновлением), error
    - `reauth.test.ts`: happy path и logout 401
    - `credentials.test.ts`: happy path и invalid creds (БД не меняется)
    - _Requirements: 3.1, 3.4, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 8.1, 8.2, 8.3, 8.4_

- [ ] 4. Чекпойнт — все API routes готовы
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Health_Check_Job (Python, Flask)
  - [ ] 5.1 Реализовать `InstanceThrottleGate` в `anti_ban/instance_throttle.py`
    - Создать файл `anti_ban/instance_throttle.py`
    - Класс с `with_gate(instance_id)` контекст-менеджером (stdlib `threading.Lock` per-instance, минимальный интервал 1.5s через `time.monotonic`)
    - Никаких вложенных захватов — без deadlock-риска
    - _Requirements: 6.6, 6.7, 7.6_

  - [ ] 5.2 Реализовать `InstanceHealthMonitor` в `anti_ban/instance_health_monitor.py`
    - Создать файл `anti_ban/instance_health_monitor.py`
    - Класс `InstanceHealthMonitor(threading.Thread)` с DI: `tick_interval_seconds=300`, `per_instance_timeout_seconds=10`, `db_session_factory`, `throttle_gate`, `audit_logger`, `clock`
    - `_tick()`: SELECT инстансы с `status != 'blocked'` → для каждого `with throttle_gate.with_gate(id)` → `getStateInstance` (timeout 10s) → UPDATE `status` + `updated_at`
    - На переход `previous_status NOT IN ('yellowCard','blocked') AND new_status IN ('yellowCard','blocked')` → INSERT `incident_log` `kind='instance_status_degraded'`
    - Любое исключение по одной записи — `logger.warning`, `continue`; тик не валится
    - `run()` цикл с прерываемым `Event.wait(tick_interval_seconds)`; `stop()` сетит Event
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ] 5.3 Wire-up в `app.py`
    - В `app.py` добавить `_ensure_instance_health_monitor()` (по образцу существующего `_ensure_state_monitor`)
    - Eager start при загрузке приложения сразу после импортов
    - `atexit`-хук вызывает `_instance_health_monitor.stop()`
    - Логировать `anti_ban.InstanceHealthMonitor started`
    - _Requirements: 7.1_

  - [ ]* 5.4 Property test «Health_Check_Job отказоустойчив»
    - Файл: `tests/test_instance_health_monitor.py`
    - **Property 7: Health_Check_Job is fault-tolerant**
    - `hypothesis` (≥100 примеров): `instances = st.lists(instance_strategy())`, `failing_indexes = st.sets(...)`
    - `_tick()` не пробрасывает исключений; failing записи не изменены в БД; non-failing обновлены; для каждой failing — server-log warning
    - **Validates: Requirements 7.4**

  - [ ]* 5.5 Property test «корректность одного тика»
    - Файл: `tests/test_instance_health_monitor.py`
    - **Property 11: Health_Check_Job tick correctness**
    - `getStateInstance` вызывается ТОЛЬКО для записей с `status != "blocked"`
    - После тика для каждого успешно ответившего инстанса `db.row.status === response.stateInstance && updated_at >= tick_start`
    - Для перехода `prev ∉ {yellowCard, blocked} && new ∈ {yellowCard, blocked}` — ровно одна новая `incident_log` строка `kind='instance_status_degraded'`; для остальных переходов — ноль новых degradation-строк
    - **Validates: Requirements 7.2, 7.3, 7.5**

  - [ ]* 5.6 Unit-тесты для монитора
    - Файл: `tests/test_instance_health_monitor.py`
    - `_tick` с одним инстансом и mock 200 → БД обновлена
    - `_tick` пропускает запись `status='blocked'`
    - Cadence: с `FakeClock` advance 5 минут → один тик; advance 10 минут → два тика
    - `_tick` не валится при сбое `incident_log.insert`
    - _Requirements: 7.1, 7.2, 7.4_

- [ ] 6. Чекпойнт — Health_Check_Job работает
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Frontend hooks
  - [ ] 7.1 Реализовать `useQRRefresh`
    - Файл: `frontend/src/lib/green-api/hooks/useQRRefresh.ts`
    - Циклит `GET /api/green-instances/[id]/qr` каждые `intervalMs=25000`
    - На `type === "qrCode"` обновляет `qrImageBase64`
    - На `type === "alreadyLogged"` зовёт `onAlreadyLogged`
    - На `type === "error"` зовёт `onError(message)` и останавливает цикл
    - Cleanup при размонтировании / `open=false`: `AbortController.abort` в течение ≤ 1s
    - _Requirements: 3.1, 3.2, 3.4, 3.6, 3.7_

  - [ ] 7.2 Реализовать `useStatePoll`
    - Файл: `frontend/src/lib/green-api/hooks/useStatePoll.ts`
    - Циклит `GET /api/green-instances/[id]/state` каждые `intervalMs=3000`
    - Отслеживает переходы `Instance_Status`, на `authorized` зовёт `onAuthorized({ phone, sharedInstanceWarning })`
    - Допускает одиночные ошибки HTTP, после 5 подряд — пробрасывает ошибку через `onTransition` или `lastError`
    - Cleanup как в 7.1
    - Опциональный pause на `visibilitychange → hidden`
    - _Requirements: 2.4, 2.5, 3.3, 3.5, 3.7_

  - [ ]* 7.3 Unit-тесты для хуков
    - Файлы: `frontend/src/lib/green-api/__tests__/useQRRefresh.test.ts`, `useStatePoll.test.ts`
    - `vi.useFakeTimers`, `@testing-library/react` `renderHook`
    - QR: смена картинки на `qrCode`, остановка на `error`, success-callback на `alreadyLogged`, остановка ≤1s при unmount
    - State: переход `notAuthorized → authorized` запускает `onAuthorized`
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.7_

- [ ] 8. Frontend components
  - [ ] 8.1 Реализовать `DiagnosticMessage`
    - Файл: `frontend/src/components/green-api/DiagnosticMessage.tsx`
    - Props: `status?: InstanceStatus`, `errorCode?: DiagnosticErrorCode`, `variant?: "inline" | "toast" | "banner"`
    - Чистая функция `diagnosticTextFor(input)` импортируется из `@/lib/green-api/diagnostic`
    - Стили — только из `Design/DESIGN.md` токенов
    - _Requirements: 8.5, 8.6, 8.7, 8.8_

  - [ ] 8.2 Реализовать `InstructionsStep`
    - Файл: `frontend/src/components/green-api/InstructionsStep.tsx`
    - Статический компонент с инструкцией по сбору `idInstance` и `apiTokenInstance` от владельца
    - Иконки `lucide-react/Info`, токены `Engagement Gold`
    - _Requirements: 1.1, 1.2_

  - [ ] 8.3 Реализовать `CredentialsForm`
    - Файл: `frontend/src/components/green-api/CredentialsForm.tsx`
    - Поля: `idInstance` (required), `apiTokenInstance` (required), `name` (optional), скрытое `apiUrl` (default `https://api.green-api.com`)
    - Inline-валидация: пустые `idInstance`/`apiTokenInstance` блокируют submit с `DiagnosticMessage`, называющим конкретное поле
    - Если `name` пуст — подставлять `Инстанс {idInstance.slice(-4)}` перед `onSubmit`
    - _Requirements: 1.3, 1.4, 1.6_

  - [ ]* 8.4 Property test для валидации формы
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p9-validation.test.ts`
    - **Property 9: Connection_Wizard validation rejects empty credentials and computes default name**
    - `fc.string()` × `fc.string()` где хотя бы одно — пустое или whitespace → submit заблокирован, `fetch` не вызван, `DiagnosticMessage` называет пустое поле
    - Для непустого `idInstance` (длина ≥ 4) и пустого `name` → перед `POST` подставлен `"Инстанс " + idInstance.slice(-4)`
    - **Validates: Requirements 1.4, 1.6**

  - [ ] 8.5 Реализовать `QRModal`
    - Файл: `frontend/src/components/green-api/QRModal.tsx`
    - Использует `useQRRefresh` и `useStatePoll`
    - Рендер PNG из `qrImageBase64`, индикатор `currentStatus`, спиннер на `isFetching`
    - На `onAuthorized` — закрыть модалку, передать `phone` и `sharedInstanceWarning`
    - На manual close — оба хука стопятся ≤ 1s через AbortController
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ] 8.6 Реализовать `SharedInstanceWarningBanner`
    - Файл: `frontend/src/components/green-api/SharedInstanceWarningBanner.tsx`
    - Props: `visible`, `onDismiss?`
    - Точный текст из Requirement 10.3, фон `bg-canary-yellow/40`, иконка `AlertTriangle`
    - _Requirements: 10.3, 10.4_

  - [ ] 8.7 Реализовать `ConnectionWizard` (state machine)
    - Файл: `frontend/src/components/green-api/ConnectionWizard.tsx`
    - State machine `instructions → credentials → status_branch → {success | qr | starting | yellow_card | blocked | sleep_mode | error}`
    - Reducer с детерминированным маппингом `POST /api/green-instances` response → шаг
    - На шаге `starting` — активный `useStatePoll`, переход на `qr` (notAuthorized) или `success` (authorized)
    - На `success` — показ `phone` и `SharedInstanceWarningBanner` если `shared_instance_warning`
    - Поддержать prop `reauthInstanceId` для входа сразу в `qr` после reauth
    - На лимит 5 инстансов сервер возвращает 400 — оставить на `credentials` и показать сообщение сервера
    - _Requirements: 1.1, 1.5, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.4, 4.5, 10.3_

  - [ ]* 8.8 Property test «ветвление wizard по статусу»
    - Файл: `frontend/src/lib/green-api/__tests__/properties/p10-status-branching.test.ts`
    - **Property 10: Connection_Wizard branches correctly on POST response**
    - `fc.constantFrom(...allInstanceStatuses, "http_error")` → симулировать POST-ответ → проверить `wizard.step` соответствует таблице маппинга (authorized→success, notAuthorized→qr, starting→starting, yellowCard→yellow_card, blocked→blocked, sleepMode→sleep_mode, http_error→error)
    - Маппинг исчерпывающий — wizard никогда не остаётся в `status_branch`
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

  - [ ] 8.9 Реализовать `ChangeCredentialsModal`
    - Файл: `frontend/src/components/green-api/ChangeCredentialsModal.tsx`
    - Поля: новые `idInstance`, `apiTokenInstance`, опциональный `apiUrl`
    - Submit вызывает `POST /api/green-instances/[id]/credentials`
    - 200 → закрыть, toast с новым статусом; 400 «Неверные credentials» → inline error под полями (`DiagnosticMessage`)
    - _Requirements: 5.1, 5.3_

- [ ] 9. Чекпойнт — фронтовые компоненты готовы
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Settings page
  - [ ] 10.1 Реализовать страницу `/dashboard/settings/instances`
    - Файл: `frontend/src/app/dashboard/settings/instances/page.tsx`
    - Загрузка списка через `GET /api/green-instances` (без `api_token`)
    - Колонки: `Имя`, `idInstance` (с кнопкой копирования), `Phone`, `Статус` (бейдж + DiagnosticMessage tooltip), `is_primary` (переключатель), `Действия`
    - Цвета бейджей по статусам — точно по таблице из design.md (`authorized→bg-mint-green`, `starting→bg-subtle-lavender`, `notAuthorized→bg-light-taupe`, `yellowCard→bg-canary-yellow`, `sleepMode→bg-whisper-gray`, `blocked→bg-leadgen-red/15`, `unknown→bg-whisper-gray`)
    - Кнопка «Подключить новый инстанс» открывает `ConnectionWizard`
    - _Requirements: 4.1, 4.6_

  - [ ] 10.2 Кнопки действий в строке инстанса
    - В том же файле страницы (или вынести в `InstanceRow.tsx`): «Перепривязать» (только для `Instance_Status ∈ {notAuthorized, yellowCard, blocked, sleepMode}`), «Проверить сейчас» (всегда), «Сменить credentials», «Удалить»
    - «Перепривязать»: `POST /api/green-instances/[id]/reauth` → `ConnectionWizard` с `reauthInstanceId`
    - «Проверить сейчас»: `GET /api/green-instances/[id]/state` → обновить отображённый статус и БД одним запросом
    - «Сменить credentials»: открыть `ChangeCredentialsModal`
    - `SharedInstanceWarningBanner` рядом со строкой, если для записи когда-либо наблюдался `shared_instance_warning === true` (хранить в localStorage до dismiss)
    - _Requirements: 4.1, 4.2, 4.6, 4.7, 5.1, 10.4_

- [ ] 11. Wire-up
  - [ ] 11.1 Добавить навигационную ссылку в дашборд
    - Файл: `frontend/src/components/dashboard/...` (существующий sidebar/nav компонент)
    - Добавить пункт «GREEN API инстансы» с `href="/dashboard/settings/instances"`
    - _Requirements: 4.6_

- [ ] 12. Чекпойнт — UI собран, навигация работает
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. E2E test
  - [ ]* 13.1 Playwright сценарий «подключение нового инстанса»
    - Файл: `frontend/tests/e2e/connect-instance.spec.ts`
    - Войти как тестовый пользователь, открыть `/dashboard/settings/instances`, нажать «Подключить новый инстанс»
    - Пройти `Instructions_Step` → `Credentials_Form`, ввести фейковые `idInstance` и `apiToken`
    - Mock GREEN API возвращает `{ stateInstance: "notAuthorized" }` на POST
    - Ассертить открытие `QR_Modal` и наличие QR-картинки
    - На следующем `GET /state` mock возвращает `{ stateInstance: "authorized" }` + `getSettings` с `wid`
    - Ассертить: модалка закрылась, в списке появился новый инстанс с бейджем `authorized` и phone
    - _Requirements: 1.1, 1.5, 2.2, 2.5, 3.1, 3.5_

- [ ] 14. Финальный чекпойнт — все тесты проходят
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Подзадачи с `*` опциональные (тесты) и могут быть пропущены при ускоренном MVP, но они закрывают universal properties из design.md.
- Каждое property из P1–P12 представлено отдельной подзадачей с явной ссылкой на номер property и список валидируемых требований.
- TS property-тесты используют `fast-check` (≥100 итераций), Python property-тесты используют `hypothesis` (≥100 примеров).
- Чекпойнты `[~]` отмечают границы этапов, между которыми удобно прогнать `npm run test` и `pytest`.
- Никаких новых Prisma-миграций — спека переиспользует существующие модели `GreenInstance` и `IncidentLog`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.5", "1.9", "5.1"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.6", "1.7", "5.2"] },
    { "id": 3, "tasks": ["1.8", "1.10", "5.3", "5.4", "5.5", "5.6"] },
    { "id": 4, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "7.1", "7.2"] },
    { "id": 5, "tasks": ["3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "7.3", "8.1", "8.2", "8.3", "8.6"] },
    { "id": 6, "tasks": ["8.4", "8.5", "8.9"] },
    { "id": 7, "tasks": ["8.7"] },
    { "id": 8, "tasks": ["8.8", "10.1"] },
    { "id": 9, "tasks": ["10.2"] },
    { "id": 10, "tasks": ["11.1"] },
    { "id": 11, "tasks": ["13.1"] }
  ]
}
```
