/**
 * `POST /api/notifications/email-relay` — email relay endpoint for the
 * Flask `Notification_Dispatcher`.
 *
 * Контракт (mirrors `scheduling/notification_dispatcher.py::_send_email`):
 *
 *   Headers:
 *     X-Notification-Relay-Secret: <shared secret>
 *     Content-Type: application/json
 *
 *   Body:
 *     { user_id: string, kind: string, payload: object, to: string }
 *
 *   Response 200: { ok: true }
 *   Response 401: invalid/missing shared secret
 *   Response 400: malformed body / missing fields
 *   Response 503: relay or SMTP not configured
 *   Response 502: SMTP transport failure
 *
 * Source: requirements.md → Requirement 10.6;
 *         tasks.md → 9.14.
 *
 * Защита: shared secret в заголовке `X-Notification-Relay-Secret`
 * совпадает с env `NOTIFICATION_RELAY_SECRET`. Это backend-to-backend
 * вызов (Flask → Next.js), пользовательской авторизации Supabase
 * здесь нет.
 */

import { createTransport, type Transporter } from "nodemailer";
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { jsonResponse } from "@/lib/json";

export const dynamic = "force-dynamic";
// Forced to Node.js runtime: nodemailer + node:crypto are not available
// in the Edge runtime.
export const runtime = "nodejs";

const SECRET_HEADER = "x-notification-relay-secret";

interface EmailRelayBody {
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  to: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Constant-time comparison to avoid leaking secret length / contents
 * via timing side-channels. Both buffers are padded to the same length
 * before comparing so `timingSafeEqual` does not throw on mismatch.
 */
function secretsMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers — pad to max length
  // with zeros so a length mismatch still results in a false comparison
  // without short-circuiting.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

function loadSmtpConfig(): SmtpConfig | { error: string } {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  const missing: string[] = [];
  if (!host) missing.push("SMTP_HOST");
  if (!portRaw) missing.push("SMTP_PORT");
  if (!user) missing.push("SMTP_USER");
  if (!pass) missing.push("SMTP_PASS");
  if (!from) missing.push("SMTP_FROM");
  if (missing.length > 0) {
    return { error: `SMTP not configured: missing ${missing.join(", ")}` };
  }

  const port = Number.parseInt(portRaw as string, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { error: `SMTP_PORT must be an integer in [1, 65535] (got "${portRaw}")` };
  }

  // SMTP_SECURE override is optional. When unset:
  //   - port 465 implies TLS (secure=true)
  //   - any other port assumes STARTTLS (secure=false)
  // This mirrors nodemailer's documented behaviour.
  const secureRaw = process.env.SMTP_SECURE;
  const secure =
    secureRaw === undefined || secureRaw === ""
      ? port === 465
      : ["1", "true", "yes", "on"].includes(secureRaw.toLowerCase());

  return {
    host: host as string,
    port,
    secure,
    user: user as string,
    pass: pass as string,
    from: from as string,
  };
}

/**
 * Derive subject + body from `kind` + `payload`. Keeps the format
 * intentionally minimal — operators get a readable email without
 * relying on per-kind templates which are out of scope here.
 *
 *   subject = `[Broadcast Suite] <kind>`
 *   text    = `payload.message` if present and string, otherwise a
 *             pretty-printed JSON dump of `payload`.
 */
function renderEmailContent(
  kind: string,
  payload: Record<string, unknown>,
): { subject: string; text: string } {
  const subject = `[Broadcast Suite] ${kind}`;
  const message = payload?.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return { subject, text: message };
  }
  let text: string;
  try {
    text = JSON.stringify(payload ?? {}, null, 2);
  } catch {
    text = String(payload);
  }
  return { subject, text };
}

function validateBody(raw: unknown): EmailRelayBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const user_id = body.user_id;
  const kind = body.kind;
  const payload = body.payload;
  const to = body.to;

  if (typeof user_id !== "string" || user_id.length === 0) {
    return { error: "Field 'user_id' must be a non-empty string" };
  }
  if (typeof kind !== "string" || kind.length === 0) {
    return { error: "Field 'kind' must be a non-empty string" };
  }
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Field 'payload' must be a JSON object" };
  }
  if (typeof to !== "string" || to.length === 0) {
    return { error: "Field 'to' must be a non-empty string" };
  }
  // Minimal email validity check — the SMTP server will do the real
  // validation; this just guards against obvious misuse.
  if (!to.includes("@")) {
    return { error: "Field 'to' must look like an email address" };
  }

  return {
    user_id,
    kind,
    payload: payload as Record<string, unknown>,
    to,
  };
}

export async function POST(req: NextRequest) {
  // 1. Relay secret must be configured server-side. Without it we
  //    cannot authenticate Flask, so we refuse with 503 — same
  //    semantic as Flask uses on its side ("provider not configured").
  const expectedSecret = process.env.NOTIFICATION_RELAY_SECRET;
  if (!expectedSecret) {
    return jsonResponse(
      { ok: false, error: "NOTIFICATION_RELAY_SECRET is not configured on the relay" },
      { status: 503 },
    );
  }

  // 2. Caller must provide the matching secret. Constant-time compare
  //    to avoid leaking any byte of the secret via response timing.
  const providedSecret = req.headers.get(SECRET_HEADER) ?? "";
  if (!secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse(
      { ok: false, error: "Invalid or missing relay secret" },
      { status: 401 },
    );
  }

  // 3. Parse and validate body.
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

  // 4. SMTP config must be present. Like the secret guard above, a
  //    misconfigured SMTP returns 503 so Flask can record a clear
  //    `dispatch_error` and keep the standard retry cycle.
  const smtp = loadSmtpConfig();
  if ("error" in smtp) {
    return jsonResponse({ ok: false, error: smtp.error }, { status: 503 });
  }

  // 5. Build transport. We deliberately create a fresh transporter
  //    per request — relay traffic is low-volume (one notification at
  //    a time, retried with back-off), and a long-lived pool would
  //    have to handle process recycling and config reloads anyway.
  let transporter: Transporter;
  try {
    transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse(
      { ok: false, error: `SMTP transport init failed: ${message}` },
      { status: 503 },
    );
  }

  const { subject, text } = renderEmailContent(validated.kind, validated.payload);

  try {
    await transporter.sendMail({
      from: smtp.from,
      to: validated.to,
      subject,
      text,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("email-relay sendMail failed:", message);
    return jsonResponse(
      { ok: false, error: `SMTP send failed: ${message}` },
      { status: 502 },
    );
  } finally {
    // Free the SMTP socket promptly — see comment above on per-request
    // transporter lifecycle.
    try {
      transporter.close();
    } catch {
      /* ignore close errors */
    }
  }

  return jsonResponse({ ok: true });
}
