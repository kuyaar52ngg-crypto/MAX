"use client";

/**
 * `useQRRefresh` — циклит `GET /api/green-instances/[id]/qr` каждые 25 секунд
 * и сохраняет последний QR в state. На `alreadyLogged` вызывает `onAlreadyLogged`,
 * на `error` — останавливает цикл и зовёт `onError(message)`.
 *
 * Все таймеры и in-flight запросы корректно отменяются на размонтировании /
 * `enabled = false` — за < 1 сек (Requirement 3.7).
 */

import { useEffect, useRef, useState } from "react";

const DEFAULT_INTERVAL_MS = 25000;

export interface UseQRRefreshOptions {
  /** instanceId БД-записи. Если null — хук «спит». */
  instanceId: bigint | string | number | null;
  /** Если false — хук остановлен. Default true. */
  enabled?: boolean;
  /** Интервал между запросами в ms. Default 25000. */
  intervalMs?: number;
  /** Callback при `alreadyLogged`. */
  onAlreadyLogged: () => void;
  /** Callback при HTTP-ошибке или type=error. */
  onError: (message: string) => void;
}

export interface UseQRRefreshResult {
  /** base64 PNG без префикса `data:image/png;base64,`. */
  qrImageBase64: string | null;
  isFetching: boolean;
  /** ms epoch с сервера — для дебага race-conditions. */
  serverTimestamp: number | null;
  /** Принудительный перезапрос QR (например по клику кнопки «Обновить»). */
  refetch: () => void;
}

interface QRApiSuccess {
  type: "qrCode" | "alreadyLogged" | "error";
  message?: string;
  server_timestamp: number;
}

export function useQRRefresh(options: UseQRRefreshOptions): UseQRRefreshResult {
  const {
    instanceId,
    enabled = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    onAlreadyLogged,
    onError,
  } = options;

  const [qrImageBase64, setQrImageBase64] = useState<string | null>(null);
  const [serverTimestamp, setServerTimestamp] = useState<number | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [tick, setTick] = useState(0);

  // Refs для callbacks — стабильный effect-graph
  const onAlreadyLoggedRef = useRef(onAlreadyLogged);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onAlreadyLoggedRef.current = onAlreadyLogged;
    onErrorRef.current = onError;
  }, [onAlreadyLogged, onError]);

  useEffect(() => {
    if (!enabled || !instanceId) return;

    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchQR(): Promise<"continue" | "stop"> {
      setIsFetching(true);
      try {
        const res = await fetch(`/api/green-instances/${instanceId}/qr`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted || stopped) return "stop";

        if (!res.ok) {
          const body = await res
            .json()
            .catch(() => ({ error: res.statusText }));
          const message = (body as { error?: string }).error ?? res.statusText;
          onErrorRef.current(message);
          // Сетевые ошибки не останавливают цикл — на следующей итерации
          // попробуем снова. Но если сервер отвечает 4xx — есть смысл
          // прекратить, чтобы не молотить заведомо мёртвый эндпойнт.
          if (res.status >= 400 && res.status < 500) {
            return "stop";
          }
          return "continue";
        }

        const data = (await res.json()) as QRApiSuccess;
        if (controller.signal.aborted || stopped) return "stop";

        setServerTimestamp(data.server_timestamp);

        if (data.type === "qrCode" && data.message) {
          setQrImageBase64(data.message);
          return "continue";
        }
        if (data.type === "alreadyLogged") {
          onAlreadyLoggedRef.current();
          return "stop";
        }
        if (data.type === "error") {
          onErrorRef.current(data.message ?? "Ошибка получения QR-кода");
          return "stop";
        }
        return "continue";
      } catch (err: unknown) {
        if (controller.signal.aborted || stopped) return "stop";
        const isAbort =
          err instanceof DOMException && err.name === "AbortError";
        if (!isAbort) {
          onErrorRef.current(err instanceof Error ? err.message : "Ошибка сети");
        }
        return "continue";
      } finally {
        if (!controller.signal.aborted && !stopped) {
          setIsFetching(false);
        }
      }
    }

    let cancelled = false;
    (async () => {
      // Первый запрос — сразу.
      const next1 = await fetchQR();
      if (cancelled || next1 === "stop") return;

      function scheduleNext() {
        if (cancelled || stopped) return;
        timer = setTimeout(async () => {
          if (cancelled || stopped) return;
          const next = await fetchQR();
          if (next === "stop") return;
          scheduleNext();
        }, intervalMs);
      }
      scheduleNext();
    })();

    return () => {
      cancelled = true;
      stopped = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, instanceId, intervalMs, tick]);

  return {
    qrImageBase64,
    serverTimestamp,
    isFetching,
    refetch: () => setTick((t) => t + 1),
  };
}
