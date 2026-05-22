/**
 * `GET /api/green-instances/[id]/qr` — QR-код для авторизации MAX.
 *
 * Возвращает `{ type, message?, server_timestamp }`. Тип `qrCode` —
 * base64 PNG в `message`; `alreadyLogged` — без message; `error` — текст в message.
 *
 * При `alreadyLogged` дополнительно дёргаем getStateInstance + getSettings,
 * чтобы синхронизировать статус и phone в БД (Requirement 3.4).
 *
 * Никогда не возвращает url, содержащий токен (Requirement 6.4).
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  decrypt,
  ensureEncryptionKey,
  EncryptionKeyMissingError,
} from "@/lib/encryption";
import {
  extractPhoneFromWid,
} from "@/lib/green-api";
import { greenApiClient } from "@/lib/green-api/server";
import type { GetQRResponse } from "@/lib/green-api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureEncryptionKey();
  } catch (err) {
    if (err instanceof EncryptionKeyMissingError) {
      return jsonResponse({ error: "Encryption service unavailable" }, { status: 503 });
    }
    throw err;
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    let instanceId: bigint;
    try {
      instanceId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const row = await prismaRetry(() =>
      prisma.greenInstance.findUnique({ where: { id: instanceId } }),
    );
    if (!row || row.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    let token: string;
    try {
      token = decrypt(row.api_token);
    } catch {
      return jsonResponse(
        { error: "Не удалось расшифровать api_token. Попробуйте сменить credentials." },
        { status: 500 },
      );
    }

    const qrResult = await greenApiClient.getQR(
      row.id,
      row.id_instance,
      token,
      row.api_url,
    );
    if (!qrResult.ok) {
      return jsonResponse(
        { error: qrResult.error.message, code: qrResult.error.code },
        { status: qrResult.error.httpStatus },
      );
    }

    // Side-effect: при `alreadyLogged` обновляем статус + phone.
    if (qrResult.data.type === "alreadyLogged") {
      const stateResult = await greenApiClient.getStateInstance(
        row.id,
        row.id_instance,
        token,
        row.api_url,
      );
      if (stateResult.ok) {
        let phone: string | null = row.phone;
        if (stateResult.data.stateInstance === "authorized") {
          const settingsResult = await greenApiClient.getSettings(
            row.id,
            row.id_instance,
            token,
            row.api_url,
          );
          if (settingsResult.ok) {
            phone = extractPhoneFromWid(settingsResult.data.wid) ?? phone;
          }
        }
        await prismaRetry(() =>
          prisma.greenInstance.update({
            where: { id: instanceId },
            data: { status: stateResult.data.stateInstance, phone },
          }),
        );
      }
    }

    const response: GetQRResponse = {
      type: qrResult.data.type,
      server_timestamp: Date.now(),
    };
    if (qrResult.data.type !== "alreadyLogged" && qrResult.data.message) {
      response.message = qrResult.data.message;
    }
    return jsonResponse(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances/[id]/qr GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
