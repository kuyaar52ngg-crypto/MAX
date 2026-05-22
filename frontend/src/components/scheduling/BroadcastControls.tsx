"use client";

/**
 * `BroadcastControls` — набор кнопок управления рассылкой в зависимости от статуса.
 *
 * Показывает разные кнопки в зависимости от `status`:
 *   - scheduled         → Snooze, Запустить сейчас, Cancel
 *   - pending_approval  → Cancel (без Snooze/Pause/Resume)
 *   - running           → Pause, Cancel, Reschedule
 *   - paused            → Resume, Snooze, Cancel, Reschedule
 *   - terminal (done/cancelled/failed/completed/rejected) → ничего
 *
 * API:
 *   - `POST /api/scheduled-broadcasts/[id]/pause`
 *   - `POST /api/scheduled-broadcasts/[id]/resume`
 *   - `POST /api/scheduled-broadcasts/[id]/cancel`
 *   - `POST /api/scheduled-broadcasts/[id]/reschedule` (через RescheduleModal)
 *   - `POST /api/scheduled-broadcasts/[id]/snooze` (через SnoozeButton)
 */

import { useState } from "react";
import { Loader2, Pause, Play, RefreshCw, Trash2 } from "lucide-react";

import { nxPost } from "@/lib/api";

import { RescheduleModal } from "./RescheduleModal";
import { SnoozeButton } from "./SnoozeButton";

const TERMINAL_STATUSES = new Set([
  "done",
  "completed",
  "cancelled",
  "failed",
  "rejected",
]);

export interface BroadcastControlsProps {
  broadcastId: number | bigint | string;
  status: string;
  approvalStatus?: string;
  scheduledFor?: string | null;
  onChange?: () => void;
  className?: string;
}

export function BroadcastControls({
  broadcastId,
  status,
  approvalStatus,
  scheduledFor = null,
  onChange,
  className,
}: BroadcastControlsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  if (TERMINAL_STATUSES.has(status)) return null;

  async function call(action: "pause" | "resume" | "cancel") {
    if (action === "cancel") {
      const ok = window.confirm(
        "Отменить эту рассылку? Это действие нельзя отменить.",
      );
      if (!ok) return;
    }
    setBusy(action);
    setError(null);
    try {
      await nxPost(`/api/scheduled-broadcasts/${broadcastId}/${action}`, {});
      onChange?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    } finally {
      setBusy(null);
    }
  }

  // pending_approval — оператор не может pause/resume/reschedule, только
  // cancel и snooze (Req 11.11).
  if (status === "pending_approval" || approvalStatus === "pending") {
    return (
      <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
        <span className="inline-flex items-center gap-1 rounded-lg bg-warning-bg border border-warning/30 px-3 py-1.5 text-xs text-warning">
          На одобрении
        </span>
        <SnoozeButton
          broadcastId={broadcastId}
          status={status}
          onSnoozed={onChange}
        />
        <ControlButton
          variant="danger"
          busy={busy === "cancel"}
          onClick={() => call("cancel")}
        >
          <Trash2 className="h-3 w-3" strokeWidth={2.5} />
          Отменить
        </ControlButton>
        {error && <ErrorPill text={error} />}
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {status === "scheduled" && (
        <SnoozeButton
          broadcastId={broadcastId}
          status={status}
          onSnoozed={onChange}
        />
      )}
      {status === "scheduled" && (
        <ControlButton busy={busy === "pause"} onClick={() => call("pause")}>
          <Pause className="h-3 w-3" strokeWidth={2.5} />
          Пауза
        </ControlButton>
      )}
      {status === "running" && (
        <ControlButton busy={busy === "pause"} onClick={() => call("pause")}>
          <Pause className="h-3 w-3" strokeWidth={2.5} />
          Пауза
        </ControlButton>
      )}
      {status === "paused" && (
        <>
          <ControlButton
            variant="primary"
            busy={busy === "resume"}
            onClick={() => call("resume")}
          >
            <Play className="h-3 w-3" strokeWidth={2.5} />
            Возобновить
          </ControlButton>
          <SnoozeButton
            broadcastId={broadcastId}
            status={status}
            onSnoozed={onChange}
          />
        </>
      )}
      {(status === "running" || status === "paused") && (
        <ControlButton
          busy={busy === "reschedule"}
          onClick={() => setRescheduleOpen(true)}
        >
          <RefreshCw className="h-3 w-3" strokeWidth={2.5} />
          Перенести
        </ControlButton>
      )}
      <ControlButton
        variant="danger"
        busy={busy === "cancel"}
        onClick={() => call("cancel")}
      >
        <Trash2 className="h-3 w-3" strokeWidth={2.5} />
        Отменить
      </ControlButton>
      {error && <ErrorPill text={error} />}

      <RescheduleModal
        broadcastId={broadcastId}
        currentScheduledFor={scheduledFor}
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        onSuccess={() => onChange?.()}
      />
    </div>
  );
}

function ControlButton({
  busy = false,
  variant = "default",
  onClick,
  children,
}: {
  busy?: boolean;
  variant?: "default" | "primary" | "danger";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const klass =
    variant === "primary"
      ? "bg-accent text-bg font-medium hover:bg-accent-hover"
      : variant === "danger"
        ? "bg-bg-elevated border border-border text-error hover:border-error/40"
        : "bg-bg-elevated border border-border text-text-secondary hover:border-accent/40";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${klass}`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
      ) : null}
      {children}
    </button>
  );
}

function ErrorPill({ text }: { text: string }) {
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1 rounded-lg bg-error-bg border border-error/30 px-2 py-1 text-[11px] text-error"
    >
      {text}
    </span>
  );
}
