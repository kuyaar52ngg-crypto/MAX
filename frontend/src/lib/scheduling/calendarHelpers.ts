/**
 * Calendar helpers — pure TypeScript utilities for `CalendarException`
 * expansion, day-overlap checks and "next business day" rolling.
 *
 * Сigma-functional модуль — не зависит от React, browser API'ев или
 * сетевого слоя. Используется:
 *   1) `Visual_Schedule_Calendar` (Task 13.1) для подсветки exception-дней
 *      и валидации drag-and-drop (Req 4.6, 4.9);
 *   2) `applySnoozePreset` (Task 11.5, см. `snoozePresets.ts`) для
 *      пресета `next_business_day` (Req 6.3);
 *   3) при необходимости — серверным mirror'ом для повторной валидации.
 *
 * Все функции работают в произвольной IANA-таймзоне через `Intl.DateTimeFormat`.
 *
 * Семантика `CalendarException` соответствует Prisma-модели в
 * `frontend/prisma/schema.prisma`:
 *   - одиночное исключение (`recurring_type === null`) — диапазон
 *     `[start_date, end_date]` включительно по обоим краям;
 *   - `recurring_type = "weekly"`  + `recurring_value` — день недели,
 *     где `1..7` трактуется как ISO (Mon=1..Sun=7) и нормализуется в
 *     0..6 (Mon=0..Sun=6) — defensive support для обоих conventions;
 *   - `recurring_type = "monthly"` + `recurring_value` — день месяца 1..31;
 *   - `recurring_type = "yearly"`  + `recurring_value` — порядковый
 *     день в году 1..366.
 *
 * Для recurring исключений `start_date`/`end_date` ограничивают окно
 * "от какой даты повторения активны" — ровно как делает серверный
 * `WindowEngine._compute_usable_intervals` (см. design.md → Components
 * and Interfaces → Schedule_Mode_Engine).
 */

import type { CalendarException } from "./types";

// ---------------------------------------------------------------------------
// Internal types and date utilities
// ---------------------------------------------------------------------------

/** Naive (timezone-less) calendar parts. */
interface DateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

/** Cached `Intl.DateTimeFormat` per timezone — formatter creation is hot. */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(tz: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  FORMATTER_CACHE.set(tz, fmt);
  return fmt;
}

interface ZonedTimeParts extends DateParts {
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
}

function zonedParts(date: Date, tz: string): ZonedTimeParts {
  if (!Number.isFinite(date.getTime())) {
    return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
  const parts = zonedFormatter(tz).formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // some locales report 24 for midnight
    minute: get("minute"),
    second: get("second"),
  };
}

/** Convert a wall-clock datetime in `tz` to its UTC instant. DST-safe. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const naiveAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const probe = zonedParts(new Date(naiveAsUtcMs), tz);
  const seenAsUtcMs = Date.UTC(
    probe.year,
    probe.month - 1,
    probe.day,
    probe.hour,
    probe.minute,
    probe.second,
    0,
  );
  const offsetMs = seenAsUtcMs - naiveAsUtcMs;
  return new Date(naiveAsUtcMs - offsetMs);
}

/** Add `n` calendar days to `(year, month, day)` interpreted in `tz`. */
function addCalendarDays(parts: DateParts, n: number, tz: string): DateParts {
  // Anchor at noon to avoid DST "spring-forward" missing-hour edge cases.
  const utc = zonedToUtc(parts.year, parts.month, parts.day, 12, 0, 0, tz);
  const shifted = new Date(utc.getTime() + n * 86_400_000);
  const p = zonedParts(shifted, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** Day-of-week index 0..6, Monday=0, matching Python `datetime.weekday()`. */
function isoWeekday(parts: DateParts): number {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  // JS getUTCDay: Sun=0..Sat=6. Convert to Mon=0..Sun=6.
  return (d.getUTCDay() + 6) % 7;
}

/** Day-of-year 1..366. */
function dayOfYear(parts: DateParts): number {
  const start = Date.UTC(parts.year, 0, 1);
  const cur = Date.UTC(parts.year, parts.month - 1, parts.day);
  return Math.floor((cur - start) / 86_400_000) + 1;
}

/** Format `(year, month, day)` as `"YYYY-MM-DD"`. */
function partsToIsoDate(p: DateParts): string {
  const yyyy = String(p.year).padStart(4, "0");
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIsoDate(s: string): DateParts | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.slice(0, 10));
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return { year, month, day };
}

/** Compare two `DateParts` lexicographically. */
function comparePartsAsc(a: DateParts, b: DateParts): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

// ---------------------------------------------------------------------------
// Public API: exception expansion / lookup
// ---------------------------------------------------------------------------

/**
 * Returns true iff the calendar day `(year, month, day)` falls inside
 * the given `CalendarException` — accounting for recurring expansions.
 *
 * Mirror of Python `is_date_in_exception` and the in-scope helper used
 * inside `preflightEngine.simulateWindow` (`dateMatchesException`).
 */
function dayMatchesException(parts: DateParts, ex: CalendarException): boolean {
  const lo = parseIsoDate(ex.start_date);
  const hi = parseIsoDate(ex.end_date);
  if (!lo || !hi) return false;

  // Recurring expansions are bounded by [start_date, end_date].
  if (comparePartsAsc(parts, lo) < 0) return false;
  if (comparePartsAsc(parts, hi) > 0) return false;

  if (ex.recurring_type === null || ex.recurring_type === undefined) {
    // One-shot exception — anything inside the inclusive range matches.
    return true;
  }
  if (ex.recurring_type === "weekly" && ex.recurring_value !== null) {
    // Schema accepts both 0..6 (Mon=0..Sun=6) and ISO 1..7 (Mon=1..Sun=7).
    const target =
      ex.recurring_value >= 1 && ex.recurring_value <= 7
        ? (ex.recurring_value - 1) % 7
        : ex.recurring_value;
    return isoWeekday(parts) === target;
  }
  if (ex.recurring_type === "monthly" && ex.recurring_value !== null) {
    return parts.day === ex.recurring_value;
  }
  if (ex.recurring_type === "yearly" && ex.recurring_value !== null) {
    return dayOfYear(parts) === ex.recurring_value;
  }
  return false;
}

/**
 * One concrete day on which a `CalendarException` is active.
 *
 * For one-shot exceptions every day in `[start_date, end_date]` produces
 * an `ExceptionOccurrence`. For recurring exceptions only the matching
 * days within the range produce occurrences.
 */
export interface ExceptionOccurrence {
  /** ISO date in user's timezone, format `YYYY-MM-DD`. */
  date: string;
  exception: CalendarException;
}

/**
 * Limit on the number of days we will iterate for a single
 * `expandRecurringExceptions` call. Defends against absurd ranges that
 * could otherwise build a large list and freeze the UI thread.
 */
const MAX_EXPANSION_DAYS = 366 * 5; // five years, plenty for monthly views

/**
 * Expand all `CalendarException` records into a flat list of concrete
 * occurrences within `[monthStart, monthEnd]` — both inclusive, matching
 * the calendar UI semantics where the user sees a whole month-sized
 * window at a time.
 *
 * The output is sorted ascending by `date`. Multiple exceptions on the
 * same day produce multiple occurrences (callers can group).
 *
 * `monthStart` / `monthEnd` may be `Date` objects (in which case their
 * wall-clock date in `tz` is used) or `YYYY-MM-DD` strings.
 */
export function expandRecurringExceptions(
  exceptions: CalendarException[],
  monthStart: Date | string,
  monthEnd: Date | string,
  tz: string = "UTC",
): ExceptionOccurrence[] {
  if (!Array.isArray(exceptions) || exceptions.length === 0) return [];

  const startParts = toDateParts(monthStart, tz);
  const endParts = toDateParts(monthEnd, tz);
  if (!startParts || !endParts) return [];
  if (comparePartsAsc(endParts, startParts) < 0) return [];

  const out: ExceptionOccurrence[] = [];
  let cursor: DateParts = startParts;
  for (let i = 0; i < MAX_EXPANSION_DAYS; i++) {
    for (const ex of exceptions) {
      if (dayMatchesException(cursor, ex)) {
        out.push({ date: partsToIsoDate(cursor), exception: ex });
      }
    }
    if (comparePartsAsc(cursor, endParts) >= 0) break;
    cursor = addCalendarDays(cursor, 1, tz);
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function toDateParts(value: Date | string, tz: string): DateParts | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const p = zonedParts(value, tz);
    return { year: p.year, month: p.month, day: p.day };
  }
  if (typeof value === "string") {
    const direct = parseIsoDate(value);
    if (direct) return direct;
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    const p = zonedParts(d, tz);
    return { year: p.year, month: p.month, day: p.day };
  }
  return null;
}

/**
 * Returns true iff the wall-clock date implied by `date` (in `tz`) falls
 * inside any of the given `CalendarException` records.
 *
 * `date` may be a `Date` instant, a `YYYY-MM-DD` string, or a full ISO
 * datetime string.
 */
export function isInException(
  date: Date | string,
  exceptions: CalendarException[],
  tz: string = "UTC",
): boolean {
  if (!Array.isArray(exceptions) || exceptions.length === 0) return false;
  const parts = toDateParts(date, tz);
  if (!parts) return false;
  for (const ex of exceptions) {
    if (dayMatchesException(parts, ex)) return true;
  }
  return false;
}

/**
 * Returns the first matching exception (or `null` if none) — useful for
 * surfacing the exception name in inline drag-and-drop errors
 * (Req 4.9: "with an inline error containing the exception name").
 */
export function findOverlappingException(
  date: Date | string,
  exceptions: CalendarException[],
  tz: string = "UTC",
): CalendarException | null {
  if (!Array.isArray(exceptions) || exceptions.length === 0) return null;
  const parts = toDateParts(date, tz);
  if (!parts) return null;
  for (const ex of exceptions) {
    if (dayMatchesException(parts, ex)) return ex;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API: next business day rolling
// ---------------------------------------------------------------------------

/**
 * Returns true for Monday..Friday in the user's timezone.
 *
 * Note: weekend definition is fixed Mon–Fri per Requirement 6.3.
 * Cultural variants (Sun–Thu, Sat–Wed) are out of scope for this spec.
 */
function isBusinessWeekday(parts: DateParts): boolean {
  const dow = isoWeekday(parts); // Mon=0..Sun=6
  return dow >= 0 && dow <= 4;
}

/** Hard upper bound on iterations for `nextBusinessDay`. */
const MAX_BUSINESS_DAY_LOOKAHEAD = 366; // one full year of consecutive blackouts

/**
 * Roll `date` forward to the next calendar day that is:
 *   1) Monday–Friday in `tz`;
 *   2) NOT inside any `CalendarException` for the user.
 *
 * The wall-clock time of day in `tz` is preserved (Requirement 6.3 —
 * "preserving the original wall-clock time of day").
 *
 * Algorithm:
 *   - Decompose `date` into wall-clock parts in `tz`.
 *   - Add one calendar day; if the resulting day is a business day AND
 *     not in any exception, recompose with the original time-of-day and
 *     return as a UTC `Date`.
 *   - Otherwise advance another day (up to `MAX_BUSINESS_DAY_LOOKAHEAD`).
 *
 * If no valid day is found within the lookahead window, returns `null`
 * — the caller should surface a user-facing error rather than
 * silently scheduling impossibly far in the future.
 */
export function nextBusinessDay(
  date: Date | string,
  tz: string,
  exceptions: CalendarException[],
): Date | null {
  const instant = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(instant.getTime())) return null;

  const tp = zonedParts(instant, tz);
  let cursor: DateParts = { year: tp.year, month: tp.month, day: tp.day };

  for (let i = 0; i < MAX_BUSINESS_DAY_LOOKAHEAD; i++) {
    cursor = addCalendarDays(cursor, 1, tz);
    if (!isBusinessWeekday(cursor)) continue;
    if (
      Array.isArray(exceptions) &&
      exceptions.length > 0 &&
      exceptions.some((ex) => dayMatchesException(cursor, ex))
    ) {
      continue;
    }
    return zonedToUtc(
      cursor.year,
      cursor.month,
      cursor.day,
      tp.hour,
      tp.minute,
      tp.second,
      tz,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal exports for tests / sibling modules
// ---------------------------------------------------------------------------

/**
 * Re-exported for `snoozePresets.ts` to avoid duplicating the
 * timezone-aware day arithmetic. Not part of the public surface.
 */
export const __internal = {
  zonedParts,
  zonedToUtc,
  addCalendarDays,
  partsToIsoDate,
  parseIsoDate,
  isoWeekday,
  dayMatchesException,
  isBusinessWeekday,
};
