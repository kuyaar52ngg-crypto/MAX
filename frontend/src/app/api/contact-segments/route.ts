/**
 * `/api/contact-segments` — CRUD для сохранённых групп контактов (тегов).
 *
 * GET → список сегментов пользователя с количеством участников и blacklist-метаданными.
 * POST → создание нового сегмента.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const segments = await prismaRetry(() =>
      prisma.contactSegment.findMany({
        where: { user_id: user.id },
        orderBy: [{ created_at: "asc" }],
        include: { _count: { select: { members: true } } },
      }),
    );

    return jsonResponse(
      segments.map((s) => ({
        id: Number(s.id),
        name: s.name,
        color: s.color,
        description: s.description,
        member_count: s._count.members,
        created_at: s.created_at.toISOString(),
        updated_at: s.updated_at.toISOString(),
      })),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { name?: unknown; color?: unknown; description?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return jsonResponse({ error: "Имя сегмента обязательно" }, { status: 400 });
    }
    if (name.length > 64) {
      return jsonResponse(
        { error: "Имя сегмента не более 64 символов" },
        { status: 400 },
      );
    }
    const color =
      typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)
        ? body.color
        : "#6b7280";
    const description =
      typeof body.description === "string"
        ? body.description.trim().slice(0, 256) || null
        : null;

    try {
      const created = await prismaRetry(() =>
        prisma.contactSegment.create({
          data: {
            user_id: user.id,
            name,
            color,
            description,
          },
        }),
      );
      return jsonResponse(
        {
          id: Number(created.id),
          name: created.name,
          color: created.color,
          description: created.description,
          member_count: 0,
          created_at: created.created_at.toISOString(),
          updated_at: created.updated_at.toISOString(),
        },
        { status: 201 },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("Unique constraint")) {
        return jsonResponse(
          { error: "Сегмент с таким именем уже существует" },
          { status: 400 },
        );
      }
      throw e;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
