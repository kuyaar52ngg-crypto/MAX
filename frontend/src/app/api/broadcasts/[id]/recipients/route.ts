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
    const phone = String(body.phone || "").trim();
    const status = String(body.status || "error").trim();
    const message_id = body.message_id ? String(body.message_id) : null;
    if (!phone) return jsonResponse({ error: "phone required" }, { status: 400 });

    const broadcast = await prismaRetry(() => prisma.broadcast.findFirst({
      where: { id: BigInt(id), user_id: user.id },
      select: { id: true },
    }));
    if (!broadcast) return jsonResponse({ error: "Broadcast not found" }, { status: 404 });

    const recipient = await prismaRetry(() => prisma.recipient.create({
      data: { broadcast_id: BigInt(id), phone, status, message_id },
    }));

    return jsonResponse(recipient, { status: 201 });
  } catch (error: any) {
    console.error("recipient POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
