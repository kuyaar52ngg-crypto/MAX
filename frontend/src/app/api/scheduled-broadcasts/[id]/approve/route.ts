/**
 * `POST /api/scheduled-broadcasts/[id]/approve`
 *
 * Apruver-эндпойнт для подтверждения рассылки в `pending_approval`.
 *
 * Контракт (Req 7.7, 7.9):
 *   - Caller должен совпадать с `broadcast.approval_user_id`. Иначе 403
 *     `APPROVAL_FORBIDDEN` и **никакие поля рассылки не меняются** (Req 7.9).
 *   - На успех: `approval_status='approved'`, `approved_at=now()`,
 *     `status='scheduled'` — после чего обычный scheduler tick подхватит
 *     рассылку через `next_run_at`.
 *
 * Эндпойнт нарочно НЕ использует `getOwned`, как остальные `[id]/route.ts`
 * методы: апрувер — это другой пользователь, не владелец рассылки.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { computeNextRunAt } from "@/lib/scheduled/computeNextRun";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
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

    const existing = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
    );
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    // Req 7.9: caller must be the resolved approver. If approval_user_id is
    // null or does not match, the caller is not the approver — 403 and DO
    // NOT modify the broadcast in any way.
    if (
      !existing.approval_user_id ||
      existing.approval_user_id !== user.id
    ) {
      return jsonResponse(
        { error: "Forbidden", code: "APPROVAL_FORBIDDEN" },
        { status: 403 },
      );
    }

    // Защитная проверка: имеет смысл аппрувить только pending — иначе мы
    // могли бы воскресить отменённую/завершённую рассылку. Это согласуется
    // с Req 7.4 (broadcast в `pending_approval` блокируется до явного
    // действия Approver) — в любом другом состоянии действие не имеет
    // смысла.
    if (existing.approval_status !== "pending") {
      return jsonResponse(
        {
          error: "Broadcast is not awaiting approval",
          code: "APPROVAL_INVALID_STATE",
          approval_status: existing.approval_status,
          status: existing.status,
        },
        { status: 409 },
      );
    }

    // Если next_run_at когда-то слетел в null (ничто в коде сейчас этого
    // не делает, но защитимся) — пересчитаем из существующих параметров,
    // как это делает PATCH при resume.
    const nextRunAt =
      existing.next_run_at ??
      computeNextRunAt({
        schedule_type: existing.schedule_type as
          | "once"
          | "drip"
          | "recurring",
        scheduled_for: existing.scheduled_for?.toISOString() ?? null,
        recurring_kind:
          (existing.recurring_kind as
            | "daily"
            | "weekly"
            | "monthly"
            | null) ?? null,
        recurring_hour: existing.recurring_hour,
        recurring_minute: existing.recurring_minute,
        recurring_day_of_week: existing.recurring_day_of_week,
        recurring_day_of_month: existing.recurring_day_of_month,
        recurring_until: existing.recurring_until?.toISOString() ?? null,
        user_tz: existing.user_tz,
      });

    const fresh = await prismaRetry(() =>
      prisma.scheduledBroadcast.update({
        where: { id: jobId },
        data: {
          approval_status: "approved",
          approved_at: new Date(),
          status: "scheduled",
          next_run_at: nextRunAt,
        },
      }),
    );

    return jsonResponse({ ...fresh, bot_api_token: "***" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/approve POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
