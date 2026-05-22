# Requirements Document

## Introduction

Фича `green-api-shared-instance-auth` добавляет в MAX Bot UX-мастер
привязки мессенджера MAX к **чужому** инстансу GREEN API, к которому
пользователь не имеет доступа в личный кабинет
[https://console.green-api.com](https://console.green-api.com).
Владелец инстанса (босс пользователя) делится только двумя
значениями: `idInstance` и `apiTokenInstance`. Подписка на инстансе
активна, но MAX в нём ещё не авторизован — нужно отсканировать QR-код
с телефона пользователя, чтобы привязка состоялась.

Ключевые цели:

- Провести пользователя через четыре шага мастера: инструкция → ввод
  credentials → определение состояния инстанса → отображение QR и
  ожидание сканирования — без перехода в личный кабинет владельца.
- Обрабатывать все возможные значения `stateInstance`
  (`authorized`, `notAuthorized`, `starting`, `yellowCard`, `blocked`,
  `sleepMode`) с понятным человеку объяснением.
- Гарантировать, что расшифрованный `apiTokenInstance` никогда не
  покидает бэкенд: все обращения к публичному GREEN API проходят
  через Next.js API routes.
- Поддерживать перепривязку MAX к существующему инстансу, смену
  credentials и фоновое обновление статуса всех инстансов
  пользователя.
- Записывать каждое подключение и изменение credentials в
  `IncidentLog`, потому что инстанс — общий ресурс.

Существующая инфраструктура переиспользуется: Prisma-модель
`GreenInstance`, шифрование `@/lib/encryption`, Supabase Auth
(`createClient` из `@/lib/supabase/server`), эндпойнт
`POST /api/green-instances` (создание + первичная валидация через
`getStateInstance`), модель `IncidentLog`, лимит 5 инстансов на
пользователя.

## Glossary

- **Connection_Wizard**: четырёхшаговый клиентский мастер
  «Подключить GREEN API инстанс» (инструкция → ввод → состояние →
  QR/завершение).
- **Instructions_Step**: первый шаг мастера — статический текст с
  объяснением, какие два значения попросить у владельца аккаунта
  GREEN API и где они находятся в личном кабинете владельца.
- **Credentials_Form**: второй шаг мастера — форма ввода `idInstance`,
  `apiTokenInstance` и опционального `name`.
- **State_Resolver**: серверный компонент, вызывающий
  `getStateInstance` и возвращающий нормализованное значение
  `Instance_Status`.
- **QR_Modal**: UI-модалка третьего/четвёртого шага мастера, в которой
  отображается QR-код и текущий `Instance_Status`.
- **QR_Refresh_Loop**: клиентский цикл обновления QR-кода через
  серверный эндпойнт `GET /api/green-instances/[id]/qr` с интервалом
  25 секунд.
- **State_Poll_Loop**: клиентский цикл опроса
  `GET /api/green-instances/[id]/state` с интервалом 3 секунды для
  отслеживания смены `Instance_Status`.
- **Instance_Status**: значение, отражающее состояние инстанса в БД,
  одно из {`unknown`, `notAuthorized`, `authorized`, `starting`,
  `yellowCard`, `blocked`, `sleepMode`}.
- **Reauth_Flow**: процесс перепривязки MAX к существующему инстансу
  через `POST /api/green-instances/[id]/reauth`, состоящий из
  `logout` + новый QR-цикл.
- **Credentials_Update_Endpoint**: эндпойнт
  `POST /api/green-instances/[id]/credentials`, обновляющий
  `id_instance` и зашифрованный `api_token` существующей записи.
- **Health_Check_Job**: фоновый процесс, обновляющий
  `Instance_Status` всех записей `GreenInstance` пользователя через
  периодический вызов `getStateInstance`.
- **Throttle_Gate**: серверный механизм, ограничивающий частоту
  обращений к GREEN API одного и того же инстанса (защита от 429).
- **Shared_Instance_Warning**: UI-баннер, показываемый когда
  `getSettings` возвращает уже настроенный `webhookUrl` или
  `outgoingWebhook`, означающий что инстансом пользуется кто-то ещё.
- **Audit_Logger**: компонент, пишущий записи в `IncidentLog` с
  типами `instance_connected`, `instance_reauthorized`,
  `instance_credentials_changed`.
- **Diagnostic_Message**: текстовое сообщение об ошибке с понятной
  человеку формулировкой и подсказкой следующего действия.
- **Settings_Page**: страница «Настройки → GREEN API инстансы», на
  которой отображаются все инстансы пользователя с актуальным
  `Instance_Status`.

## Requirements

### Requirement 1: Мастер подключения с инструкцией и вводом credentials

**User Story:** Как пользователь, не имеющий аккаунта GREEN API, я
хочу пройти пошаговый мастер подключения, чтобы привязать MAX к
инстансу босса, имея только `idInstance` и `apiTokenInstance`.

#### Acceptance Criteria

1. THE Connection_Wizard SHALL include exactly four steps in a fixed
   order: Instructions_Step, Credentials_Form, status branch, and
   terminal screen.
2. WHEN the user opens the Connection_Wizard, THE Instructions_Step
   SHALL display a textual explanation that exactly two values from
   the instance owner are required: `idInstance` and
   `apiTokenInstance`.
3. WHEN the user advances from Instructions_Step, THE
   Credentials_Form SHALL render two required text inputs for
   `idInstance` and `apiTokenInstance` and one optional input for
   instance name.
4. IF the user submits Credentials_Form with `idInstance` empty or
   `apiTokenInstance` empty, THEN THE Connection_Wizard SHALL block
   the submission and display a Diagnostic_Message naming the empty
   field.
5. WHEN the user submits Credentials_Form with non-empty values, THE
   Connection_Wizard SHALL invoke the existing
   `POST /api/green-instances` endpoint with payload
   `{ name, id_instance, api_token, api_url }`.
6. WHERE the user did not provide an instance name, THE
   Connection_Wizard SHALL substitute the default name
   `Инстанс {idInstance последние 4 цифры}` before invoking
   `POST /api/green-instances`.
7. IF the user already has 5 GreenInstance records, THEN THE
   Connection_Wizard SHALL display the existing limit error returned
   by the backend and remain on Credentials_Form.

### Requirement 2: Ветвление мастера по Instance_Status после ввода credentials

**User Story:** Как пользователь, я хочу чтобы мастер автоматически
показал нужное действие в зависимости от того, авторизован ли уже
этот инстанс, не авторизован, инициализируется или находится в
проблемном состоянии.

#### Acceptance Criteria

1. WHEN `POST /api/green-instances` returns `status == "authorized"`,
   THE Connection_Wizard SHALL display a success screen with the
   phone returned from `getSettings.wid`, mark the new record as
   `is_primary = true` if it is the user's first instance, and
   provide a button to close the wizard.
2. WHEN `POST /api/green-instances` returns
   `status == "notAuthorized"`, THE Connection_Wizard SHALL open the
   QR_Modal for the newly created GreenInstance record.
3. WHEN `POST /api/green-instances` returns `status == "starting"`,
   THE Connection_Wizard SHALL display a progress screen with the
   text "Инстанс инициализируется, ожидайте 10–30 секунд" and start
   the State_Poll_Loop on the new GreenInstance record.
4. WHEN State_Poll_Loop transitions `Instance_Status` from `starting`
   to `notAuthorized`, THE Connection_Wizard SHALL switch the UI to
   QR_Modal without user action.
5. WHEN State_Poll_Loop transitions `Instance_Status` from `starting`
   to `authorized`, THE Connection_Wizard SHALL switch the UI to the
   success screen described in 2.1.
6. IF `POST /api/green-instances` returns `status` in
   {`yellowCard`, `blocked`, `sleepMode`}, THEN THE
   Connection_Wizard SHALL display a Diagnostic_Message specific to
   that status (see Requirement 8) and not open the QR_Modal.

### Requirement 3: QR_Modal с обновлением QR и опросом статуса

**User Story:** Как пользователь, я хочу видеть свежий QR-код,
сканировать его телефоном MAX, и автоматически получать подтверждение
успешной привязки без ручного обновления страницы.

#### Acceptance Criteria

1. WHEN the QR_Modal opens, THE Connection_Wizard SHALL invoke
   `GET /api/green-instances/[id]/qr` and render the returned PNG
   image when the response field `type == "qrCode"`.
2. WHILE the QR_Modal is open, THE QR_Refresh_Loop SHALL invoke
   `GET /api/green-instances/[id]/qr` every 25 seconds and replace
   the displayed image with the new payload when `type == "qrCode"`.
3. WHILE the QR_Modal is open, THE State_Poll_Loop SHALL invoke
   `GET /api/green-instances/[id]/state` every 3 seconds.
4. WHEN `GET /api/green-instances/[id]/qr` returns
   `type == "alreadyLogged"`, THE Connection_Wizard SHALL close the
   QR_Modal, update the GreenInstance record with `status =
   "authorized"` and the phone returned from `getSettings.wid`, and
   show the success screen.
5. WHEN State_Poll_Loop observes `Instance_Status` change to
   `authorized`, THE Connection_Wizard SHALL close the QR_Modal
   within 3 seconds, persist the new status and phone, and show the
   success screen.
6. WHEN `GET /api/green-instances/[id]/qr` returns
   `type == "error"`, THE Connection_Wizard SHALL stop the
   QR_Refresh_Loop and display the error text returned in the
   `message` field.
7. WHEN the user closes the QR_Modal manually, THE Connection_Wizard
   SHALL stop both QR_Refresh_Loop and State_Poll_Loop within 1
   second.

### Requirement 4: Перепривязка MAX к существующему инстансу

**User Story:** Как пользователь, я хочу повторно привязать MAX к
тому же инстансу когда статус деградировал, чтобы вернуть инстанс в
рабочее состояние без удаления записи.

#### Acceptance Criteria

1. WHERE the Settings_Page displays a GreenInstance with
   `Instance_Status` in {`notAuthorized`, `yellowCard`, `blocked`,
   `sleepMode`}, THE Settings_Page SHALL render a "Перепривязать"
   button next to the row.
2. WHEN the user clicks "Перепривязать", THE Connection_Wizard SHALL
   invoke `POST /api/green-instances/[id]/reauth` for the selected
   record.
3. WHEN `POST /api/green-instances/[id]/reauth` is invoked, THE
   server SHALL call GREEN API `POST /waInstance{id}/logout/{token}`
   using the decrypted token, then call `getStateInstance`, then
   return the new `Instance_Status` to the client.
4. WHEN `POST /api/green-instances/[id]/reauth` returns
   `status == "notAuthorized"`, THE Connection_Wizard SHALL open the
   QR_Modal as defined in Requirement 3.
5. WHEN `POST /api/green-instances/[id]/reauth` returns
   `status == "authorized"`, THE Connection_Wizard SHALL display the
   success screen and update the GreenInstance record.
6. THE Settings_Page SHALL render a "Проверить сейчас" button on every
   GreenInstance row regardless of status.
7. WHEN the user clicks "Проверить сейчас", THE Settings_Page SHALL
   invoke `GET /api/green-instances/[id]/state`, update the displayed
   status with the response, and persist the value into the
   GreenInstance record within the same request.

### Requirement 5: Смена credentials у существующего инстанса

**User Story:** Как пользователь, я хочу заменить `idInstance` или
`apiTokenInstance` на существующей записи, чтобы переключиться на
другой инстанс без удаления и повторной настройки `is_primary`.

#### Acceptance Criteria

1. THE Credentials_Update_Endpoint
   `POST /api/green-instances/[id]/credentials` SHALL accept a JSON
   body with required fields `id_instance` and `api_token` and
   optional field `api_url`.
2. WHEN the Credentials_Update_Endpoint receives a request, THE
   server SHALL invoke `getStateInstance` using the new credentials
   before persisting any change.
3. IF `getStateInstance` returns HTTP 401 or HTTP 403 with the new
   credentials, THEN THE Credentials_Update_Endpoint SHALL return
   HTTP 400 with a Diagnostic_Message "Неверные credentials" and
   leave the GreenInstance record unchanged.
4. WHEN `getStateInstance` succeeds, THE Credentials_Update_Endpoint
   SHALL re-encrypt the new `api_token` via `@/lib/encryption.encrypt`
   and update the GreenInstance record with the new `id_instance`,
   re-encrypted `api_token`, optional `api_url`, and the
   `Instance_Status` returned by `getStateInstance`.
5. WHEN the Credentials_Update_Endpoint successfully updates a
   record, THE Audit_Logger SHALL write one IncidentLog row with
   `kind == "instance_credentials_changed"` and `details` containing
   the affected GreenInstance id, the old `id_instance`, and the new
   `id_instance`.
6. THE Credentials_Update_Endpoint SHALL preserve the existing
   `is_primary` and `name` fields of the GreenInstance record.

### Requirement 6: Backend-only обращения к GREEN API и защита токена

**User Story:** Как пользователь, я хочу быть уверен, что
расшифрованный `apiTokenInstance` никогда не попадает в браузер,
чтобы случайная утечка кода клиента или XSS не раскрыли credentials
босса.

#### Acceptance Criteria

1. THE Connection_Wizard SHALL never call any URL whose host equals
   the value of GreenInstance.api_url.
2. THE server SHALL decrypt GreenInstance.api_token only inside
   Next.js API route handlers and never include the decrypted token
   in any response body or response header.
3. THE `GET /api/green-instances` endpoint SHALL return
   GreenInstance records without the `api_token` field.
4. THE `GET /api/green-instances/[id]/qr` endpoint SHALL return only
   the fields `type`, `message`, and a server timestamp, omitting any
   GREEN API URL containing the token.
5. THE `GET /api/green-instances/[id]/state` endpoint SHALL return
   only the normalized `Instance_Status` and an optional `phone`
   field, omitting any token.
6. WHEN the Throttle_Gate receives concurrent requests for the same
   GreenInstance.id, THE Throttle_Gate SHALL serialize calls to the
   GREEN API such that no more than one outbound request per
   GreenInstance.id is in flight at any moment.
7. WHILE the QR_Refresh_Loop or State_Poll_Loop is active, THE
   Throttle_Gate SHALL enforce a minimum interval of 1.5 seconds
   between two consecutive outbound calls to GREEN API for the same
   GreenInstance.id.

### Requirement 7: Health_Check_Job — фоновое обновление статуса

**User Story:** Как пользователь, я хочу видеть в списке инстансов
актуальный статус без необходимости заходить в каждую запись и
нажимать «Проверить сейчас», чтобы заметить деградацию инстанса
заранее.

#### Acceptance Criteria

1. THE Health_Check_Job SHALL execute every 5 minutes.
2. WHEN the Health_Check_Job executes, THE Health_Check_Job SHALL
   call `getStateInstance` for every GreenInstance record whose
   `Instance_Status` is not `blocked`.
3. WHEN `getStateInstance` returns a stateInstance value, THE
   Health_Check_Job SHALL update the corresponding GreenInstance
   record's `status` and `updated_at` fields with that value.
4. IF `getStateInstance` does not return within 10 seconds for a
   given record, THEN THE Health_Check_Job SHALL skip persisting any
   change for that record on the current run.
5. WHEN the Health_Check_Job updates `Instance_Status` from a value
   in {`authorized`, `starting`, `notAuthorized`, `unknown`,
   `sleepMode`} to a value in {`yellowCard`, `blocked`}, THE
   Audit_Logger SHALL write one IncidentLog row with
   `kind == "instance_status_degraded"` and `details` containing the
   GreenInstance id, the previous status, and the new status.
6. THE Health_Check_Job SHALL reuse the Throttle_Gate defined in
   Requirement 6 when issuing GREEN API requests.

### Requirement 8: Diagnostic_Message для всех ошибок и состояний

**User Story:** Как пользователь, я хочу видеть понятное объяснение
любой ошибки или нестандартного состояния инстанса, чтобы знать
следующее действие без чтения внешней документации GREEN API.

#### Acceptance Criteria

1. IF a GREEN API call returns HTTP 401 or HTTP 403, THEN THE server
   SHALL respond to the client with HTTP 400 and the
   Diagnostic_Message "Неверные credentials: проверьте idInstance и
   apiTokenInstance".
2. IF a GREEN API call returns HTTP 466, THEN THE server SHALL
   respond with HTTP 402 and the Diagnostic_Message "Превышена квота
   инстанса: подписка на стороне владельца исчерпана или закончилась.
   Обратитесь к владельцу аккаунта GREEN API".
3. IF a GREEN API call does not return a response within 15 seconds,
   THEN THE server SHALL respond with HTTP 504 and the
   Diagnostic_Message "GREEN API не ответил за 15 секунд. Повторите
   попытку через минуту".
4. IF a GREEN API call returns HTTP 429, THEN THE server SHALL
   respond with HTTP 429 and the Diagnostic_Message "Слишком частые
   запросы к GREEN API. Подождите 30 секунд и повторите".
5. WHEN `Instance_Status == "yellowCard"` is displayed in the
   Connection_Wizard or Settings_Page, THE corresponding
   Diagnostic_Message SHALL state "Аккаунт под подозрением: GREEN API
   ограничил исходящие действия. Снизьте темп рассылок и подождите
   24 часа".
6. WHEN `Instance_Status == "blocked"` is displayed, THE
   Diagnostic_Message SHALL state "Аккаунт заблокирован GREEN API.
   Обратитесь к владельцу инстанса для разблокировки".
7. WHEN `Instance_Status == "sleepMode"` is displayed, THE
   Diagnostic_Message SHALL state "Инстанс в режиме сна из-за долгой
   неактивности. Откройте MAX на телефоне для возобновления".
8. WHEN `Instance_Status == "starting"` is displayed, THE
   Diagnostic_Message SHALL state "Инстанс инициализируется, ожидайте
   10–30 секунд".

### Requirement 9: Audit_Logger пишет события в IncidentLog

**User Story:** Как пользователь, я хочу видеть журнал всех успешных
подключений, перепривязок и смен credentials в общем `IncidentLog`,
чтобы при споре с владельцем инстанса было видно кто и когда менял
состояние.

#### Acceptance Criteria

1. WHEN `POST /api/green-instances` successfully creates a
   GreenInstance record with `Instance_Status` in {`authorized`,
   `notAuthorized`, `starting`}, THE Audit_Logger SHALL write one
   IncidentLog row with `kind == "instance_connected"`, `user_id`
   equal to the authenticated user, and `details` containing the new
   GreenInstance id, the `id_instance` value, and the resolved
   `Instance_Status`.
2. WHEN `POST /api/green-instances/[id]/reauth` causes
   `Instance_Status` to transition to `authorized`, THE Audit_Logger
   SHALL write one IncidentLog row with `kind ==
   "instance_reauthorized"` and `details` containing the GreenInstance
   id and the previous `Instance_Status`.
3. WHEN `POST /api/green-instances/[id]/credentials` successfully
   updates a record (Requirement 5.5), THE Audit_Logger SHALL write
   one IncidentLog row as specified in 5.5.
4. THE Audit_Logger SHALL set `IncidentLog.user_id` to the same
   `user_id` value as the affected GreenInstance record.
5. THE Audit_Logger SHALL set `IncidentLog.created_at` to the server
   wall clock time at the moment the originating action completed
   successfully.
6. IF the IncidentLog write fails for any reason, THEN THE server
   SHALL still return success for the originating action and emit a
   server-side log entry "audit_log_write_failed" containing the
   GreenInstance id and the failure reason.

### Requirement 10: Shared_Instance_Warning для общего инстанса

**User Story:** Как пользователь общего инстанса, я хочу получить
предупреждение, что инстансом пользуется кто-то ещё, чтобы случайно
не сломать webhook-настройки босса.

#### Acceptance Criteria

1. WHEN `POST /api/green-instances` resolves
   `Instance_Status == "authorized"`, THE server SHALL invoke
   `getSettings` for the same instance.
2. WHEN `getSettings` returns a non-empty `webhookUrl` value or
   `outgoingWebhook == "yes"`, THE server SHALL include the field
   `shared_instance_warning: true` in its response body.
3. WHERE `shared_instance_warning == true` is present in the
   response, THE Connection_Wizard SHALL render a
   Shared_Instance_Warning banner with the text "Этот инстанс
   используется и другими пользователями. Не меняйте настройки
   webhook без согласования с владельцем".
4. WHERE `shared_instance_warning == true` was observed at least once
   for a GreenInstance record, THE Settings_Page SHALL render the
   same banner next to that record's row until the warning is
   manually dismissed.
