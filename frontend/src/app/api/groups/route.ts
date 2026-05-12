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

    const groups = await prismaRetry(() => prisma.group.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
    }));
    return jsonResponse(groups);
  } catch (error: any) {
    console.error("groups GET error:", error);
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
    const { group_id, name } = body;
    if (!group_id) {
      return jsonResponse({ error: "group_id required" }, { status: 400 });
    }

    const group = await prismaRetry(() => prisma.group.upsert({
      where: { user_id_group_id: { user_id: user.id, group_id } },
      create: { user_id: user.id, group_id, name: name || "" },
      update: { name: name || undefined },
    }));

    return jsonResponse(group, { status: 201 });
  } catch (error: any) {
    console.error("groups POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
