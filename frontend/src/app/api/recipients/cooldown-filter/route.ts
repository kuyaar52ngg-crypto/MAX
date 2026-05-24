/**
 * `POST /api/recipients/cooldown-filter` — фильтр телефонов, которым уже
 * отправлялись сообщения за последние N дней.
 *
 * Это критично для anti-ban: MAX отслеживает паттерн «спам по одной базе»,
 * и повторные отправки тому же номеру в коротком окне резко повышают шанс
 * жёлтой карточки.
 *
 * Source rule (https://max-catalog24.ru/limits.html):
 *   "Используйте фразу 'если вам не интересно, проигнорируйте'.
 *    Качество контактов: идеальный показатель — >50% ответов."
 *
 * Body:
 *   { phones: string[], cooldown_days?: number }
 *
 * Response:
 *   {
 *     fresh: string[],          // можно отправлять
 *     in_cooldown: string[],    // на cooldown — не отправлять
 *     last_sent: { phone: string, sent_at: string }[],
 *     cooldown_days: number
 *   }
 *
 * Источник данных: `Recipient.sent_at` JOIN `Broadcast.user_id == user.id`.
 * Считаем «отправлено», если `Recipient.status` ∈ {sent, delivered, read}.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DEFAULT_COOLDOWN_DAYS = 7;
const MAX_COOLDOWN_DAYS = 90;
const MAX_PHONES_PER_REQUEST = 5000;

const SUCCESSFUL_STATUSES = ["sent", "delivered", "read"];

interface RequestBody {
  phones?: unknown;
  cooldown_days?: unknown;
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

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!Array.isArray(body.phones)) {
      return jsonResponse(
        { error: "phones must be an array of strings" },
        { status: 400 },
      );
    }

    const requestedDays =
      typeof body.cooldown_days === "number" &&
      Number.isFinite(body.cooldown_days)
        ? Math.floor(body.cooldown_days)
        : DEFAULT_COOLDOWN_DAYS;
    if (requestedDays < 0 || requestedDays > MAX_COOLDOWN_DAYS) {
      return jsonResponse(
        {
          error: `cooldown_days must be in [0, ${MAX_COOLDOWN_DAYS}]`,
        },
        { status: 400 },
      );
    }

    // Нормализуем телефоны (только цифры, дедуп) до запроса в БД.
    const normalized = new Set<string>();
    for (const raw of body.phones) {
      if (typeof raw !== "string") continue;
      const clean = raw.replace(/\D+/g, "");
      if (clean.length >= 10 && clean.length <= 15) {
        normalized.add(clean);
      }
    }
    if (normalized.size === 0) {
      return jsonResponse({
        fresh: [],
        in_cooldown: [],
        last_sent: [],
        cooldown_days: requestedDays,
      });
    }
    if (normalized.size > MAX_PHONES_PER_REQUEST) {
      return jsonResponse(
        { error: `Too many phones (max ${MAX_PHONES_PER_REQUEST})` },
        { status: 413 },
      );
    }

    // cooldown_days = 0 → ничего не фильтруем (явный opt-out от защиты).
    if (requestedDays === 0) {
      return jsonResponse({
        fresh: Array.from(normalized),
        in_cooldown: [],
        last_sent: [],
        cooldown_days: 0,
      });
    }

    const sinceDate = new Date(
      Date.now() - requestedDays * 24 * 60 * 60 * 1000,
    );
    const phoneList = Array.from(normalized);

    // Соберём `Recipient` за окно cooldown среди broadcast-ов пользователя.
    // Если у получателя несколько успешных отправок — берём самую свежую.
    const rawHits = await prismaRetry(() =>
      prisma.recipient.findMany({
        where: {
          phone: { in: phoneList },
          sent_at: { gte: sinceDate },
          status: { in: SUCCESSFUL_STATUSES },
          broadcast: {
            user_id: user.id,
          },
        },
        select: {
          phone: true,
          sent_at: true,
        },
        orderBy: { sent_at: "desc" },
      }),
    );

    const lastByPhone = new Map<string, Date>();
    for (const row of rawHits) {
      const existing = lastByPhone.get(row.phone);
      if (!existing || row.sent_at.getTime() > existing.getTime()) {
        lastByPhone.set(row.phone, row.sent_at);
      }
    }

    const inCooldown: string[] = [];
    const fresh: string[] = [];
    const lastSentList: { phone: string; sent_at: string }[] = [];

    for (const phone of phoneList) {
      const lastSent = lastByPhone.get(phone);
      if (lastSent) {
        inCooldown.push(phone);
        lastSentList.push({ phone, sent_at: lastSent.toISOString() });
      } else {
        fresh.push(phone);
      }
    }

    return jsonResponse({
      fresh,
      in_cooldown: inCooldown,
      last_sent: lastSentList,
      cooldown_days: requestedDays,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("recipients/cooldown-filter POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
