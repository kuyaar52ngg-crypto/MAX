"use client";

/**
 * `useStatePoll` — циклит `GET /api/green-instances/[id]/state` каждые 3 секунды.
 * При переходе в `authorized` вызывает `onAuthorized({ phone, sharedInstanceWarning })`.
 *
 * После 5 подряд HTTP-ошибок прекращает цикл и сообщает через `onError`.
 *
 * Дополнительно: pause при `document.visibilityState === "hidden"`,
 * resume при возврате во вкладку.
 */

import { useEffect, useRef, useState } from "react";
import type { InstanceStatus } from "@/lib/green-api";

const DEFAULT_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

export interface UseStatePollOptions {
  instanceId: bigint | string | number | null;
  enabled?: boolean;
  intervalMs?: number;
  onAuthorized: (snapshot: {
    phone: string | null;
    sharedInstanceWarning: boolean;
  }) => void;
  onTransition?: (from: InstanceStatus | null, to: InstanceStatus) => void;
  onError?: (message: string) => void;
}

export interface UseStatePollResult {
  currentStatus: InstanceStatus | null;
  lastError: string | null;
}

interface StateApiResponse {
  status: InstanceStatus;
  phone: string | null;
  shared_instance_warning: boolean;
}

export function useStatePoll(options: UseStatePollOptions): UseStatePollResult {
  const {
    instanceId,
    enabled = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    onAuthorized,
    onTransition,
    onError,
  } = options;

  const [currentStatus, setCurrentStatus] = useState<InstanceStatus | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const onAuthorizedRef = useRef(onAuthorized);
  const onTransitionRef = useRef(onTransition);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onAuthorizedRef.current = onAuthorized;
    onTransitionRef.current = onTransition;
    onErrorRef.current = onError;
  }, [onAuthorized, onTransition, onError]);

  useEffect(() => {
    if (!enabled || !instanceId) return;

    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;
    let prevStatus: InstanceStatus | null = null;
    let paused = false;

    async function fetchOnce(): Promise<"continue" | "stop"> {
      try {
        const res = await fetch(`/api/green-instances/${instanceId}/state`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted || stopped) return "stop";

        if (!res.ok) {
          consecutiveErrors += 1;
          const body = await res.json().catch(() => ({ error: res.statusText }));
          const message = (body as { error?: string }).error ?? res.statusText;
          setLastError(message);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            onErrorRef.current?.(message);
            return "stop";
          }
          return "continue";
        }
        consecutiveErrors = 0;
        setLastError(null);

        const data = (await res.json()) as StateApiResponse;
        if (controller.signal.aborted || stopped) return "stop";

        setCurrentStatus(data.status);
        if (prevStatus !== data.status) {
          onTransitionRef.current?.(prevStatus, data.status);
        }
        if (data.status === "authorized") {
          onAuthorizedRef.current({
            phone: data.phone,
            sharedInstanceWarning: data.shared_instance_warning,
          });
          return "stop";
        }
        prevStatus = data.status;
        return "continue";
      } catch (err: unknown) {
        if (controller.signal.aborted || stopped) return "stop";
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (isAbort) return "stop";
        consecutiveErrors += 1;
        const message = err instanceof Error ? err.message : "Ошибка сети";
        setLastError(message);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          onErrorRef.current?.(message);
          return "stop";
        }
        return "continue";
      }
    }

    let cancelled = false;
    function scheduleNext() {
      if (cancelled || stopped) return;
      timer = setTimeout(async () => {
        if (cancelled || stopped) return;
        if (paused) {
          scheduleNext();
          return;
        }
        const next = await fetchOnce();
        if (cancelled || next === "stop") return;
        scheduleNext();
      }, intervalMs);
    }

    (async () => {
      const next0 = await fetchOnce();
      if (cancelled || next0 === "stop") return;
      scheduleNext();
    })();

    function onVisChange() {
      paused = document.visibilityState === "hidden";
    }
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      cancelled = true;
      stopped = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [enabled, instanceId, intervalMs]);

  return { currentStatus, lastError };
}
