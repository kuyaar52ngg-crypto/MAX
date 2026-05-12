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

    const hidden = await prismaRetry(() => prisma.hiddenGroup.findMany({
      where: { user_id: user.id },
    }));
    return jsonResponse(hidden.map((h) => h.group_id));
  } catch (error: any) {
    console.error("hidden groups GET error:", error);
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
    const { group_id } = body;
    if (!group_id) {
      return jsonResponse({ error: "group_id required" }, { status: 400 });
    }

    await prismaRetry(() => prisma.hiddenGroup.upsert({
      where: { user_id_group_id: { user_id: user.id, group_id } },
      create: { user_id: user.id, group_id },
      update: {},
    }));

    return jsonResponse({ success: true });
  } catch (error: any) {
    console.error("hidden groups POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
