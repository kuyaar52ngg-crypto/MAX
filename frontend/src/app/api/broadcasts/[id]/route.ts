import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const broadcastId = BigInt(id);

    const rows = await prisma.recipient.findMany({
      where: { broadcast_id: broadcastId },
    });
    const mids = rows.map((r) => r.message_id).filter(Boolean) as string[];
    const dsRows = mids.length
      ? await prisma.deliveryStatus.findMany({ where: { message_id: { in: mids } } })
      : [];
    const dsMap = new Map(dsRows.map((d) => [d.message_id, d]));

    const result = rows.map((r) => ({
      id: r.id,
      broadcast_id: r.broadcast_id,
      phone: r.phone,
      status: r.status,
      message_id: r.message_id,
      sent_at: r.sent_at,
      delivery_status: dsMap.get(r.message_id || "")?.status || "pending",
    }));

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("broadcast recipients GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
