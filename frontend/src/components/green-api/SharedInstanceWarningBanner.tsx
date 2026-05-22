"use client";

/**
 * `SharedInstanceWarningBanner` — предупреждение о том, что инстанс
 * используется и другими (есть webhookUrl или outgoingWebhook=yes).
 *
 * Точный текст — Requirement 10.3.
 */

import { AlertTriangle, X } from "lucide-react";

export interface SharedInstanceWarningBannerProps {
  visible: boolean;
  onDismiss?: () => void;
  className?: string;
}

export function SharedInstanceWarningBanner({
  visible,
  onDismiss,
  className,
}: SharedInstanceWarningBannerProps) {
  if (!visible) return null;
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 ${className ?? ""}`}
    >
      <AlertTriangle
        className="h-5 w-5 mt-0.5 shrink-0 text-warning"
        strokeWidth={2}
        aria-hidden="true"
      />
      <div className="flex-1 text-sm text-warning">
        Этот инстанс используется и другими пользователями. Не меняйте
        настройки webhook без согласования с владельцем.
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Скрыть предупреждение"
          className="text-warning/70 hover:text-warning transition-colors"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
