"use client";

/**
 * Бейдж состояния инстанса для шапки дашборда (Requirements 3.1, 3.2).
 *
 * При монтировании:
 *   1. Однократно тянет начальное значение через `GET /api/status`
 *      (Flask отдаёт `{ state, broadcast_active }` — см. `app.py`).
 *   2. Подписывается на SSE-канал `/api/check-contacts/progress`,
 *      где `StateMonitor` (см. `anti_ban/state_monitor.py`) рассылает
 *      события `{ type: "state", value: <Instance_State> }` всем
 *      подписчикам — этого достаточно для шапки, т.к. `StateMonitor`
 *      пишет одинаковое состояние в оба progress-канала.
 *
 * Ошибки сети не сбрасывают последнее известное состояние, чтобы
 * шапка не моргала при кратковременных разрывах соединения.
 */

import { useEffect, useState } from "react";

import { StateBadge } from "@/components/anti-ban/StateBadge";
import type { InstanceState } from "@/lib/anti-ban";

// Базовый адрес Flask backend. Совпадает с `API_BASE` в
// `lib/hooks/useBulkOperation.ts` и `lib/api.ts`, чтобы fetch и SSE
// уходили на тот же origin, а не на Next.js dev-сервер.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export function HeaderStateBadge() {
  const [state, setState] = useState<InstanceState>("unknown");

  useEffect(() => {
    let cancelled = false;

    // ── 1. Начальное значение из /api/status ───────────────────────
    fetch(`${API_BASE}/api/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { state?: string } | null) => {
        if (!cancelled && data && typeof data.state === "string") {
          setState(data.state as InstanceState);
        }
      })
      .catch(() => {
        // Игнорируем — оставляем "unknown" до первого SSE-эвента.
      });

    // ── 2. Подписка на SSE для живых обновлений ────────────────────
    const sse = new EventSource(
      `${API_BASE}/api/check-contacts/progress`,
    );

    sse.onmessage = (event: MessageEvent) => {
      try {
        const obj = JSON.parse(event.data) as {
          type?: string;
          value?: unknown;
        };
        if (obj?.type === "state" && typeof obj.value === "string") {
          setState(obj.value as InstanceState);
        }
      } catch {
        // Невалидный JSON — игнорируем тик, не трогаем состояние.
      }
    };

    sse.onerror = () => {
      // Сетевые сбои не сбрасывают последнее известное состояние:
      // браузер сам переоткроет EventSource, а до тех пор показываем
      // последний валидный бейдж.
    };

    return () => {
      cancelled = true;
      sse.close();
    };
  }, []);

  return <StateBadge state={state} />;
}

export default HeaderStateBadge;
