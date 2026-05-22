"use client";

/**
 * `InstanceStatusBadge` — цветной бейдж со статусом инстанса.
 * Tooltip-описание берётся из `diagnosticTextFor`.
 */

import { diagnosticTextFor } from "@/lib/green-api";
import type { InstanceStatus } from "@/lib/green-api";

const STATUS_LABELS: Record<InstanceStatus, string> = {
  authorized: "Активен",
  notAuthorized: "Не авторизован",
  starting: "Инициализация",
  yellowCard: "Жёлтая карточка",
  blocked: "Заблокирован",
  sleepMode: "Сон",
  unknown: "Неизвестно",
};

const STATUS_COLOR_CLASSES: Record<InstanceStatus, string> = {
  authorized: "bg-success/15 text-success border-success/30",
  starting: "bg-accent/15 text-accent border-accent/30",
  notAuthorized: "bg-bg-elevated text-text-muted border-border",
  yellowCard: "bg-warning-bg text-warning border-warning/30",
  sleepMode: "bg-bg-elevated text-text-muted border-border",
  blocked: "bg-error-bg text-error border-error/30",
  unknown: "bg-bg-elevated text-text-muted border-border",
};

export interface InstanceStatusBadgeProps {
  status: InstanceStatus;
  className?: string;
}

export function InstanceStatusBadge({ status, className }: InstanceStatusBadgeProps) {
  return (
    <span
      title={diagnosticTextFor(status)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_COLOR_CLASSES[status]} ${className ?? ""}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
