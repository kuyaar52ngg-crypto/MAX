/**
 * `POST /api/scheduled-broadcasts/[id]/pause` — Active Broadcast Controls,
 * перевод запущенной рассылки на паузу.
 *
 * Контракт (Req 11.1, 11.2 спецификации `broadcast-scheduling-suite`):
 *
 *   11.1 Эндпойнт живёт под `/api/scheduled-broadcasts/[id]/pause`.
 *   11.2 WHEN статус = `running`, THE Scheduling_Suite SHALL:
 *        — установить `status = "paused"`,
 *        — НЕ трогать `next_run_at` (scheduler tick потом продолжит
 *          с того же `last_processed_index` linked `OperationRun`,
 *          см. Req 11.3),
 *        — НЕ трогать `operation_run_id` (на `ScheduledBroadcast` нет
 *          физической колонки — линковка идёт через
 *          `operation_runs.payload->>'scheduled_broadcast_id'`,
 *          поэтому "intact" обеспечен автоматически),
 *        — INSERT `Notification` kind = `paused` с `preference_snapshot`.
 *
 * Ownership: пауза доступна владельцу рассылки (broadcast.user_id),
 * это согласуется с DELETE/PATCH в `[id]/route.ts`.
 *
 * Валидация:
 *   • status != "running" → 409 `PAUSE_INVALID_STATUS`.
 *
 * Атомарность: `prisma.$transaction([update, notification.create])` —
 * если запись Notification не вставится, пауза откатится. Совпадает
 * с паттерном `[id]/snooze/route.ts`.
 */

import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { buildPreferenceSnapshot } from "@/lib/scheduling/notificationSnapshot";

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

    const broadcast = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
    );
    if (!broadcast || broadcast.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    // Req 11.2: pause требует строго `running`.
    if (broadcast.status !== "running") {
      return jsonResponse(
        {
          error: `Cannot pause a broadcast in status "${broadcast.status}"`,
          error_code: "PAUSE_INVALID_STATUS",
        },
        { status: 409 },
      );
    }

    // Snapshot предпочтений считается ДО транзакции — это read-only
    // вызов, не вступающий в гонку с оставшимися записями.
    const preferenceSnapshot = await buildPreferenceSnapshot(user.id);

    // Атомарно: status=paused (next_run_at оставляем как есть, чтобы
    // scheduler tick мог корректно продолжить после resume) +
    // INSERT Notification kind=paused.
    const [updated] = await prismaRetry(() =>
      prisma.$transaction([
        prisma.scheduledBroadcast.update({
          where: { id: jobId },
          data: { status: "paused" },
        }),
        prisma.notification.create({
          data: {
            user_id: user.id,
            kind: "paused",
            payload: {
              broadcast_id: Number(jobId),
              previous_status: "running",
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
      status: updated.status,
      next_run_at: updated.next_run_at?.toISOString() ?? null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/pause POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
