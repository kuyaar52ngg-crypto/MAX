/**
 * `GET /api/instances/health` — агрегированный health-check всех инстансов
 * текущего пользователя. Если у пользователя нет ни одного `GreenInstance`,
 * собирает данные про legacy-инстанс из `Profile.green_api_*`.
 *
 * Используется UI перед запуском проверки/рассылки для блокировки
 * операций на нездоровом аккаунте.
 *
 * Response:
 *   {
 *     primary: AccountHealthData | null,
 *     instances: AccountHealthData[]
 *   }
 *
 * Источники данных:
 *   - GreenInstance / Profile (current_status, created_at)
 *   - Incoming (total_incoming, incoming_last_7d)
 *   - Recipient через Broadcast (outgoing_last_7d приближённо)
 *   - OperationRun (checks_last_24h, broadcasts_last_24h)
 *   - IncidentLog (incidents_last_24h, last_bad_incident_at)
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  BAD_INCIDENT_KINDS,
  computeAccountHealth,
  type AccountHealthData,
} from "@/lib/anti-ban/health";

export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface InstanceLite {
  id: number;
  status: string;
  created_at: Date;
  is_primary: boolean;
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * HOUR_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);

    // ── Соберём все инстансы (либо legacy fallback) ────────────────
    const greenInstances = await prismaRetry(() =>
      prisma.greenInstance.findMany({
        where: { user_id: user.id },
        orderBy: [{ is_primary: "desc" }, { created_at: "asc" }],
      }),
    );

    const instanceList: InstanceLite[] = greenInstances.map((row) => ({
      id: Number(row.id),
      status: row.status,
      created_at: row.created_at,
      is_primary: row.is_primary,
    }));

    // Если нет ни одного GreenInstance — берём legacy Profile.green_api_*.
    if (instanceList.length === 0) {
      const profile = await prismaRetry(() =>
        prisma.profile.findUnique({ where: { user_id: user.id } }),
      );
      if (profile?.green_api_id) {
        instanceList.push({
          id: 0, // sentinel для legacy
          status: "unknown",
          created_at: profile.created_at,
          is_primary: true,
        });
      }
    }

    if (instanceList.length === 0) {
      return jsonResponse({ primary: null, instances: [] });
    }

    // ── Per-user агрегации (общие для всех инстансов пользователя) ──
    // У нас нет связи Recipient → instance (рассылки шли на legacy
    // Profile-credentials), поэтому incoming/outgoing считаем on user_id.
    const [
      totalIncoming,
      incomingLast7d,
      outgoingLast7d,
      checksLast24h,
      broadcastsLast24h,
      incidentsLast24h,
      lastBadIncidentRow,
    ] = await prismaRetry(() =>
      Promise.all([
        prisma.incoming.count({
          where: { user_id: user.id },
        }),
        prisma.incoming.count({
          where: { user_id: user.id, received_at: { gte: since7d } },
        }),
        prisma.recipient.count({
          where: {
            broadcast: { user_id: user.id },
            sent_at: { gte: since7d },
          },
        }),
        prisma.operationRun.count({
          where: {
            user_id: user.id,
            kind: "check",
            started_at: { gte: since24h },
          },
        }),
        prisma.operationRun.count({
          where: {
            user_id: user.id,
            kind: "broadcast",
            started_at: { gte: since24h },
          },
        }),
        prisma.incidentLog.count({
          where: {
            user_id: user.id,
            kind: { in: [...BAD_INCIDENT_KINDS] },
            created_at: { gte: since24h },
          },
        }),
        prisma.incidentLog.findFirst({
          where: {
            user_id: user.id,
            kind: { in: [...BAD_INCIDENT_KINDS] },
          },
          orderBy: { created_at: "desc" },
          select: { created_at: true },
        }),
      ]),
    );

    const lastBadIncidentAt = lastBadIncidentRow?.created_at ?? null;

    // ── Per-instance health ────────────────────────────────────────
    // Все инстансы пользователя делят одного MAX-аккаунта с историей
    // Incoming/Outgoing (на этой стадии у нас нет per-instance трекинга
    // delivery). Поэтому базовые агрегации общие, разница только в
    // current_status и created_at.
    const instances: AccountHealthData[] = instanceList.map((row) =>
      computeAccountHealth({
        instanceId: row.id,
        currentStatus: row.status,
        createdAt: row.created_at,
        totalIncoming,
        incomingLast7d,
        outgoingLast7d,
        checksLast24h,
        broadcastsLast24h,
        incidentsLast24h,
        lastBadIncidentAt,
        now,
      }),
    );

    const primary =
      instances.find((it) =>
        instanceList.find((row) => row.id === it.instance_id && row.is_primary),
      ) ??
      instances[0] ??
      null;

    return jsonResponse({ primary, instances });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("instances/health GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
