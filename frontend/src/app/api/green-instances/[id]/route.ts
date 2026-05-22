/**
 * `/api/green-instances/[id]` — управление одним инстансом GREEN API.
 *
 * PUT    → обновить name, is_primary.
 * DELETE → удалить инстанс.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  ensureEncryptionKey,
  EncryptionKeyMissingError,
} from "@/lib/encryption";

export const dynamic = "force-dynamic";

async function getOwnedInstance(instanceId: bigint, userId: string) {
  const row = await prismaRetry(() =>
    prisma.greenInstance.findUnique({ where: { id: instanceId } }),
  );
  if (!row || row.user_id !== userId) return null;
  return row;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params;
    const instanceId = BigInt(id);
    const existing = await getOwnedInstance(instanceId, user.id);
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const body = await req.json();
    const { name, is_primary } = body as {
      name?: string;
      is_primary?: boolean;
    };

    const update: Record<string, unknown> = {};

    if (name !== undefined) {
      if (!name.trim()) {
        return jsonResponse(
          { error: "Имя инстанса не может быть пустым" },
          { status: 400 },
        );
      }
      update.name = name.trim();
    }

    if (is_primary !== undefined) {
      if (is_primary) {
        // Unset is_primary on all other instances for this user
        await prismaRetry(() =>
          prisma.greenInstance.updateMany({
            where: { user_id: user.id, id: { not: instanceId } },
            data: { is_primary: false },
          }),
        );
      }
      update.is_primary = Boolean(is_primary);
    }

    if (Object.keys(update).length === 0) {
      return jsonResponse({
        id: existing.id,
        user_id: existing.user_id,
        name: existing.name,
        id_instance: existing.id_instance,
        api_url: existing.api_url,
        status: existing.status,
        phone: existing.phone,
        is_primary: existing.is_primary,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
      });
    }

    const updated = await prismaRetry(() =>
      prisma.greenInstance.update({
        where: { id: instanceId },
        data: update,
      }),
    );

    return jsonResponse({
      id: updated.id,
      user_id: updated.user_id,
      name: updated.name,
      id_instance: updated.id_instance,
      api_url: updated.api_url,
      status: updated.status,
      phone: updated.phone,
      is_primary: updated.is_primary,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances PUT:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params;
    const instanceId = BigInt(id);
    const existing = await getOwnedInstance(instanceId, user.id);
    if (!existing) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    await prismaRetry(() =>
      prisma.greenInstance.delete({ where: { id: instanceId } }),
    );

    // If deleted instance was primary, promote the next one
    if (existing.is_primary) {
      const nextInstance = await prismaRetry(() =>
        prisma.greenInstance.findFirst({
          where: { user_id: user.id },
          orderBy: { created_at: "asc" },
        }),
      );
      if (nextInstance) {
        await prismaRetry(() =>
          prisma.greenInstance.update({
            where: { id: nextInstance.id },
            data: { is_primary: true },
          }),
        );
      }
    }

    return jsonResponse({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("green-instances DELETE:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
