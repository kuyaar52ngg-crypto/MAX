# Implementation Plan: Anti-Ban UX Overhaul

## Overview

Эта фича — UX-надстройка над уже работающим движком анти-бана из спеки
`anti-ban-protection`. Поэтому план идёт от данных и бэкенда к фронтенду,
сначала минимальные аддитивные правки в Prisma и Python (миграция
`Profile.anti_ban_tour_completed_at`, расширения `RateLimiter` /
`AuditLogger`, новый `StatusAggregator` и эндпойнт
`GET /api/anti-ban/status`), затем новый Next.js-маршрут
`POST /api/profile/anti-ban-tour-completed`, потом чистые TypeScript-
библиотеки (пресеты, детектор активного пресета, метаданные полей,
симулятор, импорт/экспорт, валидация), хуки `useLiveStatus` /
`useAntiBanForm`, UI-компоненты, и в конце — сборная страница
`/dashboard/settings/anti-ban` и e2e-тест.

Реализация ведётся на TypeScript (фронтенд, Next.js API) и Python
(Flask + `anti_ban/` пакет) — языки определены существующим стеком и
дизайном, выбирать заново не нужно.

## Tasks

- [ ] 1. Database schema migration
  - [ ] 1.1 Добавить поле `anti_ban_tour_completed_at` в Prisma-модель `Profile`
    - Изменить `frontend/prisma/schema.prisma`: добавить
      `anti_ban_tour_completed_at  DateTime?` в модель `Profile`
      рядом с `welcomed_at`
    - Создать миграцию
      `frontend/prisma/migrations/20260601_add_profile_anti_ban_tour_completed_at/migration.sql`
      с `ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS
      "anti_ban_tour_completed_at" TIMESTAMPTZ;`
    - Запустить `npx prisma generate` для обновления клиента
    - _Requirements: 6.1_

- [ ] 2. Backend (Flask): rate limiter / audit / status endpoint
  - [ ] 2.1 Расширить `RateLimiter` методом `window_count`
    - В `anti_ban/rate_limiter.py` добавить публичный метод
      `window_count(*, seconds: int) -> int`, читающий длину
      существующего in-memory `self._window` за `seconds` секунд
      (под существующим `self._lock`, без побочных эффектов)
    - Не менять остальное поведение `RateLimiter`
    - _Requirements: 3.1_

  - [ ]* 2.2 Property test для `RateLimiter.window_count`
    - Файл `tests/anti_ban/test_rate_limiter_window_count_property.py`
    - **Property 4 (часть про current_rps): Live_Status_Endpoint returns valid shape**
    - С помощью `hypothesis` сгенерировать произвольные
      timestamps, наполнить `_window`, проверить что
      `window_count(seconds=60) >= 0` и равно числу записей моложе
      60 секунд от now
    - **Validates: Requirements 3.1**

  - [ ] 2.3 Расширить `AuditLogger` методами `count_incidents_kind` и `has_recent_incident`
    - В `anti_ban/audit.py` добавить
      `count_incidents_kind(user_id: str, *, kind: str, window: Literal["hour","day"]) -> int`
      — thin SQL-обёртка `SELECT COUNT(*) FROM incident_log WHERE
      user_id=? AND kind=? AND created_at > now - <window>`
    - Добавить
      `has_recent_incident(user_id: str, kinds: Iterable[str], *, window: Literal["hour","day"]) -> bool`
      — thin SQL `EXISTS` с тем же временным фильтром
    - _Requirements: 3.1, 3.4, 3.5, 3.6_

  - [ ] 2.4 Реализовать `StatusAggregator` в новом модуле
    - Создать `anti_ban/status_aggregator.py` с `@dataclass(frozen=True)`
      `LiveStatus` (поля: `current_rps: float`, `hourly_usage_pct:
      float`, `daily_usage_pct: float`, `watchdog_state:
      Literal["ok","warning","alarm"]`, `recent_429_count: int`,
      `hourly_limit_eta_minutes: Optional[float]`,
      `daily_limit_eta_minutes: Optional[float]`)
    - Реализовать класс `StatusAggregator(rate_limiter, audit_logger,
      registry, config_loader)` с методом
      `collect(user_id: str) -> LiveStatus` по формулам из design.md
      (`current_rps = window_count(seconds=60) / 60.0`,
      `hourly_usage_pct = min(100, check_h / hourly_check_limit *
      100)`, `daily_usage_pct = min(100, max(check_d/daily_check_limit,
      msg_d/daily_message_limit) * 100)`)
    - Реализовать `_compute_watchdog_state` с константами
      `ALARM_KINDS = {yellowCard, blocked, notAuthorized, quota_466,
      watchdog_reset}`, `WARNING_KINDS = {rate_limit_429,
      zero_response_ratio}`
    - Реализовать `_eta(remaining, rps)` возвращающий `None` при
      `rps <= 0` или `remaining <= 0`, иначе `(remaining / rps) / 60`
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 2.5 Property test для `_compute_watchdog_state` и `_eta`
    - Файл `tests/anti_ban/test_status_aggregator_property.py`
    - **Property 5: Watchdog_State and ETA computations are pure and follow rules**
    - **Validates: Requirements 3.4, 3.5, 3.6, 3.7**

  - [ ]* 2.6 Property test для `StatusAggregator.collect` shape
    - Тот же файл `tests/anti_ban/test_status_aggregator_property.py`
    - **Property 4: Live_Status_Endpoint returns valid shape**
    - С помощью `hypothesis` гонять произвольные счётчики и
      инциденты через мок `RateLimiter`/`AuditLogger`, проверять
      что все 7 полей `LiveStatus` имеют правильные типы и
      инварианты (`0 <= *_pct <= 100`, `current_rps >= 0`,
      `recent_429_count >= 0`, `watchdog_state ∈ {ok, warning,
      alarm}`, ETA либо `None` либо `>= 0`)
    - **Validates: Requirements 3.1**

  - [ ] 2.7 Реализовать Flask-маршрут `GET /api/anti-ban/status`
    - В `app.py` добавить обработчик `api_anti_ban_status_get` по
      пути `/api/anti-ban/status` (метод GET) — авторизация через
      существующий `_require_user_id(request)`
    - Получить инстанс `RateLimiter` через тот же селектор
      `_rate_limiter_for(user_id)`, что и `Bulk_Operation`
    - Сконструировать `StatusAggregator(...)` и вернуть
      `jsonify(asdict(snapshot)), 200`
    - _Requirements: 3.1_

  - [ ]* 2.8 Integration test для эндпойнта `GET /api/anti-ban/status`
    - Файл `tests/test_status_endpoint.py`
    - Smoke: пустое состояние возвращает 200 с дефолтным shape;
      наполненный `RateLimiter._window` и `IncidentLog` дают
      ожидаемые значения; неавторизованный запрос → 401
    - _Requirements: 3.1_

- [ ] 3. Checkpoint - Backend готов
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Backend (Next.js API): tour completion route
  - [ ] 4.1 Создать `POST /api/profile/anti-ban-tour-completed`
    - Файл `frontend/src/app/api/profile/anti-ban-tour-completed/route.ts`
    - Скопировать структуру `frontend/src/app/api/profile/welcome/route.ts`
      (тот же `getUser` через Supabase, `prismaRetry`, `jsonResponse`)
    - Поведение: 401 если нет user; если `existing.anti_ban_tour_completed_at`
      уже не null — вернуть существующее значение (идемпотентность);
      если нет profile — создать с `anti_ban_tour_completed_at: new Date()`;
      иначе — UPDATE поля на `new Date()`
    - Возвращать `{ anti_ban_tour_completed_at: <ISO> }` со статусом 200
    - _Requirements: 6.5, 6.6_

  - [ ]* 4.2 Property test идемпотентности
    - Файл `frontend/__tests__/api/anti-ban-tour-completed.property.test.ts`
    - **Property 9: Tour-completion POST is idempotent**
    - Использовать `fast-check` + in-memory mock prisma; для
      `n in [1..10]` последовательных вызовов проверить что все
      возвращают 200 и timestamp не меняется после первого
    - **Validates: Requirements 6.6**

- [ ] 5. Shared frontend libraries (pure functions)
  - [ ] 5.1 Описать TypeScript-типы AntiBanConfig
    - Файл `frontend/src/lib/anti-ban/types.ts`
    - Экспортировать `AntiBanConfig` интерфейс со всеми 24 полями
      (`delay_min`, `delay_max`, `batch_size`, `long_pause_every_n`,
      `long_pause_seconds`, `daily_check_limit`, `hourly_check_limit`,
      `daily_message_limit`, `broadcast_delay_min`,
      `broadcast_jitter_max`, `state_poll_interval_seconds`,
      `watchdog_timeout_seconds`, `watchdog_check_interval_seconds`,
      `sse_client_timeout_seconds`, `max_retries`,
      `max_consecutive_429`, `sliding_window_n`, `sliding_window_t`,
      `incident_history_limit`, `backoff_base_seconds`,
      `warn_on_zero_response_ratio`, `response_ratio_window_hours`,
      `response_ratio_min_outgoing`)
    - Экспортировать тип `Incident` и `IncidentKind` из дизайна
    - _Requirements: 1.1, 2.1, 4.3_

  - [ ] 5.2 Реализовать `PRESET_CATALOG` константу
    - Файл `frontend/src/lib/anti-ban/presets.ts`
    - Экспортировать `PresetId = "safe" | "balanced" | "aggressive"`
    - Экспортировать `PRESET_CATALOG: Record<PresetId, AntiBanConfig>`
      ровно с теми значениями полей, что зафиксированы в design.md
      (`safe`: delay_min=5.0, delay_max=12.0, daily_check_limit=500,
      hourly_check_limit=100, ...; `balanced` ≡ дефолтам Requirement
      9.2 движка; `aggressive`: delay_min=1.5, delay_max=4.0,
      daily_check_limit=2000, ...)
    - _Requirements: 1.1, 1.3, 1.4, 1.5_

  - [ ]* 5.3 Property test для `PRESET_CATALOG` (валидность всех пресетов)
    - Файл `frontend/__tests__/anti-ban/presets.property.test.ts`
    - **Property 1: Preset application is total and valid**
    - Для каждого `preset_id ∈ {safe, balanced, aggressive}`:
      проверить что `PRESET_CATALOG[preset_id]` содержит ровно 24 поля
      из `AntiBanConfig` и проходит `validateConfig` (см. задачу 5.7)
      без нарушений
    - **Validates: Requirements 1.2, 1.4, 1.5**

  - [ ] 5.4 Реализовать `detectActivePreset`
    - Файл `frontend/src/lib/anti-ban/active-preset.ts`
    - Экспортировать тип `ActivePreset = PresetId | "custom"`
    - Реализовать чистую функцию `detectActivePreset(values:
      AntiBanConfig): ActivePreset` через `deepEqual` против каждого
      пресета из `PRESET_CATALOG`; вернуть `"custom"` если ни один
      не совпадает
    - _Requirements: 1.6, 1.8, 1.9_

  - [ ]* 5.5 Property test для `detectActivePreset`
    - Файл `frontend/__tests__/anti-ban/active-preset.property.test.ts`
    - **Property 2: Active_Preset detection is total and matches deepEqual**
    - С `fast-check` гонять произвольные `AntiBanConfig`-объекты
      (используя preset как базу + случайные мутации); проверить
      что результат всегда в `{safe, balanced, aggressive, custom}`
      и совпадает с deepEqual-инвариантом
    - **Validates: Requirements 1.6, 1.8, 1.9**

  - [ ] 5.6 Реализовать `FIELD_METADATA` константу
    - Файл `frontend/src/lib/anti-ban/field-metadata.ts`
    - Экспортировать тип `FieldGroupId` (7 значений: `pacing`,
      `limits`, `batches`, `jitter`, `watchdog`, `window_audit`,
      `response`) и интерфейс `FieldMeta`
    - Экспортировать `FIELD_METADATA: ReadonlyArray<FieldMeta>` с
      записью на каждое из 24 полей `AntiBanConfig` (label,
      description одно предложение, impact в формате
      «увеличение → ...; уменьшение → ...», group)
    - Значения брать ровно из таблицы в design.md
    - _Requirements: 2.1, 2.3, 2.5_

  - [ ]* 5.7 Property test для `FIELD_METADATA` (полнота покрытия)
    - Файл `frontend/__tests__/anti-ban/field-metadata.property.test.ts`
    - **Property 3: FIELD_METADATA covers all AntiBanConfig fields**
    - Для каждого ключа в `keyof AntiBanConfig`: ровно одна запись с
      `meta.name === field`; `description` и `impact` непустые;
      `group` принадлежит множеству 7 групп
    - **Validates: Requirements 2.1, 2.5**

  - [ ] 5.8 Реализовать чистую функцию `computeSimulationResult`
    - Файл `frontend/src/lib/anti-ban/simulator.ts`
    - Экспортировать типы `SimulationInput` (поля `message_count:
      number`, `batch_size: number`) и `SimulationResult` (поля
      `eta_seconds`, `long_pause_count`, `expected_retry_count`,
      `hourly_limit_breach_risk: "none"|"low"|"high"`,
      `daily_limit_breach_risk: "none"|"low"|"high"`)
    - Реализовать `computeSimulationResult(config: AntiBanConfig,
      input: SimulationInput): SimulationResult` точно по формулам
      design.md (avg_per_request = (delay_min+delay_max)/2 + 1.0;
      long_pauses = floor(message_count / long_pause_every_n) при
      long_pause_every_n>0, иначе 0; eta_seconds = message_count *
      avg_per_request + long_pauses * long_pause_seconds;
      expected_retry_count = ceil(message_count * 0.02);
      hourly/daily breach risk по 70%/100% порогам)
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [ ]* 5.9 Property test ETA-формулы (эквивалентность серверной)
    - Файл `frontend/__tests__/anti-ban/simulator.property.test.ts`
    - **Property 7: Simulator formulas match anti-ban-protection ETA**
    - **Validates: Requirements 5.5, 5.6, 5.7**

  - [ ]* 5.10 Property test монотонности риска
    - Тот же файл `frontend/__tests__/anti-ban/simulator.property.test.ts`
    - **Property 8: Simulator risk is monotonic in message_count**
    - Для произвольного `config` и любых `m1 <= m2`:
      `risk_rank(r(m1).hourly_limit_breach_risk) <= risk_rank(r(m2).…)`
      и аналогично для daily
    - **Validates: Requirements 5.8, 5.9**

  - [ ] 5.11 Реализовать `validateConfig` (TypeScript-копия Requirement 9.3 движка)
    - Файл `frontend/src/lib/anti-ban/validation.ts`
    - Экспортировать функцию `validateConfig(values: AntiBanConfig):
      string[]` возвращающую список нарушений (`delay_min < 1.0`,
      `delay_max < delay_min`, `batch_size < 1`,
      `long_pause_seconds < 0`, `daily_check_limit < 1`,
      `hourly_check_limit < 1`)
    - Каждое нарушение — отдельная строка с именем поля, чтобы UI
      мог показать inline
    - _Requirements: 7.9_

  - [ ] 5.12 Реализовать `exportProfile` и `parseImport`
    - Файл `frontend/src/lib/anti-ban/profile-io.ts`
    - Экспортировать `SCHEMA_VERSION_CURRENT = "1.0"`,
      `ProfileExportFile` интерфейс, `ProfileImportFile` алиас,
      `ParseImportResult` union
    - Реализовать `exportProfile(values: AntiBanConfig, preset:
      ActivePreset, now?: () => Date): ProfileExportFile`
    - Реализовать `parseImport(raw: string): ParseImportResult`:
      на ошибку JSON или отсутствие `values` → `{ok:false, error}`;
      иначе вернуть `{ok:true, file, violations: validateConfig(file.values)}`
    - _Requirements: 7.2, 7.4, 7.7, 7.8, 7.9_

  - [ ]* 5.13 Property test round-trip exportProfile → parseImport
    - Файл `frontend/__tests__/anti-ban/profile-io.property.test.ts`
    - **Property 10: Profile export → import round-trip preserves values**
    - **Validates: Requirements 7.7**

  - [ ]* 5.14 Property test валидации импорта
    - Тот же файл `frontend/__tests__/anti-ban/profile-io.property.test.ts`
    - **Property 11: Import validation rejects exactly Req 9.3 violations**
    - **Validates: Requirements 7.9**

- [ ] 6. Checkpoint - Frontend libraries готовы
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Frontend hooks
  - [ ] 7.1 Реализовать `useLiveStatus`
    - Файл `frontend/src/hooks/useLiveStatus.ts` (создать папку
      `frontend/src/hooks/` если нет)
    - Экспортировать `LIVE_REFRESH_INTERVAL_SECONDS = 5`,
      интерфейсы `LiveStatus` (см. types.ts) и `UseLiveStatusResult`
    - Реализовать хук на `useEffect` + `setTimeout` (а не
      `setInterval`): запрос `GET /api/anti-ban/status`, при успехе
      `setStatus`, при ошибке `setStatus(null), setError(...)`,
      перезапуск таймера только после возврата ответа
    - При unmount — `clearTimeout` и `AbortController.abort()`
    - _Requirements: 3.1, 3.3, 3.8_

  - [ ]* 7.2 Unit test для `useLiveStatus` (fake timers)
    - Файл `frontend/__tests__/hooks/useLiveStatus.test.ts`
    - Vitest fake timers: ровно K+1 fetch-вызовов за K*5 секунд;
      восстановление после серии `[200, 500, 200]`
    - _Requirements: 3.3, 3.8_

  - [ ] 7.3 Реализовать `useAntiBanForm`
    - Файл `frontend/src/hooks/useAntiBanForm.ts`
    - Экспортировать интерфейсы `AntiBanFormState`, `UseAntiBanFormApi`
    - Реализовать через `useReducer` с действиями `SET_FIELD`,
      `APPLY_PRESET`, `APPLY_IMPORT`, `SAVE_START`, `SAVE_OK`,
      `SAVE_ERROR`, `RESET`
    - На каждое изменение values — пересчёт `activePreset` через
      `detectActivePreset`; `hasUnsavedChanges = !deepEqual(values,
      lastApplied)`
    - `save()` шлёт `PUT /api/anti-ban-config`; на 422/400 заполняет
      `fieldErrors` из body.violations; на 200 обновляет
      `lastApplied = values`
    - На `applyPreset(preset)` — обновляет values, lastAppliedPreset,
      activePreset = preset (lastApplied НЕ обновляется до save)
    - _Requirements: 1.2, 1.6, 1.9, 7.5, 8.4, 9.1_

- [ ] 8. Frontend components
  - [ ] 8.1 Реализовать `PresetSelector` и `Active_Preset_Indicator`
    - Файл `frontend/src/components/anti-ban/PresetSelector.tsx`
    - Файл `frontend/src/components/anti-ban/ActivePresetIndicator.tsx`
    - `PresetSelector` рендерит ровно три карточки в фиксированном
      порядке Safe → Balanced → Aggressive, выделяет активную
    - При клике: если `hasUnsavedChanges === false` или выбранный
      пресет совпадает с `activePreset` — сразу `onApply(preset)`;
      иначе — открыть `<PresetSwitchConfirmation />` (см. 8.4)
    - `ActivePresetIndicator` всегда виден; на `activePreset ===
      "custom"` показывает `Custom_Profile_Label` «Свой (на основе X)»
      где X = `lastAppliedPreset`
    - Атрибут `data-tour="presets"` на корневом контейнере для
      привязки тура
    - _Requirements: 1.1, 1.6, 1.7, 1.9_

  - [ ] 8.2 Реализовать `FieldTooltip` на Radix Popover
    - Установить зависимость `@radix-ui/react-popover` через
      `npm install @radix-ui/react-popover` в `frontend/`
    - Файл `frontend/src/components/anti-ban/FieldTooltip.tsx`
    - Триггер — кнопка-иконка `lucide-react/Info` 16×16 с
      `aria-label="Подсказка к полю {label}"`
    - Поповер с `description` и `impact` из `FIELD_METADATA`,
      `side="top"`, `sideOffset={6}`, `collisionPadding={8}`
    - Если `fieldName` отсутствует в `FIELD_METADATA` — вернуть `null`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [ ]* 8.3 Unit test позиционирования `FieldTooltip` (без сдвига разметки)
    - Файл `frontend/__tests__/anti-ban/FieldTooltip.test.tsx`
    - Snapshot: bbox соседних элементов до и после открытия совпадают
    - _Requirements: 2.6_

  - [ ] 8.4 Реализовать `PresetSwitchConfirmation`
    - Файл `frontend/src/components/anti-ban/PresetSwitchConfirmation.tsx`
    - Модальное окно с заголовком «Применить пресет «X»?» и текстом
      «Текущие ручные изменения будут потеряны»
    - Кнопки: «Применить пресет» → `onConfirm(preset)`;
      «Отменить» → `onCancel()` (форма не меняется)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 8.5 Реализовать `LiveStatusBanner`
    - Файл `frontend/src/components/anti-ban/LiveStatusBanner.tsx`
    - Props: `status: LiveStatus | null`, `error: string | null`
    - Цветовое состояние:
      `ok` → `bg-mint-green` + `CheckCircle2`;
      `warning` → `bg-canary-yellow` + `AlertTriangle` + текст «Инцидентов за час: N»;
      `alarm` → `bg-leadgen-red` + `OctagonAlert` + текст «Последний инцидент: {kind}»;
      `status==null` → серый плейсхолдер «Статус недоступен» + `CloudOff`
    - Форматирование ETA: `null`→«—», `<1`→«менее минуты»,
      `<60`→«через {round(N)} мин», `>=60`→«через {floor(N/60)} ч {round(N%60)} мин»
    - Атрибут `data-tour="live-status"` на корневом элементе
    - _Requirements: 3.2, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ] 8.6 Реализовать `IncidentFeed`
    - Файл `frontend/src/components/anti-ban/IncidentFeed.tsx`
    - Props: `incidents: ReadonlyArray<Incident>`, `pageSize?: number = 20`
    - Внутренний `useState` для `page` и `kindFilter`
    - Выпадающий `Incident_Filter` со значениями всех `IncidentKind`
      + «все типы»; при смене — сброс page на 1
    - Пагинация «Предыдущая» / «Следующая»
    - Каждая строка: время (локальное), kind, краткое описание,
      кнопка «Подробнее» раскрывающая `<details>` с
      `JSON.stringify(details, null, 2)`
    - Пустое состояние «Инцидентов не зарегистрировано»
    - Атрибут `data-tour="incident-feed"` на корневом контейнере
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 8.7 Property test фильтра и пагинации `IncidentFeed`
    - Файл `frontend/__tests__/anti-ban/incident-feed.property.test.ts`
    - **Property 6: Incident filter and pagination are total and faithful**
    - **Validates: Requirements 4.4, 4.6, 4.7**

  - [ ] 8.8 Реализовать `SimulatorModal`
    - Файл `frontend/src/components/anti-ban/SimulatorModal.tsx`
    - Модальное окно с двумя инпутами (`message_count`, `batch_size`),
      по умолчанию `batch_size` берётся из текущей формы
    - На каждое изменение — синхронный вызов
      `computeSimulationResult(config, input)`
    - Отображение результата с цветовой индикацией: `none`→серый,
      `low`→жёлтый, `high`→красный
    - Форматирование `eta_seconds`: `>=3600` → «N часов M минут»;
      иначе «N минут»
    - Кнопка-триггер «Симулировать рассылку» с
      `data-tour="simulate"`
    - _Requirements: 5.1, 5.2, 5.3, 5.10, 5.11_

  - [ ] 8.9 Реализовать `OnboardingTour` (без react-joyride)
    - Файл `frontend/src/components/anti-ban/OnboardingTour.tsx`
    - Экспортировать константу `TOUR_STEPS: ReadonlyArray<TourStep>`
      из 7 шагов с селекторами `data-tour="..."` (live-status,
      presets, field-group-pacing, simulate, incident-feed,
      import-export, save) — заголовки и тексты по design.md
    - Build-time guard:
      `type LengthOk<A> = A["length"] extends 5|6|7 ? A : never;
       const _check: LengthOk<typeof TOUR_STEPS> = TOUR_STEPS;`
      и runtime-fallback `if (TOUR_STEPS.length<5||>7) return null`
    - Реализация на `createPortal`: затемнение `rgba(17,17,17,0.55)`,
      «вырез» вокруг `target.getBoundingClientRect()` через
      `box-shadow: 0 0 0 9999px rgba(...)`
    - Карточка с кнопками «Назад» (со 2-го шага), «Далее» / «Готово»
      на последнем, «Пропустить»; `Escape` = «Пропустить»
    - На «Готово»/«Пропустить» — POST
      `/api/profile/anti-ban-tour-completed`, затем закрыть
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.7, 6.8_

  - [ ] 8.10 Реализовать `ImportExportControls`
    - Файл `frontend/src/components/anti-ban/ImportExportControls.tsx`
    - Кнопка «Экспорт настроек»: вызывает `exportProfile`,
      `JSON.stringify(file, null, 2)`, создаёт `Blob` с
      `type:"application/json"`, скачивает с именем
      `anti-ban-profile-${YYYY-MM-DD}.json` (UTC)
    - Кнопка «Импорт настроек»: `<input type="file" accept=".json">`,
      читает через `File.text()`, вызывает `parseImport`
    - На `ok:false` — toast «Файл не является валидным профилем
      анти-бана»; на `ok:true` — открыть `ImportDiffModal`
    - Атрибут `data-tour="import-export"` на корневом контейнере
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.8_

  - [ ] 8.11 Реализовать `ImportDiffModal`
    - Файл `frontend/src/components/anti-ban/ImportDiffModal.tsx`
    - Props: `current`, `incoming: AntiBanConfig`,
      `schemaVersionMatch: boolean`,
      `violations: ReadonlyArray<string>`, `onConfirm`, `onCancel`
    - Список полей `current[k] !== incoming[k]` с парами «было →
      станет»
    - Если `!schemaVersionMatch` — warning-блок с предупреждением
      из Requirement 7.6
    - Если `violations.length > 0` — список нарушений и кнопка
      «Применить» disabled
    - На «Применить» (если разрешено) — `onConfirm()` →
      `useAntiBanForm.applyImport(incoming, sourcePreset)`
    - _Requirements: 7.4, 7.5, 7.6, 7.9_

- [ ] 9. Page integration
  - [ ] 9.1 Создать страницу `/dashboard/settings/anti-ban`
    - Файл `frontend/src/app/dashboard/settings/anti-ban/page.tsx`
    - Серверный компонент: загружает `Profile` (включая
      `anti_ban_tour_completed_at`) и `AntiBanConfig` через `apiGet`
    - Передаёт initial-данные клиентскому компоненту
      `<AntiBanUXClient />` (создать в том же каталоге как
      `AntiBanUXClient.tsx`)
    - _Requirements: 6.2, 6.7, 9.1_

  - [ ] 9.2 Реализовать `AntiBanUXClient` (композиция всех компонентов)
    - Файл `frontend/src/app/dashboard/settings/anti-ban/AntiBanUXClient.tsx`
    - Использует `useAntiBanForm(initialConfig)` и `useLiveStatus()`
    - Рендерит сверху вниз: `<LiveStatusBanner>`, `<PresetSelector>`
      + `<ActivePresetIndicator>`, форму с полями сгруппированными
      по `FIELD_METADATA.group` (7 секций) с `<FieldTooltip>` рядом
      с каждым полем (атрибуты `data-tour="field-group-pacing"`
      на первой группе, `data-tour="save"` на кнопке Сохранить),
      кнопку открытия `<SimulatorModal>`, секцию `<IncidentFeed>`,
      `<ImportExportControls>`, кнопку «Запустить тур снова»
    - На mount: если `profile.anti_ban_tour_completed_at == null` —
      установить `tourOpen=true` и смонтировать `<OnboardingTour>`
    - Save-flow: при успешном `save()` показать toast «Настройки
      сохранены. Применятся в течение 60 секунд»; при `has_active_run`
      в ответе — добавить inline-подсказку «Изменения применятся к
      новым операциям; текущая операция продолжит работать с
      прежними настройками»
    - При ошибке save (422 с `violations`) — расставить
      `fieldErrors` под каждым полем
    - _Requirements: 1.2, 1.6, 1.7, 1.9, 2.5, 3.2, 4.1, 5.1, 6.2, 6.7, 6.8, 7.1, 7.3, 8.1, 9.1, 9.2, 9.4_

  - [ ] 9.3 Загрузка инцидентов на странице
    - В `AntiBanUXClient` вызывать `apiGet("/api/incidents")` через
      `useEffect` на mount, передавать массив в `<IncidentFeed>`
    - На ошибку загрузки — показать «Не удалось загрузить инциденты»
      с кнопкой «Повторить»
    - _Requirements: 4.2_

- [ ] 10. End-to-end test
  - [ ]* 10.1 E2E-сценарий Playwright «открыть страницу — пройти тур — применить пресет — сохранить»
    - Файл `frontend/e2e/anti-ban-ux-overhaul.spec.ts` (или
      эквивалент в существующей структуре e2e)
    - Сценарий: новый пользователь открывает
      `/dashboard/settings/anti-ban`, видит `<OnboardingTour>` с
      первым шагом, проходит до конца через «Далее», нажимает
      «Готово» → POST `/api/profile/anti-ban-tour-completed` 200
    - Кликает Safe-пресет → значения формы заполняются;
      нажимает «Сохранить» → toast «Настройки сохранены»
    - Поверхностно проверяет наличие `<LiveStatusBanner>` и
      пустого состояния `<IncidentFeed>`
    - _Requirements: 1.2, 3.2, 4.1, 6.2, 6.5, 9.2_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP;
  они охватывают property-based тесты (fast-check на фронтенде,
  hypothesis на Python), unit-тесты позиционирования и e2e
- Каждая задача ссылается на конкретные acceptance criteria для
  трассировки
- Property-тесты валидируют 11 correctness properties из design.md;
  example/unit-тесты валидируют UI-эффекты и форматирование
- Чекпойнты вставлены между крупными этапами для инкрементальной
  валидации
- Изменения в существующем `PUT /api/anti-ban-config` не требуются:
  `ConfigLoader.invalidate(user_id)` уже вызывается там, hot-reload
  обеспечен «как есть» (Requirement 9.1, 9.3); UX-слой только
  добавляет текст про TTL 60 секунд в success-toast (задача 9.2)
- Если `GET /api/anti-ban-config` возвращает поле `has_active_run`
  (минимальная аддитивная правка для Requirement 9.4) — оно
  пробрасывается из save-ответа в `AntiBanUXClient`; добавление
  этого поля в существующий хендлер выполняется в рамках задачи 9.2
  (правка `app.py` в response shape без изменения семантики)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "4.1", "5.2", "5.6", "5.11"] },
    { "id": 2, "tasks": ["2.2", "2.4", "4.2", "5.3", "5.4", "5.7", "5.8", "5.12"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "5.5", "5.9", "5.10", "5.13", "5.14"] },
    { "id": 4, "tasks": ["2.8", "7.1", "7.3"] },
    { "id": 5, "tasks": ["7.2", "8.1", "8.2", "8.4", "8.5", "8.6", "8.8", "8.9", "8.10", "8.11"] },
    { "id": 6, "tasks": ["8.3", "8.7", "9.1"] },
    { "id": 7, "tasks": ["9.2"] },
    { "id": 8, "tasks": ["9.3"] },
    { "id": 9, "tasks": ["10.1"] }
  ]
}
```
