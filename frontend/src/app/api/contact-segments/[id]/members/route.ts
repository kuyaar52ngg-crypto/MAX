/**
 * `/api/contact-segments/[id]/members` — управление телефонами в сегменте.
 *
 * POST   → добавить набор телефонов (батчем)
 * DELETE → удалить набор телефонов
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_PHONES_PER_REQUEST = 5000;

interface BatchBody {
  phones?: unknown;
}

function normalize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\D+/g, "");
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}

async function checkOwnership(segmentId: bigint, userId: string) {
  const seg = await prismaRetry(() =>
    prisma.contactSegment.findUnique({ where: { id: segmentId } }),
  );
  return seg && seg.user_id === userId ? seg : null;
}

export async function POST(
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
    if (!(await checkOwnership(segId, user.id))) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const body = (await req.json()) as BatchBody;
    if (!Array.isArray(body.phones)) {
      return jsonResponse(
        { error: "phones must be an array" },
        { status: 400 },
      );
    }
    if (body.phones.length > MAX_PHONES_PER_REQUEST) {
      return jsonResponse(
        { error: `Too many (max ${MAX_PHONES_PER_REQUEST})` },
        { status: 413 },
      );
    }

    // Принимаем строки или объекты {phone, name?, notes?}.
    const records: { phone: string; name: string | null; notes: string | null }[] = [];
    for (const raw of body.phones) {
      if (typeof raw === "string") {
        const phone = normalize(raw);
        if (phone) records.push({ phone, name: null, notes: null });
      } else if (raw && typeof raw === "object" && "phone" in raw) {
        const ph = (raw as { phone: unknown }).phone;
        const phone = normalize(ph);
        if (phone) {
          const name =
            typeof (raw as { name?: unknown }).name === "string"
              ? ((raw as { name: string }).name.trim().slice(0, 128) || null)
              : null;
          const notes =
            typeof (raw as { notes?: unknown }).notes === "string"
              ? ((raw as { notes: string }).notes.trim().slice(0, 512) || null)
              : null;
          records.push({ phone, name, notes });
        }
      }
    }

    // Дедуп.
    const seen = new Set<string>();
    const unique = records.filter((r) => {
      if (seen.has(r.phone)) return false;
      seen.add(r.phone);
      return true;
    });

    if (unique.length === 0) {
      return jsonResponse({ inserted: 0, skipped: 0 });
    }

    // createMany с skipDuplicates для идемпотентного добавления.
    const result = await prismaRetry(() =>
      prisma.contactSegmentMember.createMany({
        data: unique.map((u) => ({
          segment_id: segId,
          phone: u.phone,
          name: u.name,
          notes: u.notes,
        })),
        skipDuplicates: true,
      }),
    );

    return jsonResponse({
      inserted: result.count,
      skipped: unique.length - result.count,
      total_requested: body.phones.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments members POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function DELETE(
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
    if (!(await checkOwnership(segId, user.id))) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const body = (await req.json()) as BatchBody;
    if (!Array.isArray(body.phones) || body.phones.length === 0) {
      return jsonResponse(
        { error: "phones must be a non-empty array" },
        { status: 400 },
      );
    }
    const phones = body.phones
      .map((p) => normalize(p))
      .filter((p): p is string => typeof p === "string");

    if (phones.length === 0) {
      return jsonResponse({ deleted: 0 });
    }

    const result = await prismaRetry(() =>
      prisma.contactSegmentMember.deleteMany({
        where: {
          segment_id: segId,
          phone: { in: phones },
        },
      }),
    );

    return jsonResponse({ deleted: result.count });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-segments members DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
