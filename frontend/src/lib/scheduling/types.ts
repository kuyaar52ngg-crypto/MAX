/**
 * Broadcast Scheduling Suite — TypeScript types.
 *
 * Все типы соответствуют разделу "Components and Interfaces" в
 * `.kiro/specs/broadcast-scheduling-suite/design.md` и моделям
 * Prisma `frontend/prisma/schema.prisma` (`ScheduledBroadcast`,
 * `AntiBanConfig`, `CalendarException`, `GreenInstance`).
 *
 * Здесь живут только декларативные типы — без кода логики.
 */

import type { BroadcastContact } from "@/lib/types";
import type { AntiBanConfig } from "@/lib/anti-ban";

// ---------------------------------------------------------------------------
// Broadcast lifecycle status
// ---------------------------------------------------------------------------

/**
 * Статусы `ScheduledBroadcast` после расширения этой спекой.
 *
 * Источник: design.md → Components and Interfaces → `Visual_Schedule_Calendar`,
 * Requirement 7 (Approval Workflow), Requirement 11 (Active Broadcast Controls).
 */
export type BroadcastStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "pending_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

// ---------------------------------------------------------------------------
// Schedule mode
// ---------------------------------------------------------------------------

/**
 * Расширенный список значений `ScheduledBroadcast.schedule_type`:
 * — старые (`exact` / `drip` / `recurring`) из `enhanced-broadcast-scheduling`;
 * — новые (`window` / `smart_time` / `ab_time` / `burst`) из этой спеки.
 */
export type ScheduleType =
  | "exact"
  | "drip"
  | "recurring"
  | "window"
  | "smart_time"
  | "ab_time"
  | "burst";

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Тип события рассылки, на который оператор может подписаться.
 *
 * Источник: design.md → Components and Interfaces → `NotificationCenter`,
 * requirements.md → Glossary → `Notification_Event_Kind`.
 */
export type NotificationEventKind =
  | "scheduled"
  | "started"
  | "paused"
  | "resumed"
  | "completed"
  | "failed"
  | "anti_ban_threshold"
  | "awaiting_approval"
  | "ab_time_completed"
  | "auto_snoozed";

/**
 * Канал доставки уведомления.
 *
 * Источник: requirements.md → Glossary → `Notification_Channel`.
 */
export type NotificationChannel = "in_app" | "email" | "telegram";

/**
 * Один элемент NotificationCenter / `GET /api/notifications`.
 *
 * Источник: design.md → `NotificationCenter` → `NotificationView`.
 */
export interface NotificationView {
  id: number;
  kind: NotificationEventKind;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Scheduled broadcast draft (input для PreFlight Preview)
// ---------------------------------------------------------------------------

/**
 * Черновик `ScheduledBroadcast`, который пользователь редактирует в UI
 * до клика «Подтвердить и запланировать». Содержит ровно те поля,
 * которые нужны:
 *   1) серверу для создания записи через `POST /api/scheduled-broadcasts`;
 *   2) клиентскому `PreFlight_Engine` для расчёта ETA и предупреждений.
 *
 * Источник: design.md → `PreFlightModalProps.draft`
 * (распределение режима выбирается через `schedule_type`).
 */
export interface ScheduledBroadcastDraft {
  /** Имя рассылки (опционально, отображается в календаре и список view). */
  name?: string | null;

  /** Текст основного сообщения. */
  message: string;

  /** Получатели. Дедупликация по нормализованному номеру — задача движка. */
  contacts: BroadcastContact[];

  /** Опциональный per-recipient персонализированный текст. */
  personalizedMessages?: Record<string, string> | null;

  use_typing?: boolean;
  delay_seconds?: number;
  file_url?: string | null;
  file_name?: string | null;

  /** Режим планирования (см. `ScheduleType`). */
  schedule_type: ScheduleType;

  /** Опорная точка для exact / drip / recurring / smart_time / ab_time / burst. */
  scheduled_for?: string | null;

  // === Send Window (Req 1) ===
  send_window_start?: string | null;
  send_window_end?: string | null;

  // === Smart-Time (Req 2) ===
  smart_time_window_days?: number | null;
  smart_time_top_n?: number | null;

  // === A/B Time Test (Req 3) ===
  ab_time_test_id?: number | null;

  // === Quiet hours (наследуется из enhanced-broadcast-scheduling) ===
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  respect_recipient_tz?: boolean;
  user_tz?: string;

  // === Anti-Ban / Adaptive_Throttle ===
  instance_id?: number | null;
  adaptive_throttle?: boolean;

  // === Auto-Snooze (Req 9) ===
  auto_snooze_enabled?: boolean;
  auto_snooze_threshold?: number;
  auto_snooze_minutes?: number;
  auto_snooze_window_minutes?: number;

  // === Approval (Req 7). UUID или email — резолвится сервером. ===
  approval_user_id?: string | null;

  // === Связи ===
  follow_up_chain_id?: number | null;
  ab_test_id?: number | null;

  /** Идентификатор предыдущей рассылки при `Reschedule_Operation` (Req 11). */
  parent_broadcast_id?: number | null;

  /**
   * Только для существующих черновиков (редактирование):
   * нужен `PreFlight_Engine` для детерминированного seed jitter'а
   * (`WindowEngine` использует `seeded_rng(broadcast.id)`).
   */
  id?: number;
}

// ---------------------------------------------------------------------------
// PreFlight Preview
// ---------------------------------------------------------------------------

/**
 * Один элемент в `PreFlightResult.warnings`.
 *
 * Источник: design.md → `PreFlight_Modal` → `PreFlightWarning`.
 * Спецификация классов: requirements.md Req 5.5–5.8.
 */
export interface PreFlightWarning {
  kind:
    | "quiet_hours_postpone"
    | "calendar_exception_postpone"
    | "daily_limit_exceeded"
    | "instance_unhealthy";
  message: string;
  affectedCount?: number;
}

/**
 * Результат `runPreFlight(...)`.
 *
 * Источник: design.md → `PreFlight_Modal` → `PreFlightResult`.
 * Бюджет вычисления: 300 ms на 5000 контактов (Req 5.12).
 */
export interface PreFlightResult {
  /** Кол-во получателей после дедупликации. */
  recipientCount: number;
  /** ETA первого сообщения, формат `HH:MM` в `user_tz`. */
  firstSendEta: string;
  /** ETA последнего сообщения, формат `HH:MM` в `user_tz`. */
  lastSendEta: string;
  /** 24-bucket гистограмма «сколько сообщений в каждый час». */
  histogram: number[];
  /** Список предупреждений (см. `PreFlightWarning`). */
  warnings: PreFlightWarning[];
  /** Реальное время вычисления (для телеметрии бюджета). */
  computeMs: number;
}

// ---------------------------------------------------------------------------
// Re-exports / locally-defined supporting types
// ---------------------------------------------------------------------------

/**
 * Re-export уже существующего `AntiBanConfig` чтобы все потребители
 * `scheduling/`-модулей могли импортировать единым путём.
 */
export type { AntiBanConfig };

/**
 * Pure-функциональный аналог Prisma-модели `CalendarException`.
 *
 * Соответствует `frontend/prisma/schema.prisma`:
 *   model CalendarException {
 *     id              BigInt   @id @default(autoincrement())
 *     user_id         String   @db.Uuid
 *     name            String
 *     start_date      DateTime @db.Date
 *     end_date        DateTime @db.Date
 *     recurring_type  String?
 *     recurring_value Int?
 *     created_at      DateTime @default(now())
 *   }
 *
 * `start_date` / `end_date` сериализуются как ISO-строки (`YYYY-MM-DD`).
 */
export interface CalendarException {
  id: number;
  user_id: string;
  name: string;
  /** ISO date string, формат `YYYY-MM-DD`. */
  start_date: string;
  /** ISO date string, формат `YYYY-MM-DD`. */
  end_date: string;
  /** `null` — одиночное исключение; `weekly` / `monthly` / `yearly` — повторение. */
  recurring_type: "weekly" | "monthly" | "yearly" | null;
  /**
   * Семантика зависит от `recurring_type`:
   *   weekly  → day_of_week (0–6, ISO: 1=Mon..7=Sun зависит от соглашения spec'и);
   *   monthly → day_of_month (1–31);
   *   yearly  → ordinal (1–366).
   */
  recurring_value: number | null;
  /** ISO date-time. */
  created_at: string;
}

/**
 * Pure-функциональный аналог Prisma-модели `GreenInstance`.
 *
 * Соответствует `frontend/prisma/schema.prisma`:
 *   model GreenInstance {
 *     id            BigInt   @id @default(autoincrement())
 *     user_id       String   @db.Uuid
 *     name          String
 *     id_instance   String
 *     api_token     String                                  // encrypted
 *     api_url       String   @default("https://api.green-api.com")
 *     status        String   @default("unknown")
 *     phone         String?
 *     is_primary    Boolean  @default(false)
 *     created_at    DateTime @default(now())
 *     updated_at    DateTime @updatedAt
 *   }
 *
 * Используется `PreFlight_Engine` для warning'а `instance_unhealthy`
 * (Req 5.8).
 */
export type GreenInstanceStatus =
  | "authorized"
  | "yellowCard"
  | "blocked"
  | "notAuthorized"
  | "starting"
  | "sleepMode"
  | "unknown";

export interface GreenInstance {
  id: number;
  user_id: string;
  name: string;
  id_instance: string;
  /**
   * NB: на клиент `api_token` НЕ отдаётся — токен расшифровывается
   * только серверной стороной. Поле включено в тип ради структурной
   * совместимости с Prisma; на стороне UI оно всегда `null`.
   */
  api_token?: string | null;
  api_url: string;
  /** Совпадает с `InstanceState` из `@/lib/anti-ban`. */
  status: GreenInstanceStatus;
  phone: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}
