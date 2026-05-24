/**
 * `/api/contact-segments/[id]` — операции над одним сегментом.
 *
 * GET    → детали + members
 * PATCH  → переименовать / сменить цвет / описание
 * DELETE → удалить сегмент (вместе с members через cascade)
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function getOwnedSegment(segmentId: bigint, userId: string) {
  const seg = await prismaRetry(() =>
    prisma.contactSegment.findUnique({ where: { id: segmentId } }),
  );
  if (!seg || seg.user_id !== userId) return null;
  return seg;
}

export async function GET(
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
    let segId: bigint;
    try {
      segId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const seg = await getOwnedSegment(segId, user.id);
    if (!seg) return jsonResponse({ error: "Not found" }, { status: 404 });

    const members = await prismaRetry(() =>
      prisma.contactSegmentMember.findMany({
        where: { segment_id: segId },
        orderBy: { added_at: "desc" },
      }),
    );

    return jsonResponse({
      id: Number(seg.id),
      name: seg.name,
      color: seg.color,
      description: seg.description,
      created_at: seg.created_at.toISOString(),
      updated_at: seg.updated_at.toISOString(),
      members: members.map((m) => ({
        id: Number(m.id),
        phone: m.phone,
        name: m.name,
        notes: m.notes,
        added_at: m.added_at.toISOString(),
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments [id] GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
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
    let segId: bigint;
    try {
      segId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }
    const seg = await getOwnedSegment(segId, user.id);
    if (!seg) return jsonResponse({ error: "Not found" }, { status: 404 });

    const body = (await req.json()) as {
      name?: unknown;
      color?: unknown;
      description?: unknown;
    };
    const update: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (!trimmed) {
        return jsonResponse({ error: "Имя не может быть пустым" }, { status: 400 });
      }
      update.name = trimmed.slice(0, 64);
    }
    if (typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)) {
      update.color = body.color;
    }
    if (body.description !== undefined) {
      update.description =
        typeof body.description === "string"
          ? body.description.trim().slice(0, 256) || null
          : null;
    }
    if (Object.keys(update).length === 0) {
      return jsonResponse(seg);
    }

    const fresh = await prismaRetry(() =>
      prisma.contactSegment.update({
        where: { id: segId },
        data: update,
      }),
    );
    return jsonResponse({
      id: Number(fresh.id),
      name: fresh.name,
      color: fresh.color,
      description: fresh.description,
      created_at: fresh.created_at.toISOString(),
      updated_at: fresh.updated_at.toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments [id] PATCH:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

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
    let segId: bigint;
    try {
      segId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }
    const seg = await getOwnedSegment(segId, user.id);
    if (!seg) return jsonResponse({ error: "Not found" }, { status: 404 });

    await prismaRetry(() =>
      prisma.contactSegment.delete({ where: { id: segId } }),
    );
    return jsonResponse({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments [id] DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
