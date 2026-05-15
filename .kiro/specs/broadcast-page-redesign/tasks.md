# Implementation Plan: Broadcast Page Redesign

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

Реализация ведётся снизу вверх: общие типы и константы → чистые модули AI (маркетинг-промпт, клиент, прокси) → конфигурация окружения → листовые UI-компоненты (`Auto_Grow_Textarea`, `Attachment_Uploader`, `AI_Generator_Button`, `Preview_Accordion`, `Recipients_Block`, `Settings_Block`) → составной `Message_Block` и helper-загрузчик → рефакторинг `Broadcast_Page` (`page.tsx`) с трёхколоночным макетом → расширение Flask `POST /api/broadcast` для multipart и обёртка `broadcast_with_uploaded_file` в `bot.py`. Property-тесты (fast-check) располагаются рядом с соответствующими модулями и каждый вынесен в отдельный файл, чтобы их можно было выполнять параллельно.

Стек: TypeScript + Next.js 15 (App Router) + React 19 + Tailwind v4 на фронтенде; Python 3 + Flask на бэкенде.

## Tasks

- [x] 1. Set up shared types and constants
  - [x] 1.1 Create broadcast types and constants module
    - File: `frontend/src/components/broadcast/types.ts`
    - Define `AttachmentState`, `AttachmentError`, `AIGenerateRequest`, `AIGenerateResponse`, `AIGenerateError`, `ResultRow`, `ProgressEvent`
    - Define constants `ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024`, `TEXTAREA_MIN_LINES = 5`, `TEXTAREA_MAX_LINES = 20`, `PREVIEW_RECIPIENT_LIMIT = 5`, `OLLAMA_TIMEOUT_MS = 60_000`, `OLLAMA_DEFAULT_MODEL = "gemma3:27b-cloud"`
    - Re-export from `frontend/src/components/broadcast/index.ts` for ergonomic imports
    - _Requirements: 3.6, 5.3, 5.4, 6.5, 6.11, 8.4_

- [x] 2. Implement AI marketer prompt module
  - [x] 2.1 Implement `isPredominantlyCyrillic` and `buildMarketerSystemPrompt`
    - File: `frontend/src/lib/ai/marketer-prompt.ts`
    - `isPredominantlyCyrillic(s)` считает только буквы (Unicode `\p{Script=Cyrillic}` / `\p{Script=Latin}`), порог 50%, пустая или нелатинская/некириллическая строка → `true`
    - `buildMarketerSystemPrompt(userInput)` возвращает строку, содержащую (а) роль маркетолога и упоминание массовых рассылок, (б) запрет Markdown и пояснений, (в) языковую директиву по результату `isPredominantlyCyrillic`
    - _Requirements: 7.2, 7.3, 7.4_

  - [ ]* 2.2 Write property test for `isPredominantlyCyrillic`
    - File: `frontend/src/lib/ai/__tests__/isPredominantlyCyrillic.property.test.ts`
    - **Property 4: Чистая функция `isPredominantlyCyrillic`**
    - **Validates: Requirements 7.3**

  - [ ]* 2.3 Write property test for `buildMarketerSystemPrompt` invariants
    - File: `frontend/src/lib/ai/__tests__/marketer-prompt.property.test.ts`
    - **Property 5: Инварианты `Marketer_System_Prompt`**
    - **Validates: Requirements 7.2, 7.3, 7.4**

- [x] 3. Implement AI client and Ollama proxy
  - [x] 3.1 Implement `requestAiText` helper
    - File: `frontend/src/lib/ai/client.ts`
    - `POST /api/ai/generate` с JSON `{prompt}`, парсинг `{text}`, бросает `Error(body.error || statusText)`, принимает `AbortSignal`
    - _Requirements: 4.5, 4.6, 4.8_

  - [x] 3.2 Implement `Ollama_Proxy` route handler
    - File: `frontend/src/app/api/ai/generate/route.ts`
    - `export const dynamic = "force-dynamic"`; Supabase `auth.getUser()` через `@/lib/supabase/server`
    - Чтение `process.env.OLLAMA_API_KEY` и `process.env.OLLAMA_MODEL` (default `OLLAMA_DEFAULT_MODEL`)
    - `AbortController` с `setTimeout(60_000)` на запрос к `https://ollama.com/api/chat`
    - Системное сообщение из `buildMarketerSystemPrompt` (импорт из 2.1); user-сообщение по умолчанию `"Сгенерируй маркетинговый текст для рассылки"` при пустом `prompt.trim()`
    - Маппинг статусов: 200/400/401/500/502/504; в успехе — `text` из `message.content` или `response`
    - Никогда не включать значение `OLLAMA_API_KEY` в тело или заголовки ответа
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 7.1, 7.5, 8.1, 8.4_

  - [ ]* 3.3 Write property test for `OLLAMA_API_KEY` secrecy
    - File: `frontend/src/app/api/ai/generate/__tests__/secrecy.property.test.ts`
    - **Property 6: Секретность `OLLAMA_API_KEY`**
    - **Validates: Requirements 6.9, 8.1**

  - [ ]* 3.4 Write property test for proxy status mapping
    - File: `frontend/src/app/api/ai/generate/__tests__/status-mapping.property.test.ts`
    - **Property 7: Маппинг статусов `Ollama_Proxy`**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10, 6.11, 8.4**

  - [ ]* 3.5 Write property test for default user prompt
    - File: `frontend/src/app/api/ai/generate/__tests__/default-prompt.property.test.ts`
    - **Property 8: Дефолтный пользовательский запрос**
    - **Validates: Requirements 7.5**

  - [ ]* 3.6 Write unit tests for proxy branches
    - File: `frontend/src/app/api/ai/generate/__tests__/route.test.ts`
    - Замоканный `createClient` (auth) и глобальный `fetch`; примеры на каждую ветку (200/400/401/500/502/504)
    - _Requirements: 6.6, 6.7, 6.8, 6.10, 6.11_

- [x] 4. Configure environment variables for Ollama
  - [x] 4.1 Update `.env.example` and confirm `.gitignore`
    - File: `.env.example`
    - Добавить запись `OLLAMA_API_KEY=` (без значения)
    - Добавить запись `OLLAMA_MODEL=gemma3:27b-cloud`
    - Подтвердить, что `.env` присутствует в `.gitignore` (без коммита реального ключа)
    - _Requirements: 8.2, 8.3, 8.5_

- [x] 5. Checkpoint - Ensure AI layer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement leaf broadcast UI components
  - [x] 6.1 Implement `Auto_Grow_Textarea`
    - File: `frontend/src/components/broadcast/AutoGrowTextarea.tsx`
    - `"use client"`, `useRef<HTMLTextAreaElement>`, пересчёт высоты в `useLayoutEffect([value])`: `clamp(scrollHeight, minH, maxH)` через `lineHeight + padding + border`
    - `overflowY = "auto"` если `scrollHeight > maxH`, иначе `"hidden"`
    - Слушатели `focus`/`blur` НЕ привязываются — высота не пересчитывается на фокусе
    - Использует `TEXTAREA_MIN_LINES` / `TEXTAREA_MAX_LINES` из 1.1
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 6.2 Write property test for `Auto_Grow_Textarea` height
    - File: `frontend/src/components/broadcast/__tests__/AutoGrowTextarea.height.property.test.tsx`
    - **Property 2: Высота `Auto_Grow_Textarea`**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5**

  - [ ]* 6.3 Write property test for `Auto_Grow_Textarea` focus idempotence
    - File: `frontend/src/components/broadcast/__tests__/AutoGrowTextarea.focus.property.test.tsx`
    - **Property 3: Идемпотентность фокуса в `Auto_Grow_Textarea`**
    - **Validates: Requirements 5.6**

  - [x] 6.4 Implement `Attachment_Uploader`
    - File: `frontend/src/components/broadcast/AttachmentUploader.tsx`
    - `<input type="file">` без `accept` (любой MIME)
    - При выборе файла: `file.size > ATTACHMENT_MAX_BYTES` → `onReject({ kind: "too_large", sizeBytes, maxBytes })`; иначе → `onSelect(file)`
    - Отображает `file.name`, отформатированный размер (KiB/MiB), кнопку ✕ → `onRemove`
    - При `uploadError` показывает inline-ошибку и кнопку «Повторить» без сброса `attachment`
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.9_

  - [ ]* 6.5 Write property test for attachment size validation
    - File: `frontend/src/components/broadcast/__tests__/AttachmentUploader.property.test.tsx`
    - **Property 1: Валидация вложения по размеру**
    - **Validates: Requirements 3.2, 3.4, 3.6**

  - [x] 6.6 Implement `AI_Generator_Button`
    - File: `frontend/src/components/broadcast/AIGeneratorButton.tsx`
    - Подпись «Использовать AI», иконка `Sparkles` из `lucide-react`
    - При `pending=true`: атрибут `disabled`, `aria-busy="true"`, спиннер вместо иконки
    - _Requirements: 4.4, 4.7_

  - [ ]* 6.7 Write unit tests for `AI_Generator_Button`
    - File: `frontend/src/components/broadcast/__tests__/AIGeneratorButton.test.tsx`
    - Состояния `pending=true` (disabled, aria-busy, spinner) и `pending=false` (active, иконка); проверка вызова `onClick`
    - _Requirements: 4.4, 4.7_

  - [x] 6.8 Implement `Preview_Accordion`
    - File: `frontend/src/components/broadcast/PreviewAccordion.tsx`
    - `aria-expanded` отражает `expanded`, кнопка переключения с иконкой `ChevronDown`
    - В раскрытом состоянии — ровно `min(contacts.length, PREVIEW_RECIPIENT_LIMIT)` карточек, в каждой `phone` и `message` (без подстановки переменных и без рандомизации)
    - При пустом списке — placeholder
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 4.9_

  - [ ]* 6.9 Write property test for `Preview_Accordion` behavior
    - File: `frontend/src/components/broadcast/__tests__/PreviewAccordion.property.test.tsx`
    - **Property 9: Поведение `Preview_Accordion`**
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.7**

  - [x] 6.10 Extract `Recipients_Block`
    - File: `frontend/src/components/broadcast/RecipientsBlock.tsx`
    - Презентационный компонент: ввод номера + чипсы + загрузка CSV (поведение идентично текущему монолиту)
    - **Удалить** блок «Доступные переменные из CSV» и кнопки `{field}`
    - _Requirements: 1.2, 4.1_

  - [x] 6.11 Extract `Settings_Block`
    - File: `frontend/src/components/broadcast/SettingsBlock.tsx`
    - Поле «Задержка (сек)» (1..30) и чекбокс «Имитация набора», переиспользует `glass rounded-xl ...`
    - _Requirements: 1.2_

- [x] 7. Implement composite `Message_Block`
  - [x] 7.1 Compose `Message_Block` from leaf components
    - File: `frontend/src/components/broadcast/MessageBlock.tsx`
    - Селектор шаблона (если шаблоны переданы), `Auto_Grow_Textarea`, `Attachment_Uploader`, `AI_Generator_Button`, кнопка «Начать рассылку», блок прогресса/ошибок
    - **Удалить** панель переменных, индикаторы «Переменные»/«Рандом-блоков», кнопку «Проверить текст», текст-помощь про `{name}` / `{a|b|c}`
    - Кнопка «Начать рассылку» выставляет `disabled` тогда и только тогда, когда `message.trim() === ""` И `attachment.kind === "none"`
    - _Requirements: 1.3, 1.6, 4.1, 4.2, 4.3, 4.4, 9.2, 9.3_

  - [ ]* 7.2 Write unit tests for start-button enable rule
    - File: `frontend/src/components/broadcast/__tests__/MessageBlock.test.tsx`
    - disabled при пустом message+attachment; не disabled при наличии message; не disabled при наличии attachment
    - _Requirements: 9.3_

- [x] 8. Implement broadcast start helper
  - [x] 8.1 Implement `postBroadcast`
    - File: `frontend/src/lib/broadcast/start.ts`
    - Конструирует `FormData` с полями `broadcast_id`, `message`, `contacts` (JSON), `phones` (JSON), `delay`, `use_typing` (`"0"`/`"1"`); поле `file` добавляется только если передан `attachment`
    - Использует существующий `apiUpload`/`nxFetch` слой (см. `frontend/src/lib/api`)
    - _Requirements: 3.7, 9.1_

  - [ ]* 8.2 Write property test for multipart payload structure
    - File: `frontend/src/lib/broadcast/__tests__/start.property.test.ts`
    - **Property 12: Структура multipart-payload запуска рассылки**
    - **Validates: Requirements 3.7, 9.1**

- [x] 9. Checkpoint - Ensure component and helper tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Refactor `Broadcast_Page`
  - [x] 10.1 Rewrite `page.tsx` to three-column layout
    - File: `frontend/src/app/dashboard/broadcast/page.tsx`
    - Реорганизовать состояние: `contacts`, `message`, `delay`, `useTyping`, `attachment` (`AttachmentState`), `aiPending`, `aiError`, `uploadError`, `broadcasting`, `progress`, `results`, `previewExpanded` (default `true`)
    - Контейнер: `grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)_minmax(280px,400px)] gap-6`; левая колонка — стек `Recipients_Block` → `Settings_Block`; центральная — `Message_Block` (включая кнопку «Начать рассылку» и прогресс); правая — `Preview_Accordion`
    - Интегрировать `requestAiText` (3.1) под `AI_Generator_Button`; на ошибку — выставить `aiError`, не менять `message`
    - Запуск рассылки через `postBroadcast` (8.1); SSE прогресс хранится в `useRef<EventSource>`, `useEffect`-cleanup вызывает `close()` ровно один раз и обнуляет ref
    - **Удалить** `renderPreviewMessage`, `extractVariables`, `countRandomBlocks`, поля URL/имени файла, локальные подстановки `{field}` и `{a|b|c}`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.6, 3.3, 3.7, 3.8, 3.9, 4.5, 4.6, 4.7, 4.8, 4.9, 9.1, 9.2, 9.3, 9.4_

  - [ ]* 10.2 Write property test for responsive layout
    - File: `frontend/src/app/dashboard/broadcast/__tests__/page.layout.property.test.tsx`
    - **Property 10: Адаптивный макет `Broadcast_Page`**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**

  - [ ]* 10.3 Write property test for start-button rule
    - File: `frontend/src/app/dashboard/broadcast/__tests__/page.startButton.property.test.tsx`
    - **Property 11: Правило активации кнопки запуска рассылки**
    - **Validates: Requirements 9.3**

  - [ ]* 10.4 Write property test for `EventSource` cleanup
    - File: `frontend/src/app/dashboard/broadcast/__tests__/page.sseCleanup.property.test.tsx`
    - **Property 13: Очистка `EventSource` при размонтировании**
    - **Validates: Requirements 9.4**

- [x] 11. Update Flask backend
  - [x] 11.1 Add `_upload_local_file` and `broadcast_with_uploaded_file` in `bot.py`
    - File: `bot.py`
    - Вынести private `_upload_local_file(file_path)` из существующего `send_file_by_upload` (GREEN-API `uploadFile`)
    - Добавить `broadcast_with_uploaded_file(self, contacts, message, file_path, file_name, delay=2.0, use_typing=False, progress_cb=None)`: загрузка файла один раз и переиспользование `urlFile` через `self.broadcast(..., file_url=upload['urlFile'], file_name=file_name)`
    - При сбое загрузки — вызывать `progress_cb` со статусом `error` для каждого получателя
    - _Requirements: 3.8_

  - [x] 11.2 Extend `POST /api/broadcast` to accept multipart/form-data in `app.py`
    - File: `app.py`
    - Парсинг `Content-Type`: ветка `multipart/*` (поля `broadcast_id`, `message`, `contacts`, `phones`, `delay`, `use_typing` + `request.files['file']` сохранён в `UPLOAD_FOLDER` под `bcast_{ts}_{secure_filename}`); ветка `application/json` (legacy `file_url`/`file_name`) сохраняется
    - Поток `run()` обёрнут в `try/finally`: для multipart вызывает `broadcast_with_uploaded_file`, в `finally` — `os.remove(uploaded_path)` (OSError проглатывается с логом); для JSON-ветки — текущий `broadcast(..., file_url=, file_name=)`
    - 409 при `_broadcast_active`; 400 при пустых message И file
    - _Requirements: 3.7, 3.8_

  - [ ]* 11.3 Write unit tests for `/api/broadcast` Flask endpoint
    - File: `tests/test_app_broadcast.py`
    - multipart: контакты JSON, файл сохраняется в `UPLOAD_FOLDER`, удаляется после `run()` в `finally`
    - JSON legacy путь работает с `file_url`
    - 409 при `_broadcast_active=True`; 400 при пустом message и без файла
    - Невалидный JSON в `contacts`/`phones` → 400 с понятным сообщением
    - _Requirements: 3.7, 3.8_

  - [ ]* 11.4 Write unit tests for `broadcast_with_uploaded_file`
    - File: `tests/test_bot_broadcast.py`
    - Mock `_upload_local_file`: success → переиспользует `urlFile`, failure → все получатели проходят через `progress_cb` со статусом `error`
    - _Requirements: 3.8_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP, but the property tests directly correspond to the 13 correctness properties in the design and are strongly recommended.
- Каждый property-тест вынесен в отдельный файл, чтобы их можно было запускать и редактировать независимо.
- `Broadcast_Page` (`page.tsx`) интегрирует все остальные модули — это финальная точка соединения; не редактировать `page.tsx` до завершения 6.x, 7.1, 8.1, 3.1.
- Никаких изменений в Prisma-схеме не требуется. Поле `file_url` в `Broadcast` остаётся (при multipart туда пишется имя файла).
- Запрещено хранить `OLLAMA_API_KEY` под префиксом `NEXT_PUBLIC_*` или включать его в ответы прокси.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1", "11.1"] },
    { "id": 1, "tasks": ["2.1", "6.1", "6.4", "6.6", "6.8", "6.10", "6.11", "8.1", "11.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1", "3.2", "6.2", "6.3", "6.5", "6.7", "6.9", "7.1", "8.2", "11.3", "11.4"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5", "3.6", "7.2", "10.1"] },
    { "id": 4, "tasks": ["10.2", "10.3", "10.4"] }
  ]
}
```
