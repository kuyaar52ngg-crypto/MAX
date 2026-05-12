import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await req.json();
    const broadcast = await prismaRetry(() => prisma.broadcast.updateMany({
      where: { id: BigInt(id), user_id: user.id },
      data: {
        sent: Number(body.sent || 0),
        not_found: Number(body.not_found || 0),
        failed: Number(body.failed || 0),
        status: "done",
      },
    }));

    return jsonResponse({ updated: broadcast.count });
  } catch (error: any) {
    console.error("broadcast finish POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
