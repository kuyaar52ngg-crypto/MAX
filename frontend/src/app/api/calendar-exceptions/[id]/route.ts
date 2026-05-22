/**
 * `/api/calendar-exceptions/[id]` — удаление календарного исключения.
 *
 * DELETE → удалить исключение (физическое удаление).
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const exceptionId = BigInt(id);

    // Проверяем, что исключение принадлежит пользователю.
    const existing = await prismaRetry(() =>
      prisma.calendarException.findUnique({ where: { id: exceptionId } }),
    );
    if (!existing || existing.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    await prismaRetry(() =>
      prisma.calendarException.delete({ where: { id: exceptionId } }),
    );

    return jsonResponse({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("calendar-exceptions DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
