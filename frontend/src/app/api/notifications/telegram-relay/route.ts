/**
 * `POST /api/notifications/telegram-relay` — internal Telegram relay for
 * Flask operations that run outside Next.js but need profile Telegram settings.
 *
 * Auth: X-Notification-Relay-Secret must match NOTIFICATION_RELAY_SECRET.
 */

import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { decrypt } from "@/lib/encryption";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SECRET_HEADER = "x-notification-relay-secret";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secretsMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

function validateBody(raw: unknown):
  | { identifier: string; title: string; message: string }
  | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const identifier = body.identifier;
  const title = body.title;
  const message = body.message;
  if (typeof identifier !== "string" || identifier.trim().length === 0) {
    return { error: "Field 'identifier' must be a non-empty string" };
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return { error: "Field 'title' must be a non-empty string" };
  }
  if (typeof message !== "string") {
    return { error: "Field 'message' must be a string" };
  }
  return {
    identifier: identifier.trim(),
    title: title.trim(),
    message,
  };
}

async function loadProfile(identifier: string) {
  const where = UUID_RE.test(identifier)
    ? { OR: [{ user_id: identifier }, { green_api_id: identifier }] }
    : { green_api_id: identifier };

  return prismaRetry(() =>
    prisma.profile.findFirst({
      where,
      select: {
        telegram_bot_token: true,
        telegram_chat_id: true,
      },
    }),
  );
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.NOTIFICATION_RELAY_SECRET;
  if (!expectedSecret) {
    return jsonResponse(
      { ok: false, error: "NOTIFICATION_RELAY_SECRET is not configured on the relay" },
      { status: 503 },
    );
  }

  const providedSecret = req.headers.get(SECRET_HEADER) ?? "";
  if (!secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ ok: false, error: "Invalid or missing relay secret" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Body is not valid JSON" }, { status: 400 });
  }

  const validated = validateBody(raw);
  if ("error" in validated) {
    return jsonResponse({ ok: false, error: validated.error }, { status: 400 });
  }

  const profile = await loadProfile(validated.identifier);
  if (!profile?.telegram_bot_token || !profile.telegram_chat_id) {
    return jsonResponse(
      { ok: false, error: "Telegram is not configured for this profile" },
      { status: 404 },
    );
  }

  let token: string;
  try {
    token = decrypt(profile.telegram_bot_token);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to decrypt token";
    return jsonResponse({ ok: false, error: message }, { status: 503 });
  }

  const text = `${validated.title}\n\n${validated.message}`.trim().slice(0, 4096);
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: profile.telegram_chat_id,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return jsonResponse(
      { ok: false, error: `Telegram API failed: ${response.status} ${body.slice(0, 300)}` },
      { status: 502 },
    );
  }

  return jsonResponse({ ok: true });
}
