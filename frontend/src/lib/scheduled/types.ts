/**
 * Типы планировщика рассылок. Совпадают с моделью `ScheduledBroadcast`
 * в `frontend/prisma/schema.prisma` и таблицей `scheduled_broadcasts`,
 * которую читает Flask-планировщик (`scheduler.py`).
 */

import type { BroadcastContact } from "@/lib/types";

export type ScheduleType = "once" | "drip" | "recurring";
export type RecurringKind = "daily" | "weekly" | "monthly";
export type ScheduleStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "done"
  | "cancelled"
  | "failed";

export interface ScheduledBroadcastDTO {
  id: number;
  user_id: string;
  name: string | null;
  message: string;
  contacts: BroadcastContact[];
  personalized_messages: Record<string, string> | null;
  use_typing: boolean;
  delay_seconds: number;
  file_url: string | null;
  file_name: string | null;

  schedule_type: ScheduleType;
  scheduled_for: string | null;

  drip_batch_size: number | null;
  drip_interval_minutes: number | null;
  drip_wave_index: number;

  recurring_kind: RecurringKind | null;
  recurring_hour: number | null;
  recurring_minute: number | null;
  recurring_day_of_week: number | null;
  recurring_day_of_month: number | null;
  recurring_until: string | null;

  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  respect_recipient_tz: boolean;
  user_tz: string;

  status: ScheduleStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  runs_count: number;

  created_at: string;
  updated_at: string;
}

/**
 * Payload для создания scheduled broadcast.
 * Контакты, сообщение, file_* — из обычного UI рассылки.
 * Schedule-поля заполняются в `ScheduleModal`.
 */
export interface CreateScheduledBroadcastInput {
  name?: string | null;
  message: string;
  contacts: BroadcastContact[];
  personalized_messages?: Record<string, string> | null;
  use_typing?: boolean;
  delay_seconds?: number;
  file_url?: string | null;
  file_name?: string | null;

  schedule_type: ScheduleType;
  scheduled_for?: string | null; // ISO

  drip_batch_size?: number | null;
  drip_interval_minutes?: number | null;

  recurring_kind?: RecurringKind | null;
  recurring_hour?: number | null;
  recurring_minute?: number | null;
  recurring_day_of_week?: number | null;
  recurring_day_of_month?: number | null;
  recurring_until?: string | null;

  quiet_hours_enabled?: boolean;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  respect_recipient_tz?: boolean;
  user_tz?: string;
}

export interface UpdateScheduledBroadcastInput
  extends Partial<CreateScheduledBroadcastInput> {
  status?: ScheduleStatus;
}
