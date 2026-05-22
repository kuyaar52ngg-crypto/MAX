/**
 * `/api/scheduled-broadcasts` — CRUD над `ScheduledBroadcast`.
 *
 * GET  → список задач текущего пользователя (sorted by next_run_at).
 * POST → создание новой задачи: валидируем payload, копируем
 *        GREEN-API credentials из `Profile`, считаем `next_run_at`
 *        и записываем в Postgres. Flask-планировщик подхватывает
 *        задачу при следующем tick (раз в 15 сек).
 *
 * Validation gate (broadcast-scheduling-suite Task 9.12):
 *   POST дополнительно валидирует `schedule_type ∈ {window, smart_time,
 *   burst}` через `@/lib/scheduling/createValidation` и применяет
 *   approval gate из `Profile.approval_required_above_n` (Req 7.3 / 7.5
 *   / 7.6). Legacy режимы (`once` / `drip` / `recurring`) продолжают
 *   обслуживаться существующим `validateScheduleInput`.
 */

import { NextRequest } from "next/server";

import { Prisma } from "@prisma/client";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  computeNextRunAt,
  validateScheduleInput,
} from "@/lib/scheduled/computeNextRun";
import type {
  CreateScheduledBroadcastInput,
} from "@/lib/scheduled/types";
import {
  isApprovalRequired,
  isSuiteScheduleType,
  validateBurst,
  validateSmartTime,
  validateWindowBounds,
  validateWindowStartInFuture,
  validateWindowSufficientTime,
  type ApiError,
  type NewModeCreateInput,
} from "@/lib/scheduling/createValidation";
import { resolveApprover } from "@/lib/scheduling/resolveApprover";
import { buildPreferenceSnapshot } from "@/lib/scheduling/notificationSnapshot";
import { DEFAULT_ANTI_BAN_CONFIG } from "@/lib/anti-ban";
import type { CalendarException } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

/**
 * Suite-mode payload extends `CreateScheduledBroadcastInput` with the
 * fields documented in `frontend/src/lib/scheduling/types.ts`. Legacy
 * code never sets these, so falling back to `Partial<...>` keeps the
 * older contract untouched.
 *
 * `schedule_type` is widened to `string` because JSON-parsed payloads
 * can carry the new suite values (`window` / `smart_time` / `burst`)
 * that the legacy `ScheduleType` union does not list. The dispatch
 * logic in `validateSuiteCreate` is responsible for rejecting unknown
 * values via `isSuiteScheduleType` + the legacy validator's own check.
 */
type CreateInput = Omit<CreateScheduledBroadcastInput, "schedule_type"> & {
  schedule_type: string;
} & Partial<{
    send_window_start: string | null;
    send_window_end: string | null;
    smart_time_window_days: number | null;
    smart_time_top_n: number | null;
    follow_up_chain_id: number | null;
    ab_test_id: number | null;
    ab_time_test_id: number | null;
    instance_id: number | null;
    adaptive_throttle: boolean;
    auto_snooze_enabled: boolean;
    auto_snooze_threshold: number;
    auto_snooze_minutes: number;
    auto_snooze_window_minutes: number;
    approval_user_id: string | null;
    parent_broadcast_id: number | null;
  }>;

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
      prisma.scheduledBroadcast.findMany({
        where: { user_id: user.id },
        orderBy: [{ status: "asc" }, { next_run_at: "asc" }, { id: "desc" }],
        take: 200,
      }),
    );

    // Не возвращаем токен на клиент.
    const safe = rows.map((r) => ({
      ...r,
      bot_api_token: r.bot_api_token ? "***" : null,
    }));
    return jsonResponse(safe);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts GET:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

/**
 * Build the `NewModeCreateInput` view that pure validators accept,
 * threading suite fields out of the wider request body. Returning a
 * fresh object (rather than passing `body` through) makes property
 * tests trivial: the validators take exactly what they need.
 */
function toNewModeInput(body: CreateInput): NewModeCreateInput {
  return {
    schedule_type: body.schedule_type,
    contacts: body.contacts ?? [],
    send_window_start: body.send_window_start ?? null,
    send_window_end: body.send_window_end ?? null,
    smart_time_window_days: body.smart_time_window_days ?? null,
    smart_time_top_n: body.smart_time_top_n ?? null,
    quiet_hours_enabled: body.quiet_hours_enabled,
    quiet_hours_start: body.quiet_hours_start,
    quiet_hours_end: body.quiet_hours_end,
    follow_up_chain_id: body.follow_up_chain_id ?? null,
    ab_test_id: body.ab_test_id ?? null,
    ab_time_test_id: body.ab_time_test_id ?? null,
    user_tz: body.user_tz ?? null,
  };
}

/** Map an `ApiError` to the wire format used everywhere in this file. */
function errorBody(error: ApiError) {
  return {
    error: error.message,
    error_code: error.error_code,
  };
}

/**
 * Run the suite-specific validation pipeline for `schedule_type ∈
 * {window, smart_time, burst}`. Returns the first error encountered,
 * or `null` when everything passes.
 *
 * Order matters:
 *   - For `window`, `WINDOW_INSUFFICIENT_TIME` (Req 1.9) takes priority
 *     over the bounds checks (Req 1.2 / 1.3 / 1.4) — but ONLY when the
 *     input actually contains a parsable window range; otherwise we
 *     surface `WINDOW_FIELDS_MISSING` first to give the operator a
 *     meaningful message.
 *   - `smart_time` uses a single rule.
 *   - `burst` runs limit (422) → quiet hours (400) → extension (400).
 */
async function validateSuiteCreate(
  body: CreateInput,
  userId: string,
  burstLimit: number,
): Promise<ApiError | null> {
  const input = toNewModeInput(body);

  if (input.schedule_type === "window") {
    // 1. Structural bounds first — without parsable, ordered start/end
    //    we can't compute usable seconds (so 1.9 has nothing to say).
    const bounds = validateWindowBounds(input);
    if (bounds) return bounds;

    // 2. WINDOW_INSUFFICIENT_TIME (Req 1.9) — takes precedence over
    //    Req 1.4 (`WINDOW_IN_PAST`) per the spec, so we run it BEFORE
    //    the future-check below.
    const [antiBan, exceptions] = await Promise.all([
      prismaRetry(() =>
        prisma.antiBanConfig.findUnique({ where: { user_id: userId } }),
      ),
      prismaRetry(() =>
        prisma.calendarException.findMany({
          where: { user_id: userId },
          orderBy: [{ start_date: "asc" }, { id: "desc" }],
        }),
      ),
    ]);
    const delayMin = antiBan?.delay_min ?? DEFAULT_ANTI_BAN_CONFIG.delay_min;
    const exceptionsView: CalendarException[] = (exceptions ?? []).map((row) => ({
      id: Number(row.id),
      user_id: row.user_id,
      name: row.name,
      start_date: row.start_date.toISOString().slice(0, 10),
      end_date: row.end_date.toISOString().slice(0, 10),
      recurring_type:
        (row.recurring_type as CalendarException["recurring_type"]) ?? null,
      recurring_value: row.recurring_value ?? null,
      created_at: row.created_at.toISOString(),
    }));
    const insufficient = validateWindowSufficientTime(
      input,
      { delay_min: delayMin },
      exceptionsView,
    );
    if (insufficient) return insufficient;

    // 3. Future-check last (Req 1.4).
    const inPast = validateWindowStartInFuture(input);
    if (inPast) return inPast;

    return null;
  }

  if (input.schedule_type === "smart_time") {
    return validateSmartTime(input);
  }

  if (input.schedule_type === "burst") {
    return validateBurst(input, { burst_recipient_limit: burstLimit });
  }

  return null;
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

    const body = (await req.json()) as CreateInput;

    // Common-payload sanity (message/contacts) — applies to every mode.
    if (!body.message?.trim() && !body.file_url) {
      return jsonResponse(
        {
          error: "Текст сообщения или файл обязательны",
          error_code: "MESSAGE_REQUIRED",
        },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.contacts) || body.contacts.length === 0) {
      return jsonResponse(
        { error: "Список получателей пуст", error_code: "CONTACTS_EMPTY" },
        { status: 400 },
      );
    }

    // Profile lookup is needed for both GREEN-API credentials and the
    // approval / burst limits. Fetch it once.
    const profile = await prismaRetry(() =>
      prisma.profile.findUnique({ where: { user_id: user.id } }),
    );
    if (!profile?.green_api_id || !profile?.green_api_token) {
      return jsonResponse(
        { error: "GREEN-API credentials are not configured" },
        { status: 400 },
      );
    }

    const burstLimit = profile.burst_recipient_limit ?? 100;
    const approvalThreshold = profile.approval_required_above_n ?? 0;

    // ── Mode dispatch ──────────────────────────────────────────────
    if (isSuiteScheduleType(body.schedule_type)) {
      const suiteError = await validateSuiteCreate(body, user.id, burstLimit);
      if (suiteError) {
        return jsonResponse(errorBody(suiteError), { status: suiteError.status });
      }
    } else {
      // Legacy validator — owns once / drip / recurring (and, for
      // backward compatibility, any other unknown value will be
      // rejected here). The cast is safe because the validator's first
      // check rejects any `schedule_type` not in the legacy union.
      const errors = validateScheduleInput(
        body as unknown as CreateScheduledBroadcastInput,
      );
      if (errors.length > 0) {
        return jsonResponse({ error: "validation_failed", errors }, { status: 400 });
      }
    }

    // ── Approval gate (Req 7.3 / 7.5 / 7.6) ────────────────────────
    const approvalRequired = isApprovalRequired(
      body.contacts.length,
      approvalThreshold,
    );
    let approverUserId: string | null = null;
    if (approvalRequired) {
      const resolved = await resolveApprover(body.approval_user_id ?? null);
      if (resolved.kind !== "uuid") {
        return jsonResponse(
          {
            error:
              "approval_user_id is required and must resolve to an existing user",
            error_code: "APPROVAL_USER_NOT_FOUND",
          },
          { status: 422 },
        );
      }
      approverUserId = resolved.userId;
    }

    // ── Compute next_run_at ─────────────────────────────────────────
    // For legacy modes we use the existing helper; for suite modes the
    // first kick happens through `Schedule_Mode_Engine.dispatch_due()`,
    // which keys off `next_run_at` too.
    let nextRun: Date | null;
    if (isSuiteScheduleType(body.schedule_type)) {
      // Suite modes anchor on `scheduled_for` if present, else on the
      // window start, else on `now()`. The Python engine recomputes
      // per-recipient send times anyway — `next_run_at` here is just
      // the dispatch trigger.
      if (body.scheduled_for) {
        nextRun = new Date(body.scheduled_for);
      } else if (body.send_window_start) {
        nextRun = new Date(body.send_window_start);
      } else {
        nextRun = new Date();
      }
      if (!Number.isFinite(nextRun.getTime())) nextRun = new Date();
    } else {
      nextRun = computeNextRunAt({
        // We've already established this is NOT a suite type, so it's
        // safe to narrow back to the legacy `ScheduleType` union for
        // the helper's signature.
        schedule_type: body.schedule_type as
          | "once"
          | "drip"
          | "recurring",
        scheduled_for: body.scheduled_for,
        recurring_kind: body.recurring_kind,
        recurring_hour: body.recurring_hour,
        recurring_minute: body.recurring_minute,
        recurring_day_of_week: body.recurring_day_of_week,
        recurring_day_of_month: body.recurring_day_of_month,
        recurring_until: body.recurring_until,
        user_tz: body.user_tz,
      });
    }

    const initialStatus = approvalRequired ? "pending_approval" : "scheduled";

    // ── Build the canonical Prisma payload ──────────────────────────
    const data: Prisma.ScheduledBroadcastUncheckedCreateInput = {
      user_id: user.id,
      name: body.name?.trim() || null,
      message: body.message,
      contacts: (body.contacts ?? []) as object,
      personalized_messages: body.personalized_messages
        ? (body.personalized_messages as object)
        : Prisma.JsonNull,
      use_typing: Boolean(body.use_typing),
      delay_seconds:
        typeof body.delay_seconds === "number" ? body.delay_seconds : 3.0,
      file_url: body.file_url ?? null,
      file_name: body.file_name ?? null,

      schedule_type: body.schedule_type,
      scheduled_for: body.scheduled_for ? new Date(body.scheduled_for) : null,

      drip_batch_size: body.drip_batch_size ?? null,
      drip_interval_minutes: body.drip_interval_minutes ?? null,

      recurring_kind: body.recurring_kind ?? null,
      recurring_hour: body.recurring_hour ?? null,
      recurring_minute: body.recurring_minute ?? null,
      recurring_day_of_week: body.recurring_day_of_week ?? null,
      recurring_day_of_month: body.recurring_day_of_month ?? null,
      recurring_until: body.recurring_until ? new Date(body.recurring_until) : null,

      quiet_hours_enabled: Boolean(body.quiet_hours_enabled),
      quiet_hours_start:
        typeof body.quiet_hours_start === "number" ? body.quiet_hours_start : 22,
      quiet_hours_end:
        typeof body.quiet_hours_end === "number" ? body.quiet_hours_end : 8,
      respect_recipient_tz: Boolean(body.respect_recipient_tz),
      user_tz: body.user_tz || "UTC",

      // Suite-specific fields (NULL when not in the relevant mode).
      send_window_start: body.send_window_start ? new Date(body.send_window_start) : null,
      send_window_end: body.send_window_end ? new Date(body.send_window_end) : null,
      smart_time_window_days: body.smart_time_window_days ?? null,
      smart_time_top_n: body.smart_time_top_n ?? null,
      ab_time_test_id:
        typeof body.ab_time_test_id === "number" ? BigInt(body.ab_time_test_id) : null,

      auto_snooze_enabled: Boolean(body.auto_snooze_enabled),
      auto_snooze_threshold:
        typeof body.auto_snooze_threshold === "number"
          ? body.auto_snooze_threshold
          : 3,
      auto_snooze_minutes:
        typeof body.auto_snooze_minutes === "number"
          ? body.auto_snooze_minutes
          : 30,
      auto_snooze_window_minutes:
        typeof body.auto_snooze_window_minutes === "number"
          ? body.auto_snooze_window_minutes
          : 15,

      // Approval bookkeeping (Req 7.3 / 7.6)
      approval_required: approvalRequired,
      approval_status: approvalRequired ? "pending" : "none",
      approval_user_id: approverUserId,

      // Lineage / extensions
      parent_broadcast_id:
        typeof body.parent_broadcast_id === "number"
          ? BigInt(body.parent_broadcast_id)
          : null,
      follow_up_chain_id:
        typeof body.follow_up_chain_id === "number"
          ? BigInt(body.follow_up_chain_id)
          : null,
      ab_test_id:
        typeof body.ab_test_id === "number" ? BigInt(body.ab_test_id) : null,
      instance_id:
        typeof body.instance_id === "number" ? BigInt(body.instance_id) : null,
      adaptive_throttle: Boolean(body.adaptive_throttle),

      status: initialStatus,
      next_run_at: nextRun,

      bot_id_instance: profile.green_api_id,
      bot_api_token: profile.green_api_token,
      bot_api_url: profile.green_api_url || "https://api.green-api.com",
    };

    // ── Persist + (optionally) emit the awaiting-approval Notification ─
    let created;
    if (approvalRequired && approverUserId) {
      // Snapshot the approver's preferences so the dispatcher honours
      // the channel set as it was at request time (Req 10.4).
      const snapshot = await buildPreferenceSnapshot(approverUserId);
      const tx = await prismaRetry(() =>
        prisma.$transaction(async (tx) => {
          const row = await tx.scheduledBroadcast.create({ data });
          await tx.notification.create({
            data: {
              user_id: approverUserId,
              kind: "awaiting_approval",
              payload: {
                broadcast_id: Number(row.id),
                requested_by: user.id,
                recipient_count: body.contacts.length,
                scheduled_for: row.scheduled_for?.toISOString() ?? null,
              } as Prisma.InputJsonValue,
              preference_snapshot:
                snapshot as unknown as Prisma.InputJsonValue,
            },
          });
          return row;
        }),
      );
      created = tx;
    } else {
      created = await prismaRetry(() =>
        prisma.scheduledBroadcast.create({ data }),
      );
    }

    return jsonResponse({ ...created, bot_api_token: "***" }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
