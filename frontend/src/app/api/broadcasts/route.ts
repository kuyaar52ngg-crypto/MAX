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

    const broadcasts = await prismaRetry(() => prisma.broadcast.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
      take: 50,
    }));
    return jsonResponse(broadcasts);
  } catch (error: any) {
    console.error("broadcasts GET error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { message, total, file_url, file_name, use_typing } = body;

    const broadcast = await prismaRetry(() => prisma.broadcast.create({
      data: {
        user_id: user.id,
        message: message || "",
        total: total || 0,
        file_url: file_url || null,
        file_name: file_name || null,
        use_typing: use_typing || false,
      },
    }));

    return jsonResponse(broadcast, { status: 201 });
  } catch (error: any) {
    console.error("broadcasts POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
