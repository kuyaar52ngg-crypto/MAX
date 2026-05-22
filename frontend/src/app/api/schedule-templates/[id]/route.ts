import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PUT(
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
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return jsonResponse({ error: "Укажите название шаблона" }, { status: 400 });
    }

    const template = await prismaRetry(() =>
      prisma.scheduleTemplate.update({
        where: { id: BigInt(id), user_id: user.id },
        data: { name: name.trim() },
      })
    );

    return jsonResponse(template);
  } catch (error: any) {
    if (error.code === "P2025") {
      return jsonResponse({ error: "Template not found" }, { status: 404 });
    }
    console.error("schedule-templates PUT error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(
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

    await prismaRetry(() =>
      prisma.scheduleTemplate.delete({
        where: { id: BigInt(id), user_id: user.id },
      })
    );

    return jsonResponse({ deleted: id });
  } catch (error: any) {
    if (error.code === "P2025") {
      return jsonResponse({ error: "Template not found" }, { status: 404 });
    }
    console.error("schedule-templates DELETE error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
