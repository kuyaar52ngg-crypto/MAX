"use client";

/**
 * `DiagnosticMessage` — единый компонент для отображения диагностических
 * сообщений: либо для `InstanceStatus`, либо для `DiagnosticErrorCode`.
 *
 * Variants:
 *   - inline: строка ошибки под полем
 *   - toast: всплывающее уведомление
 *   - banner: широкая полоса предупреждения
 */

import { AlertTriangle, Info, XCircle } from "lucide-react";
import {
  diagnosticTextFor,
  diagnosticTextForErrorCode,
} from "@/lib/green-api";
import type {
  DiagnosticErrorCode,
  InstanceStatus,
} from "@/lib/green-api";

export interface DiagnosticMessageProps {
  status?: InstanceStatus;
  errorCode?: DiagnosticErrorCode;
  customMessage?: string;
  variant?: "inline" | "toast" | "banner";
  className?: string;
}

export function DiagnosticMessage({
  status,
  errorCode,
  customMessage,
  variant = "inline",
  className,
}: DiagnosticMessageProps) {
  const text =
    customMessage ??
    (errorCode
      ? diagnosticTextForErrorCode(errorCode)
      : status
        ? diagnosticTextFor(status)
        : "");

  if (!text) return null;

  // Severity по статусу/коду — для выбора иконки и цвета.
  const severity = computeSeverity(status, errorCode);

  const Icon = severity === "error" ? XCircle : severity === "warning" ? AlertTriangle : Info;

  if (variant === "banner") {
    return (
      <div
        role={severity === "error" ? "alert" : "status"}
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${severityClasses(severity, "banner")} ${className ?? ""}`}
      >
        <Icon className="h-5 w-5 mt-0.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="text-sm">{text}</span>
      </div>
    );
  }

  if (variant === "toast") {
    return (
      <div
        role={severity === "error" ? "alert" : "status"}
        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm shadow-md ${severityClasses(severity, "toast")} ${className ?? ""}`}
      >
        <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        <span>{text}</span>
      </div>
    );
  }

  // inline
  return (
    <p
      role={severity === "error" ? "alert" : undefined}
      className={`flex items-start gap-1.5 text-xs ${severityClasses(severity, "inline")} ${className ?? ""}`}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function computeSeverity(
  status?: InstanceStatus,
  errorCode?: DiagnosticErrorCode,
): "info" | "warning" | "error" {
  if (errorCode) {
    if (errorCode === "invalid_credentials" || errorCode === "not_found")
      return "error";
    if (
      errorCode === "quota_exceeded" ||
      errorCode === "server_error" ||
      errorCode === "network_error" ||
      errorCode === "timeout" ||
      errorCode === "rate_limited"
    )
      return "warning";
    return "info";
  }
  if (!status) return "info";
  if (status === "blocked") return "error";
  if (status === "yellowCard" || status === "sleepMode") return "warning";
  if (status === "starting" || status === "notAuthorized" || status === "unknown")
    return "info";
  return "info";
}

function severityClasses(
  severity: "info" | "warning" | "error",
  variant: "inline" | "toast" | "banner",
): string {
  const base = {
    inline: {
      info: "text-text-muted",
      warning: "text-warning",
      error: "text-error",
    },
    toast: {
      info: "bg-bg-elevated border border-border text-text",
      warning: "bg-warning-bg border border-warning/30 text-warning",
      error: "bg-error-bg border border-error/30 text-error",
    },
    banner: {
      info: "bg-bg-elevated border-border text-text-secondary",
      warning: "bg-warning-bg border-warning/30 text-warning",
      error: "bg-error-bg border-error/30 text-error",
    },
  };
  return base[variant][severity];
}
