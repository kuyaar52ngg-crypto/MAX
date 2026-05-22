/**
 * `POST /api/green-instances/[id]/reauth` — перепривязка MAX к существующему инстансу.
 *
 * Шаги:
 *   1. logout (через GREEN-API).
 *   2. getStateInstance.
 *   3. UPDATE status [+ phone, если authorized]. `is_primary` и `name` НЕ трогаем.
 *   4. Если новый статус == authorized И previous != authorized →
 *      audit-event `instance_reauthorized`.
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
import { auditLog, greenApiClient } from "@/lib/green-api/server";
import type { InstanceStatus, PostReauthResponse } from "@/lib/green-api";

export const dynamic = "force-dynamic";

export async function POST(
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

    const previousStatus = row.status as InstanceStatus;
    let token: string;
    try {
      token = decrypt(row.api_token);
    } catch {
      return jsonResponse(
        { error: "Не удалось расшифровать api_token. Попробуйте сменить credentials." },
        { status: 500 },
      );
    }

    const logoutResult = await greenApiClient.logout(
      row.id,
      row.id_instance,
      token,
      row.api_url,
    );
    if (!logoutResult.ok) {
      // Только если код явно про неверные credentials/not_found — пробрасываем.
      // Прочие ошибки (например, 5xx) — пробрасываем тоже, иначе скрытно
      // оставим неконсистентное состояние.
      return jsonResponse(
        { error: logoutResult.error.message, code: logoutResult.error.code },
        { status: logoutResult.error.httpStatus },
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

    if (newStatus === "authorized" && previousStatus !== "authorized") {
      await auditLog("instance_reauthorized", user.id, {
        green_instance_id: row.id.toString(),
        id_instance: row.id_instance,
        previous_status: previousStatus,
        new_status: "authorized",
      });
    }

    const body: PostReauthResponse = {
      status: newStatus,
      phone,
      shared_instance_warning: sharedInstanceWarning,
    };
    return jsonResponse(body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances/[id]/reauth POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
