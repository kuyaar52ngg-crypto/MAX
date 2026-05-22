"use client";

/**
 * `SnoozeButton` — dropdown «Перенести на …» с пресетами.
 *
 * При клике делает POST `/api/scheduled-broadcasts/[id]/snooze`.
 * На успех вызывает `onSnoozed(newScheduledFor)` — родитель оптимистично
 * обновляет state. На ошибку показывает toast в DiagnosticMessage.
 */

import { useState } from "react";
import { Clock, Loader2, Moon } from "lucide-react";

import { nxPost } from "@/lib/api";
import {
  SNOOZE_CUSTOM_MAX_MINUTES,
  SNOOZE_CUSTOM_MIN_MINUTES,
} from "@/lib/scheduling/snoozePresets";

const TERMINAL_STATUSES = new Set([
  "done",
  "completed",
  "cancelled",
  "failed",
  "rejected",
]);

const PRESETS = [
  { id: "1h", label: "+ 1 час" },
  { id: "1d", label: "+ 1 день" },
  { id: "7d", label: "+ 7 дней" },
  { id: "next_business_day", label: "Следующий рабочий день" },
] as const;

export interface SnoozeButtonProps {
  broadcastId: number | bigint | string;
  /** Статус рассылки. Disabled, если статус терминальный. */
  status: string;
  /** Optional callback — родитель может оптимистично обновить state. */
  onSnoozed?: (newScheduledFor: string) => void;
  /** Custom-минуты по умолчанию (для удобства тестов). */
  defaultCustomMinutes?: number;
  className?: string;
}

interface SnoozeResponse {
  ok: boolean;
  scheduled_for: string | null;
  next_run_at: string | null;
  adjusted_for_quiet_hours: boolean;
}

export function SnoozeButton({
  broadcastId,
  status,
  onSnoozed,
  defaultCustomMinutes = 30,
  className,
}: SnoozeButtonProps) {
  const disabled = TERMINAL_STATUSES.has(status);
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(defaultCustomMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyPreset(preset: string, custom?: number) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { preset };
      if (preset === "custom" && typeof custom === "number") {
        body.custom_minutes = custom;
      }
      const res = await nxPost<SnoozeResponse>(
        `/api/scheduled-broadcasts/${broadcastId}/snooze`,
        body,
      );
      if (res.scheduled_for) onSnoozed?.(res.scheduled_for);
      setOpen(false);
      setCustomOpen(false);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Не удалось перенести";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`relative inline-block ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
        className="inline-flex items-center gap-1 rounded-lg bg-bg-elevated border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-50"
        title={
          disabled
            ? "Перенос недоступен для завершённых/отменённых рассылок"
            : "Перенести рассылку"
        }
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
        ) : (
          <Moon className="h-3 w-3" strokeWidth={2.5} />
        )}
        Перенести
      </button>
      {open && (
        <>
          {/* overlay чтобы клик за пределами закрывал dropdown */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => {
              setOpen(false);
              setCustomOpen(false);
            }}
          />
          <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-border bg-surface shadow-lg overflow-hidden">
            {customOpen ? (
              <div className="p-3 space-y-2">
                <label className="block text-xs text-text-muted">
                  На сколько минут (1–{SNOOZE_CUSTOM_MAX_MINUTES})
                </label>
                <input
                  type="number"
                  min={SNOOZE_CUSTOM_MIN_MINUTES}
                  max={SNOOZE_CUSTOM_MAX_MINUTES}
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(Number(e.target.value) || 0)}
                  autoFocus
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                />
                {error && (
                  <p className="text-xs text-error">{error}</p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setCustomOpen(false)}
                    className="px-3 py-1.5 text-xs text-text-muted hover:text-text"
                  >
                    Назад
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !Number.isInteger(customMinutes) ||
                      customMinutes < SNOOZE_CUSTOM_MIN_MINUTES ||
                      customMinutes > SNOOZE_CUSTOM_MAX_MINUTES
                    }
                    onClick={() => applyPreset("custom", customMinutes)}
                    className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-bg text-xs font-medium rounded-lg transition-all disabled:opacity-50"
                  >
                    Применить
                  </button>
                </div>
              </div>
            ) : (
              <ul className="py-1">
                {PRESETS.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => applyPreset(p.id)}
                      className="w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text transition-colors flex items-center gap-2"
                    >
                      <Clock className="h-3.5 w-3.5 text-text-muted" strokeWidth={2} />
                      {p.label}
                    </button>
                  </li>
                ))}
                <li className="border-t border-border">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setCustomOpen(true);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text transition-colors"
                  >
                    Своё значение…
                  </button>
                </li>
                {error && (
                  <li className="px-4 py-2 text-xs text-error border-t border-border">
                    {error}
                  </li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
