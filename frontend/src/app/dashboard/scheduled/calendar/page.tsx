"use client";

/**
 * `/dashboard/scheduled/calendar` — визуальный календарь запланированных рассылок.
 *
 * Pills можно перетаскивать в другие дни (для статусов scheduled/paused/
 * pending_approval). Время дня сохраняется. CalendarException-дни помечены
 * dashed-рамкой и блокируют drop.
 */

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { nxGet } from "@/lib/api";
import { VisualScheduleCalendar } from "@/components/scheduling/VisualScheduleCalendar";
import type { CalendarException } from "@/lib/scheduling/types";

export default function CalendarPage() {
  const router = useRouter();
  const [exceptions, setExceptions] = useState<CalendarException[]>([]);

  useEffect(() => {
    nxGet<CalendarException[]>("/api/calendar-exceptions")
      .then((rows) => setExceptions(Array.isArray(rows) ? rows : []))
      .catch(() => setExceptions([]));
  }, []);

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
            <CalendarClock className="h-5 w-5" strokeWidth={2.2} />
          </div>
          <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
            Календарь рассылок
          </h1>
          <p className="text-text-muted text-sm mt-1">
            Перетаскивайте задачи между днями. Сегодня выделено акцентом, дни
            календарных исключений отмечены штриховкой.
          </p>
        </div>
        <Link
          href="/dashboard/scheduled"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:border-accent/40 transition-colors"
        >
          ← К списку
        </Link>
      </header>

      <VisualScheduleCalendar
        exceptions={exceptions}
        onPillClick={(b) => router.push(`/dashboard/scheduled#broadcast-${b.id}`)}
      />

      <Legend />
    </div>
  );
}

function Legend() {
  const items = [
    { label: "Запланирована", color: "bg-blue-500/20 border-blue-500/40 text-blue-400" },
    { label: "Идёт сейчас", color: "bg-success/20 border-success/40 text-success" },
    { label: "На паузе", color: "bg-warning/20 border-warning/40 text-warning" },
    {
      label: "На одобрении",
      color: "bg-violet-500/20 border-violet-500/40 text-violet-400",
    },
    { label: "Завершена", color: "bg-bg-elevated border-border text-text-muted" },
    { label: "Ошибка", color: "bg-error/20 border-error/40 text-error" },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {items.map((it) => (
        <span
          key={it.label}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${it.color}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          {it.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1 rounded-full border-2 border-dashed border-warning/40 px-2 py-0.5 text-warning">
        Календарное исключение
      </span>
    </div>
  );
}
