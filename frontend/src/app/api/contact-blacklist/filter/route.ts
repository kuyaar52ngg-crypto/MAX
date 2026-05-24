/**
 * `POST /api/contact-blacklist/filter` — фильтрация массива телефонов
 * по blacklist пользователя.
 *
 * Используется UI рассылки перед запуском, чтобы случайно не отправить
 * сообщение тем, кого пользователь явно занёс в blacklist.
 *
 * Body:  { phones: string[] }
 * Body:  { allowed: string[], blocked: string[] }
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_PHONES_PER_REQUEST = 10_000;

function normalize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\D+/g, "");
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
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

    const body = (await req.json()) as { phones?: unknown };
    if (!Array.isArray(body.phones)) {
      return jsonResponse({ error: "phones must be an array" }, { status: 400 });
    }
    if (body.phones.length > MAX_PHONES_PER_REQUEST) {
      return jsonResponse(
        { error: `Too many (max ${MAX_PHONES_PER_REQUEST})` },
        { status: 413 },
      );
    }

    // Нормализуем + дедуп.
    const seen = new Set<string>();
    for (const raw of body.phones) {
      const p = normalize(raw);
      if (p) seen.add(p);
    }
    const unique = Array.from(seen);
    if (unique.length === 0) {
      return jsonResponse({ allowed: [], blocked: [] });
    }

    const blacklisted = await prismaRetry(() =>
      prisma.contactBlacklist.findMany({
        where: {
          user_id: user.id,
          phone: { in: unique },
        },
        select: { phone: true },
      }),
    );
    const blockedSet = new Set(blacklisted.map((b) => b.phone));

    const allowed: string[] = [];
    const blocked: string[] = [];
    for (const p of unique) {
      if (blockedSet.has(p)) blocked.push(p);
      else allowed.push(p);
    }

    return jsonResponse({ allowed, blocked });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("contact-blacklist/filter POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
