"use client";

/**
 * `QrPoller` — изолированный QR-блок второго шага CredentialsWizard.
 *
 * Делает две вещи в фоне:
 *   1. Каждые 50 секунд перезапрашивает QR через `/api/qr` (т.к. GREEN-API
 *      инвалидирует QR через ~1 минуту).
 *   2. Каждые 2 секунды дёргает `/api/status`, чтобы поймать переход
 *      stateInstance в `authorized` сразу после того, как пользователь
 *      отсканировал QR в MAX-приложении.
 *
 * При смене state на `authorized` вызывает `onAuthorized` — родительский
 * wizard переходит на success-step без ручных кликов пользователя.
 *
 * Все таймеры и EventSource'ы отчищаются на unmount, чтобы при возврате
 * на страницу или выходе из wizard'а не оставалось «висящих» fetch'ей.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { apiGet } from "@/lib/api";

/** Cколько секунд QR живёт перед обновлением. GREEN-API даёт ~60. */
const QR_TTL_SECONDS = 50;
/** Период polling state-а инстанса. */
const STATE_POLL_MS = 2_000;

export interface QrPollerProps {
  onAuthorized(): void;
  onStateChange?(state: string): void;
}

export function QrPoller({ onAuthorized, onStateChange }: QrPollerProps) {
  const [qrData, setQrData] = useState<string | null>(null);
  const [qrType, setQrType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(QR_TTL_SECONDS);
  const [loading, setLoading] = useState<boolean>(true);
  const [currentState, setCurrentState] = useState<string>("unknown");

  const cancelledRef = useRef(false);
  const onAuthorizedRef = useRef(onAuthorized);
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => {
    onAuthorizedRef.current = onAuthorized;
    onStateChangeRef.current = onStateChange;
  }, [onAuthorized, onStateChange]);

  async function fetchQr() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ type: string; data?: string }>("/api/qr");
      if (cancelledRef.current) return;
      setQrType(data.type);
      if (data.type === "qrCode" && data.data) {
        setQrData(data.data);
        setSecondsLeft(QR_TTL_SECONDS);
      } else if (data.type === "alreadyLogged") {
        setQrData(null);
        // Уже авторизован — сразу скажем родителю.
        onAuthorizedRef.current();
      } else {
        setQrData(null);
        setError("GREEN-API вернул неожиданный тип ответа. Проверьте credentials.");
      }
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Не удалось получить QR-код");
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    fetchQr();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Тикалка обратного отсчёта; по истечении — рефетч QR.
  useEffect(() => {
    if (loading || qrType !== "qrCode") return;
    const timer = setInterval(() => {
      setSecondsLeft((n) => {
        if (n <= 1) {
          fetchQr();
          return QR_TTL_SECONDS;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, qrType]);

  // Polling /api/status каждые 2 сек — ловим переход в authorized.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await apiGet<{ state: string }>("/api/status");
        if (cancelled) return;
        const state = data.state || "unknown";
        setCurrentState(state);
        onStateChangeRef.current?.(state);
        if (state === "authorized") {
          onAuthorizedRef.current();
        }
      } catch {
        // Сетевые сбои — игнор; на следующей итерации повторим.
      }
    };
    tick();
    const id = setInterval(tick, STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-4">
      {error && (
        <div className="px-4 py-3 bg-error-bg border border-error/20 rounded-xl text-error text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-3">
        <div className="relative flex h-72 w-72 items-center justify-center rounded-2xl border-2 border-border bg-white p-4">
          {loading && !qrData ? (
            <Loader2 className="h-10 w-10 animate-spin text-text-muted" strokeWidth={2} />
          ) : qrData ? (
            <img
              src={`data:image/png;base64,${qrData}`}
              alt="QR-код для авторизации"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="text-center text-sm text-text-muted">
              QR недоступен. Нажмите «Обновить».
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm text-text-muted">
          {qrType === "qrCode" && (
            <span>
              Обновится через{" "}
              <span className="text-text font-mono">{secondsLeft}</span> сек
            </span>
          )}
          <button
            type="button"
            onClick={fetchQr}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface hover:border-accent/40 transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              strokeWidth={2}
            />
            Обновить
          </button>
        </div>

        <div className="text-xs text-text-muted">
          Текущий статус инстанса:{" "}
          <span className="font-mono text-text">{currentState}</span>
        </div>
      </div>

      <div className="rounded-xl bg-bg-elevated border border-border p-4 text-sm text-text-secondary space-y-2">
        <div className="font-semibold text-text">Как авторизовать MAX:</div>
        <ol className="list-decimal list-inside space-y-1 text-text-muted">
          <li>Откройте приложение MAX на телефоне</li>
          <li>Перейдите в Настройки → Связанные устройства</li>
          <li>Нажмите «Привязать устройство» и отсканируйте QR выше</li>
          <li>
            Когда на экране появится зелёный экран — авторизация завершена
            автоматически
          </li>
        </ol>
      </div>
    </div>
  );
}

export default QrPoller;
