/**
 * `POST /api/notifications/[id]/read` — отметить уведомление прочитанным.
 *
 * Безопасность: `read_at = now()` выставляется только если уведомление
 * принадлежит вызывающему пользователю (`user_id = auth.user.id`).
 * Повторный вызов идемпотентен — `read_at` не перезаписывается, чтобы
 * сохранить первоначальный момент прочтения.
 *
 * Источник: requirements.md → Requirement 10.5, 10.9.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
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
    let notificationId: bigint;
    try {
      notificationId = BigInt(id);
    } catch {
      return jsonResponse({ error: "invalid id" }, { status: 400 });
    }

    // Update only when ownership matches AND not yet read — keeps the first
    // read timestamp stable across repeat calls.
    const result = await prismaRetry(() =>
      prisma.notification.updateMany({
        where: {
          id: notificationId,
          user_id: user.id,
          read_at: null,
        },
        data: { read_at: new Date() },
      }),
    );

    if (result.count === 0) {
      // Differentiate "not yours / not found" from "already read".
      const existing = await prismaRetry(() =>
        prisma.notification.findFirst({
          where: { id: notificationId, user_id: user.id },
          select: { id: true, read_at: true },
        }),
      );
      if (!existing) {
        return jsonResponse({ error: "Not found" }, { status: 404 });
      }
      return jsonResponse({
        marked: id,
        read_at: existing.read_at?.toISOString() ?? null,
        already_read: true,
      });
    }

    return jsonResponse({ marked: id, already_read: false });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("notifications/[id]/read error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
