/**
 * `POST /api/scheduled-broadcasts/[id]/resume` — Active Broadcast Controls,
 * возобновление паузнутой рассылки.
 *
 * Контракт (Req 11.1, 11.3 спецификации `broadcast-scheduling-suite`):
 *
 *   11.1 Эндпойнт живёт под `/api/scheduled-broadcasts/[id]/resume`.
 *   11.3 WHEN статус = `paused`, THE Scheduling_Suite SHALL:
 *        — установить `status = "running"` так, чтобы следующий
 *          scheduler tick продолжил с того же
 *          `OperationRun.last_processed_index` без повторной отправки
 *          уже доставленных получателей,
 *        — INSERT `Notification` kind = `resumed` с
 *          `preference_snapshot`.
 *
 * Никакого пересчёта `next_run_at` не нужно — `pause` его сохранил,
 * и worker сам подтянет рассылку из той же точки.
 *
 * Ownership: владелец рассылки (broadcast.user_id), как в pause/cancel.
 *
 * Валидация:
 *   • status != "paused" → 409 `RESUME_INVALID_STATUS`.
 *
 * Атомарность: `prisma.$transaction([update, notification.create])` —
 * если notification не вставится, resume откатится.
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

    // Req 11.3: resume требует строго `paused`.
    if (broadcast.status !== "paused") {
      return jsonResponse(
        {
          error: `Cannot resume a broadcast in status "${broadcast.status}"`,
          error_code: "RESUME_INVALID_STATUS",
        },
        { status: 409 },
      );
    }

    const preferenceSnapshot = await buildPreferenceSnapshot(user.id);

    const [updated] = await prismaRetry(() =>
      prisma.$transaction([
        prisma.scheduledBroadcast.update({
          where: { id: jobId },
          data: { status: "running" },
        }),
        prisma.notification.create({
          data: {
            user_id: user.id,
            kind: "resumed",
            payload: {
              broadcast_id: Number(jobId),
              previous_status: "paused",
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
    console.error("scheduled-broadcasts/[id]/resume POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
