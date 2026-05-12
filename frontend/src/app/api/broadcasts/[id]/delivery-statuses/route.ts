import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const broadcastId = BigInt(id);

    const rows = await prismaRetry(() => prisma.recipient.findMany({
      where: { broadcast_id: broadcastId },
    }));
    const mids = rows.map((r) => r.message_id).filter(Boolean) as string[];
    const dsRows = mids.length
      ? await prismaRetry(() => prisma.deliveryStatus.findMany({ where: { message_id: { in: mids } } }))
      : [];
    const dsMap = new Map(dsRows.map((d) => [d.message_id, d]));

    const result = rows.map((r) => ({
      phone: r.phone,
      message_id: r.message_id,
      status: r.status,
      delivery_status: dsMap.get(r.message_id || "")?.status || "pending",
      timestamp: dsMap.get(r.message_id || "")?.timestamp || null,
    }));

    return jsonResponse(result);
  } catch (error: any) {
    console.error("delivery-statuses GET error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
