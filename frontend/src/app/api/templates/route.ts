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

    const templates = await prismaRetry(() => prisma.template.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
    }));
    return jsonResponse(templates);
  } catch (error: any) {
    console.error("templates GET error:", error);
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
    const { name, text } = body;
    if (!name || !text) {
      return jsonResponse({ error: "name and text required" }, { status: 400 });
    }

    const template = await prismaRetry(() => prisma.template.create({
      data: { user_id: user.id, name, text },
    }));

    return jsonResponse(template, { status: 201 });
  } catch (error: any) {
    console.error("templates POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
