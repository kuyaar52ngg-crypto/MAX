/**
 * `/api/notification-preferences` — настройки доставки уведомлений
 * по каналам (in_app / email / telegram) для каждого `event_kind`.
 *
 * GET → список предпочтений пользователя. На первом обращении upsert'им
 *       дефолты (`in_app=true`, `email=false`, `telegram=false`) для
 *       всех `event_kind`, чтобы клиент сразу видел полный матрицу.
 * PUT → upsert одной записи `(user_id, event_kind, channel)` —
 *       включение/выключение канала для конкретного события.
 *
 * Спец-кейс: попытка включить telegram-канал без сконфигурированного
 * `INSTANCE_ENCRYPTION_KEY` возвращает 503 «Encryption not configured»,
 * потому что bot token пользователя без шифрования хранить нельзя.
 *
 * _Requirements: 10.2, 10.10_
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Источник: design.md → NotificationCenter, types.ts → NotificationEventKind.
const EVENT_KINDS = [
  "scheduled",
  "started",
  "paused",
  "resumed",
  "completed",
  "failed",
  "anti_ban_threshold",
  "awaiting_approval",
  "ab_time_completed",
  "auto_snoozed",
] as const;

const CHANNELS = ["in_app", "email", "telegram"] as const;

type EventKind = (typeof EVENT_KINDS)[number];
type Channel = (typeof CHANNELS)[number];

function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

function isEncryptionConfigured(): boolean {
  const key = process.env.INSTANCE_ENCRYPTION_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Гарантирует, что для пользователя присутствуют записи по всем
 * (event_kind, channel) парам. Дефолты: `in_app=true`, прочее — `false`.
 *
 * Используется только из GET — PUT работает с уже существующими записями,
 * либо создаёт ровно одну через upsert.
 */
async function ensureDefaults(userId: string) {
  // Сначала читаем существующие — чтобы не дёргать БД insert'ами,
  // если для пользователя уже всё инициализировано.
  const existing = await prismaRetry(() =>
    prisma.notificationPreference.findMany({
      where: { user_id: userId },
      select: { event_kind: true, channel: true },
    }),
  );

  const have = new Set(existing.map((row) => `${row.event_kind}::${row.channel}`));

  const missing: { event_kind: EventKind; channel: Channel }[] = [];
  for (const kind of EVENT_KINDS) {
    for (const ch of CHANNELS) {
      if (!have.has(`${kind}::${ch}`)) {
        missing.push({ event_kind: kind, channel: ch });
      }
    }
  }

  if (missing.length === 0) return;

  await prismaRetry(() =>
    prisma.notificationPreference.createMany({
      data: missing.map(({ event_kind, channel }) => ({
        user_id: userId,
        event_kind,
        channel,
        // Дефолт по требованию: только in_app включён.
        enabled: channel === "in_app",
      })),
      skipDuplicates: true,
    }),
  );
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

    await ensureDefaults(user.id);

    const rows = await prismaRetry(() =>
      prisma.notificationPreference.findMany({
        where: { user_id: user.id },
        orderBy: [{ event_kind: "asc" }, { channel: "asc" }],
      }),
    );

    return jsonResponse({ items: rows });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("notification-preferences GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      event_kind?: unknown;
      channel?: unknown;
      enabled?: unknown;
    };

    if (!isEventKind(body.event_kind)) {
      return jsonResponse(
        { error: "invalid event_kind" },
        { status: 400 },
      );
    }
    if (!isChannel(body.channel)) {
      return jsonResponse({ error: "invalid channel" }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return jsonResponse(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }

    const eventKind: EventKind = body.event_kind;
    const channel: Channel = body.channel;
    const enabled: boolean = body.enabled;

    // Telegram канал требует шифрования bot token — без ключа нельзя
    // безопасно хранить секреты, поэтому отклоняем включение.
    if (channel === "telegram" && enabled && !isEncryptionConfigured()) {
      return jsonResponse(
        { error: "Encryption not configured" },
        { status: 503 },
      );
    }

    const saved = await prismaRetry(() =>
      prisma.notificationPreference.upsert({
        where: {
          user_id_event_kind_channel: {
            user_id: user.id,
            event_kind: eventKind,
            channel,
          },
        },
        create: {
          user_id: user.id,
          event_kind: eventKind,
          channel,
          enabled,
        },
        update: {
          enabled,
        },
      }),
    );

    return jsonResponse(saved);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("notification-preferences PUT:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
