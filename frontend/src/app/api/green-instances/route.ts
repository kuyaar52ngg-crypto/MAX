/**
 * `/api/green-instances` — CRUD для инстансов GREEN API.
 *
 * GET  → список инстансов текущего пользователя (без расшифрованных токенов).
 * POST → добавление нового инстанса:
 *        - лимит 5 на пользователя;
 *        - валидация credentials через `getStateInstance` (через `Throttle_Gate`);
 *        - на `authorized` дополнительно `getSettings` для phone и
 *          `shared_instance_warning` (Requirement 10.1, 10.2);
 *        - audit-event `instance_connected` (Requirement 9.1).
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
import {
  computeSharedInstanceWarning,
  extractPhoneFromWid,
} from "@/lib/green-api";
import { auditLog, greenApiClient } from "@/lib/green-api/server";
import type { InstanceStatus } from "@/lib/green-api";

export const dynamic = "force-dynamic";

const MAX_INSTANCES_PER_USER = 5;

export async function GET() {
  try {
    ensureEncryptionKey();
  } catch (err) {
    if (err instanceof EncryptionKeyMissingError) {
      return jsonResponse(
        { error: "Encryption service unavailable" },
        { status: 503 },
      );
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

    const instances = await prismaRetry(() =>
      prisma.greenInstance.findMany({
        where: { user_id: user.id },
        orderBy: [{ is_primary: "desc" }, { created_at: "asc" }],
      }),
    );

    // Никогда не возвращаем `api_token` (Requirement 6.3).
    const safe = instances.map((inst) => ({
      id: inst.id,
      user_id: inst.user_id,
      name: inst.name,
      id_instance: inst.id_instance,
      api_url: inst.api_url,
      status: inst.status as InstanceStatus,
      phone: inst.phone,
      is_primary: inst.is_primary,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
    }));

    return jsonResponse(safe);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureEncryptionKey();
  } catch (err) {
    if (err instanceof EncryptionKeyMissingError) {
      return jsonResponse(
        { error: "Encryption service unavailable" },
        { status: 503 },
      );
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

    const body = await req.json();
    const { name, id_instance, api_token, api_url } = body as {
      name?: string;
      id_instance?: string;
      api_token?: string;
      api_url?: string;
    };

    const idInstance = (id_instance ?? "").trim();
    const apiToken = (api_token ?? "").trim();
    const rawApiUrl = (api_url ?? "").trim();

    if (!idInstance) {
      return jsonResponse(
        { error: "Поле id_instance обязательно" },
        { status: 400 },
      );
    }
    if (!apiToken) {
      return jsonResponse(
        { error: "Поле api_token обязательно" },
        { status: 400 },
      );
    }

    // Default name — `Инстанс XXXX` (последние 4 цифры) — мирроринг
    // фронтового поведения для устойчивости (Requirement 1.6).
    const defaultName = `Инстанс ${idInstance.slice(-4)}`;
    const finalName = (name ?? "").trim() || defaultName;

    // Лимит 5 инстансов на пользователя.
    const existingCount = await prismaRetry(() =>
      prisma.greenInstance.count({ where: { user_id: user.id } }),
    );
    if (existingCount >= MAX_INSTANCES_PER_USER) {
      return jsonResponse(
        { error: "Достигнут лимит инстансов (максимум 5)" },
        { status: 400 },
      );
    }

    const instanceApiUrl = (rawApiUrl || "https://api.green-api.com").replace(/\/$/, "");

    // Используем синтетический ключ для throttle (записи ещё нет в БД).
    // Любая последующая запись будет читаться по реальному id из БД.
    const synthGateKey = `__pending__:${user.id}:${idInstance}`;

    const stateResult = await greenApiClient.getStateInstance(
      synthGateKey,
      idInstance,
      apiToken,
      instanceApiUrl,
    );

    let instanceStatus: InstanceStatus = "unknown";
    let phone: string | null = null;
    let sharedInstanceWarning = false;

    if (!stateResult.ok) {
      // Для `invalid_credentials` отказываем — нельзя сохранять заведомо
      // мёртвую запись, иначе она «висит» в списке.
      if (stateResult.error.code === "invalid_credentials") {
        return jsonResponse(
          { error: stateResult.error.message, code: stateResult.error.code },
          { status: stateResult.error.httpStatus },
        );
      }
      // Прочие сетевые/server ошибки — сохраняем как unknown, чтобы health-job
      // потом ре-валидировал.
      instanceStatus = "unknown";
    } else {
      instanceStatus = stateResult.data.stateInstance;
      if (instanceStatus === "authorized") {
        const settingsResult = await greenApiClient.getSettings(
          synthGateKey,
          idInstance,
          apiToken,
          instanceApiUrl,
        );
        if (settingsResult.ok) {
          phone = extractPhoneFromWid(settingsResult.data.wid);
          sharedInstanceWarning = computeSharedInstanceWarning(
            settingsResult.data.webhookUrl,
            settingsResult.data.outgoingWebhook,
          );
        }
      }
    }

    const encryptedToken = encrypt(apiToken);

    const created = await prismaRetry(() =>
      prisma.greenInstance.create({
        data: {
          user_id: user.id,
          name: finalName,
          id_instance: idInstance,
          api_token: encryptedToken,
          api_url: instanceApiUrl,
          status: instanceStatus,
          phone,
          is_primary: existingCount === 0,
        },
      }),
    );

    // Audit. Не блокируем ответ при сбое — auditLog никогда не пробрасывает.
    if (
      instanceStatus === "authorized" ||
      instanceStatus === "notAuthorized" ||
      instanceStatus === "starting"
    ) {
      await auditLog("instance_connected", user.id, {
        green_instance_id: created.id.toString(),
        id_instance: idInstance,
        new_status: instanceStatus,
        shared_instance_warning: sharedInstanceWarning,
      });
    }

    return jsonResponse(
      {
        id: created.id,
        user_id: created.user_id,
        name: created.name,
        id_instance: created.id_instance,
        api_url: created.api_url,
        status: created.status,
        phone: created.phone,
        is_primary: created.is_primary,
        shared_instance_warning: sharedInstanceWarning,
        created_at: created.created_at,
        updated_at: created.updated_at,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Unique constraint")) {
      return jsonResponse(
        { error: "Этот инстанс уже подключён к вашему аккаунту" },
        { status: 400 },
      );
    }
    console.error("green-instances POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
