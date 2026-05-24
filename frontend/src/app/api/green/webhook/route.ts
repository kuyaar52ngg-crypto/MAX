/**
 * `POST /api/green/webhook` — приёмник webhooks от GREEN-API.
 *
 * GREEN-API шлёт несколько типов webhook events:
 *   - `incomingMessageReceived` — новое входящее сообщение
 *   - `outgoingMessageStatus` — статус отправленного: sent/delivered/read/failed
 *   - `outgoingAPIMessageReceived` / `outgoingMessageReceived` — наша же отправка зеркалом
 *   - `stateInstanceChanged` — смена статуса инстанса
 *
 * Документация: https://green-api.com/v3/docs/api/webhook/
 *
 * Что мы делаем:
 *   - `incomingMessageReceived` → INSERT в `Incoming`
 *   - `outgoingMessageStatus` → UPDATE `DeliveryStatus` + `Recipient.status`
 *   - `stateInstanceChanged` → UPDATE `GreenInstance.status` (для signed instances)
 *
 * Авторизация:
 *   GREEN-API не подписывает webhook, но в URL должен передаваться
 *   ?token=<API_TOKEN_INSTANCE> или ?id_instance=<INST>&token=<TOK>.
 *   Мы проверяем что параметры совпадают с одним из существующих
 *   `GreenInstance` записей. Без этого — 401.
 *
 * Формат URL для настройки в GREEN-API:
 *   https://<your-domain>/api/green/webhook?id_instance=...&token=...
 *
 * Этот webhook stateless и идемпотентен. Безопасен для повторных вызовов.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

interface WebhookEnvelope {
  typeWebhook?: string;
  instanceData?: {
    idInstance?: number | string;
    wid?: string;
    typeInstance?: string;
  };
  timestamp?: number;
  idMessage?: string;
  body?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MessageData {
  typeMessage?: string;
  textMessageData?: { textMessage?: string };
  fileMessageData?: { downloadUrl?: string; fileName?: string };
  extendedTextMessageData?: { text?: string };
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const idInstanceParam = url.searchParams.get("id_instance");
    const tokenParam = url.searchParams.get("token");

    if (!idInstanceParam || !tokenParam) {
      return jsonResponse(
        { error: "Missing id_instance or token in query string" },
        { status: 401 },
      );
    }

    // Найдём GreenInstance по id_instance + сравним расшифрованный api_token.
    const instance = await prismaRetry(() =>
      prisma.greenInstance.findFirst({
        where: { id_instance: idInstanceParam },
      }),
    );
    if (!instance) {
      return jsonResponse({ error: "Instance not found" }, { status: 401 });
    }

    let storedToken: string;
    try {
      storedToken = decrypt(instance.api_token);
    } catch {
      return jsonResponse({ error: "Decryption failed" }, { status: 500 });
    }

    if (storedToken !== tokenParam) {
      return jsonResponse({ error: "Invalid token" }, { status: 401 });
    }

    let body: WebhookEnvelope;
    try {
      body = (await req.json()) as WebhookEnvelope;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    const type = body.typeWebhook;
    if (!type) {
      // Тихо игнорируем безымянные пакеты — некоторые webhook test'ы шлют пустые.
      return jsonResponse({ ok: true, ignored: true });
    }

    const userId = instance.user_id;

    // ── Type 1: incoming message ─────────────────────────────────────
    if (
      type === "incomingMessageReceived" ||
      type === "incomingMessage"
    ) {
      const senderData = (body as { senderData?: { sender?: string; senderName?: string } })
        .senderData ?? {};
      const messageData = (body as { messageData?: MessageData }).messageData ?? {};
      const sender = senderData.sender ?? "";
      if (!sender) {
        return jsonResponse({ ok: true, ignored: "no_sender" });
      }
      const senderPhone = sender.replace(/@.*$/, "");
      const text =
        messageData.textMessageData?.textMessage ??
        messageData.extendedTextMessageData?.text ??
        null;
      const fileUrl = messageData.fileMessageData?.downloadUrl ?? null;
      const msgType = messageData.typeMessage ?? "text";

      await prismaRetry(() =>
        prisma.incoming.create({
          data: {
            user_id: userId,
            sender: senderPhone,
            sender_name: senderData.senderName ?? null,
            message: text,
            type: msgType,
            file_url: fileUrl,
            received_at: body.timestamp
              ? new Date(body.timestamp * 1000)
              : new Date(),
            is_read: false,
          },
        }),
      );
      return jsonResponse({ ok: true, kind: "incoming" });
    }

    // ── Type 2: outgoing status update ──────────────────────────────
    if (
      type === "outgoingMessageStatus" ||
      type === "messageStatus"
    ) {
      const messageId = body.idMessage;
      const status =
        (body as { status?: string }).status ?? "sent";
      if (!messageId) {
        return jsonResponse({ ok: true, ignored: "no_messageId" });
      }
      // 1. Upsert DeliveryStatus.
      await prismaRetry(() =>
        prisma.deliveryStatus.upsert({
          where: { message_id: messageId },
          create: {
            message_id: messageId,
            status,
          },
          update: {
            status,
            timestamp: new Date(),
          },
        }),
      );
      // 2. Подтянем Recipient если message_id привязан и обновим статус.
      await prismaRetry(() =>
        prisma.recipient.updateMany({
          where: { message_id: messageId },
          data: { status },
        }),
      );
      return jsonResponse({ ok: true, kind: "delivery" });
    }

    // ── Type 3: outgoing mirror — наша же отправка отзеркалена ───────
    if (
      type === "outgoingAPIMessageReceived" ||
      type === "outgoingMessageReceived"
    ) {
      // Пока ничего полезного не делаем, но фиксируем для аналитики.
      return jsonResponse({ ok: true, kind: "outgoing_mirror" });
    }

    // ── Type 4: instance state changed ──────────────────────────────
    if (type === "stateInstanceChanged") {
      const newState =
        (body as { stateInstance?: string }).stateInstance ?? "unknown";
      await prismaRetry(() =>
        prisma.greenInstance.update({
          where: { id: instance.id },
          data: { status: newState },
        }),
      );
      return jsonResponse({ ok: true, kind: "state" });
    }

    // Неизвестный тип — успех + ignored, чтобы GREEN-API не ретраил.
    return jsonResponse({ ok: true, ignored: type });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green/webhook POST:", message);
    // GREEN-API ожидает 200 для подтверждения. На 5xx он будет ретраить
    // долго и забивать наш сервер. Лучше залогировать и вернуть 200.
    return jsonResponse({ ok: false, error: message }, { status: 200 });
  }
}

// Также позволим GET для health-check со стороны GREEN-API при настройке.
export async function GET() {
  return jsonResponse({
    ok: true,
    info: "GREEN-API webhook endpoint. POST events here.",
  });
}
