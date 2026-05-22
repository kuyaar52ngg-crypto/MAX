/**
 * `POST /api/scheduled-broadcasts/[id]/snooze` — быстрый перенос
 * запланированной рассылки на пресет («+1 час», «+1 день», «+неделя»,
 * «следующий рабочий день» или произвольное число минут).
 *
 * Поведение и контракт полностью соответствуют Requirement 6:
 *
 *   6.1 Body: `{ preset: "1h"|"1d"|"7d"|"next_business_day"|"custom",
 *               custom_minutes?: number }`.
 *   6.2 Сдвиг существующих `scheduled_for` и `next_run_at` без создания
 *       новой записи.
 *   6.3 `next_business_day` — следующий Mon–Fri в `user_tz`, не
 *       пересекающийся с `CalendarException`, с сохранением
 *       wall-clock времени дня.
 *   6.4 `custom_minutes` ∈ [1, 43200] (30 дней). Иначе 400
 *       `SNOOZE_CUSTOM_INVALID`.
 *   6.5 Только `status ∈ {scheduled, paused, pending_approval}`.
 *       Иначе 409 `SNOOZE_INVALID_STATUS`.
 *   6.6 Если новый `scheduled_for` попал в quiet hours — roll forward
 *       до первого инстанта вне quiet hours.
 *   6.7 Успех → INSERT `Notification` kind=`scheduled` со снимком
 *       `preference_snapshot`.
 *   6.8 На любой error НЕ создаём notification (нет транзакции —
 *       нет уведомления).
 *
 * Логика арифметики переиспользует `applySnoozePreset` из
 * `@/lib/scheduling/snoozePresets`, которая в свою очередь опирается
 * на `nextBusinessDay` / `isInException` из
 * `@/lib/scheduling/calendarHelpers`. Это даёт единое место правды
 * между UI-preview, серверным расчётом и (в будущем) Python
 * `Reschedule_Operation`.
 */

import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  applySnoozePreset,
  isValidCustomMinutes,
  type QuietHoursConfig,
  type SnoozePreset,
} from "@/lib/scheduling/snoozePresets";
import { buildPreferenceSnapshot } from "@/lib/scheduling/notificationSnapshot";
import type { CalendarException } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

const ALLOWED_PRESETS: readonly SnoozePreset[] = [
  "1h",
  "1d",
  "7d",
  "next_business_day",
  "custom",
] as const;

const SNOOZEABLE_STATUSES = new Set([
  "scheduled",
  "paused",
  "pending_approval",
]);

interface SnoozeRequestBody {
  preset?: unknown;
  custom_minutes?: unknown;
}

function isSnoozePreset(value: unknown): value is SnoozePreset {
  return (
    typeof value === "string" &&
    (ALLOWED_PRESETS as readonly string[]).includes(value)
  );
}

/**
 * Read user's `CalendarException` records and reshape into the
 * pure-functional shape expected by `applySnoozePreset`. Dates from
 * Postgres come back as `Date` instances; we serialise them to
 * `YYYY-MM-DD` so the helper's parser can consume them uniformly.
 */
async function loadExceptions(userId: string): Promise<CalendarException[]> {
  const rows = await prismaRetry(() =>
    prisma.calendarException.findMany({
      where: { user_id: userId },
      orderBy: [{ start_date: "asc" }, { id: "desc" }],
    }),
  );
  return rows.map((row) => ({
    id: Number(row.id),
    user_id: row.user_id,
    name: row.name,
    start_date: row.start_date.toISOString().slice(0, 10),
    end_date: row.end_date.toISOString().slice(0, 10),
    recurring_type:
      (row.recurring_type as CalendarException["recurring_type"]) ?? null,
    recurring_value: row.recurring_value ?? null,
    created_at: row.created_at.toISOString(),
  }));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    let jobId: bigint;
    try {
      jobId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Invalid id" }, { status: 400 });
    }

    let body: SnoozeRequestBody;
    try {
      body = (await req.json()) as SnoozeRequestBody;
    } catch {
      return jsonResponse(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (!isSnoozePreset(body.preset)) {
      return jsonResponse(
        {
          error: "Invalid preset",
          error_code: "SNOOZE_PRESET_INVALID",
        },
        { status: 400 },
      );
    }
    const preset: SnoozePreset = body.preset;

    // Pre-validate custom_minutes BEFORE any DB hit so we never load
    // exceptions / broadcast rows just to reject malformed input.
    let customMinutes: number | null | undefined = undefined;
    if (preset === "custom") {
      if (!isValidCustomMinutes(body.custom_minutes)) {
        return jsonResponse(
          {
            error:
              "custom_minutes must be an integer in [1, 43200] (up to 30 days)",
            error_code: "SNOOZE_CUSTOM_INVALID",
          },
          { status: 400 },
        );
      }
      customMinutes = body.custom_minutes;
    }

    const broadcast = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
    );
    if (!broadcast || broadcast.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    if (!SNOOZEABLE_STATUSES.has(broadcast.status)) {
      return jsonResponse(
        {
          error: `Cannot snooze a broadcast in status "${broadcast.status}"`,
          error_code: "SNOOZE_INVALID_STATUS",
        },
        { status: 409 },
      );
    }

    // Anchor for the snooze offset is `scheduled_for` if present, else
    // `next_run_at`, else "now". `applySnoozePreset` is total over all
    // three branches, but if neither exists we cannot meaningfully
    // shift the schedule.
    const anchor =
      broadcast.scheduled_for ??
      broadcast.next_run_at ??
      null;
    if (!anchor) {
      return jsonResponse(
        {
          error: "Broadcast has no scheduled_for/next_run_at to snooze",
          error_code: "SNOOZE_NO_ANCHOR",
        },
        { status: 409 },
      );
    }

    const exceptions = await loadExceptions(user.id);

    const quietHours: QuietHoursConfig = {
      enabled: Boolean(broadcast.quiet_hours_enabled),
      start: broadcast.quiet_hours_start ?? 22,
      end: broadcast.quiet_hours_end ?? 8,
    };

    const outcome = applySnoozePreset(
      anchor,
      preset,
      customMinutes,
      broadcast.user_tz || "UTC",
      exceptions,
      quietHours,
    );

    if (outcome.kind === "invalid_custom") {
      return jsonResponse(
        {
          error:
            "custom_minutes must be an integer in [1, 43200] (up to 30 days)",
          error_code: "SNOOZE_CUSTOM_INVALID",
        },
        { status: 400 },
      );
    }
    if (outcome.kind === "no_business_day") {
      return jsonResponse(
        {
          error:
            "No business day available within lookahead window — adjust calendar exceptions",
          error_code: "SNOOZE_NO_BUSINESS_DAY",
        },
        { status: 422 },
      );
    }

    const newScheduledFor = outcome.scheduledFor;

    // Build preference_snapshot BEFORE any write so that a snapshot
    // failure does not leave a half-applied snooze. `buildPreferenceSnapshot`
    // is idempotent and read-only — it will not touch the DB if the
    // user already has all preferences materialised.
    const preferenceSnapshot = await buildPreferenceSnapshot(user.id);

    // Apply both the schedule shift and the notification insert in a
    // single transaction so that Req 6.8 is mechanically guaranteed:
    // if the notification insert fails, the snooze is rolled back too.
    const [updated] = await prismaRetry(() =>
      prisma.$transaction([
        prisma.scheduledBroadcast.update({
          where: { id: jobId },
          data: {
            scheduled_for: newScheduledFor,
            next_run_at: newScheduledFor,
          },
        }),
        prisma.notification.create({
          data: {
            user_id: user.id,
            kind: "scheduled",
            payload: {
              broadcast_id: Number(jobId),
              scheduled_for: newScheduledFor.toISOString(),
              preset,
              custom_minutes:
                preset === "custom" ? customMinutes ?? null : null,
              adjusted_for_quiet_hours: outcome.adjustedForQuietHours,
            } as Prisma.InputJsonValue,
            preference_snapshot:
              preferenceSnapshot as unknown as Prisma.InputJsonValue,
          },
        }),
      ]),
    );

    return jsonResponse({
      ok: true,
      id: Number(updated.id),
      scheduled_for: updated.scheduled_for?.toISOString() ?? null,
      next_run_at: updated.next_run_at?.toISOString() ?? null,
      adjusted_for_quiet_hours: outcome.adjustedForQuietHours,
      preset,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/snooze POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
