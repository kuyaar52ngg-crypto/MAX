"use client";

/**
 * `RescheduleModal` — окно перепланирования остатка рассылки на другое время.
 *
 * Backend:
 *   `POST /api/scheduled-broadcasts/[id]/reschedule` — атомарно создаёт
 *   новую `ScheduledBroadcast` со статусом `scheduled` и `parent_broadcast_id`
 *   = текущий, оригинал переходит в `completed`/`cancelled`.
 *
 * Доступно только для running/paused. Для completed/failed/cancelled — не
 * имеет смысла (нет pending получателей).
 */

import { useEffect, useState } from "react";
import { ArrowRight, CalendarClock, Loader2, X } from "lucide-react";

import { nxPost } from "@/lib/api";

export interface RescheduleModalProps {
  broadcastId: number | bigint | string;
  currentScheduledFor: string | null;
  open: boolean;
  onClose: () => void;
  onSuccess?: (newBroadcastId: number | null) => void;
}

interface RescheduleResponse {
  new_broadcast_id: number | null;
  original_status_after: string;
  pending_recipient_count: number;
}

function defaultDateTime(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function RescheduleModal({
  broadcastId,
  currentScheduledFor,
  open,
  onClose,
  onSuccess,
}: RescheduleModalProps) {
  const [scheduledFor, setScheduledFor] = useState(defaultDateTime(60));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (currentScheduledFor) {
      const cur = new Date(currentScheduledFor);
      if (!Number.isNaN(cur.getTime())) {
        const local = new Date(cur.getTime() - cur.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
        setScheduledFor(local);
        return;
      }
    }
    setScheduledFor(defaultDateTime(60));
  }, [open, currentScheduledFor]);

  if (!open) return null;

  async function submit() {
    setError(null);
    if (!scheduledFor) {
      setError("Укажите дату и время");
      return;
    }
    const dt = new Date(scheduledFor);
    if (!Number.isFinite(dt.getTime())) {
      setError("Некорректная дата");
      return;
    }
    if (dt.getTime() <= Date.now()) {
      setError("Дата должна быть в будущем");
      return;
    }
    setSubmitting(true);
    try {
      const res = await nxPost<RescheduleResponse>(
        `/api/scheduled-broadcasts/${broadcastId}/reschedule`,
        { scheduled_for: dt.toISOString() },
      );
      onSuccess?.(res.new_broadcast_id);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось перепланировать");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <CalendarClock className="h-5 w-5" strokeWidth={2} />
            </div>
            <h2 className="text-base font-semibold text-text">
              Перенести рассылку
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="p-5 space-y-4"
        >
          <p className="text-xs text-text-muted">
            Будет создана новая рассылка с теми же текстом, файлом и
            настройками — но только для тех получателей, которые ещё не
            получили сообщение. Оригинал переведётся в «completed».
          </p>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Новая дата и время
            </label>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
            />
          </div>
          {error && (
            <p className="text-xs text-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              ) : (
                <ArrowRight className="h-4 w-4" strokeWidth={2} />
              )}
              Перенести
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
