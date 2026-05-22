/**
 * `/api/scheduled-broadcasts/[id]` — управление одной задачей.
 *
 * PATCH  → пауза / возобновление / правка полей.
 * DELETE → отмена задачи (status="cancelled", next_run_at=null —
 *          Flask-планировщик пропускает такие задачи).
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  computeNextRunAt,
  validateScheduleInput,
} from "@/lib/scheduled/computeNextRun";
import type {
  CreateScheduledBroadcastInput,
  UpdateScheduledBroadcastInput,
} from "@/lib/scheduled/types";

export const dynamic = "force-dynamic";

async function getOwned(jobId: bigint, userId: string) {
  const row = await prismaRetry(() =>
    prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
  );
  if (!row || row.user_id !== userId) return null;
  return row;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const jobId = BigInt(id);
    const existing = await getOwned(jobId, user.id);
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const body = (await req.json()) as UpdateScheduledBroadcastInput;

    // Простые status-операции (pause/resume/cancel) пропускаем без
    // полной валидации payload.
    const update: Record<string, unknown> = {};

    if (body.status) {
      if (!["scheduled", "paused", "cancelled", "running", "done", "failed"].includes(body.status)) {
        return jsonResponse({ error: "invalid status" }, { status: 400 });
      }
      update.status = body.status;
      if (body.status === "cancelled") {
        update.next_run_at = null;
      }
      if (body.status === "scheduled" && !existing.next_run_at) {
        // Resume — пересчитаем next_run_at из существующих параметров.
        const recomputed = computeNextRunAt({
          schedule_type: existing.schedule_type as
            | "once"
            | "drip"
            | "recurring",
          scheduled_for: existing.scheduled_for?.toISOString() ?? null,
          recurring_kind:
            (existing.recurring_kind as "daily" | "weekly" | "monthly" | null) ?? null,
          recurring_hour: existing.recurring_hour,
          recurring_minute: existing.recurring_minute,
          recurring_day_of_week: existing.recurring_day_of_week,
          recurring_day_of_month: existing.recurring_day_of_month,
          recurring_until: existing.recurring_until?.toISOString() ?? null,
          user_tz: existing.user_tz,
        });
        update.next_run_at = recomputed;
      }
    }

    // Полное редактирование payload — допускается только для задач со
    // статусом `scheduled` или `paused`, чтобы не лезть в уже бегущую.
    const editable = ["scheduled", "paused"].includes(existing.status);
    if (
      (body.message !== undefined ||
        body.contacts !== undefined ||
        body.schedule_type !== undefined) &&
      editable
    ) {
      const merged: CreateScheduledBroadcastInput = {
        message: body.message ?? existing.message,
        contacts:
          (body.contacts as CreateScheduledBroadcastInput["contacts"]) ??
          (existing.contacts as CreateScheduledBroadcastInput["contacts"]),
        personalized_messages:
          (body.personalized_messages as Record<string, string> | null) ??
          (existing.personalized_messages as Record<string, string> | null),
        use_typing: body.use_typing ?? existing.use_typing,
        delay_seconds: body.delay_seconds ?? existing.delay_seconds,
        file_url: body.file_url ?? existing.file_url ?? null,
        file_name: body.file_name ?? existing.file_name ?? null,
        schedule_type:
          (body.schedule_type as CreateScheduledBroadcastInput["schedule_type"]) ??
          (existing.schedule_type as CreateScheduledBroadcastInput["schedule_type"]),
        scheduled_for:
          body.scheduled_for ?? existing.scheduled_for?.toISOString() ?? null,
        drip_batch_size: body.drip_batch_size ?? existing.drip_batch_size,
        drip_interval_minutes:
          body.drip_interval_minutes ?? existing.drip_interval_minutes,
        recurring_kind:
          (body.recurring_kind as CreateScheduledBroadcastInput["recurring_kind"]) ??
          (existing.recurring_kind as CreateScheduledBroadcastInput["recurring_kind"]),
        recurring_hour: body.recurring_hour ?? existing.recurring_hour,
        recurring_minute: body.recurring_minute ?? existing.recurring_minute,
        recurring_day_of_week:
          body.recurring_day_of_week ?? existing.recurring_day_of_week,
        recurring_day_of_month:
          body.recurring_day_of_month ?? existing.recurring_day_of_month,
        recurring_until:
          body.recurring_until ?? existing.recurring_until?.toISOString() ?? null,
        quiet_hours_enabled:
          body.quiet_hours_enabled ?? existing.quiet_hours_enabled,
        quiet_hours_start:
          body.quiet_hours_start ?? existing.quiet_hours_start,
        quiet_hours_end:
          body.quiet_hours_end ?? existing.quiet_hours_end,
        respect_recipient_tz:
          body.respect_recipient_tz ?? existing.respect_recipient_tz,
        user_tz: body.user_tz ?? existing.user_tz,
      };
      const errors = validateScheduleInput(merged);
      if (errors.length > 0) {
        return jsonResponse({ error: "validation_failed", errors }, { status: 400 });
      }

      Object.assign(update, {
        message: merged.message,
        contacts: merged.contacts,
        personalized_messages: merged.personalized_messages ?? null,
        use_typing: Boolean(merged.use_typing),
        delay_seconds: merged.delay_seconds ?? 3.0,
        file_url: merged.file_url ?? null,
        file_name: merged.file_name ?? null,
        schedule_type: merged.schedule_type,
        scheduled_for: merged.scheduled_for ? new Date(merged.scheduled_for) : null,
        drip_batch_size: merged.drip_batch_size ?? null,
        drip_interval_minutes: merged.drip_interval_minutes ?? null,
        recurring_kind: merged.recurring_kind ?? null,
        recurring_hour: merged.recurring_hour ?? null,
        recurring_minute: merged.recurring_minute ?? null,
        recurring_day_of_week: merged.recurring_day_of_week ?? null,
        recurring_day_of_month: merged.recurring_day_of_month ?? null,
        recurring_until: merged.recurring_until ? new Date(merged.recurring_until) : null,
        quiet_hours_enabled: Boolean(merged.quiet_hours_enabled),
        quiet_hours_start: merged.quiet_hours_start ?? 22,
        quiet_hours_end: merged.quiet_hours_end ?? 8,
        respect_recipient_tz: Boolean(merged.respect_recipient_tz),
        user_tz: merged.user_tz || "UTC",
        next_run_at: computeNextRunAt({
          schedule_type: merged.schedule_type,
          scheduled_for: merged.scheduled_for,
          recurring_kind: merged.recurring_kind,
          recurring_hour: merged.recurring_hour,
          recurring_minute: merged.recurring_minute,
          recurring_day_of_week: merged.recurring_day_of_week,
          recurring_day_of_month: merged.recurring_day_of_month,
          recurring_until: merged.recurring_until,
          user_tz: merged.user_tz,
        }),
      });
    }

    if (Object.keys(update).length === 0) {
      return jsonResponse(existing);
    }

    const fresh = await prismaRetry(() =>
      prisma.scheduledBroadcast.update({
        where: { id: jobId },
        data: update as never,
      }),
    );
    return jsonResponse({ ...fresh, bot_api_token: "***" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts PATCH:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const jobId = BigInt(id);
    const existing = await getOwned(jobId, user.id);
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    // Не удаляем физически — оставляем для истории. Помечаем cancelled.
    await prismaRetry(() =>
      prisma.scheduledBroadcast.update({
        where: { id: jobId },
        data: { status: "cancelled", next_run_at: null },
      }),
    );
    return jsonResponse({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
