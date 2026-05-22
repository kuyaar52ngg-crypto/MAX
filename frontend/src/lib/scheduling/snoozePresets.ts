/**
 * Snooze presets — pure-function mirror of the server-side snooze logic
 * (`POST /api/scheduled-broadcasts/[id]/snooze`).
 *
 * The same arithmetic runs in three places, and they MUST stay in sync:
 *   1) here, for optimistic UI updates and the SnoozeButton mock-preview
 *      ("apply preset and show the new wall-clock time before submit");
 *   2) the Next.js API route (`Task 9.1`);
 *   3) the Python `Reschedule_Operation` (`Task 6.7`).
 *
 * Spec references:
 *   - Requirement 6.1 — body shape `{ preset, custom_minutes? }`
 *   - Requirement 6.2 — increment `scheduled_for` by the preset offset
 *   - Requirement 6.3 — `next_business_day`: roll to next Mon–Fri in
 *     `user_tz` that is NOT inside any `CalendarException`, preserving
 *     the wall-clock time of day
 *   - Requirement 6.4 — `custom`: `custom_minutes ∈ [1, 43200]`
 *   - Requirement 6.6 — if the new `scheduled_for` falls inside quiet
 *     hours, roll forward to the first instant outside quiet hours
 */

import type { CalendarException } from "./types";
import { __internal, nextBusinessDay } from "./calendarHelpers";

const { zonedParts, zonedToUtc, addCalendarDays } = __internal;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Five fixed snooze presets — exactly mirrors design.md → SnoozeButton. */
export type SnoozePreset = "1h" | "1d" | "7d" | "next_business_day" | "custom";

/** Minimum and maximum allowed custom minutes (Req 6.4). */
export const SNOOZE_CUSTOM_MIN_MINUTES = 1;
export const SNOOZE_CUSTOM_MAX_MINUTES = 43_200; // 30 days

/** Minute offsets for fixed presets (`next_business_day` is computed). */
export const SNOOZE_PRESET_MINUTES: Readonly<Record<"1h" | "1d" | "7d", number>> = {
  "1h": 60,
  "1d": 24 * 60,
  "7d": 7 * 24 * 60,
};

/** Optional quiet-hours config — same fields as `ScheduledBroadcast`. */
export interface QuietHoursConfig {
  enabled: boolean;
  /** 0..23, integer hour-of-day in `tz` when quiet hours start. */
  start: number;
  /** 0..23, integer hour-of-day in `tz` when quiet hours end. */
  end: number;
}

/**
 * Result of `applySnoozePreset`.
 *
 * `kind === "ok"` — the new `scheduledFor` is ready to be persisted.
 * `kind === "invalid_custom"` — `custom_minutes` failed validation
 *   (Req 6.4 — server returns `SNOOZE_CUSTOM_INVALID`).
 * `kind === "no_business_day"` — the lookahead window for
 *   `next_business_day` was exhausted (extremely unusual, e.g. a year
 *   of recurring blackouts) — UI should surface a user-facing error.
 */
export type SnoozePresetOutcome =
  | {
      kind: "ok";
      /** New `scheduled_for` as a UTC `Date`. */
      scheduledFor: Date;
      /** Whether the result was rolled forward past quiet hours. */
      adjustedForQuietHours: boolean;
    }
  | { kind: "invalid_custom" }
  | { kind: "no_business_day" };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` iff `n` is a finite integer inside the inclusive
 * `[SNOOZE_CUSTOM_MIN_MINUTES, SNOOZE_CUSTOM_MAX_MINUTES]` range.
 *
 * Exposed so the SnoozeButton custom-input modal can mirror exactly the
 * server-side check before calling `applySnoozePreset`.
 */
export function isValidCustomMinutes(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= SNOOZE_CUSTOM_MIN_MINUTES &&
    n <= SNOOZE_CUSTOM_MAX_MINUTES
  );
}

// ---------------------------------------------------------------------------
// Quiet-hours roll-forward (Req 6.6)
// ---------------------------------------------------------------------------

/**
 * If `instant` falls inside `[qh.start, qh.end)` in `tz`, return the
 * first UTC instant >= `instant` that is OUTSIDE quiet hours; otherwise
 * return `instant` unchanged.
 *
 * Quiet-hours semantics (mirror of `WindowEngine._compute_usable_intervals`):
 *   - `start === end`         — empty zone, never matches.
 *   - `start <  end`          — same-day zone `[start:00, end:00)`.
 *   - `start >  end`          — wraps midnight: `[start:00, 24:00) ∪
 *                                                 [00:00, end:00)`.
 *
 * On exit the returned datetime is at exactly `qh.end:00:00` in `tz`,
 * snapped to the day-of-quiet-hours-end (handling the wrap case).
 */
function rollPastQuietHours(
  instant: Date,
  qh: QuietHoursConfig,
  tz: string,
): { rolled: Date; adjusted: boolean } {
  if (!qh.enabled) return { rolled: instant, adjusted: false };
  if (qh.start === qh.end) return { rolled: instant, adjusted: false };
  if (
    !Number.isInteger(qh.start) ||
    !Number.isInteger(qh.end) ||
    qh.start < 0 ||
    qh.start > 23 ||
    qh.end < 0 ||
    qh.end > 23
  ) {
    // Defensive — if quiet hours are misconfigured we don't touch the
    // instant; the server will refuse persistence with its own error.
    return { rolled: instant, adjusted: false };
  }

  const p = zonedParts(instant, tz);
  const hour = p.hour;
  const minutesPart = p.minute;
  const secondsPart = p.second;
  const isMidnightExact =
    minutesPart === 0 && secondsPart === 0;

  let inQh: boolean;
  let rollToNextDay: boolean;
  if (qh.start < qh.end) {
    // Same-day zone [start, end). Edge: hour === end is OUT.
    inQh = hour > qh.start ? hour < qh.end : hour === qh.start;
    if (!inQh && hour === qh.start && !isMidnightExact) {
      // Within the start hour but past minute 0 → still in QH.
      inQh = true;
    }
    rollToNextDay = false;
  } else {
    // Wrap-midnight zone [start, 24) ∪ [0, end).
    inQh = hour >= qh.start || hour < qh.end;
    rollToNextDay = inQh && hour >= qh.start;
  }
  if (!inQh) return { rolled: instant, adjusted: false };

  const target = rollToNextDay
    ? addCalendarDays({ year: p.year, month: p.month, day: p.day }, 1, tz)
    : { year: p.year, month: p.month, day: p.day };

  const rolled = zonedToUtc(
    target.year,
    target.month,
    target.day,
    qh.end,
    0,
    0,
    tz,
  );
  return { rolled, adjusted: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a snooze preset to `scheduledFor` and return the new UTC
 * `Date`, with all the post-processing the server applies on success
 * (next-business-day rolling and quiet-hours roll-forward).
 *
 * This is a PURE function — no side effects, no network. The intended
 * call-sites are:
 *   - `SnoozeButton` (Task 13.4): preview the new wall-clock time
 *     inside the dropdown before the user confirms.
 *   - `useScheduleCalendar` (Task 12.2): optimistic update before the
 *     server response lands.
 *
 * @param scheduledFor   The current `scheduled_for` of the broadcast.
 *                       May be a UTC ISO string or a `Date`.
 * @param preset         One of the five fixed presets.
 * @param customMinutes  Required iff `preset === "custom"`. Validated
 *                       per Req 6.4.
 * @param tz             User timezone (`ScheduledBroadcast.user_tz`).
 *                       Defaults to `"UTC"` for safety.
 * @param exceptions     User's `CalendarException` records — consulted
 *                       only by `next_business_day` (Req 6.3).
 * @param quietHours     Optional. When provided AND `enabled`, the
 *                       result is rolled forward past quiet hours
 *                       (Req 6.6).
 */
export function applySnoozePreset(
  scheduledFor: Date | string,
  preset: SnoozePreset,
  customMinutes: number | null | undefined,
  tz: string,
  exceptions: CalendarException[],
  quietHours?: QuietHoursConfig,
): SnoozePresetOutcome {
  const base =
    scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (!Number.isFinite(base.getTime())) {
    // Invalid input → treat as a custom-validation failure (the most
    // user-actionable surface) rather than throwing — this keeps
    // `applySnoozePreset` total over the API boundary.
    return { kind: "invalid_custom" };
  }
  const userTz = tz || "UTC";

  // Compute the new instant for fixed-offset presets and for `custom`.
  let next: Date | null = null;

  if (preset === "1h" || preset === "1d" || preset === "7d") {
    next = new Date(base.getTime() + SNOOZE_PRESET_MINUTES[preset] * 60_000);
  } else if (preset === "custom") {
    if (!isValidCustomMinutes(customMinutes)) {
      return { kind: "invalid_custom" };
    }
    next = new Date(base.getTime() + customMinutes * 60_000);
  } else if (preset === "next_business_day") {
    next = nextBusinessDay(base, userTz, exceptions);
    if (next === null) {
      return { kind: "no_business_day" };
    }
  } else {
    // Unknown preset — defensive, keeps the function total.
    return { kind: "invalid_custom" };
  }

  // Apply quiet-hours roll-forward (Req 6.6). For `next_business_day`
  // the roll is taken on the same business day; if QH push the instant
  // past midnight the wrap branch handles it but the resulting day may
  // no longer be a business day. In that rare case we re-run
  // `nextBusinessDay` to honour Req 6.3 over Req 6.6 (business-day
  // constraint is stronger; QH is the secondary tie-breaker).
  let adjusted = false;
  if (quietHours && quietHours.enabled) {
    const rolled = rollPastQuietHours(next, quietHours, userTz);
    next = rolled.rolled;
    adjusted = rolled.adjusted;

    if (preset === "next_business_day" && adjusted) {
      const stillBusiness = isBusinessDay(next, userTz, exceptions);
      if (!stillBusiness) {
        const reRolled = nextBusinessDay(next, userTz, exceptions);
        if (reRolled === null) {
          return { kind: "no_business_day" };
        }
        // Preserve the time-of-day from the QH-rolled instant.
        const p = zonedParts(next, userTz);
        const re = zonedParts(reRolled, userTz);
        next = zonedToUtc(
          re.year,
          re.month,
          re.day,
          p.hour,
          p.minute,
          p.second,
          userTz,
        );
      }
    }
  }

  return { kind: "ok", scheduledFor: next, adjustedForQuietHours: adjusted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBusinessDay(
  instant: Date,
  tz: string,
  exceptions: CalendarException[],
): boolean {
  const p = zonedParts(instant, tz);
  const parts = { year: p.year, month: p.month, day: p.day };
  if (!__internal.isBusinessWeekday(parts)) return false;
  if (Array.isArray(exceptions)) {
    for (const ex of exceptions) {
      if (__internal.dayMatchesException(parts, ex)) return false;
    }
  }
  return true;
}
