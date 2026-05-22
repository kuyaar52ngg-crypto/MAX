/**
 * `POST /api/scheduled-broadcasts/[id]/cancel` — Active Broadcast Controls,
 * принудительное прекращение рассылки.
 *
 * Контракт (Req 11.1, 11.4 спецификации `broadcast-scheduling-suite`):
 *
 *   11.1 Эндпойнт живёт под `/api/scheduled-broadcasts/[id]/cancel`.
 *   11.4 WHEN статус ∈ {scheduled, paused, running, pending_approval},
 *        THE Scheduling_Suite SHALL:
 *        — установить `status = "cancelled"`,
 *        — установить `last_run_at = now()`,
 *        — прекратить работу worker'а для этой рассылки.
 *
 * Worker прекращается «пассивно»: BroadcastScheduler при следующем tick
 * не подбирает строки в `cancelled`, а текущая рабочая итерация
 * завершится при следующем чтении статуса. Дополнительно мы
 * принудительно зануляем `next_run_at` — это гарантирует, что
 * scheduler tick больше никогда не возьмёт эту рассылку (тот же
 * паттерн, что в `[id]/route.ts::DELETE` и в reschedule-cancelled).
 *
 * Notification: спецификация Req 11.4 НЕ предписывает emit
 * `Notification` для cancel (в дизайне `Notification_Event_Kind` нет
 * варианта `cancelled`). Поэтому ничего не пишем — это согласуется
 * с design.md (NotificationCenter список kind'ов).
 *
 * Ownership: только владелец рассылки.
 *
 * Валидация:
 *   • status ∉ {scheduled, paused, running, pending_approval} → 409
 *     `CANCEL_INVALID_STATUS`. Это покрывает уже терминальные статусы
 *     (`completed`, `failed`, `cancelled`, `rejected`) — повторная
 *     отмена бессмысленна и могла бы перетереть `last_run_at`.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CANCELLABLE_STATUSES = new Set([
  "scheduled",
  "paused",
  "running",
  "pending_approval",
]);

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

    const broadcast = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
    );
    if (!broadcast || broadcast.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    if (!CANCELLABLE_STATUSES.has(broadcast.status)) {
      return jsonResponse(
        {
          error: `Cannot cancel a broadcast in status "${broadcast.status}"`,
          error_code: "CANCEL_INVALID_STATUS",
        },
        { status: 409 },
      );
    }

    const updated = await prismaRetry(() =>
      prisma.scheduledBroadcast.update({
        where: { id: jobId },
        data: {
          status: "cancelled",
          last_run_at: new Date(),
          next_run_at: null,
        },
      }),
    );

    return jsonResponse({
      ok: true,
      id: Number(updated.id),
      status: updated.status,
      last_run_at: updated.last_run_at?.toISOString() ?? null,
      previous_status: broadcast.status,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/cancel POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
