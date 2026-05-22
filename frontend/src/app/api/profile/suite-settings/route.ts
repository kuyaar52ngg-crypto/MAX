/**
 * `/api/profile/suite-settings` — операторские настройки broadcast-suite:
 *   - `approval_required_above_n` — порог получателей для approval gate (0 = выкл.)
 *   - `burst_recipient_limit` — потолок для burst-режима
 *   - `telegram_bot_token` (зашифрован) — токен для notification-канала Telegram
 *   - `telegram_chat_id` — куда писать
 *
 * GET → возвращает значения. `telegram_bot_token` НЕ возвращается; вместо
 *       него флаг `telegram_bot_token_set: boolean`.
 * PUT → upsert. На сохранение telegram-токена при отсутствующем
 *       `INSTANCE_ENCRYPTION_KEY` отвечает 503 «Encryption not configured».
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  encrypt,
  ensureEncryptionKey,
  EncryptionKeyMissingError,
} from "@/lib/encryption";

export const dynamic = "force-dynamic";

interface SuiteSettingsResponse {
  approval_required_above_n: number;
  burst_recipient_limit: number;
  telegram_bot_token_set: boolean;
  telegram_chat_id: string | null;
}

interface PutBody {
  approval_required_above_n?: number | null;
  burst_recipient_limit?: number | null;
  telegram_bot_token?: string | null; // null/empty → очистка
  telegram_chat_id?: string | null;
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

    const profile = await prismaRetry(() =>
      prisma.profile.upsert({
        where: { user_id: user.id },
        create: { user_id: user.id },
        update: {},
      }),
    );
    const body: SuiteSettingsResponse = {
      approval_required_above_n: profile.approval_required_above_n ?? 0,
      burst_recipient_limit: profile.burst_recipient_limit ?? 100,
      telegram_bot_token_set: Boolean(profile.telegram_bot_token),
      telegram_chat_id: profile.telegram_chat_id ?? null,
    };
    return jsonResponse(body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("profile/suite-settings GET:", message);
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

    let body: PutBody;
    try {
      body = (await req.json()) as PutBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    const update: Record<string, unknown> = {};

    if (body.approval_required_above_n !== undefined) {
      const v = body.approval_required_above_n;
      if (v !== null) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100000) {
          return jsonResponse(
            { error: "approval_required_above_n must be an integer in [0, 100000]" },
            { status: 400 },
          );
        }
      }
      update.approval_required_above_n = v ?? 0;
    }

    if (body.burst_recipient_limit !== undefined) {
      const v = body.burst_recipient_limit;
      if (v === null) {
        update.burst_recipient_limit = 100;
      } else {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10000) {
          return jsonResponse(
            { error: "burst_recipient_limit must be an integer in [1, 10000]" },
            { status: 400 },
          );
        }
        update.burst_recipient_limit = v;
      }
    }

    // Telegram fields — токен хранится зашифрованным.
    if (body.telegram_bot_token !== undefined) {
      const raw = (body.telegram_bot_token ?? "").trim();
      if (raw.length === 0) {
        update.telegram_bot_token = null;
      } else {
        try {
          ensureEncryptionKey();
        } catch (err) {
          if (err instanceof EncryptionKeyMissingError) {
            return jsonResponse(
              {
                error:
                  "Encryption not configured. Set INSTANCE_ENCRYPTION_KEY to enable Telegram notifications.",
              },
              { status: 503 },
            );
          }
          throw err;
        }
        update.telegram_bot_token = encrypt(raw);
      }
    }

    if (body.telegram_chat_id !== undefined) {
      const raw = (body.telegram_chat_id ?? "").trim();
      update.telegram_chat_id = raw.length === 0 ? null : raw;
    }

    await prismaRetry(() =>
      prisma.profile.upsert({
        where: { user_id: user.id },
        create: {
          user_id: user.id,
          ...update,
        },
        update,
      }),
    );

    const fresh = await prismaRetry(() =>
      prisma.profile.findUnique({ where: { user_id: user.id } }),
    );
    const response: SuiteSettingsResponse = {
      approval_required_above_n: fresh?.approval_required_above_n ?? 0,
      burst_recipient_limit: fresh?.burst_recipient_limit ?? 100,
      telegram_bot_token_set: Boolean(fresh?.telegram_bot_token),
      telegram_chat_id: fresh?.telegram_chat_id ?? null,
    };
    return jsonResponse(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("profile/suite-settings PUT:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
