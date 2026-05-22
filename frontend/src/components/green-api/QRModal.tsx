"use client";

/**
 * `QRModal` — окно с QR-кодом и индикатором статуса инстанса.
 *
 * Внутри одновременно работают два цикла:
 *   - `useQRRefresh` обновляет PNG каждые 25 секунд;
 *   - `useStatePoll` опрашивает статус каждые 3 секунды.
 *
 * При смене статуса в `authorized` или type=`alreadyLogged` — закрываем
 * модалку и зовём `onAuthorized`. При manual close — оба цикла останавливаются
 * через `enabled=false` (cleanup эффектов завершает `AbortController.abort`
 * за < 1 секунды).
 */

import { useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";

import { useQRRefresh } from "@/lib/green-api/hooks/useQRRefresh";
import { useStatePoll } from "@/lib/green-api/hooks/useStatePoll";
import type { InstanceStatus } from "@/lib/green-api";

import { InstanceStatusBadge } from "./InstanceStatusBadge";
import { DiagnosticMessage } from "./DiagnosticMessage";

export interface QRModalProps {
  instanceId: bigint | string | number | null;
  open: boolean;
  /** Текст крупной шапки модалки. */
  title?: string;
  onAuthorized: (snapshot: {
    phone: string | null;
    sharedInstanceWarning: boolean;
  }) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}

export function QRModal({
  instanceId,
  open,
  title = "Авторизация MAX",
  onAuthorized,
  onClose,
  onError,
}: QRModalProps) {
  const [error, setError] = useState<string | null>(null);

  const handleQrError = (msg: string) => {
    setError(msg);
    onError?.(msg);
  };

  const handleStateError = (msg: string) => {
    setError(msg);
    onError?.(msg);
  };

  const handleAlreadyLogged = () => {
    onAuthorized({ phone: null, sharedInstanceWarning: false });
  };

  const { qrImageBase64, isFetching, refetch } = useQRRefresh({
    instanceId,
    enabled: open,
    onAlreadyLogged: handleAlreadyLogged,
    onError: handleQrError,
  });

  const { currentStatus } = useStatePoll({
    instanceId,
    enabled: open,
    onAuthorized,
    onError: handleStateError,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md mx-4 rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex flex-col items-center gap-3">
            <div className="relative flex h-72 w-72 items-center justify-center rounded-2xl border-2 border-border bg-white p-4 overflow-hidden">
              {qrImageBase64 ? (
                <img
                  src={`data:image/png;base64,${qrImageBase64}`}
                  alt="QR-код для авторизации MAX"
                  className="h-full w-full object-contain"
                />
              ) : (
                <Loader2
                  className="h-10 w-10 animate-spin text-text-muted"
                  strokeWidth={2}
                />
              )}
              {isFetching && qrImageBase64 && (
                <span className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] text-text-muted bg-bg-elevated/90 rounded px-1.5 py-0.5">
                  <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={2} />
                  обновление…
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted">Текущий статус:</span>
              <InstanceStatusBadge
                status={(currentStatus ?? "unknown") as InstanceStatus}
              />
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  refetch();
                }}
                disabled={isFetching}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-text-muted hover:border-accent/40 hover:text-text transition-colors disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
                  strokeWidth={2}
                />
                Обновить
              </button>
            </div>
          </div>

          {error && (
            <DiagnosticMessage variant="banner" customMessage={error} />
          )}

          <div className="rounded-xl bg-bg-elevated border border-border p-4 text-sm text-text-secondary space-y-2">
            <div className="font-semibold text-text">Как авторизовать MAX:</div>
            <ol className="list-decimal list-inside space-y-1 text-text-muted">
              <li>Откройте приложение MAX на телефоне</li>
              <li>Перейдите в Настройки → Связанные устройства</li>
              <li>Нажмите «Привязать устройство» и отсканируйте QR выше</li>
              <li>
                Авторизация сработает автоматически — модалка закроется сама
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
