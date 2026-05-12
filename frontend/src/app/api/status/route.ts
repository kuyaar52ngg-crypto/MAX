import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await prismaRetry(() => prisma.broadcast.findMany({
      where: { user_id: user.id, status: "done" },
    }));

    let total = 0, sent = 0, not_found = 0, failed = 0;
    for (const r of rows) {
      total += r.total || 0;
      sent += r.sent || 0;
      not_found += r.not_found || 0;
      failed += r.failed || 0;
    }

    const unread = await prismaRetry(() => prisma.incoming.count({
      where: { user_id: user.id, is_read: false },
    }));

    return jsonResponse({
      stats: {
        total,
        sent,
        not_found,
        failed,
        success_rate: total ? Math.round((sent / total) * 1000) / 10 : 0,
      },
      unread_count: unread,
    });
  } catch (error: any) {
    console.error("status GET error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
