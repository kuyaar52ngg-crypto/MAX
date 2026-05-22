"use client";

/**
 * `/dashboard/scheduled` — список запланированных рассылок.
 *
 * Показывает все ScheduledBroadcast пользователя в порядке статуса и
 * времени запуска. Каждая карточка — операция управления:
 *   - Пауза  / Возобновить (PATCH status)
 *   - Запустить сейчас (PATCH next_run_at = now)
 *   - Отменить (DELETE)
 *
 * Опросы /api/scheduled-broadcasts каждые 10 сек обеспечивают live-update
 * прогресса (статус, runs_count, last_run_at).
 */

import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Droplet,
  Globe2,
  Loader2,
  Moon,
  Play,
  Repeat,
  XCircle,
} from "lucide-react";
import Link from "next/link";

import { nxGet, nxPatch } from "@/lib/api";
import type { ScheduledBroadcastDTO, ScheduleStatus } from "@/lib/scheduled/types";
import { BroadcastControls } from "@/components/scheduling";

const STATUS_LABEL: Record<ScheduleStatus, { label: string; color: string }> = {
  scheduled: { label: "Запланирована", color: "text-blue-400 bg-blue-400/10" },
  running: { label: "Идёт сейчас", color: "text-accent bg-accent/10" },
  paused: { label: "На паузе", color: "text-yellow-500 bg-yellow-500/10" },
  done: { label: "Завершена", color: "text-success bg-success/10" },
  cancelled: { label: "Отменена", color: "text-text-muted bg-text-muted/10" },
  failed: { label: "Ошибка", color: "text-error bg-error/10" },
};

export default function ScheduledBroadcastsPage() {
  const [items, setItems] = useState<ScheduledBroadcastDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await nxGet<ScheduledBroadcastDTO[]>(
        "/api/scheduled-broadcasts",
      );
      setItems(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function runNow(item: ScheduledBroadcastDTO) {
    // Сдвигаем next_run_at в прошлое, чтобы scheduler подобрал на следующем tick.
    await nxPatch(`/api/scheduled-broadcasts/${item.id}`, {
      scheduled_for: new Date().toISOString(),
      status: "scheduled",
    });
    await load();
  }

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
            <CalendarClock className="h-5 w-5" strokeWidth={2.2} />
          </div>
          <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
            Запланированные рассылки
          </h1>
          <p className="text-text-muted text-sm mt-1">
            Однократные, drip-кампании, окна, smart-time и повторяющиеся
            рассылки. Планировщик в бэкенде проверяет очередь каждые 15 секунд.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/dashboard/scheduled/calendar"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:border-accent/40 transition-colors"
          >
            <CalendarDays className="h-4 w-4" strokeWidth={2} />
            Календарь
          </Link>
          <Link
            href="/dashboard/scheduled/awaiting-approval"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:border-accent/40 transition-colors"
          >
            <ClipboardCheck className="h-4 w-4" strokeWidth={2} />
            На одобрении
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Загрузка…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <CalendarClock
            className="mx-auto h-10 w-10 text-text-muted mb-3"
            strokeWidth={1.5}
          />
          <h3 className="text-base font-semibold text-text">
            Пока ничего не запланировано
          </h3>
          <p className="text-sm text-text-muted mt-1">
            Откройте «Рассылка», подготовьте сообщение и нажмите
            «Запланировать…» в меню кнопки старта.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ScheduledCard
              key={String(item.id)}
              item={item}
              onRunNow={() => runNow(item)}
              onChange={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  item: ScheduledBroadcastDTO;
  onRunNow(): void;
  onChange(): void;
}

function ScheduledCard({ item, onRunNow, onChange }: CardProps) {
  const status = STATUS_LABEL[item.status] ?? STATUS_LABEL.scheduled;
  const TypeIcon =
    item.schedule_type === "once"
      ? Clock
      : item.schedule_type === "drip"
        ? Droplet
        : Repeat;

  const typeLabel =
    item.schedule_type === "once"
      ? "Однократно"
      : item.schedule_type === "drip"
        ? "Drip"
        : "Повтор";

  const nextRun = item.next_run_at ? new Date(item.next_run_at) : null;
  const lastRun = item.last_run_at ? new Date(item.last_run_at) : null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <TypeIcon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-text truncate max-w-[320px]">
                {item.name?.trim() || `Рассылка #${item.id}`}
              </h3>
              <span
                className={`px-2 py-0.5 rounded-full text-xs ${status.color}`}
              >
                {status.label}
              </span>
              <span className="text-xs text-text-muted">{typeLabel}</span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {Array.isArray(item.contacts) ? item.contacts.length : 0}{" "}
              получателей
              {item.runs_count > 0 ? ` · запусков: ${item.runs_count}` : ""}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {item.status === "scheduled" && (
            <button
              type="button"
              onClick={onRunNow}
              className="px-3 py-1.5 rounded-lg text-xs bg-accent text-bg font-medium hover:bg-accent-hover transition-colors inline-flex items-center gap-1"
            >
              <Play className="h-3 w-3" strokeWidth={2.5} />
              Запустить сейчас
            </button>
          )}
          <BroadcastControls
            broadcastId={item.id}
            status={item.status}
            scheduledFor={item.scheduled_for}
            onChange={onChange}
          />
        </div>
      </div>

      <p className="text-sm text-text-secondary line-clamp-3 whitespace-pre-wrap break-words bg-bg-elevated/50 rounded-lg p-3">
        {item.message || (item.file_name ? `📎 ${item.file_name}` : "—")}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-text-muted">
        {nextRun && (
          <Stat
            icon={<CalendarClock className="h-3.5 w-3.5" strokeWidth={2} />}
            label="Следующий запуск"
            value={nextRun.toLocaleString()}
          />
        )}
        {lastRun && (
          <Stat
            icon={<CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />}
            label="Последний запуск"
            value={lastRun.toLocaleString()}
          />
        )}
        {item.schedule_type === "drip" && (
          <Stat
            icon={<Droplet className="h-3.5 w-3.5" strokeWidth={2} />}
            label="Прогресс drip"
            value={`Волна ${item.drip_wave_index + 1} · батч ${item.drip_batch_size ?? "?"} каждые ${item.drip_interval_minutes ?? "?"} мин`}
          />
        )}
        {item.schedule_type === "recurring" && (
          <Stat
            icon={<Repeat className="h-3.5 w-3.5" strokeWidth={2} />}
            label="Повторение"
            value={describeRecurring(item)}
          />
        )}
        {item.quiet_hours_enabled && (
          <Stat
            icon={<Moon className="h-3.5 w-3.5" strokeWidth={2} />}
            label="Тихие часы"
            value={`${pad2(item.quiet_hours_start)}:00 – ${pad2(item.quiet_hours_end)}:00${item.respect_recipient_tz ? " (по получателю)" : ""}`}
          />
        )}
        <Stat
          icon={<Globe2 className="h-3.5 w-3.5" strokeWidth={2} />}
          label="Таймзона"
          value={item.user_tz}
        />
      </div>

      {item.last_error && (
        <div className="rounded-lg border border-error/30 bg-error-bg/50 px-3 py-2 text-xs text-error flex gap-2">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" strokeWidth={2} />
          <span>{item.last_error}</span>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-bg-elevated/40 px-3 py-2 border border-border">
      <div className="flex items-center gap-1.5 text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-text mt-0.5 font-medium truncate">{value}</div>
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function describeRecurring(item: ScheduledBroadcastDTO): string {
  if (!item.recurring_kind) return "—";
  const time = `${pad2(item.recurring_hour ?? 0)}:${pad2(item.recurring_minute ?? 0)}`;
  if (item.recurring_kind === "daily") return `Ежедневно в ${time}`;
  if (item.recurring_kind === "weekly") {
    const dows = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    return `Каждую ${dows[item.recurring_day_of_week ?? 0]} в ${time}`;
  }
  return `Каждое ${item.recurring_day_of_month ?? 1} число в ${time}`;
}
