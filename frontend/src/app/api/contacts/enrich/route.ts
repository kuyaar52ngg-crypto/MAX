import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const chatIds: string[] = body.chatIds || [];
    if (!chatIds.length) {
      return jsonResponse({});
    }

    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const cached = await prismaRetry(() => prisma.contactCache.findMany({
      where: { user_id: user.id, chat_id: { in: chatIds } },
    }));

    const result: Record<string, { name: string | null; avatar_url: string | null }> = {};
    const toFetch: string[] = [];

    for (const cid of chatIds) {
      const c = cached.find((x) => x.chat_id === cid);
      if (c && now - new Date(c.updated_at).getTime() < STALE_MS) {
        result[cid] = { name: c.name, avatar_url: c.avatar_url };
      } else {
        toFetch.push(cid);
      }
    }

    // TODO: fetch missing from Flask /api/contact-info in parallel
    for (const cid of toFetch) {
      result[cid] = { name: null, avatar_url: null };
    }

    return jsonResponse(result);
  } catch (error: any) {
    console.error("contacts enrich error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
