"use client";

/**
 * `NotificationCenter` — dropdown в header с иконкой колокольчика
 * + бейдж количества непрочитанных + список последних 20 уведомлений.
 *
 * Источник данных — `GET /api/notifications`, polling каждые 15 секунд.
 * `markRead(id)` ставит read_at = now через `POST /api/notifications/[id]/read`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  Sparkles,
  Square,
  Timer,
  XCircle,
} from "lucide-react";

import { nxGet, nxPost } from "@/lib/api";
import type {
  NotificationEventKind,
  NotificationView,
} from "@/lib/scheduling/types";

const POLL_INTERVAL_MS = 15_000;
const DROPDOWN_LIMIT = 20;

const KIND_META: Record<
  NotificationEventKind,
  { icon: typeof Bell; label: string; tone: "info" | "success" | "warning" | "error" }
> = {
  scheduled: { icon: Calendar, label: "Запланировано", tone: "info" },
  started: { icon: Play, label: "Стартовала", tone: "info" },
  paused: { icon: Pause, label: "Поставлена на паузу", tone: "warning" },
  resumed: { icon: Play, label: "Возобновлена", tone: "info" },
  completed: { icon: CheckCircle2, label: "Завершена", tone: "success" },
  failed: { icon: XCircle, label: "Ошибка", tone: "error" },
  anti_ban_threshold: { icon: AlertTriangle, label: "Anti-ban порог", tone: "warning" },
  awaiting_approval: { icon: Square, label: "Ожидает одобрения", tone: "warning" },
  ab_time_completed: { icon: Sparkles, label: "AB-Time тест завершён", tone: "success" },
  auto_snoozed: { icon: Timer, label: "Авто-снуз", tone: "warning" },
};

const TONE_CLASSES = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
} as const;

interface NotificationApiResponse {
  items: NotificationView[];
  unread_count: number;
}

export function NotificationCenter() {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await nxGet<NotificationApiResponse>("/api/notifications");
      setItems((data.items ?? []).slice(0, DROPDOWN_LIMIT));
      setUnreadCount(data.unread_count ?? 0);
    } catch {
      // network error — silent retry на следующем тике
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Закрытие по клику вне.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function markRead(id: number) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && !it.readAt
          ? { ...it, readAt: new Date().toISOString() }
          : it,
      ),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await nxPost(`/api/notifications/${id}/read`, {});
    } catch {
      // на сбое перезагрузим, чтобы вернуть консистентное состояние
      load();
    }
  }

  async function markAllRead() {
    const unread = items.filter((it) => !it.readAt).map((it) => it.id);
    setItems((prev) =>
      prev.map((it) =>
        it.readAt ? it : { ...it, readAt: new Date().toISOString() },
      ),
    );
    setUnreadCount(0);
    await Promise.allSettled(
      unread.map((id) => nxPost(`/api/notifications/${id}/read`, {})),
    );
  }

  const hasUnread = unreadCount > 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          hasUnread
            ? `Уведомления: ${unreadCount} непрочитанных`
            : "Уведомления"
        }
        aria-expanded={open}
        className="relative inline-flex items-center justify-center h-9 w-9 rounded-xl border border-border bg-surface text-text-muted hover:text-text hover:border-border-focus transition-colors"
      >
        <Bell className="h-4 w-4" strokeWidth={2} />
        {hasUnread && (
          <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-[10px] font-bold text-bg">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-[80] mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-text">Уведомления</span>
            {hasUnread && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-accent hover:underline"
              >
                Отметить все
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                Уведомлений пока нет
              </div>
            ) : (
              <ul>
                {items.map((it) => (
                  <NotificationRow
                    key={it.id}
                    item={it}
                    onMarkRead={() => markRead(it.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  item,
  onMarkRead,
}: {
  item: NotificationView;
  onMarkRead: () => void;
}) {
  const meta = KIND_META[item.kind] ?? {
    icon: Bell,
    label: item.kind,
    tone: "info" as const,
  };
  const Icon = meta.icon;
  const summary = useMemo(() => formatPayload(item), [item]);
  const isUnread = !item.readAt;

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={() => isUnread && onMarkRead()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && isUnread) {
          e.preventDefault();
          onMarkRead();
        }
      }}
      className={`flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 transition-colors cursor-pointer ${
        isUnread ? "bg-accent/5 hover:bg-accent/10" : "hover:bg-bg-elevated"
      }`}
    >
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-lg bg-bg-elevated ${TONE_CLASSES[meta.tone]}`}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text">{meta.label}</span>
          {isUnread && (
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          )}
        </div>
        {summary && (
          <p className="text-xs text-text-muted mt-0.5 line-clamp-2">
            {summary}
          </p>
        )}
        <p className="text-[10px] text-text-muted mt-0.5 inline-flex items-center gap-1">
          <Clock className="h-3 w-3" strokeWidth={2} />
          {formatRelativeTime(item.createdAt)}
        </p>
      </div>
    </li>
  );
}

function formatPayload(item: NotificationView): string {
  const p = item.payload;
  switch (item.kind) {
    case "scheduled": {
      const sf = (p.scheduled_for as string) || "";
      const at = sf ? ` на ${new Date(sf).toLocaleString("ru-RU")}` : "";
      return `Рассылка #${p.broadcast_id ?? "?"}${at}`;
    }
    case "started":
      return `Стартовала рассылка #${p.broadcast_id ?? "?"}`;
    case "paused":
      return `Рассылка #${p.broadcast_id ?? "?"} поставлена на паузу`;
    case "resumed":
      return `Рассылка #${p.broadcast_id ?? "?"} возобновлена`;
    case "completed":
      return `Рассылка #${p.broadcast_id ?? "?"} завершена`;
    case "failed":
      return `Рассылка #${p.broadcast_id ?? "?"}: ${p.reason ?? "ошибка"}`;
    case "auto_snoozed":
      return `Рассылка #${p.broadcast_id ?? "?"} автоматически приостановлена на ${p.minutes ?? "?"} мин`;
    case "anti_ban_threshold":
      return `Достигнут порог анти-бана: ${p.kind ?? "?"}`;
    case "awaiting_approval": {
      const count = p.recipient_count ?? "?";
      return `Запрос одобрения рассылки #${p.broadcast_id ?? "?"} на ${count} получателей`;
    }
    case "ab_time_completed":
      return `AB-Time тест #${p.test_id ?? "?"} определил победителя: ${p.winner_slot ?? "?"}:00`;
    default:
      return "";
  }
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(t).toLocaleString("ru-RU");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return new Date(t).toLocaleDateString("ru-RU");
}
