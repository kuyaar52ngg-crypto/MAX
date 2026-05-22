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
 *
 * UI:
 *   - на ≥lg-экранах рендерим полный `StateBadge` с текстом;
 *   - на узких — компактный цветной dot с tooltip-ом (хедер итак тесный
 *     из-за 7 пунктов меню + NotificationCenter + UserMenu).
 */

import { useEffect, useState } from "react";

import { StateBadge } from "@/components/anti-ban/StateBadge";
import type { InstanceState } from "@/lib/anti-ban";

// Базовый адрес Flask backend. Совпадает с `API_BASE` в
// `lib/hooks/useBulkOperation.ts` и `lib/api.ts`, чтобы fetch и SSE
// уходили на тот же origin, а не на Next.js dev-сервер.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

const STATE_LABELS: Record<InstanceState, string> = {
  authorized: "Авторизован",
  yellowCard: "Yellow card",
  blocked: "Заблокирован",
  notAuthorized: "Не авторизован",
  starting: "Запускается",
  sleepMode: "Сон",
  unknown: "Неизвестно",
};

const STATE_DOT_COLORS: Record<InstanceState, string> = {
  authorized: "bg-green-500",
  yellowCard: "bg-yellow-500",
  blocked: "bg-red-500",
  notAuthorized: "bg-red-500",
  starting: "bg-blue-500",
  sleepMode: "bg-blue-500",
  unknown: "bg-gray-400",
};

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

  const label = STATE_LABELS[state] ?? state;
  const dotColor = STATE_DOT_COLORS[state] ?? STATE_DOT_COLORS.unknown;

  return (
    <>
      {/* Компактный dot для узких экранов */}
      <span
        role="status"
        aria-label={`Instance state: ${label}`}
        title={label}
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-surface lg:hidden"
      >
        <span className={`h-2 w-2 rounded-full ${dotColor}`} aria-hidden="true" />
      </span>
      {/* Полный бейдж с текстом — только на ≥lg */}
      <span className="hidden lg:inline-flex">
        <StateBadge state={state} />
      </span>
    </>
  );
}

export default HeaderStateBadge;
