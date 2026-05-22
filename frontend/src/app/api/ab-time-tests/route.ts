/**
 * `POST /api/ab-time-tests` — создаёт A/B Time Test (тест времени отправки).
 *
 * Body: `{ scheduled_broadcast_id: number, slots: number[], wait_hours?: number }`
 *
 * Требования (broadcast-scheduling-suite, Requirement 3):
 *   - 3.1: модель `ABTimeTest` (slots, winner_slot, wait_hours, status, ...)
 *   - 3.2: `slots` — 2..4 различных целых часа в [0, 23] иначе 400 `ABTIME_SLOTS_INVALID`
 *   - 3.10: если к broadcast уже привязан `ab_test_id` (вариант сообщений) или
 *           `ab_time_test_id` — 409 `ABTEST_KIND_CONFLICT`
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface CreateAbTimeTestBody {
  scheduled_broadcast_id?: number | string;
  slots?: unknown;
  wait_hours?: number;
}

function validateSlots(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 2 || value.length > 4) return null;
  const slots: number[] = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
    if (raw < 0 || raw > 23) return null;
    if (slots.includes(raw)) return null; // distinct
    slots.push(raw);
  }
  return slots;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    let body: CreateAbTimeTestBody;
    try {
      body = (await req.json()) as CreateAbTimeTestBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    if (
      body.scheduled_broadcast_id === undefined ||
      body.scheduled_broadcast_id === null
    ) {
      return jsonResponse(
        { error: "scheduled_broadcast_id is required" },
        { status: 400 },
      );
    }

    let broadcastId: bigint;
    try {
      broadcastId = BigInt(body.scheduled_broadcast_id);
    } catch {
      return jsonResponse(
        { error: "scheduled_broadcast_id must be an integer" },
        { status: 400 },
      );
    }

    const slots = validateSlots(body.slots);
    if (!slots) {
      return jsonResponse(
        {
          error: "slots must be 2..4 distinct integers in [0, 23]",
          error_code: "ABTIME_SLOTS_INVALID",
        },
        { status: 400 },
      );
    }

    let waitHours = 24;
    if (body.wait_hours !== undefined && body.wait_hours !== null) {
      if (
        typeof body.wait_hours !== "number" ||
        !Number.isInteger(body.wait_hours) ||
        body.wait_hours < 1 ||
        body.wait_hours > 168
      ) {
        return jsonResponse(
          { error: "wait_hours must be an integer in [1, 168]" },
          { status: 400 },
        );
      }
      waitHours = body.wait_hours;
    }

    const broadcast = await prismaRetry(() =>
      prisma.scheduledBroadcast.findUnique({ where: { id: broadcastId } }),
    );
    if (!broadcast || broadcast.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    // Req 3.10: нельзя одновременно держать message-variant ABTest и
    // time-variant ABTimeTest на одном broadcast. Также не привязываем второй
    // ABTimeTest, если уже есть.
    if (broadcast.ab_test_id !== null || broadcast.ab_time_test_id !== null) {
      return jsonResponse(
        {
          error:
            "Broadcast already has an A/B test (message-variant or time-variant) attached",
          error_code: "ABTEST_KIND_CONFLICT",
        },
        { status: 409 },
      );
    }

    const created = await prismaRetry(() =>
      prisma.$transaction(async (tx) => {
        const test = await tx.aBTimeTest.create({
          data: {
            user_id: user.id,
            scheduled_broadcast_id: broadcastId,
            slots,
            wait_hours: waitHours,
            status: "running",
          },
        });
        await tx.scheduledBroadcast.update({
          where: { id: broadcastId },
          data: { ab_time_test_id: test.id },
        });
        return test;
      }),
    );

    return jsonResponse(created, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ab-time-tests POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
