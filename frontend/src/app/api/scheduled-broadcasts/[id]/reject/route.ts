/**
 * `POST /api/scheduled-broadcasts/[id]/reject`
 *
 * Apruver-эндпойнт для отклонения рассылки в `pending_approval`.
 *
 * Контракт (Req 7.8, 7.9):
 *   - Caller должен совпадать с `broadcast.approval_user_id`. Иначе 403
 *     `APPROVAL_FORBIDDEN` и **никакие поля рассылки не меняются** (Req 7.9).
 *   - Body требует non-empty `rejection_reason` (string). На пустой/missing —
 *     400 `APPROVAL_REASON_REQUIRED`.
 *   - На успех: `approval_status='rejected'`, `status='rejected'`,
 *     `rejection_reason` записан. `next_run_at` обнуляется — отклонённая
 *     рассылка не должна подхватываться planner-tick.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RejectBody {
  rejection_reason?: unknown;
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

    const existing = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: jobId } }),
    );
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    // Req 7.9: caller must be the resolved approver. Если нет —
    // 403 БЕЗ изменения каких-либо полей. Эта проверка должна стоять
    // ПЕРЕД парсингом body, чтобы даже невалидный JSON или пустой
    // `rejection_reason` не давал shortcut к информации о рассылке
    // и не мог триггерить никакой записи.
    if (
      !existing.approval_user_id ||
      existing.approval_user_id !== user.id
    ) {
      return jsonResponse(
        { error: "Forbidden", code: "APPROVAL_FORBIDDEN" },
        { status: 403 },
      );
    }

    let body: RejectBody;
    try {
      body = (await req.json()) as RejectBody;
    } catch {
      return jsonResponse(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const rawReason = body?.rejection_reason;
    const reason =
      typeof rawReason === "string" ? rawReason.trim() : "";
    if (!reason) {
      return jsonResponse(
        {
          error: "rejection_reason is required",
          code: "APPROVAL_REASON_REQUIRED",
        },
        { status: 400 },
      );
    }

    // Согласованность с approve: имеет смысл отклонять только pending.
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

    const fresh = await prismaRetry(() =>
      prisma.scheduledBroadcast.update({
        where: { id: jobId },
        data: {
          approval_status: "rejected",
          status: "rejected",
          rejection_reason: reason,
          next_run_at: null,
        },
      }),
    );

    return jsonResponse({ ...fresh, bot_api_token: "***" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/reject POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
