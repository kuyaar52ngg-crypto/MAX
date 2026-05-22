/**
 * `GET /api/ab-time-tests/[id]` — детали теста + агрегированные метрики
 * по слотам.
 *
 * Response:
 *   {
 *     id, slots, winner_slot, status,
 *     metrics: [{ hour, delivery_pct, read_pct, reply_pct }, ...]
 *   }
 *
 * Метрики считаются из `ABTimeTestRecipient`: для каждого slot_hour из
 * `slots` агрегируем число записей и долю с delivered/read/replied. Слоты
 * без получателей возвращаются с нулевыми процентами.
 *
 * _Requirements: 3.1, 3.5, 3.7_
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface SlotMetric {
  hour: number;
  total: number;
  delivery_pct: number;
  read_pct: number;
  reply_pct: number;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    let testId: bigint;
    try {
      testId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Invalid id" }, { status: 400 });
    }

    const test = await prismaRetry(() =>
      prisma.aBTimeTest.findUnique({ where: { id: testId } }),
    );
    if (!test || test.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    const recipients = await prismaRetry(() =>
      prisma.aBTimeTestRecipient.findMany({
        where: { ab_time_test_id: testId },
        select: { slot_hour: true, delivered: true, read: true, replied: true },
      }),
    );

    const buckets = new Map<number, { total: number; delivered: number; read: number; replied: number }>();
    const slots = (test.slots as unknown as number[]) ?? [];
    for (const slot of slots) {
      buckets.set(slot, { total: 0, delivered: 0, read: 0, replied: 0 });
    }
    for (const r of recipients) {
      const bucket =
        buckets.get(r.slot_hour) ??
        (() => {
          const fresh = { total: 0, delivered: 0, read: 0, replied: 0 };
          buckets.set(r.slot_hour, fresh);
          return fresh;
        })();
      bucket.total += 1;
      if (r.delivered) bucket.delivered += 1;
      if (r.read) bucket.read += 1;
      if (r.replied) bucket.replied += 1;
    }

    const metrics: SlotMetric[] = Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, b]) => ({
        hour,
        total: b.total,
        delivery_pct: pct(b.delivered, b.total),
        read_pct: pct(b.read, b.total),
        reply_pct: pct(b.replied, b.total),
      }));

    return jsonResponse({
      id: test.id,
      scheduled_broadcast_id: test.scheduled_broadcast_id,
      slots,
      winner_slot: test.winner_slot,
      wait_hours: test.wait_hours,
      status: test.status,
      started_at: test.started_at,
      completed_at: test.completed_at,
      metrics,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ab-time-tests GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
