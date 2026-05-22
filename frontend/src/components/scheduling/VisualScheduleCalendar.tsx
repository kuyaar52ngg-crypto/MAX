"use client";

/**
 * `VisualScheduleCalendar` — календарный месячный/недельный обзор
 * запланированных рассылок с drag-and-drop через `@dnd-kit/core`.
 *
 * Возможности:
 *   - месячный и недельный вид;
 *   - цветовое кодирование по статусу;
 *   - tooltip на hover (название, время, кол-во получателей, статус);
 *   - перетаскивание pill'ов в другие дни (только scheduled/paused/pending_approval);
 *   - подсветка today (ring), CalendarException-дней (dashed border).
 *
 * Drag-and-drop делает PATCH `/api/scheduled-broadcasts/[id]` с новым
 * `scheduled_for` (preserving original time-of-day).
 */

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Users,
} from "lucide-react";

import { nxGet, nxPatch } from "@/lib/api";
import type { CalendarException } from "@/lib/scheduling/types";

interface BroadcastSummary {
  id: number;
  name: string | null;
  status: string;
  approval_status?: string;
  schedule_type: string;
  scheduled_for: string | null;
  next_run_at: string | null;
  contacts: unknown;
  user_tz: string;
}

const DRAGGABLE_STATUSES = new Set([
  "scheduled",
  "paused",
  "pending_approval",
]);

const STATUS_COLORS: Record<string, string> = {
  scheduled: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  running: "bg-success/20 text-success border-success/40",
  paused: "bg-warning/20 text-warning border-warning/40",
  pending_approval:
    "bg-violet-500/20 text-violet-400 border-violet-500/40",
  completed: "bg-bg-elevated text-text-muted border-border",
  done: "bg-bg-elevated text-text-muted border-border",
  failed: "bg-error/20 text-error border-error/40",
  cancelled:
    "bg-bg-elevated text-text-muted border-border opacity-60 line-through",
  rejected:
    "bg-error/10 text-error border-error/30 opacity-70 line-through",
};

type ViewMode = "month" | "week";

interface DayKey {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toKey(d: DayKey): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function fromKey(s: string): DayKey {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function dayKeyFromDate(d: Date): DayKey {
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  };
}

function compareKeys(a: DayKey, b: DayKey): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function todayKey(): DayKey {
  return dayKeyFromDate(new Date());
}

function startOfMonth(d: DayKey): DayKey {
  return { year: d.year, month: d.month, day: 1 };
}

function nextMonth(d: DayKey): DayKey {
  return d.month === 12
    ? { year: d.year + 1, month: 1, day: 1 }
    : { year: d.year, month: d.month + 1, day: 1 };
}

function prevMonth(d: DayKey): DayKey {
  return d.month === 1
    ? { year: d.year - 1, month: 12, day: 1 }
    : { year: d.year, month: d.month - 1, day: 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Mon=0..Sun=6 */
function isoWeekday(d: DayKey): number {
  return (new Date(d.year, d.month - 1, d.day).getDay() + 6) % 7;
}

function isException(d: DayKey, exceptions: CalendarException[]): boolean {
  for (const ex of exceptions ?? []) {
    if (!ex) continue;
    if (ex.recurring_type === null || ex.recurring_type === undefined) {
      const cur = d.year * 10000 + d.month * 100 + d.day;
      const [sy, sm, sd] = ex.start_date.split("-").map(Number);
      const [ey, em, ed] = ex.end_date.split("-").map(Number);
      const lo = sy * 10000 + sm * 100 + sd;
      const hi = ey * 10000 + em * 100 + ed;
      if (cur >= lo && cur <= hi) return true;
      continue;
    }
    if (ex.recurring_type === "weekly" && ex.recurring_value !== null) {
      const target =
        ex.recurring_value >= 1 && ex.recurring_value <= 7
          ? (ex.recurring_value - 1) % 7
          : ex.recurring_value;
      if (isoWeekday(d) === target) return true;
    } else if (ex.recurring_type === "monthly" && ex.recurring_value !== null) {
      if (d.day === ex.recurring_value) return true;
    } else if (ex.recurring_type === "yearly" && ex.recurring_value !== null) {
      const start = Date.UTC(d.year, 0, 1);
      const cur = Date.UTC(d.year, d.month - 1, d.day);
      if (Math.floor((cur - start) / 86_400_000) + 1 === ex.recurring_value) return true;
    }
  }
  return false;
}

function broadcastDayKey(b: BroadcastSummary): DayKey | null {
  const iso = b.next_run_at ?? b.scheduled_for ?? null;
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return dayKeyFromDate(d);
}

export function VisualScheduleCalendar({
  exceptions = [],
  onPillClick,
}: {
  exceptions?: CalendarException[];
  onPillClick?: (broadcast: BroadcastSummary) => void;
}) {
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState<DayKey>(todayKey());
  const [items, setItems] = useState<BroadcastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const load = useMemo(
    () => async () => {
      try {
        const data = await nxGet<BroadcastSummary[]>(
          "/api/scheduled-broadcasts",
        );
        setItems(Array.isArray(data) ? data : []);
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Не удалось загрузить");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Группировка items по dayKey.
  const byDay = useMemo(() => {
    const map = new Map<string, BroadcastSummary[]>();
    for (const it of items) {
      const k = broadcastDayKey(it);
      if (!k) continue;
      const key = toKey(k);
      const list = map.get(key) ?? [];
      list.push(it);
      map.set(key, list);
    }
    // Сортировка внутри дня по времени
    for (const [k, list] of map) {
      list.sort((a, b) => {
        const ta = new Date(a.next_run_at ?? a.scheduled_for ?? 0).getTime();
        const tb = new Date(b.next_run_at ?? b.scheduled_for ?? 0).getTime();
        return ta - tb;
      });
      map.set(k, list);
    }
    return map;
  }, [items]);

  // Список дней для текущего view.
  const days = useMemo<DayKey[]>(() => {
    if (view === "month") {
      const first = startOfMonth(anchor);
      const total = daysInMonth(first.year, first.month);
      const leadingBlanks = isoWeekday(first); // Mon=0
      const out: DayKey[] = [];
      // Предыдущий месяц для заполнения первой строки
      if (leadingBlanks > 0) {
        const prevM = prevMonth(first);
        const prevTotal = daysInMonth(prevM.year, prevM.month);
        for (let i = leadingBlanks; i > 0; i--) {
          out.push({ year: prevM.year, month: prevM.month, day: prevTotal - i + 1 });
        }
      }
      for (let d = 1; d <= total; d++) {
        out.push({ year: first.year, month: first.month, day: d });
      }
      // Дополним до сетки 6 строк × 7 = 42 ячеек.
      while (out.length < 42) {
        const last = out[out.length - 1];
        const lastTotal = daysInMonth(last.year, last.month);
        if (last.day < lastTotal) {
          out.push({ ...last, day: last.day + 1 });
        } else {
          const nm = nextMonth(last);
          out.push(nm);
        }
      }
      return out;
    }
    // week: 7 дней начиная с понедельника недели anchor
    const wd = isoWeekday(anchor);
    const out: DayKey[] = [];
    const firstWeekDay = new Date(anchor.year, anchor.month - 1, anchor.day - wd);
    for (let i = 0; i < 7; i++) {
      const d = new Date(firstWeekDay);
      d.setDate(firstWeekDay.getDate() + i);
      out.push(dayKeyFromDate(d));
    }
    return out;
  }, [view, anchor]);

  function handlePrev() {
    if (view === "month") {
      setAnchor((a) => prevMonth(a));
    } else {
      const d = new Date(anchor.year, anchor.month - 1, anchor.day - 7);
      setAnchor(dayKeyFromDate(d));
    }
  }

  function handleNext() {
    if (view === "month") {
      setAnchor((a) => nextMonth(a));
    } else {
      const d = new Date(anchor.year, anchor.month - 1, anchor.day + 7);
      setAnchor(dayKeyFromDate(d));
    }
  }

  async function handleDragEnd(ev: DragEndEvent) {
    if (!ev.over) return;
    const broadcastId = String(ev.active.id);
    const targetKey = String(ev.over.id);
    const target = fromKey(targetKey);
    if (!target) return;
    const today = todayKey();
    if (compareKeys(target, today) < 0) {
      setError("Нельзя планировать в прошлое");
      return;
    }
    if (isException(target, exceptions)) {
      setError("Эта дата находится в календарном исключении");
      return;
    }
    const broadcast = items.find((b) => String(b.id) === broadcastId);
    if (!broadcast) return;
    const sourceIso =
      broadcast.next_run_at ?? broadcast.scheduled_for ?? null;
    if (!sourceIso) return;
    const sourceDate = new Date(sourceIso);
    const newDate = new Date(
      target.year,
      target.month - 1,
      target.day,
      sourceDate.getHours(),
      sourceDate.getMinutes(),
      sourceDate.getSeconds(),
    );
    if (newDate.getTime() <= Date.now()) {
      setError("Новая дата должна быть в будущем");
      return;
    }
    // Optimistic update
    setItems((prev) =>
      prev.map((it) =>
        it.id === broadcast.id
          ? {
              ...it,
              scheduled_for: newDate.toISOString(),
              next_run_at: newDate.toISOString(),
            }
          : it,
      ),
    );
    setError(null);
    try {
      await nxPatch(`/api/scheduled-broadcasts/${broadcast.id}`, {
        scheduled_for: newDate.toISOString(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось перенести");
      load(); // revert
    }
  }

  const headerLabel = useMemo(() => {
    if (view === "month") {
      return new Date(anchor.year, anchor.month - 1, 1).toLocaleDateString(
        "ru-RU",
        { month: "long", year: "numeric" },
      );
    }
    const start = days[0];
    const end = days[6];
    return `${pad2(start.day)}.${pad2(start.month)} – ${pad2(end.day)}.${pad2(end.month)}.${end.year}`;
  }, [view, anchor, days]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Предыдущий период"
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-surface text-text-muted hover:text-text hover:border-border-focus transition-colors"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(todayKey())}
            className="px-3 py-1.5 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:border-accent/40 transition-colors"
          >
            Сегодня
          </button>
          <button
            type="button"
            onClick={handleNext}
            aria-label="Следующий период"
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-surface text-text-muted hover:text-text hover:border-border-focus transition-colors"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
          </button>
          <span className="text-base font-semibold text-text capitalize ml-2">
            {headerLabel}
          </span>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-surface border border-border p-0.5">
          {(["month", "week"] as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                view === v
                  ? "bg-accent text-bg"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {v === "month" ? "Месяц" : "Неделя"}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-2.5 text-sm text-error flex items-center gap-2">
          <CalendarDays className="h-4 w-4 shrink-0" strokeWidth={2} />
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Загрузка…
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden text-xs">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
              <div
                key={d}
                className="bg-bg-elevated px-2 py-2 text-center font-semibold text-text-muted"
              >
                {d}
              </div>
            ))}
            {days.map((d) => (
              <CalendarCell
                key={toKey(d)}
                day={d}
                items={byDay.get(toKey(d)) ?? []}
                anchor={anchor}
                view={view}
                isException={isException(d, exceptions)}
                onPillClick={onPillClick}
              />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  );
}

function CalendarCell({
  day,
  items,
  anchor,
  view,
  isException,
  onPillClick,
}: {
  day: DayKey;
  items: BroadcastSummary[];
  anchor: DayKey;
  view: ViewMode;
  isException: boolean;
  onPillClick?: (b: BroadcastSummary) => void;
}) {
  const today = todayKey();
  const isToday = compareKeys(day, today) === 0;
  const isPast = compareKeys(day, today) < 0;
  const isCurrentMonth =
    view === "week" ||
    (day.year === anchor.year && day.month === anchor.month);
  const dayKey = toKey(day);
  const { setNodeRef, isOver } = useDroppable({ id: dayKey });

  return (
    <div
      ref={setNodeRef}
      className={`bg-bg min-h-[110px] p-2 space-y-1 transition-colors ${
        isCurrentMonth ? "" : "bg-bg-elevated/40"
      } ${isPast ? "opacity-60" : ""} ${
        isToday ? "ring-2 ring-accent ring-inset" : ""
      } ${isException ? "border-2 border-dashed border-warning/40" : ""} ${
        isOver ? "bg-accent/10" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-mono ${
            isToday
              ? "text-accent font-bold"
              : isCurrentMonth
                ? "text-text"
                : "text-text-muted"
          }`}
        >
          {day.day}
        </span>
        {items.length > 3 && (
          <span className="text-[10px] text-text-muted">+{items.length - 3}</span>
        )}
      </div>
      <div className="space-y-1">
        {items.slice(0, 3).map((it) => (
          <CalendarPill key={it.id} broadcast={it} onClick={onPillClick} />
        ))}
      </div>
    </div>
  );
}

function CalendarPill({
  broadcast,
  onClick,
}: {
  broadcast: BroadcastSummary;
  onClick?: (b: BroadcastSummary) => void;
}) {
  const draggable = DRAGGABLE_STATUSES.has(broadcast.status);
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: String(broadcast.id),
      disabled: !draggable,
    });
  const colorClass =
    STATUS_COLORS[broadcast.status] ?? STATUS_COLORS.scheduled;
  const ts = broadcast.next_run_at ?? broadcast.scheduled_for ?? null;
  const time = ts ? new Date(ts) : null;
  const recipientCount = Array.isArray(broadcast.contacts)
    ? broadcast.contacts.length
    : 0;
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return;
        e.stopPropagation();
        onClick?.(broadcast);
      }}
      title={`${broadcast.name?.trim() || `Рассылка #${broadcast.id}`}${
        time ? ` · ${time.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : ""
      } · ${recipientCount} получателей · ${broadcast.status}`}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        zIndex: isDragging ? 50 : undefined,
      }}
      className={`block w-full truncate text-left px-1.5 py-0.5 rounded text-[10px] border ${colorClass} ${
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
    >
      {time && (
        <span className="font-mono mr-1">
          {pad2(time.getHours())}:{pad2(time.getMinutes())}
        </span>
      )}
      <span className="truncate">
        {broadcast.name?.trim() || `#${broadcast.id}`}
      </span>
      {recipientCount > 0 && (
        <Users className="inline h-2.5 w-2.5 ml-1" strokeWidth={2.5} />
      )}
    </button>
  );
}
