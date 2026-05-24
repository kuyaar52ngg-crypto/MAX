/**
 * `/api/contact-blacklist` — глобальный blacklist пользователя.
 *
 * GET    → список всех номеров в blacklist
 * POST   → добавить набор номеров с опциональным reason
 * DELETE → удалить набор номеров
 *
 * Использование на frontend: перед запуском broadcast вызвать `POST
 * /api/contact-blacklist/filter` (другой endpoint), который вернёт
 * `{ allowed, blocked }` и UI убирает заблокированных перед отправкой.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_PHONES_PER_REQUEST = 5000;

function normalize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\D+/g, "");
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await prismaRetry(() =>
      prisma.contactBlacklist.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
      }),
    );
    return jsonResponse(
      rows.map((r) => ({
        id: Number(r.id),
        phone: r.phone,
        reason: r.reason,
        created_at: r.created_at.toISOString(),
      })),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-blacklist GET:", message);
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

    const body = (await req.json()) as {
      phones?: unknown;
      reason?: unknown;
    };
    if (!Array.isArray(body.phones)) {
      return jsonResponse({ error: "phones must be an array" }, { status: 400 });
    }
    if (body.phones.length > MAX_PHONES_PER_REQUEST) {
      return jsonResponse(
        { error: `Too many (max ${MAX_PHONES_PER_REQUEST})` },
        { status: 413 },
      );
    }
    const reason =
      typeof body.reason === "string"
        ? body.reason.trim().slice(0, 256) || null
        : null;

    const phones = body.phones
      .map((p) => normalize(p))
      .filter((p): p is string => typeof p === "string");
    const seen = new Set<string>();
    const unique = phones.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

    if (unique.length === 0) {
      return jsonResponse({ inserted: 0 });
    }

    const result = await prismaRetry(() =>
      prisma.contactBlacklist.createMany({
        data: unique.map((p) => ({
          user_id: user.id,
          phone: p,
          reason,
        })),
        skipDuplicates: true,
      }),
    );
    return jsonResponse({ inserted: result.count });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-blacklist POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { phones?: unknown };
    if (!Array.isArray(body.phones) || body.phones.length === 0) {
      return jsonResponse(
        { error: "phones must be a non-empty array" },
        { status: 400 },
      );
    }
    const phones = body.phones
      .map((p) => normalize(p))
      .filter((p): p is string => typeof p === "string");
    if (phones.length === 0) return jsonResponse({ deleted: 0 });

    const result = await prismaRetry(() =>
      prisma.contactBlacklist.deleteMany({
        where: {
          user_id: user.id,
          phone: { in: phones },
        },
      }),
    );
    return jsonResponse({ deleted: result.count });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-blacklist DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
