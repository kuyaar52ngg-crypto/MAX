"use client";

/**
 * `SchedulingPreFlightModal` — модалка предпросмотра расписания для
 * НОВЫХ режимов (window / smart_time / ab_time / burst).
 *
 * Показывает:
 *   - количество получателей после дедупликации;
 *   - ETA первого и последнего сообщения (HH:MM в user_tz);
 *   - 24-bar histogram распределения по часам;
 *   - список warnings (тихие часы, calendar exceptions, лимиты, нездоровый инстанс).
 *
 * Расчёт делает чистая функция `runPreFlight` (mirror Python-стороны).
 * Бюджет 300ms — если не уложились, рендерим fallback message.
 */

import { useMemo } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";

import { runPreFlight } from "@/lib/scheduling/preflightEngine";
import type {
  AntiBanConfig,
  CalendarException,
  GreenInstance,
  PreFlightResult,
  ScheduledBroadcastDraft,
} from "@/lib/scheduling/types";

export interface SchedulingPreFlightModalProps {
  open: boolean;
  draft: ScheduledBroadcastDraft;
  antiBan: AntiBanConfig;
  exceptions: CalendarException[];
  instance: GreenInstance | null;
  /** Optional: per-recipient histogram for smart_time режима. */
  recipientHistograms?: Map<string, number[]>;
  /** Кнопка submitting на родителе (например, idle отправка). */
  submitting?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function SchedulingPreFlightModal({
  open,
  draft,
  antiBan,
  exceptions,
  instance,
  recipientHistograms,
  submitting = false,
  onConfirm,
  onClose,
}: SchedulingPreFlightModalProps) {
  const result = useMemo<PreFlightResult | null>(() => {
    if (!open) return null;
    try {
      return runPreFlight({
        draft,
        antiBan,
        exceptions,
        instance,
        recipientHistograms,
      });
    } catch (err) {
      console.warn("preflight failed", err);
      return null;
    }
  }, [open, draft, antiBan, exceptions, instance, recipientHistograms]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <CalendarClock className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text">
                Предпросмотр расписания
              </h2>
              <p className="text-xs text-text-muted">
                Режим: {scheduleTypeLabel(draft.schedule_type)}
              </p>
            </div>
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

        <div className="p-5 space-y-5">
          {result ? (
            <PreflightContent result={result} draft={draft} />
          ) : (
            <FallbackMessage />
          )}
        </div>

        <div className="sticky bottom-0 bg-bg/95 backdrop-blur-xl border-t border-border p-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-surface transition-colors"
          >
            Изменить
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-bg text-sm font-medium transition-all disabled:opacity-50 active:scale-95"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
            Подтвердить и запланировать
          </button>
        </div>
      </div>
    </div>
  );
}

function PreflightContent({
  result,
  draft,
}: {
  result: PreFlightResult;
  draft: ScheduledBroadcastDraft;
}) {
  const histogramMax = Math.max(1, ...result.histogram);

  // Дополнительная подсказка для window-режима (Req 1.11):
  // «N сообщений за X часов = одно сообщение каждые Y минут»
  const windowHint = useWindowHint(draft, result);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat
          label="Получателей"
          value={result.recipientCount.toLocaleString("ru-RU")}
        />
        <Stat label="ETA первого" value={result.firstSendEta || "—"} />
        <Stat label="ETA последнего" value={result.lastSendEta || "—"} />
      </div>

      {windowHint && (
        <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3 text-sm text-text-secondary">
          {windowHint}
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-text mb-2">
          Распределение по часам ({draft.user_tz || "UTC"})
        </h3>
        <div className="rounded-xl border border-border bg-bg-elevated p-4">
          <div className="flex items-end gap-1 h-24">
            {result.histogram.map((count, hour) => {
              const heightPct = (count / histogramMax) * 100;
              return (
                <div
                  key={hour}
                  className="flex-1 flex flex-col items-center justify-end gap-1"
                  title={`${pad2(hour)}:00 — ${count} сообщений`}
                >
                  <div className="w-full bg-accent/20 rounded-t-sm relative group">
                    <div
                      className="bg-accent rounded-t-sm transition-all"
                      style={{ height: `${Math.max(2, heightPct)}%`, minHeight: count > 0 ? 2 : 0 }}
                    />
                    {count > 0 && (
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-mono text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                        {count}
                      </span>
                    )}
                  </div>
                  <span className="text-[9px] font-mono text-text-muted">
                    {hour % 3 === 0 ? pad2(hour) : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Предупреждения</h3>
        {result.warnings.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
            Нет предупреждений — расписание безопасно
          </div>
        ) : (
          <ul className="space-y-2">
            {result.warnings.map((w, i) => (
              <li
                key={`${w.kind}-${i}`}
                className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning"
              >
                <AlertTriangle
                  className="h-3.5 w-3.5 mt-0.5 shrink-0"
                  strokeWidth={2}
                />
                <span>
                  {w.message}
                  {typeof w.affectedCount === "number" &&
                    ` (затронуто: ${w.affectedCount})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FallbackMessage() {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning-bg p-4 text-sm text-warning">
      Слишком много получателей для предпросмотра. Сократите список или
      продолжите без предпросмотра — расписание будет рассчитано на сервере.
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg-elevated border border-border px-4 py-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-lg font-semibold text-text mt-1">{value}</div>
    </div>
  );
}

function scheduleTypeLabel(t: string): string {
  switch (t) {
    case "window":
      return "Send Window — равномерное распределение в окне";
    case "smart_time":
      return "Smart-Time — лучший час для каждого получателя";
    case "ab_time":
      return "A/B Time — тестируем время отправки";
    case "burst":
      return "Burst — максимальная скорость";
    case "exact":
    case "once":
      return "Точное время";
    case "drip":
      return "Drip-кампания";
    case "recurring":
      return "Регулярная отправка";
    default:
      return t;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function useWindowHint(
  draft: ScheduledBroadcastDraft,
  result: PreFlightResult,
): string | null {
  if (draft.schedule_type !== "window") return null;
  if (!draft.send_window_start || !draft.send_window_end) return null;
  const a = new Date(draft.send_window_start).getTime();
  const b = new Date(draft.send_window_end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const totalSeconds = (b - a) / 1000;
  const hours = totalSeconds / 3600;
  const n = result.recipientCount;
  if (n <= 0) return null;
  const intervalMinutes = totalSeconds / n / 60;
  return `${n} сообщений за ${hours.toFixed(1)} часов = одно сообщение каждые ${intervalMinutes.toFixed(1)} минут`;
}
