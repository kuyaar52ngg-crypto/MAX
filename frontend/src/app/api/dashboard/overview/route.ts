/**
 * `GET /api/dashboard/overview` — агрегированные данные для главной
 * страницы дашборда. Один запрос вместо 5+ — ускоряет first paint.
 *
 * Возвращает:
 *   - active_runs: текущие OperationRun со status='running'/'paused'
 *   - upcoming_scheduled: ближайшие 3 ScheduledBroadcast (status=scheduled)
 *   - recent_incidents: последние 5 IncidentLog за 24ч
 *   - stats_24h: счётчики проверок/рассылок/входящих за сутки
 *   - last_broadcasts: последние 3 завершённых broadcast с success rate
 *
 * Health-данные тянутся отдельным запросом /api/instances/health,
 * чтобы клиент мог опрашивать его чаще без re-fetch всего overview.
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export interface DashboardOverview {
  active_runs: {
    id: number;
    kind: string;
    status: string;
    processed: number;
    total: number;
    started_at: string;
  }[];
  upcoming_scheduled: {
    id: number;
    name: string | null;
    schedule_type: string;
    next_run_at: string | null;
    recipient_count: number;
  }[];
  recent_incidents: {
    id: number;
    kind: string;
    created_at: string;
    details: Record<string, unknown>;
  }[];
  stats_24h: {
    checks_processed: number;
    broadcasts_started: number;
    incoming_received: number;
    incidents_count: number;
  };
  last_broadcasts: {
    id: number;
    created_at: string;
    total: number;
    sent: number;
    failed: number;
    not_found: number;
    status: string;
    success_rate: number;
  }[];
  /** Был ли когда-либо у пользователя broadcast — для onboarding gate. */
  has_ever_broadcast: boolean;
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

    const since24h = new Date(Date.now() - DAY_MS);

    const [
      activeRuns,
      upcomingRows,
      incidentRows,
      checkRunsLast24h,
      broadcastsLast24h,
      incomingLast24h,
      incidentsLast24h,
      lastBroadcasts,
      totalBroadcastsCount,
    ] = await prismaRetry(() =>
      Promise.all([
        prisma.operationRun.findMany({
          where: {
            user_id: user.id,
            status: { in: ["running", "paused"] },
          },
          orderBy: { started_at: "desc" },
          take: 5,
        }),
        prisma.scheduledBroadcast.findMany({
          where: {
            user_id: user.id,
            status: "scheduled",
            next_run_at: { not: null },
          },
          orderBy: { next_run_at: "asc" },
          take: 3,
        }),
        prisma.incidentLog.findMany({
          where: {
            user_id: user.id,
            created_at: { gte: since24h },
          },
          orderBy: { created_at: "desc" },
          take: 5,
        }),
        prisma.operationRun.findMany({
          where: {
            user_id: user.id,
            kind: "check",
            started_at: { gte: since24h },
          },
          select: { processed: true },
        }),
        prisma.operationRun.count({
          where: {
            user_id: user.id,
            kind: "broadcast",
            started_at: { gte: since24h },
          },
        }),
        prisma.incoming.count({
          where: {
            user_id: user.id,
            received_at: { gte: since24h },
          },
        }),
        prisma.incidentLog.count({
          where: {
            user_id: user.id,
            created_at: { gte: since24h },
          },
        }),
        prisma.broadcast.findMany({
          where: { user_id: user.id },
          orderBy: { id: "desc" },
          take: 3,
        }),
        prisma.broadcast.count({
          where: { user_id: user.id },
        }),
      ]),
    );

    const checksProcessed = checkRunsLast24h.reduce(
      (sum, r) => sum + (r.processed ?? 0),
      0,
    );

    const upcoming = await Promise.all(
      upcomingRows.map(async (row) => {
        const contactsArr = Array.isArray(row.contacts) ? row.contacts : [];
        return {
          id: Number(row.id),
          name: row.name,
          schedule_type: row.schedule_type,
          next_run_at: row.next_run_at?.toISOString() ?? null,
          recipient_count: contactsArr.length,
        };
      }),
    );

    const response: DashboardOverview = {
      active_runs: activeRuns.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        status: r.status,
        processed: r.processed,
        total: r.total,
        started_at: r.started_at.toISOString(),
      })),
      upcoming_scheduled: upcoming,
      recent_incidents: incidentRows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        created_at: r.created_at.toISOString(),
        details: (r.details ?? {}) as Record<string, unknown>,
      })),
      stats_24h: {
        checks_processed: checksProcessed,
        broadcasts_started: broadcastsLast24h,
        incoming_received: incomingLast24h,
        incidents_count: incidentsLast24h,
      },
      last_broadcasts: lastBroadcasts.map((b) => {
        const total = b.total ?? 0;
        const sent = b.sent ?? 0;
        const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;
        return {
          id: Number(b.id),
          created_at: b.created_at.toISOString(),
          total,
          sent,
          failed: b.failed ?? 0,
          not_found: b.not_found ?? 0,
          status: b.status,
          success_rate: successRate,
        };
      }),
      has_ever_broadcast: totalBroadcastsCount > 0,
    };

    return jsonResponse(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("dashboard/overview GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
