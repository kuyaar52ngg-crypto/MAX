/**
 * `/api/calendar-exceptions` — CRUD для календарных исключений.
 *
 * GET  → список исключений текущего пользователя.
 * POST → создание нового исключения (одна дата, диапазон или recurring).
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_RECURRING_TYPES = ["weekly", "monthly", "yearly"] as const;

function isValidISODate(str: string): boolean {
  const d = new Date(str);
  return !isNaN(d.getTime());
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await prismaRetry(() =>
      prisma.calendarException.findMany({
        where: { user_id: user.id },
        orderBy: [{ start_date: "asc" }, { id: "desc" }],
      }),
    );

    return jsonResponse(rows);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("calendar-exceptions GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
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

    const body = await req.json();

    // Validate name
    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return jsonResponse(
        { error: "Укажите название исключения" },
        { status: 400 },
      );
    }

    // Validate start_date
    if (!body.start_date || typeof body.start_date !== "string" || !isValidISODate(body.start_date)) {
      return jsonResponse(
        { error: "Укажите корректную дату начала" },
        { status: 400 },
      );
    }

    // Validate end_date
    if (!body.end_date || typeof body.end_date !== "string" || !isValidISODate(body.end_date)) {
      return jsonResponse(
        { error: "Укажите корректную дату окончания" },
        { status: 400 },
      );
    }

    // Validate end_date >= start_date
    const startDate = new Date(body.start_date);
    const endDate = new Date(body.end_date);
    if (endDate < startDate) {
      return jsonResponse(
        { error: "Дата окончания не может быть раньше даты начала" },
        { status: 400 },
      );
    }

    // Validate recurring_type
    if (body.recurring_type !== undefined && body.recurring_type !== null) {
      if (!VALID_RECURRING_TYPES.includes(body.recurring_type)) {
        return jsonResponse(
          { error: "Некорректный тип повторения. Допустимые: weekly, monthly, yearly" },
          { status: 400 },
        );
      }

      // Validate recurring_value based on recurring_type
      if (body.recurring_value !== undefined && body.recurring_value !== null) {
        const val = body.recurring_value;
        if (typeof val !== "number" || !Number.isInteger(val)) {
          return jsonResponse(
            { error: "recurring_value должно быть целым числом" },
            { status: 400 },
          );
        }
        if (body.recurring_type === "weekly" && (val < 0 || val > 6)) {
          return jsonResponse(
            { error: "Для weekly recurring_value должно быть от 0 до 6 (день недели)" },
            { status: 400 },
          );
        }
        if (body.recurring_type === "monthly" && (val < 1 || val > 31)) {
          return jsonResponse(
            { error: "Для monthly recurring_value должно быть от 1 до 31 (день месяца)" },
            { status: 400 },
          );
        }
      }
    }

    const created = await prismaRetry(() =>
      prisma.calendarException.create({
        data: {
          user_id: user.id,
          name: body.name.trim(),
          start_date: startDate,
          end_date: endDate,
          recurring_type: body.recurring_type ?? null,
          recurring_value: body.recurring_value ?? null,
        },
      }),
    );

    return jsonResponse(created, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("calendar-exceptions POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
