"use client";

import { useMemo } from "react";

export type IncidentKind =
  | "yellowCard"
  | "blocked"
  | "notAuthorized"
  | "rate_limit_429"
  | "quota_466"
  | "watchdog_reset"
  | "error"
  | string;

export interface Incident {
  id: number;
  user_id: string;
  operation_run_id: number | null;
  kind: IncidentKind;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface IncidentListProps {
  items: Incident[];
  /** Locale for date grouping; defaults to ru-RU. */
  locale?: string;
  className?: string;
  emptyMessage?: string;
}

const KIND_LABEL: Record<string, string> = {
  yellowCard: "Yellow card",
  blocked: "Заблокирован",
  notAuthorized: "Не авторизован",
  rate_limit_429: "HTTP 429 Rate limit",
  quota_466: "HTTP 466 Quota",
  watchdog_reset: "Watchdog timeout",
  error: "Ошибка",
};

const KIND_COLOR: Record<string, string> = {
  yellowCard: "bg-yellow-100 text-yellow-800 border-yellow-300",
  blocked: "bg-red-100 text-red-800 border-red-300",
  notAuthorized: "bg-red-100 text-red-800 border-red-300",
  rate_limit_429: "bg-orange-100 text-orange-800 border-orange-300",
  quota_466: "bg-orange-100 text-orange-800 border-orange-300",
  watchdog_reset: "bg-purple-100 text-purple-800 border-purple-300",
  error: "bg-gray-100 text-gray-700 border-gray-300",
};

function dayKey(iso: string): string {
  // Take first 10 chars (YYYY-MM-DD); if not parseable, fallback to whole string.
  if (typeof iso === "string" && iso.length >= 10 && iso[4] === "-") {
    return iso.slice(0, 10);
  }
  return iso;
}

function formatTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDateHeader(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
}

export function IncidentList({
  items,
  locale = "ru-RU",
  className,
  emptyMessage = "Инцидентов нет",
}: IncidentListProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, Incident[]>();
    for (const inc of items) {
      const key = dayKey(inc.created_at);
      const arr = map.get(key) ?? [];
      arr.push(inc);
      map.set(key, arr);
    }
    // Days sorted descending (newest first).
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [items]);

  if (items.length === 0) {
    return <div className={`text-sm text-gray-500 ${className ?? ""}`}>{emptyMessage}</div>;
  }

  return (
    <div className={["space-y-4", className ?? ""].filter(Boolean).join(" ")}>
      {grouped.map(([day, dayItems]) => (
        <section key={day}>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            {formatDateHeader(day + "T00:00:00", locale)}
          </h3>
          <ul className="space-y-1">
            {dayItems.map(inc => {
              const label = KIND_LABEL[inc.kind] ?? inc.kind;
              const color = KIND_COLOR[inc.kind] ?? KIND_COLOR.error;
              return (
                <li key={inc.id} className="flex items-start gap-3 p-2 border border-gray-200 rounded">
                  <span className={["inline-flex items-center px-2 py-0.5 rounded text-xs border", color].join(" ")}>
                    {label}
                  </span>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {formatTime(inc.created_at, locale)}
                  </span>
                  {inc.operation_run_id != null && (
                    <span className="text-xs text-gray-400">
                      run #{inc.operation_run_id}
                    </span>
                  )}
                  {inc.details && Object.keys(inc.details).length > 0 && (
                    <code className="text-xs text-gray-600 truncate">
                      {JSON.stringify(inc.details)}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default IncidentList;
