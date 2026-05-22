/**
 * PreFlight Engine — TypeScript (browser-side) implementation.
 *
 * Mirror of the server-side `scheduling/preflight_calc.py` distribution
 * formula. The two implementations MUST stay in sync — the cross-language
 * equivalence test (Task 11.4) compares histogram + warnings on identical
 * inputs (see `.kiro/specs/broadcast-scheduling-suite/design.md`,
 * "PreFlight_Engine" section, and Requirement 5.12).
 *
 * Public surface:
 *   - runPreFlight(input)            — synchronous, deterministic, ≤ 300 ms
 *   - dedupePhones(contacts)
 *   - simulateDistribution(input)    — exposed for unit + property tests
 *   - computeHistogram(sends, tz)
 *   - buildWarnings(input, sends)
 *
 * Determinism:
 *   - All randomness is derived from `mulberry32(broadcast.id ?? 0)` so the
 *     Python side can mirror the exact same number sequence (mulberry32 is
 *     a 32-bit PRNG with a closed-form, easily portable).
 *
 * Performance budget (Requirement 5.12):
 *   - Hard deadline 300 ms for up to 5000 contacts.
 *   - We checkpoint the wall clock at three points (after dedup, after
 *     simulate, after histogram) and return `null` if the elapsed time
 *     exceeds `PREFLIGHT_DEADLINE_MS - PREFLIGHT_ABORT_MARGIN_MS`. When
 *     `runPreFlight` returns null the modal shows
 *     «не успели рассчитать, попробуйте уменьшить количество получателей»
 *     (per design.md → PreFlight_Engine → step 4).
 */

import type {
  AntiBanConfig,
  CalendarException,
  GreenInstance,
  PreFlightResult,
  PreFlightWarning,
  ScheduledBroadcastDraft,
  ScheduleType,
} from "./types";

/** Hard deadline for the entire computation (Req 5.12). */
const PREFLIGHT_DEADLINE_MS = 300;

/**
 * Internal margin so we always return BEFORE the hard deadline; better
 * to surrender slightly early than to ship a stale partial result.
 */
const PREFLIGHT_ABORT_MARGIN_MS = 20;

/** Effective budget after subtracting the safety margin. */
const PREFLIGHT_BUDGET_MS = PREFLIGHT_DEADLINE_MS - PREFLIGHT_ABORT_MARGIN_MS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs for `runPreFlight`. Mirrors design.md → PreFlight_Engine.
 *
 * `recipientHistograms` is consumed by `smart_time` mode — the UI may
 * pre-fetch top-slots via `GET /api/recipient-activity`. When absent,
 * the engine falls back to the operator-default peak hours `{10,14,19}`
 * (Req 2.5).
 */
export interface PreFlightInput {
  draft: ScheduledBroadcastDraft;
  antiBan: AntiBanConfig;
  exceptions: CalendarException[];
  instance: GreenInstance | null;
  recipientHistograms?: Map<string, number[]>;
}

/**
 * Internal "send plan" produced by `simulateDistribution`. Same shape
 * the server uses (`ScheduledSend`) but stripped to the bits the UI needs.
 */
export interface SimulatedSend {
  phone: string;
  send_at: Date;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mirror of Python `seeded_rng(broadcast.id)`)
// ---------------------------------------------------------------------------

/**
 * Mulberry32 — deterministic 32-bit PRNG.
 *
 * The Python mirror MUST use the identical algorithm:
 *
 *     def mulberry32(seed: int):
 *         a = seed & 0xFFFFFFFF
 *         def gen() -> float:
 *             nonlocal a
 *             a = (a + 0x6D2B79F5) & 0xFFFFFFFF
 *             t = a
 *             t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
 *             t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61)))) & 0xFFFFFFFF
 *             return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
 *         return gen
 *
 * Algorithm reference: Tommy Ettinger, public domain.
 */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [-max, max], matching Python `random.uniform(-max, max)`. */
function uniformBipolar(rng: () => number, max: number): number {
  return (rng() * 2 - 1) * max;
}

// ---------------------------------------------------------------------------
// Phone deduplication
// ---------------------------------------------------------------------------

function normalizePhone(phone: string): string {
  return (phone ?? "").replace(/\D+/g, "");
}

/**
 * Deduplicate the contact list by normalised phone number. Preserves
 * the ORIGINAL phone string of the first occurrence for downstream code
 * that may render it back to the user.
 */
export function dedupePhones(contacts: { phone: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of contacts ?? []) {
    if (!c || typeof c.phone !== "string") continue;
    const norm = normalizePhone(c.phone);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(c.phone);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timezone helpers (Intl-based, no external deps)
// ---------------------------------------------------------------------------

interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
}

function safeIntlParts(date: Date, tz: string): ZonedParts {
  if (!Number.isFinite(date.getTime())) {
    // Defensive — return epoch parts so downstream code never crashes.
    return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
  const fmt = getZonedFormatter(tz);
  const parts = fmt.formatToParts(date);
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

/**
 * Cached `Intl.DateTimeFormat` per timezone. Constructing a formatter
 * is the dominant cost in PreFlight (≈40 µs each); reusing it lets us
 * fit 5000 contacts in <300 ms on commodity hardware.
 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function getZonedFormatter(tz: string): Intl.DateTimeFormat {
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

/**
 * Convert a "naive" wall-clock datetime in `tz` to its UTC instant.
 *
 * Algorithm (DST-safe up to one second-level skew):
 *   1. Build the naive datetime as if it were UTC (`Date.UTC(...)`).
 *   2. Ask Intl what wall-clock that UTC instant looks like in `tz`.
 *   3. The difference = offset; subtract it.
 *
 * Adapted from `src/lib/scheduled/computeNextRun.ts::naiveToUtc`.
 */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const naiveAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const probe = safeIntlParts(new Date(naiveAsUtcMs), tz);
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

/** Add `n` calendar days to (year, month, day) in `tz`. Returns naive Date parts. */
function addCalendarDays(
  parts: { year: number; month: number; day: number },
  n: number,
  tz: string,
): { year: number; month: number; day: number } {
  // Anchor the date at noon to dodge DST spring-forward edges.
  const utc = zonedToUtc(parts.year, parts.month, parts.day, 12, 0, 0, tz);
  const shifted = new Date(utc.getTime() + n * 86_400_000);
  const p = safeIntlParts(shifted, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// ---------------------------------------------------------------------------
// Interval algebra
// ---------------------------------------------------------------------------

type Interval = [Date, Date];

function intervalDuration(intervals: Interval[]): number {
  let s = 0;
  for (const [a, b] of intervals) s += Math.max(0, b.getTime() - a.getTime());
  return s / 1000;
}

function clipInterval(iv: Interval, lo: Date, hi: Date): Interval | null {
  const a = iv[0].getTime() < lo.getTime() ? lo : iv[0];
  const b = iv[1].getTime() > hi.getTime() ? hi : iv[1];
  return b.getTime() > a.getTime() ? [a, b] : null;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter((iv) => iv[1].getTime() > iv[0].getTime())
    .sort((a, b) => a[0].getTime() - b[0].getTime());
  const out: Interval[] = [];
  for (const iv of sorted) {
    if (out.length === 0) {
      out.push([iv[0], iv[1]]);
      continue;
    }
    const last = out[out.length - 1];
    if (iv[0].getTime() <= last[1].getTime()) {
      if (iv[1].getTime() > last[1].getTime()) last[1] = iv[1];
    } else {
      out.push([iv[0], iv[1]]);
    }
  }
  return out;
}

/**
 * Subtract `exclusions` from a single window.
 * Returns the disjoint, sorted list of usable sub-intervals.
 */
function subtractExclusions(
  window: Interval,
  exclusions: Interval[],
): Interval[] {
  if (window[1].getTime() <= window[0].getTime()) return [];
  const merged = mergeIntervals(
    exclusions
      .map((ex) => clipInterval(ex, window[0], window[1]))
      .filter((ex): ex is Interval => ex !== null),
  );
  if (merged.length === 0) return [[window[0], window[1]]];

  const out: Interval[] = [];
  let cursor = window[0];
  for (const [s, e] of merged) {
    if (s.getTime() > cursor.getTime()) {
      out.push([cursor, s]);
    }
    if (e.getTime() > cursor.getTime()) {
      cursor = e;
    }
    if (cursor.getTime() >= window[1].getTime()) break;
  }
  if (cursor.getTime() < window[1].getTime()) {
    out.push([cursor, window[1]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quiet-hours and calendar-exception zones
// ---------------------------------------------------------------------------

/**
 * Generate UTC quiet-hour zones overlapping `[winStart, winEnd]`.
 *
 * QH semantics (mirror of WindowEngine._compute_usable_intervals):
 *   - hours are integers 0..23 in `userTz`.
 *   - if `qhStart <= qhEnd` → QH zone of a day is `[qhStart, qhEnd)`.
 *   - if `qhStart >  qhEnd` → wraps midnight: `[qhStart, 24) ∪ [0, qhEnd)`.
 *
 * Iterates from one day before `winStart` to one day after `winEnd`
 * (in `userTz`) so we catch wrap-around zones that started yesterday.
 */
function quietHoursZones(
  winStart: Date,
  winEnd: Date,
  qhStart: number,
  qhEnd: number,
  userTz: string,
): Interval[] {
  const zones: Interval[] = [];
  const startParts = safeIntlParts(winStart, userTz);
  const endParts = safeIntlParts(winEnd, userTz);

  let cursor = addCalendarDays(
    { year: startParts.year, month: startParts.month, day: startParts.day },
    -1,
    userTz,
  );
  // Hard cap: max 90 days iteration (defensive — far above any realistic window).
  for (let i = 0; i < 92; i++) {
    if (qhStart === qhEnd) {
      // Empty QH zone — Req 1.7 only triggers when enabled+window is non-empty.
    } else if (qhStart < qhEnd) {
      zones.push([
        zonedToUtc(cursor.year, cursor.month, cursor.day, qhStart, 0, 0, userTz),
        zonedToUtc(cursor.year, cursor.month, cursor.day, qhEnd, 0, 0, userTz),
      ]);
    } else {
      // Wraps midnight: two intervals.
      const next = addCalendarDays(cursor, 1, userTz);
      zones.push([
        zonedToUtc(cursor.year, cursor.month, cursor.day, qhStart, 0, 0, userTz),
        zonedToUtc(next.year, next.month, next.day, 0, 0, 0, userTz),
      ]);
      zones.push([
        zonedToUtc(cursor.year, cursor.month, cursor.day, 0, 0, 0, userTz),
        zonedToUtc(cursor.year, cursor.month, cursor.day, qhEnd, 0, 0, userTz),
      ]);
    }
    if (
      cursor.year > endParts.year ||
      (cursor.year === endParts.year && cursor.month > endParts.month) ||
      (cursor.year === endParts.year &&
        cursor.month === endParts.month &&
        cursor.day > endParts.day)
    ) {
      break;
    }
    cursor = addCalendarDays(cursor, 1, userTz);
  }
  // Clip and merge.
  const clipped: Interval[] = [];
  for (const z of zones) {
    const c = clipInterval(z, winStart, winEnd);
    if (c) clipped.push(c);
  }
  return mergeIntervals(clipped);
}

/** Day-of-week index 0..6 with Monday=0, matching Python `datetime.weekday()`. */
function isoWeekday(parts: { year: number; month: number; day: number }): number {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  // JS getUTCDay: Sun=0..Sat=6. Convert to Mon=0..Sun=6.
  return (d.getUTCDay() + 6) % 7;
}

/** Day-of-year 1..366. */
function dayOfYear(parts: { year: number; month: number; day: number }): number {
  const start = Date.UTC(parts.year, 0, 1);
  const cur = Date.UTC(parts.year, parts.month - 1, parts.day);
  return Math.floor((cur - start) / 86_400_000) + 1;
}

function dateMatchesException(
  parts: { year: number; month: number; day: number },
  ex: CalendarException,
): boolean {
  // Parse YYYY-MM-DD bounds.
  const [sy, sm, sd] = ex.start_date.split("-").map(Number);
  const [ey, em, ed] = ex.end_date.split("-").map(Number);
  if (
    !Number.isFinite(sy) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(sd) ||
    !Number.isFinite(ey) ||
    !Number.isFinite(em) ||
    !Number.isFinite(ed)
  ) {
    return false;
  }
  if (ex.recurring_type === null || ex.recurring_type === undefined) {
    const cur = parts.year * 10000 + parts.month * 100 + parts.day;
    const lo = sy * 10000 + sm * 100 + sd;
    const hi = ey * 10000 + em * 100 + ed;
    return cur >= lo && cur <= hi;
  }
  // Recurring rules expand within [start_date, end_date] anchor.
  if (ex.recurring_type === "weekly" && ex.recurring_value !== null) {
    // Schema says ISO Mon=1..Sun=7 OR 0..6 — both supported defensively.
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

interface ExceptionZoneResult {
  zones: Interval[];
  /** name → number of days the exception postpones inside the window. */
  affected: Map<string, number>;
}

function calendarExceptionZones(
  winStart: Date,
  winEnd: Date,
  exceptions: CalendarException[],
  userTz: string,
): ExceptionZoneResult {
  const zones: Interval[] = [];
  const affected = new Map<string, number>();
  if (!exceptions || exceptions.length === 0) {
    return { zones, affected };
  }
  const startParts = safeIntlParts(winStart, userTz);
  const endParts = safeIntlParts(winEnd, userTz);
  let cursor = {
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
  };
  // Defensive: cap iterations at a reasonable upper bound (~year + slack).
  for (let i = 0; i < 400; i++) {
    for (const ex of exceptions) {
      if (dateMatchesException(cursor, ex)) {
        const a = zonedToUtc(cursor.year, cursor.month, cursor.day, 0, 0, 0, userTz);
        const next = addCalendarDays(cursor, 1, userTz);
        const b = zonedToUtc(next.year, next.month, next.day, 0, 0, 0, userTz);
        zones.push([a, b]);
        affected.set(ex.name, (affected.get(ex.name) ?? 0) + 1);
      }
    }
    if (
      cursor.year > endParts.year ||
      (cursor.year === endParts.year && cursor.month > endParts.month) ||
      (cursor.year === endParts.year &&
        cursor.month === endParts.month &&
        cursor.day >= endParts.day)
    ) {
      break;
    }
    cursor = addCalendarDays(cursor, 1, userTz);
  }
  const clipped: Interval[] = [];
  for (const z of zones) {
    const c = clipInterval(z, winStart, winEnd);
    if (c) clipped.push(c);
  }
  return { zones: mergeIntervals(clipped), affected };
}

// ---------------------------------------------------------------------------
// Distribution simulators (mirror Python Schedule_Mode_Engine strategies)
// ---------------------------------------------------------------------------

/**
 * Project an offset (in seconds) into a list of usable intervals,
 * returning the wall-clock Date that lies `offset` seconds into the
 * concatenated usable timeline.
 *
 * Mirror of Python `WindowEngine._project_offset_into_intervals`.
 */
function projectOffsetIntoIntervals(
  intervals: Interval[],
  offsetSeconds: number,
): Date {
  if (intervals.length === 0) return new Date(0);
  let remaining = Math.max(0, offsetSeconds);
  for (const [a, b] of intervals) {
    const span = (b.getTime() - a.getTime()) / 1000;
    if (remaining <= span) {
      return new Date(a.getTime() + remaining * 1000);
    }
    remaining -= span;
  }
  // Overflow — clamp to the final instant of the last interval.
  return intervals[intervals.length - 1][1];
}

/**
 * Compute the total *usable* seconds inside `[winStart, winEnd]` after
 * subtracting quiet-hour zones and `CalendarException` zones for the
 * given user timezone.
 *
 * This is the TS mirror of Python `WindowEngine._compute_usable_intervals`
 * (see `scheduling/window_engine.py`). The number of seconds it returns
 * is the very quantity the server-side validation gate compares against
 * `N * antiBan.delay_min` to decide whether `WINDOW_INSUFFICIENT_TIME`
 * applies (Req 1.9).
 *
 * Exposed (rather than kept private) so the
 * `POST /api/scheduled-broadcasts` validator can mirror the engine's
 * decision without duplicating the interval algebra.
 */
export function computeWindowUsableSeconds(
  winStart: Date,
  winEnd: Date,
  userTz: string,
  quietHoursEnabled: boolean,
  quietHoursStart: number,
  quietHoursEnd: number,
  exceptions: CalendarException[],
): number {
  if (
    !Number.isFinite(winStart.getTime()) ||
    !Number.isFinite(winEnd.getTime()) ||
    winEnd.getTime() <= winStart.getTime()
  ) {
    return 0;
  }
  const exclusions: Interval[] = [];
  if (quietHoursEnabled) {
    exclusions.push(
      ...quietHoursZones(winStart, winEnd, quietHoursStart, quietHoursEnd, userTz),
    );
  }
  exclusions.push(
    ...calendarExceptionZones(winStart, winEnd, exceptions ?? [], userTz).zones,
  );
  const usable = subtractExclusions([winStart, winEnd], exclusions);
  return intervalDuration(usable);
}

/**
 * `window` mode — even spread with deterministic jitter (Req 1.5–1.10).
 * Mirror of Python `WindowEngine.distribute`.
 */
function simulateWindow(
  draft: ScheduledBroadcastDraft,
  antiBan: AntiBanConfig,
  exceptions: CalendarException[],
  phones: string[],
): SimulatedSend[] {
  if (phones.length === 0) return [];
  if (!draft.send_window_start || !draft.send_window_end) return [];
  const start = new Date(draft.send_window_start);
  const end = new Date(draft.send_window_end);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    return [];
  }
  const userTz = draft.user_tz || "UTC";

  // Gather exclusions: quiet hours + calendar exceptions.
  const exclusions: Interval[] = [];
  if (draft.quiet_hours_enabled) {
    const qhs = draft.quiet_hours_start ?? 22;
    const qhe = draft.quiet_hours_end ?? 8;
    exclusions.push(...quietHoursZones(start, end, qhs, qhe, userTz));
  }
  exclusions.push(...calendarExceptionZones(start, end, exceptions, userTz).zones);

  const usable = subtractExclusions([start, end], exclusions);
  const usableSeconds = intervalDuration(usable);
  const n = phones.length;

  // When the window is unschedulable we still produce a best-effort
  // preview by spreading over the FULL window; the form-level validator
  // will surface WINDOW_INSUFFICIENT_TIME on submit.
  const intervalsForSpread =
    usableSeconds >= n * antiBan.delay_min && usable.length > 0
      ? usable
      : [[start, end] as Interval];
  const spreadSeconds = intervalDuration(intervalsForSpread);
  const baseInterval = spreadSeconds / n;

  const rng = mulberry32(draft.id ?? 0);
  const sends: SimulatedSend[] = [];
  for (let i = 0; i < n; i++) {
    const jitterMax = Math.min(60, baseInterval / 4);
    const jitter = uniformBipolar(rng, jitterMax);
    const offset = i * baseInterval + jitter;
    const sendAt = projectOffsetIntoIntervals(intervalsForSpread, offset);
    sends.push({ phone: phones[i], send_at: sendAt });
  }
  return sends;
}

/**
 * `smart_time` mode — round-robin over per-recipient top slots
 * (Req 2.6–2.9). Mirror of Python `SmartTimeEngine.distribute` with
 * the simplification that PreFlight uses the cached histograms passed
 * via `recipientHistograms` (or the operator-default `{10,14,19}` peaks
 * when missing — Req 2.5 default_fallback).
 */
function simulateSmartTime(
  draft: ScheduledBroadcastDraft,
  antiBan: AntiBanConfig,
  exceptions: CalendarException[],
  phones: string[],
  recipientHistograms: Map<string, number[]> | undefined,
): SimulatedSend[] {
  if (phones.length === 0) return [];
  const anchorIso = draft.scheduled_for ?? null;
  const anchor = anchorIso ? new Date(anchorIso) : new Date();
  if (!Number.isFinite(anchor.getTime())) return [];
  const userTz = draft.user_tz || "UTC";
  const windowDays = clampInt(draft.smart_time_window_days ?? 1, 1, 14);
  const topN = clampInt(draft.smart_time_top_n ?? 3, 1, 6);
  const hourlyLimit = Math.max(1, antiBan.hourly_check_limit);

  const defaultFallback = pickTopHours([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0], topN);

  const exclusionZones = calendarExceptionZones(
    anchor,
    new Date(anchor.getTime() + windowDays * 86_400_000),
    exceptions,
    userTz,
  ).zones;

  const perHourCount = new Map<string, number>();
  const rrIndex = new Map<string, number>();
  const sends: SimulatedSend[] = [];

  const anchorParts = safeIntlParts(anchor, userTz);
  let cursor = { year: anchorParts.year, month: anchorParts.month, day: anchorParts.day };

  for (const phone of phones) {
    const slots = pickRecipientSlots(phone, recipientHistograms, defaultFallback, topN);
    const idx = rrIndex.get(phone) ?? 0;
    rrIndex.set(phone, idx + 1);
    const baseHour = slots[idx % slots.length];

    let placed: Date | null = null;
    let dayParts = cursor;
    for (let dayOffset = 0; dayOffset <= windowDays && !placed; dayOffset++) {
      const candidateParts =
        dayOffset === 0 ? dayParts : addCalendarDays(cursor, dayOffset, userTz);
      // Try the recipient's preferred hours in order, sliding past QH/exceptions.
      for (const hour of slots) {
        const adjusted = shiftPastQuietHours(
          hour,
          draft.quiet_hours_enabled === true,
          draft.quiet_hours_start ?? 22,
          draft.quiet_hours_end ?? 8,
        );
        if (adjusted === null) continue;
        const ts = zonedToUtc(
          candidateParts.year,
          candidateParts.month,
          candidateParts.day,
          adjusted,
          0,
          0,
          userTz,
        );
        // Skip calendar exceptions
        if (anyIntervalContains(exclusionZones, ts)) continue;
        // Hourly cap
        const key = `${candidateParts.year}-${candidateParts.month}-${candidateParts.day}-${adjusted}`;
        const cnt = perHourCount.get(key) ?? 0;
        if (cnt >= hourlyLimit) continue;
        perHourCount.set(key, cnt + 1);
        placed = ts;
        break;
      }
      // Suppress unused-var lint when we don't actually consume baseHour
      // in a given iteration but fall through to next day.
      void baseHour;
    }
    sends.push({ phone, send_at: placed ?? anchor });
  }
  return sends;
}

/**
 * `ab_time` mode — split into N groups, all messages of group k go at
 * `slots[k]:00` of `scheduled_for`'s day. Mirror of Python
 * `ABTimeEngine.distribute` (deterministic shuffle by broadcast.id).
 */
function simulateAbTime(
  draft: ScheduledBroadcastDraft,
  phones: string[],
): SimulatedSend[] {
  if (phones.length === 0) return [];
  const anchor = draft.scheduled_for ? new Date(draft.scheduled_for) : new Date();
  if (!Number.isFinite(anchor.getTime())) return [];
  const userTz = draft.user_tz || "UTC";

  // Without DB access PreFlight defaults to a 2-slot test {10, 19} —
  // the actual slots come from `ABTimeTest` row created server-side
  // (Task 9.11). When those land via `recipientHistograms` integration
  // we'll thread them through; for now PreFlight is best-effort.
  const slots: number[] = [10, 19];

  const groups = deterministicSplit(phones, slots.length, draft.id ?? 0);
  const anchorParts = safeIntlParts(anchor, userTz);
  const sends: SimulatedSend[] = [];
  for (let g = 0; g < slots.length; g++) {
    const ts = zonedToUtc(
      anchorParts.year,
      anchorParts.month,
      anchorParts.day,
      slots[g],
      0,
      0,
      userTz,
    );
    for (const phone of groups[g]) sends.push({ phone, send_at: ts });
  }
  return sends;
}

/**
 * `burst` mode — anchor at `scheduled_for`, increment by `delay_min`
 * per message. Mirror of Python `BurstEngine.delay_for(message_index, ...)`
 * for the `normal` throttle state.
 */
function simulateBurst(
  draft: ScheduledBroadcastDraft,
  antiBan: AntiBanConfig,
  phones: string[],
): SimulatedSend[] {
  if (phones.length === 0) return [];
  const anchor = draft.scheduled_for ? new Date(draft.scheduled_for) : new Date();
  if (!Number.isFinite(anchor.getTime())) return [];
  const stepMs = Math.max(1, antiBan.delay_min) * 1000;
  return phones.map((p, i) => ({
    phone: p,
    send_at: new Date(anchor.getTime() + i * stepMs),
  }));
}

/**
 * Existing modes from `enhanced-broadcast-scheduling`. PreFlight handles
 * them with a pragmatic linear spread so the histogram and ETA still
 * make sense; the server-side scheduler remains authoritative.
 */
function simulateLegacy(
  draft: ScheduledBroadcastDraft,
  antiBan: AntiBanConfig,
  phones: string[],
): SimulatedSend[] {
  if (phones.length === 0) return [];
  const anchor = draft.scheduled_for ? new Date(draft.scheduled_for) : new Date();
  if (!Number.isFinite(anchor.getTime())) return [];
  const stepMs = Math.max(1, (antiBan.delay_min + antiBan.delay_max) / 2) * 1000;
  return phones.map((p, i) => ({
    phone: p,
    send_at: new Date(anchor.getTime() + i * stepMs),
  }));
}

/**
 * Top-level distribution simulator. Selects the strategy by
 * `draft.schedule_type` and returns the planned sends. The output is
 * sorted by `send_at` to make ETA-extraction trivial downstream.
 */
export function simulateDistribution(input: PreFlightInput): SimulatedSend[] {
  const { draft, antiBan, exceptions, recipientHistograms } = input;
  const phones = dedupePhones(draft.contacts ?? []);
  const type: ScheduleType = draft.schedule_type;
  let sends: SimulatedSend[] = [];
  switch (type) {
    case "window":
      sends = simulateWindow(draft, antiBan, exceptions, phones);
      break;
    case "smart_time":
      sends = simulateSmartTime(draft, antiBan, exceptions, phones, recipientHistograms);
      break;
    case "ab_time":
      sends = simulateAbTime(draft, phones);
      break;
    case "burst":
      sends = simulateBurst(draft, antiBan, phones);
      break;
    default:
      sends = simulateLegacy(draft, antiBan, phones);
      break;
  }
  sends.sort((a, b) => a.send_at.getTime() - b.send_at.getTime());
  return sends;
}

// ---------------------------------------------------------------------------
// Histogram + warnings
// ---------------------------------------------------------------------------

/**
 * Bucket sends into a 24-element array indexed by the hour-of-day in
 * `userTz`. Mirror of design.md → PreFlight_Engine "computeHistogram".
 *
 * Hot path optimisation: probe the timezone offset at the first and
 * last send. If it's stable across the window (no DST transition),
 * compute the hour with a single subtraction; otherwise fall back to
 * `Intl.DateTimeFormat` per send.
 */
export function computeHistogram(
  sends: { send_at: Date }[],
  userTz: string,
): number[] {
  const hist = new Array<number>(24).fill(0);
  if (sends.length === 0) return hist;

  // Probe offsets at the boundaries.
  const first = sends[0].send_at;
  const last = sends[sends.length - 1].send_at;
  const offFirst = tzOffsetMinutes(first, userTz);
  const offLast = tzOffsetMinutes(last, userTz);
  const stableOffset = offFirst === offLast ? offFirst : null;

  if (stableOffset !== null) {
    // Fast path: hour = (utc_ms / 3_600_000 + offsetMinutes / 60) mod 24.
    for (const s of sends) {
      if (!s || !(s.send_at instanceof Date) || !Number.isFinite(s.send_at.getTime())) {
        continue;
      }
      const localMs = s.send_at.getTime() + stableOffset * 60_000;
      // Use UTC-domain math after shifting; the result is the wall-clock hour in tz.
      const h = ((Math.floor(localMs / 3_600_000) % 24) + 24) % 24;
      hist[h] += 1;
    }
    return hist;
  }

  // Slow path: DST inside the window. Fall back to per-send Intl call.
  for (const s of sends) {
    if (!s || !(s.send_at instanceof Date) || !Number.isFinite(s.send_at.getTime())) {
      continue;
    }
    const parts = safeIntlParts(s.send_at, userTz);
    const h = parts.hour % 24;
    hist[h] += 1;
  }
  return hist;
}

/**
 * Returns the offset of `tz` (in minutes east of UTC) at the moment
 * `date`. Computed via the difference between the wall-clock parts
 * `Intl` reports and the same date interpreted as UTC.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  if (!Number.isFinite(date.getTime())) return 0;
  const parts = safeIntlParts(date, tz);
  const seenAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return Math.round((seenAsUtcMs - date.getTime()) / 60_000);
}

/**
 * Compose the warning list (Req 5.5–5.8). The order is fixed —
 * tests rely on it: quiet_hours, calendar_exception, daily_limit, instance.
 */
export function buildWarnings(
  input: PreFlightInput,
  sends: SimulatedSend[],
): PreFlightWarning[] {
  const warnings: PreFlightWarning[] = [];
  const { draft, antiBan, exceptions, instance } = input;
  const userTz = draft.user_tz || "UTC";

  // 1) quiet_hours_postpone (Req 5.5)
  if (draft.quiet_hours_enabled) {
    const qhs = draft.quiet_hours_start ?? 22;
    const qhe = draft.quiet_hours_end ?? 8;
    if (qhs !== qhe && sends.length > 0) {
      const offFirst = tzOffsetMinutes(sends[0].send_at, userTz);
      const offLast = tzOffsetMinutes(sends[sends.length - 1].send_at, userTz);
      const stableOffset = offFirst === offLast ? offFirst : null;
      let affected = 0;
      for (const s of sends) {
        let hour: number;
        if (stableOffset !== null) {
          const localMs = s.send_at.getTime() + stableOffset * 60_000;
          hour = ((Math.floor(localMs / 3_600_000) % 24) + 24) % 24;
        } else {
          hour = safeIntlParts(s.send_at, userTz).hour;
        }
        const inWindow =
          qhs < qhe ? hour >= qhs && hour < qhe : hour >= qhs || hour < qhe;
        if (inWindow) affected++;
      }
      if (affected > 0) {
        warnings.push({
          kind: "quiet_hours_postpone",
          message: `${affected} сообщ. попадают в тихие часы ${formatHour(qhs)}–${formatHour(qhe)} и будут отложены`,
          affectedCount: affected,
        });
      }
    }
  }

  // 2) calendar_exception_postpone (Req 5.6)
  if (exceptions && exceptions.length > 0 && sends.length > 0) {
    const winStart = sends[0].send_at;
    const winEnd = sends[sends.length - 1].send_at;
    const ex = calendarExceptionZones(winStart, winEnd, exceptions, userTz);
    if (ex.affected.size > 0) {
      const parts: string[] = [];
      let totalAffected = 0;
      for (const [name, days] of ex.affected.entries()) {
        parts.push(`${name} (${days} дн.)`);
      }
      // Count how many sends actually overlap any exception zone.
      for (const s of sends) {
        if (anyIntervalContains(ex.zones, s.send_at)) totalAffected++;
      }
      warnings.push({
        kind: "calendar_exception_postpone",
        message: `Календарные исключения: ${parts.join(", ")}`,
        affectedCount: totalAffected,
      });
    }
  }

  // 3) daily_limit_exceeded (Req 5.7)
  const dailyLimit = antiBan.daily_message_limit;
  if (dailyLimit > 0 && sends.length > dailyLimit) {
    const offFirst = tzOffsetMinutes(sends[0].send_at, userTz);
    const offLast = tzOffsetMinutes(sends[sends.length - 1].send_at, userTz);
    const stableOffset = offFirst === offLast ? offFirst : null;
    const perDay = new Map<number, number>();
    for (const s of sends) {
      let key: number;
      if (stableOffset !== null) {
        const localMs = s.send_at.getTime() + stableOffset * 60_000;
        key = Math.floor(localMs / 86_400_000);
      } else {
        const p = safeIntlParts(s.send_at, userTz);
        key = p.year * 10000 + p.month * 100 + p.day;
      }
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    let maxDay = 0;
    for (const v of perDay.values()) if (v > maxDay) maxDay = v;
    if (maxDay > dailyLimit) {
      warnings.push({
        kind: "daily_limit_exceeded",
        message: `Превышен дневной лимит: ${maxDay} сообщ. за день при лимите ${dailyLimit}`,
        affectedCount: maxDay - dailyLimit,
      });
    }
  }

  // 4) instance_unhealthy (Req 5.8)
  if (instance && instance.status !== "authorized") {
    warnings.push({
      kind: "instance_unhealthy",
      message: `Инстанс «${instance.name}» в статусе ${instance.status}`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// runPreFlight
// ---------------------------------------------------------------------------

/**
 * Entry point for the PreFlight modal. Synchronous, deterministic and
 * pure (no network, no DOM). Returns `null` when the wall-clock budget
 * is blown — the modal renders «не успели рассчитать, попробуйте
 * уменьшить количество получателей» (Req 5.12).
 */
export function runPreFlight(input: PreFlightInput): PreFlightResult | null {
  const t0 = nowMs();
  const userTz = input.draft.user_tz || "UTC";

  const phones = dedupePhones(input.draft.contacts ?? []);
  if (deadlineExceeded(t0)) return null;

  const sends = simulateDistribution({
    ...input,
    draft: {
      ...input.draft,
      // Replace contacts with the deduplicated list so simulators don't
      // have to re-dedupe and to keep histogram counts faithful.
      contacts: phones.map((phone) => ({ phone })),
    },
  });
  if (deadlineExceeded(t0)) return null;

  const histogram = computeHistogram(sends, userTz);
  if (deadlineExceeded(t0)) return null;

  const warnings = buildWarnings(input, sends);
  const computeMs = nowMs() - t0;
  if (computeMs > PREFLIGHT_BUDGET_MS) return null;

  const firstSendEta = sends.length > 0 ? formatHourMinute(sends[0].send_at, userTz) : "—";
  const lastSendEta =
    sends.length > 0 ? formatHourMinute(sends[sends.length - 1].send_at, userTz) : "—";

  return {
    recipientCount: phones.length,
    firstSendEta,
    lastSendEta,
    histogram,
    warnings,
    computeMs,
  };
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function deadlineExceeded(t0: number): boolean {
  return nowMs() - t0 > PREFLIGHT_BUDGET_MS;
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const v = Math.floor(value);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function pickTopHours(hist: number[], topN: number): number[] {
  // Tie-break: descending count, ascending hour (Req 2.6).
  const indexed = hist.map((c, h) => ({ c, h }));
  indexed.sort((a, b) => (a.c === b.c ? a.h - b.h : b.c - a.c));
  return indexed.slice(0, topN).map((x) => x.h);
}

function pickRecipientSlots(
  phone: string,
  histograms: Map<string, number[]> | undefined,
  fallback: number[],
  topN: number,
): number[] {
  if (!histograms) return fallback;
  const hist = histograms.get(phone);
  if (!hist || hist.length !== 24) return fallback;
  const total = hist.reduce((s, v) => s + (v || 0), 0);
  if (total < 5) return fallback;
  return pickTopHours(hist, topN);
}

function shiftPastQuietHours(
  hour: number,
  enabled: boolean,
  qhStart: number,
  qhEnd: number,
): number | null {
  if (!enabled || qhStart === qhEnd) return hour;
  const inQh =
    qhStart < qhEnd
      ? hour >= qhStart && hour < qhEnd
      : hour >= qhStart || hour < qhEnd;
  if (!inQh) return hour;
  // Simplest mirror: bump to qhEnd (the first hour outside QH).
  return qhEnd % 24;
}

function anyIntervalContains(intervals: Interval[], date: Date): boolean {
  const t = date.getTime();
  for (const [a, b] of intervals) {
    if (t >= a.getTime() && t < b.getTime()) return true;
  }
  return false;
}

/**
 * Deterministic split of `items` into `n` groups, balanced so that
 * `max_size − min_size <= 1`. Mirror of Python `deterministic_split`
 * used by `ABTimeEngine.distribute` (seed = `broadcast.id`).
 *
 * Algorithm: Fisher–Yates shuffle with mulberry32, then round-robin.
 */
function deterministicSplit<T>(items: T[], n: number, seed: number): T[][] {
  const arr = items.slice();
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const groups: T[][] = Array.from({ length: Math.max(1, n) }, () => []);
  for (let i = 0; i < arr.length; i++) {
    groups[i % groups.length].push(arr[i]);
  }
  return groups;
}

function formatHour(h: number): string {
  return `${Math.max(0, Math.min(23, h)).toString().padStart(2, "0")}:00`;
}

function formatHourMinute(date: Date, tz: string): string {
  const p = safeIntlParts(date, tz);
  return `${p.hour.toString().padStart(2, "0")}:${p.minute.toString().padStart(2, "0")}`;
}
