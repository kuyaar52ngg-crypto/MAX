/**
 * Server-side validation gate for `POST /api/scheduled-broadcasts`
 * covering the four new `schedule_type` values introduced by the
 * Broadcast Scheduling Suite:
 *
 *   - `window`     (Req 1.2 / 1.3 / 1.4 / 1.9)
 *   - `smart_time` (Req 2.2)
 *   - `burst`      (Req 8.7 / 8.8 / 8.9)
 *
 * Plus the cross-cutting **approval gate** (Req 7.3 / 7.5 / 7.6) which
 * fires for any mode when the operator's `Profile.approval_required_above_n`
 * threshold is exceeded.
 *
 * Each rule is encoded as a small pure function that maps the input
 * payload to an `ApiError` (or `null` when the rule passes). The route
 * handler iterates the relevant rules in priority order and returns the
 * first error it finds.
 *
 * Determinism is important: the same payload + same anti-ban / profile
 * snapshot MUST yield the same error code so property-tests can pin
 * the contract (Task 9.13 / P16).
 */

import type { CalendarException } from "@/lib/scheduling/types";
import type { AntiBanConfig } from "@/lib/anti-ban";
import { computeWindowUsableSeconds } from "@/lib/scheduling/preflightEngine";

/**
 * Common error envelope returned by every rule. Status + `error_code`
 * are stable; the human-readable `message` is for logs and toast UIs.
 */
export interface ApiError {
  status: 400 | 422;
  error_code: string;
  message: string;
}

/**
 * Snapshot of the operator's `Profile` that the validation gate needs.
 * Kept small and explicit so the route handler doesn't have to leak the
 * full Prisma model into pure validation code.
 */
export interface ProfileLimits {
  burst_recipient_limit: number;
  approval_required_above_n: number;
}

/**
 * Subset of `CreateScheduledBroadcastInput` plus the new-mode fields
 * documented in `frontend/src/lib/scheduling/types.ts::ScheduledBroadcastDraft`.
 *
 * The validator deliberately accepts a structural type (rather than the
 * legacy `CreateScheduledBroadcastInput`) so it can be used by both the
 * suite's POST handler and any future JSON ingestion paths without
 * coupling either to the other.
 */
export interface NewModeCreateInput {
  schedule_type: string;
  contacts?: ReadonlyArray<{ phone: string }>;
  // window
  send_window_start?: string | null;
  send_window_end?: string | null;
  // smart_time
  smart_time_window_days?: number | null;
  smart_time_top_n?: number | null;
  // burst incompatibilities
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  follow_up_chain_id?: number | null;
  ab_test_id?: number | null;
  ab_time_test_id?: number | null;
  // misc
  user_tz?: string | null;
}

/**
 * Set of `schedule_type` values that this module owns. The legacy
 * validator (`@/lib/scheduled/computeNextRun::validateScheduleInput`)
 * still owns `once` / `drip` / `recurring` / `exact`.
 *
 * Note: the database column is `String`, not an enum, so the route
 * handler must guard against unknown values up-front; this set is the
 * source of truth for "is this a suite-mode value?".
 */
export const SUITE_SCHEDULE_TYPES: readonly string[] = [
  "window",
  "smart_time",
  "burst",
  // ab_time is delegated to ab-time-tests creation flow, not here.
];

export function isSuiteScheduleType(value: string): boolean {
  return SUITE_SCHEDULE_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

/**
 * Validate `send_window_start` / `send_window_end` for `schedule_type =
 * "window"`. Returns the first error encountered or `null` when the
 * boundary checks pass.
 *
 * This function only checks the **structural** rules (fields present,
 * parsable, ordered). The temporal rule "start must be in the future"
 * (Req 1.4) is split out into `validateWindowStartInFuture` so callers
 * can run `WINDOW_INSUFFICIENT_TIME` (Req 1.9) **between** them — the
 * spec mandates that 1.9 take precedence over 1.4 even though both
 * would also have failed (Req 1.9 final sentence).
 *
 * Boundary rules:
 *   - both fields required        → 400 `WINDOW_FIELDS_MISSING`
 *   - either unparsable           → 400 `WINDOW_INVALID_RANGE`
 *   - end <= start                → 400 `WINDOW_INVALID_RANGE`  (Req 1.3)
 */
export function validateWindowBounds(
  input: Pick<NewModeCreateInput, "send_window_start" | "send_window_end">,
): ApiError | null {
  const startIso = input.send_window_start;
  const endIso = input.send_window_end;
  if (!startIso || !endIso) {
    return {
      status: 400,
      error_code: "WINDOW_FIELDS_MISSING",
      message:
        "send_window_start and send_window_end are required for window mode",
    };
  }
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return {
      status: 400,
      error_code: "WINDOW_INVALID_RANGE",
      message: "send_window_start / send_window_end must be valid ISO strings",
    };
  }
  if (end.getTime() <= start.getTime()) {
    return {
      status: 400,
      error_code: "WINDOW_INVALID_RANGE",
      message: "send_window_end must be strictly after send_window_start",
    };
  }
  return null;
}

/**
 * Verify that `send_window_start` is strictly in the future (Req 1.4).
 *
 * Caller MUST run `validateWindowBounds` first; this helper assumes
 * the inputs are structurally valid (otherwise it returns `null` so
 * the bounds error wins).
 *
 * Returns 400 `WINDOW_IN_PAST` when start <= now.
 */
export function validateWindowStartInFuture(
  input: Pick<NewModeCreateInput, "send_window_start">,
  now: Date = new Date(),
): ApiError | null {
  const startIso = input.send_window_start;
  if (!startIso) return null;
  const start = new Date(startIso);
  if (!Number.isFinite(start.getTime())) return null;
  if (start.getTime() <= now.getTime()) {
    return {
      status: 400,
      error_code: "WINDOW_IN_PAST",
      message: "send_window_start must be in the future",
    };
  }
  return null;
}

/**
 * Mirror of Python `preflight_calc.validate_window` for the
 * `WINDOW_INSUFFICIENT_TIME` rule (Req 1.9). Returns the error when
 * the usable seconds (after subtracting quiet-hour and calendar-
 * exception zones) cannot fit `N * delay_min` seconds — i.e. even a
 * back-to-back at the floor pace would overrun the window.
 *
 * Per Req 1.9 this error has higher priority than 1.2/1.3/1.4 and
 * MUST be returned even when one of those would also fire — callers
 * should evaluate this rule BEFORE `validateWindowBounds`. To keep
 * the function safe to call on malformed input we return `null` when
 * the dates are invalid (the bounds-validator will then surface the
 * appropriate error).
 */
export function validateWindowSufficientTime(
  input: Pick<
    NewModeCreateInput,
    | "send_window_start"
    | "send_window_end"
    | "quiet_hours_enabled"
    | "quiet_hours_start"
    | "quiet_hours_end"
    | "user_tz"
    | "contacts"
  >,
  antiBan: Pick<AntiBanConfig, "delay_min">,
  exceptions: CalendarException[],
): ApiError | null {
  if (!input.send_window_start || !input.send_window_end) {
    return null;
  }
  const start = new Date(input.send_window_start);
  const end = new Date(input.send_window_end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  if (end.getTime() <= start.getTime()) {
    return null;
  }
  const n = (input.contacts ?? []).length;
  if (n <= 0) return null;
  const usableSeconds = computeWindowUsableSeconds(
    start,
    end,
    input.user_tz || "UTC",
    Boolean(input.quiet_hours_enabled),
    input.quiet_hours_start ?? 22,
    input.quiet_hours_end ?? 8,
    exceptions,
  );
  const required = n * Math.max(0, antiBan.delay_min);
  if (usableSeconds < required) {
    return {
      status: 422,
      error_code: "WINDOW_INSUFFICIENT_TIME",
      message:
        `Usable window time (${Math.floor(usableSeconds)}s) is shorter than ` +
        `required ${Math.ceil(required)}s for ${n} recipients at delay_min=` +
        `${antiBan.delay_min}s`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// smart_time
// ---------------------------------------------------------------------------

/**
 * Validate `smart_time_window_days ∈ [1,14]` and `smart_time_top_n ∈
 * [1,6]` (Req 2.2). Both checks fire BEFORE any scheduling work runs.
 *
 * Returns the first error encountered.
 */
export function validateSmartTime(
  input: Pick<
    NewModeCreateInput,
    "smart_time_window_days" | "smart_time_top_n"
  >,
): ApiError | null {
  const wd = input.smart_time_window_days;
  if (typeof wd !== "number" || !Number.isInteger(wd) || wd < 1 || wd > 14) {
    return {
      status: 400,
      error_code: "SMART_TIME_WINDOW_DAYS_INVALID",
      message: "smart_time_window_days must be an integer in [1,14]",
    };
  }
  const tn = input.smart_time_top_n;
  if (typeof tn !== "number" || !Number.isInteger(tn) || tn < 1 || tn > 6) {
    return {
      status: 400,
      error_code: "SMART_TIME_TOP_N_INVALID",
      message: "smart_time_top_n must be an integer in [1,6]",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// burst
// ---------------------------------------------------------------------------

/**
 * Validate Burst-Mode (Req 8.7 / 8.8 / 8.9). Order of checks matches
 * the spec: limit (422) → quiet hours (400) → extension flags (400).
 *
 * Each error code is exclusive — the property-test P16 asserts that
 * exactly one of {BURST_*} fires per malformed payload, so we must
 * NOT bundle multiple checks into a single error object.
 */
export function validateBurst(
  input: Pick<
    NewModeCreateInput,
    | "contacts"
    | "quiet_hours_enabled"
    | "follow_up_chain_id"
    | "ab_test_id"
    | "ab_time_test_id"
  >,
  profile: Pick<ProfileLimits, "burst_recipient_limit">,
): ApiError | null {
  const n = (input.contacts ?? []).length;
  // Req 8.7: 422 BURST_RECIPIENT_LIMIT_EXCEEDED (semantic — caller
  // intent is valid but breaches the operator's safety cap).
  if (n > Math.max(0, profile.burst_recipient_limit)) {
    return {
      status: 422,
      error_code: "BURST_RECIPIENT_LIMIT_EXCEEDED",
      message:
        `Burst mode allows at most ${profile.burst_recipient_limit} ` +
        `recipients (got ${n})`,
    };
  }
  // Req 8.8: quiet hours and burst are mutually exclusive — burst's
  // whole point is to ignore long pauses, which silently breaks
  // quiet-hour intent.
  if (input.quiet_hours_enabled === true) {
    return {
      status: 400,
      error_code: "BURST_INCOMPATIBLE_QUIET_HOURS",
      message: "Burst mode is incompatible with quiet_hours_enabled=true",
    };
  }
  // Req 8.9: burst can't carry follow-up / AB extensions because the
  // worker takes a different fast-path that bypasses these subsystems.
  if (
    input.follow_up_chain_id != null ||
    input.ab_test_id != null ||
    input.ab_time_test_id != null
  ) {
    return {
      status: 400,
      error_code: "BURST_INCOMPATIBLE_EXTENSION",
      message:
        "Burst mode cannot be combined with follow_up_chain_id, ab_test_id, or ab_time_test_id",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// approval gate
// ---------------------------------------------------------------------------

/**
 * Decision returned by `evaluateApprovalGate`. When `required` is
 * false, the broadcast can be created with `status=scheduled` directly.
 * When `required` is true, the route MUST set:
 *   - approval_required = true
 *   - approval_status   = "pending"
 *   - status            = "pending_approval"
 *   - approval_user_id  = (resolved UUID)
 * and emit a `Notification` of kind `awaiting_approval` for the
 * approver.
 *
 * `approverUserId` is `null` when no approval is required.
 */
export interface ApprovalGateDecision {
  required: boolean;
  /** UUID of the resolved approver, or null when not required. */
  approverUserId: string | null;
}

/**
 * Decide whether the approval gate fires for the given recipient count
 * and operator threshold (Req 7.3). The threshold value `0` means
 * **disabled**; any positive value means "approval is required when
 * `len(contacts) > approval_required_above_n`". Strict `>`, not `>=`,
 * matches the spec wording "more than N".
 */
export function isApprovalRequired(
  recipientCount: number,
  threshold: number,
): boolean {
  return threshold > 0 && recipientCount > threshold;
}
