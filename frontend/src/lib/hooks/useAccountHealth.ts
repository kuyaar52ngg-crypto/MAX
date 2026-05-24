"use client";

/**
 * `useAccountHealth` — pull-based хук для получения health-снимка
 * primary GREEN-API инстанса. Используется в `<PreFlightModal>` и
 * `<EnhancedScheduleModal>` для блокировки массовых операций
 * на нездоровом аккаунте.
 *
 * Polling 60 секунд пока компонент смонтирован — этого достаточно,
 * чтобы UI отображал свежие данные после ручного «Проверить сейчас».
 */

import { useCallback, useEffect, useState } from "react";

import { nxGet } from "@/lib/api";
import type { AccountHealthData } from "@/lib/anti-ban/health";

interface HealthApiResponse {
  primary: AccountHealthData | null;
  instances: AccountHealthData[];
}

export interface UseAccountHealthResult {
  primary: AccountHealthData | null;
  instances: AccountHealthData[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAccountHealth(
  pollMs: number = 60_000,
): UseAccountHealthResult {
  const [primary, setPrimary] = useState<AccountHealthData | null>(null);
  const [instances, setInstances] = useState<AccountHealthData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await nxGet<HealthApiResponse>("/api/instances/health");
      setPrimary(data.primary);
      setInstances(data.instances ?? []);
      setError(null);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Не удалось получить health";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (pollMs <= 0) return;
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return { primary, instances, loading, error, refetch: load };
}
