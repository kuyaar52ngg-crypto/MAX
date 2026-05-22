/**
 * `GET /api/notifications` — список уведомлений текущего оператора.
 *
 * Ответ:
 *   {
 *     items: NotificationView[],   // последние 50, отсортированы по created_at DESC
 *     unread_count: number,        // общее число непрочитанных (read_at IS NULL)
 *   }
 *
 * Источник: requirements.md → Requirement 10.1, 10.5, 10.9;
 *           design.md → Components and Interfaces → `NotificationCenter`.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import type {
  NotificationEventKind,
  NotificationView,
} from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 50;

export async function GET(_req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const [rows, unreadCount] = await prismaRetry(() =>
      Promise.all([
        prisma.notification.findMany({
          where: { user_id: user.id },
          orderBy: { created_at: "desc" },
          take: PAGE_LIMIT,
        }),
        prisma.notification.count({
          where: { user_id: user.id, read_at: null },
        }),
      ]),
    );

    const items: NotificationView[] = rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind as NotificationEventKind,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      readAt: row.read_at ? row.read_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    }));

    return jsonResponse({ items, unread_count: unreadCount });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("notifications GET error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
