/**
 * `POST /api/green-instances/[id]/credentials` — смена id_instance/api_token
 * на существующей записи. is_primary и name СОХРАНЯЮТСЯ (Requirement 5.6).
 *
 * Поток:
 *   1. Проверка ownership.
 *   2. Валидация body (id_instance, api_token непустые).
 *   3. До записи в БД — getStateInstance НОВЫМИ credentials.
 *      На invalid_credentials — 400 без изменения БД.
 *   4. Если authorized — дополнительно getSettings для phone.
 *   5. Атомарно (в транзакции) UPDATE id_instance, api_token (encrypt), api_url, status, phone.
 *   6. После транзакции — audit event `instance_credentials_changed`.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  decrypt,
  encrypt,
  ensureEncryptionKey,
  EncryptionKeyMissingError,
} from "@/lib/encryption";
import {
  extractPhoneFromWid,
} from "@/lib/green-api";
import { auditLog, greenApiClient } from "@/lib/green-api/server";
import type {
  PostCredentialsRequest,
  PostCredentialsResponse,
} from "@/lib/green-api";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
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

    let body: PostCredentialsRequest;
    try {
      body = (await req.json()) as PostCredentialsRequest;
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    const newIdInstance = (body.id_instance ?? "").trim();
    const newApiToken = (body.api_token ?? "").trim();
    const rawApiUrl = (body.api_url ?? "").trim();
    const newApiUrl = (rawApiUrl || row.api_url).replace(/\/$/, "");

    if (!newIdInstance) {
      return jsonResponse({ error: "Поле id_instance обязательно" }, { status: 400 });
    }
    if (!newApiToken) {
      return jsonResponse({ error: "Поле api_token обязательно" }, { status: 400 });
    }

    // Проверка новых credentials ДО записи (Requirement 5.2/5.3).
    const stateResult = await greenApiClient.getStateInstance(
      row.id,
      newIdInstance,
      newApiToken,
      newApiUrl,
    );
    if (!stateResult.ok) {
      return jsonResponse(
        { error: stateResult.error.message, code: stateResult.error.code },
        { status: stateResult.error.httpStatus },
      );
    }

    const newStatus = stateResult.data.stateInstance;
    let phone: string | null = row.phone;
    if (newStatus === "authorized") {
      const settingsResult = await greenApiClient.getSettings(
        row.id,
        newIdInstance,
        newApiToken,
        newApiUrl,
      );
      if (settingsResult.ok) {
        phone = extractPhoneFromWid(settingsResult.data.wid) ?? phone;
      }
    }

    const previousIdInstance = row.id_instance;
    const encryptedToken = encrypt(newApiToken);

    await prismaRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.greenInstance.update({
          where: { id: instanceId },
          data: {
            id_instance: newIdInstance,
            api_token: encryptedToken,
            api_url: newApiUrl,
            status: newStatus,
            phone,
            // is_primary, name — сознательно НЕ трогаем (Property 6).
          },
        });
      }),
    );

    await auditLog("instance_credentials_changed", user.id, {
      green_instance_id: row.id.toString(),
      previous_id_instance: previousIdInstance,
      id_instance: newIdInstance,
      new_status: newStatus,
    });

    // Защита от случайного использования старого decrypted-токена в коде.
    void decrypt;

    const response: PostCredentialsResponse = {
      status: newStatus,
      phone,
      id_instance: newIdInstance,
      api_url: newApiUrl,
    };
    return jsonResponse(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances/[id]/credentials POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
