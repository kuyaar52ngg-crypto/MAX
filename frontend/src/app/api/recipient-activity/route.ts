/**
 * `GET /api/recipient-activity?phone=...&top_n=N`
 *
 * Read-only Activity_Analyzer endpoint, mirroring Python
 * `scheduling/activity_analyzer.py::ActivityAnalyzer.compute_histogram` /
 * `top_slots`. The UI uses this for the per-recipient Smart-Time preview
 * (see design.md → "Components and Interfaces → Activity_Analyzer" and
 * `usePreflight` hook), and `PreFlight_Engine` consumes the histograms
 * via `recipientHistograms` (see `frontend/src/lib/scheduling/preflightEngine.ts`).
 *
 * Behaviour is defined by Requirement 2.11 of the
 * `broadcast-scheduling-suite` spec (read-only endpoint returning
 * `{ phone, histogram: number[24], top_slots: number[], source }`),
 * with the fallback chain spelled out in Requirements 2.3 / 2.4 /
 * 2.5 / 2.6.
 *
 * Implementation choice: direct Prisma aggregation against
 * `incoming` + `delivery_statuses` over the last 30 days, matching
 * the rest of the suite where Prisma owns CRUD/aggregation in TS and
 * Flask owns Green-API I/O. The two SQL queries below are 1:1
 * translations of the Python originals — same window
 * (`NOW() - INTERVAL '30 days'`), same positive delivery-statuses
 * `{read, played, viewed}`, same JOIN through `recipients` →
 * `broadcasts.user_id`.
 *
 * Fallback chain (Requirements 2.4, 2.5):
 *   1. recipient histogram, if `sum >= 5`           → source = "recipient"
 *   2. operator-global histogram, if `sum >= 5`     → source = "operator_global"
 *   3. fixed default histogram peaked at {10,14,19} → source = "default_fallback"
 *
 * Top-N tie-break (Requirement 2.6): descending count, ascending hour value.
 *
 * `top_n` query parameter is optional, default 3, allowed range 1..6
 * (matches the Smart-Time `smart_time_top_n` contract from Req 2.2).
 */

import { NextRequest } from "next/server";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Minimum events for a histogram to be considered "valid" (Req 2.4 / 2.5). */
const MIN_EVENTS_FOR_VALID_HISTOGRAM = 5;

/** Default `top_n` when client omits the query parameter (matches Smart-Time default). */
const DEFAULT_TOP_N = 3;

/** Allowed `top_n` range — same as Smart-Time `smart_time_top_n` (Req 2.2). */
const MIN_TOP_N = 1;
const MAX_TOP_N = 6;

/** Default-fallback peak hours per Requirement 2.5. */
const DEFAULT_PEAK_HOURS = [10, 14, 19] as const;

type ActivitySource = "recipient" | "operator_global" | "default_fallback";

interface HourCountRow {
  hour: number;
  cnt: bigint | number;
}

/**
 * 24-bucket fallback histogram with peaks at hours {10, 14, 19} and
 * zeros everywhere else (Requirement 2.5). Sum is 3 (< 5), but that's
 * fine — `select_top_n` works on this distribution and returns those
 * three hours first, then continues with ascending tie-break.
 */
function buildDefaultFallbackHistogram(): number[] {
  const hist = Array.from({ length: 24 }, () => 0);
  for (const h of DEFAULT_PEAK_HOURS) hist[h] = 1;
  return hist;
}

/**
 * Top-N hours: descending by count, ascending by hour for ties
 * (Requirement 2.6, mirrors `ActivityAnalyzer._select_top_n`).
 */
function selectTopN(hist: number[], topN: number): number[] {
  const indexed = hist.map((count, hour) => ({ hour, count }));
  indexed.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.hour - b.hour;
  });
  return indexed.slice(0, topN).map((entry) => entry.hour);
}

/** Fold a `(hour, cnt)` row set into a 24-bucket array, in place. */
function foldRowsIntoHistogram(rows: HourCountRow[], hist: number[]): void {
  for (const row of rows) {
    const h = Number(row.hour);
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      hist[h] += Number(row.cnt);
    }
  }
}

/**
 * Recipient-scoped histogram: incoming messages from `phone` to this
 * operator, plus positive delivery statuses on broadcasts of this
 * operator addressed to `phone`. Last 30 days, grouped by hour-of-day.
 */
async function queryRecipientHistogram(
  userId: string,
  phone: string,
): Promise<number[]> {
  const hist = Array.from({ length: 24 }, () => 0);

  const incomingRows = await prisma.$queryRaw<HourCountRow[]>`
    SELECT EXTRACT(HOUR FROM received_at)::int AS hour,
           COUNT(*)::bigint                    AS cnt
      FROM incoming
     WHERE user_id = ${userId}::uuid
       AND sender  = ${phone}
       AND received_at >= NOW() - INTERVAL '30 days'
  GROUP BY 1
  `;
  foldRowsIntoHistogram(incomingRows, hist);

  const deliveryRows = await prisma.$queryRaw<HourCountRow[]>`
    SELECT EXTRACT(HOUR FROM ds.timestamp)::int AS hour,
           COUNT(*)::bigint                     AS cnt
      FROM delivery_statuses ds
      JOIN recipients r ON r.message_id = ds.message_id
      JOIN broadcasts b ON b.id         = r.broadcast_id
     WHERE b.user_id    = ${userId}::uuid
       AND r.phone      = ${phone}
       AND ds.status    IN ('read', 'played', 'viewed')
       AND ds.timestamp >= NOW() - INTERVAL '30 days'
  GROUP BY 1
  `;
  foldRowsIntoHistogram(deliveryRows, hist);

  return hist;
}

/**
 * Operator-global histogram: all incoming for this operator + all
 * positive delivery statuses on this operator's broadcasts. Same
 * window, same positive statuses. Used as fallback when recipient
 * histogram has fewer than 5 events (Requirement 2.4).
 */
async function queryOperatorGlobalHistogram(userId: string): Promise<number[]> {
  const hist = Array.from({ length: 24 }, () => 0);

  const incomingRows = await prisma.$queryRaw<HourCountRow[]>`
    SELECT EXTRACT(HOUR FROM received_at)::int AS hour,
           COUNT(*)::bigint                    AS cnt
      FROM incoming
     WHERE user_id = ${userId}::uuid
       AND received_at >= NOW() - INTERVAL '30 days'
  GROUP BY 1
  `;
  foldRowsIntoHistogram(incomingRows, hist);

  const deliveryRows = await prisma.$queryRaw<HourCountRow[]>`
    SELECT EXTRACT(HOUR FROM ds.timestamp)::int AS hour,
           COUNT(*)::bigint                     AS cnt
      FROM delivery_statuses ds
      JOIN recipients r ON r.message_id = ds.message_id
      JOIN broadcasts b ON b.id         = r.broadcast_id
     WHERE b.user_id    = ${userId}::uuid
       AND ds.status    IN ('read', 'played', 'viewed')
       AND ds.timestamp >= NOW() - INTERVAL '30 days'
  GROUP BY 1
  `;
  foldRowsIntoHistogram(deliveryRows, hist);

  return hist;
}

function sumHistogram(hist: number[]): number {
  let s = 0;
  for (const v of hist) s += v;
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);

    // ── Phone validation ────────────────────────────────────────────
    // We do NOT digit-strip the phone here: the upstream `incoming`
    // and `recipients` tables store phones in their canonical form
    // (as Green-API delivers them), and the Python `Activity_Analyzer`
    // also uses phone exactly as given. Stripping non-digits here
    // would create a mismatch with the stored values. Caller is
    // responsible for sending the canonical phone string.
    const rawPhone = url.searchParams.get("phone");
    const phone = (rawPhone ?? "").trim();
    if (!phone) {
      return jsonResponse(
        { error: "phone query parameter is required" },
        { status: 400 },
      );
    }

    // ── top_n validation (default 3, range 1..6) ────────────────────
    let topN = DEFAULT_TOP_N;
    const rawTopN = url.searchParams.get("top_n");
    if (rawTopN != null && rawTopN !== "") {
      const parsed = Number.parseInt(rawTopN, 10);
      if (
        !Number.isFinite(parsed) ||
        String(parsed) !== rawTopN.trim() ||
        parsed < MIN_TOP_N ||
        parsed > MAX_TOP_N
      ) {
        return jsonResponse(
          {
            error: `top_n must be an integer in [${MIN_TOP_N}, ${MAX_TOP_N}]`,
          },
          { status: 400 },
        );
      }
      topN = parsed;
    }

    // ── Fallback chain (Requirements 2.4, 2.5) ──────────────────────
    let histogram: number[];
    let source: ActivitySource;

    const recipientHist = await prismaRetry(() =>
      queryRecipientHistogram(user.id, phone),
    );
    if (sumHistogram(recipientHist) >= MIN_EVENTS_FOR_VALID_HISTOGRAM) {
      histogram = recipientHist;
      source = "recipient";
    } else {
      const globalHist = await prismaRetry(() =>
        queryOperatorGlobalHistogram(user.id),
      );
      if (sumHistogram(globalHist) >= MIN_EVENTS_FOR_VALID_HISTOGRAM) {
        histogram = globalHist;
        source = "operator_global";
      } else {
        histogram = buildDefaultFallbackHistogram();
        source = "default_fallback";
      }
    }

    const topSlots = selectTopN(histogram, topN);

    return jsonResponse({
      phone,
      histogram,
      top_slots: topSlots,
      source,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("recipient-activity GET error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
