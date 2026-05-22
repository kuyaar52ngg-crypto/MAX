/**
 * `GET /api/green-instances/[id]/state` — актуализация статуса инстанса.
 *
 * Шаги:
 *   1. Расшифровка `api_token` (только server-side).
 *   2. Вызов GREEN-API `getStateInstance` через `Throttle_Gate`.
 *   3. Если `authorized` — дополнительно `getSettings` для phone и shared-warning.
 *   4. UPDATE `green_instances.status[, phone]`.
 *   5. Ответ без поля `api_token` и без url с токеном (Requirement 6.5).
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
  computeSharedInstanceWarning,
  extractPhoneFromWid,
} from "@/lib/green-api";
import { greenApiClient } from "@/lib/green-api/server";
import type { GetStateResponse } from "@/lib/green-api";

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

    const stateResult = await greenApiClient.getStateInstance(
      row.id,
      row.id_instance,
      token,
      row.api_url,
    );
    if (!stateResult.ok) {
      return jsonResponse(
        { error: stateResult.error.message, code: stateResult.error.code },
        { status: stateResult.error.httpStatus },
      );
    }

    const newStatus = stateResult.data.stateInstance;
    let phone: string | null = row.phone;
    let sharedInstanceWarning = false;

    if (newStatus === "authorized") {
      const settingsResult = await greenApiClient.getSettings(
        row.id,
        row.id_instance,
        token,
        row.api_url,
      );
      if (settingsResult.ok) {
        phone = extractPhoneFromWid(settingsResult.data.wid) ?? phone;
        sharedInstanceWarning = computeSharedInstanceWarning(
          settingsResult.data.webhookUrl,
          settingsResult.data.outgoingWebhook,
        );
      }
    }

    await prismaRetry(() =>
      prisma.greenInstance.update({
        where: { id: instanceId },
        data: { status: newStatus, phone },
      }),
    );

    const body: GetStateResponse = {
      status: newStatus,
      phone,
      shared_instance_warning: sharedInstanceWarning,
    };
    return jsonResponse(body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances/[id]/state GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
