/**
 * Notification preference snapshot helpers.
 *
 * Когда API-маршрут создаёт `Notification`, он должен вшить актуальную
 * карту предпочтений пользователя `{event_kind: {channel: enabled}}` в
 * колонку `preference_snapshot` (Req 10.4) — `Notification_Dispatcher`
 * читает именно snapshot, а не live `NotificationPreference`, чтобы
 * закрыть гонку «оператор отключил канал после создания уведомления,
 * но оно всё равно должно уйти по старой подписке».
 *
 * Дефолты при отсутствии записей: `in_app=true`, `email=false`,
 * `telegram=false`. Должны совпадать с `ensureDefaults` в
 * `/api/notification-preferences/route.ts`.
 */

import { prisma, prismaRetry } from "@/lib/prisma";

import type {
  NotificationChannel,
  NotificationEventKind,
} from "./types";

/** Канонический порядок event-kind'ов. Используется для defaults и тестов. */
export const NOTIFICATION_EVENT_KINDS: readonly NotificationEventKind[] = [
  "scheduled",
  "started",
  "paused",
  "resumed",
  "completed",
  "failed",
  "anti_ban_threshold",
  "awaiting_approval",
  "ab_time_completed",
  "auto_snoozed",
] as const;

/** Канонический порядок channel'ов. */
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  "in_app",
  "email",
  "telegram",
] as const;

/** Snapshot предпочтений: `{event_kind: {channel: enabled}}`. */
export type NotificationPreferenceSnapshot = Record<
  NotificationEventKind,
  Record<NotificationChannel, boolean>
>;

/**
 * Дефолтный snapshot — `in_app` включён для всех событий, остальные
 * каналы выключены. Возвращает «толстый» объект, в котором заполнены
 * ВСЕ пары (event_kind, channel), чтобы dispatcher не натыкался на
 * `undefined`.
 */
export function defaultPreferenceSnapshot(): NotificationPreferenceSnapshot {
  const map = {} as NotificationPreferenceSnapshot;
  for (const kind of NOTIFICATION_EVENT_KINDS) {
    const inner = {} as Record<NotificationChannel, boolean>;
    for (const ch of NOTIFICATION_CHANNELS) {
      inner[ch] = ch === "in_app";
    }
    map[kind] = inner;
  }
  return map;
}

/**
 * Считывает `NotificationPreference` пользователя и накладывает поверх
 * дефолтов. Любая пара (event_kind, channel), для которой в БД нет
 * записи, остаётся со значением по умолчанию.
 *
 * Гарантии:
 *   - функция тотальна — если строка из БД содержит неизвестный
 *     `event_kind` или `channel`, она просто пропускается;
 *   - результат всегда содержит ровно `len(EVENT_KINDS) × len(CHANNELS)`
 *     булевых значений.
 */
export async function buildPreferenceSnapshot(
  userId: string,
): Promise<NotificationPreferenceSnapshot> {
  const rows = await prismaRetry(() =>
    prisma.notificationPreference.findMany({
      where: { user_id: userId },
      select: { event_kind: true, channel: true, enabled: true },
    }),
  );

  const snapshot = defaultPreferenceSnapshot();
  for (const row of rows) {
    const kind = row.event_kind as NotificationEventKind;
    const ch = row.channel as NotificationChannel;
    if (!(kind in snapshot)) continue;
    if (!(ch in snapshot[kind])) continue;
    snapshot[kind][ch] = row.enabled;
  }
  return snapshot;
}
