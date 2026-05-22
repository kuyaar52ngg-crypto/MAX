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

    const templates = await prismaRetry(() =>
      prisma.scheduleTemplate.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
      })
    );

    return jsonResponse(templates);
  } catch (error: any) {
    console.error("schedule-templates GET error:", error);
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
    const { name, config } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return jsonResponse({ error: "Укажите название шаблона" }, { status: 400 });
    }

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return jsonResponse({ error: "config must be a valid object" }, { status: 400 });
    }

    const template = await prismaRetry(() =>
      prisma.scheduleTemplate.create({
        data: {
          user_id: user.id,
          name: name.trim(),
          config,
        },
      })
    );

    return jsonResponse(template, { status: 201 });
  } catch (error: any) {
    console.error("schedule-templates POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
