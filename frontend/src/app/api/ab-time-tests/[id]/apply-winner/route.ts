/**
 * `POST /api/ab-time-tests/[id]/apply-winner` — применить победителя
 * A/B Time Test, создав новый `ScheduleTemplate` с `recurring_hour=winner_slot`.
 *
 * Доступно только при `status=completed AND winner_slot != null`.
 * В любом другом состоянии — 409 `ABTIME_WINNER_NOT_READY`.
 *
 * _Requirements: 3.7_
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
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

    let body: { name?: string } = {};
    try {
      body = (await req.json()) as { name?: string };
    } catch {
      // body опциональный
    }

    const test = await prismaRetry(() =>
      prisma.aBTimeTest.findUnique({ where: { id: testId } }),
    );
    if (!test || test.user_id !== user.id) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    if (test.status !== "completed" || test.winner_slot === null) {
      return jsonResponse(
        {
          error:
            "A/B Time Test winner is not ready. Required: status=completed AND winner_slot != null",
          error_code: "ABTIME_WINNER_NOT_READY",
        },
        { status: 409 },
      );
    }

    const winnerSlot = test.winner_slot;
    const templateName =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : `A/B Time winner @ ${String(winnerSlot).padStart(2, "0")}:00`;

    const template = await prismaRetry(() =>
      prisma.scheduleTemplate.create({
        data: {
          user_id: user.id,
          name: templateName,
          config: {
            schedule_type: "recurring",
            recurring_kind: "daily",
            recurring_hour: winnerSlot,
            recurring_minute: 0,
            ab_time_test_id: Number(testId),
            source: "ab_time_winner",
          },
        },
      }),
    );

    return jsonResponse(
      {
        ok: true,
        winner_slot: winnerSlot,
        schedule_template_id: template.id,
        schedule_template: template,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ab-time-tests apply-winner POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
