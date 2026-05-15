"use client";

/**
 * Хук для управления массовой операцией (`Bulk_Operation`) на стороне UI.
 *
 * Реализует Requirements 5.6 и 5.7 (см. `.kiro/specs/anti-ban-protection`):
 *
 * 5.6 — при получении SSE-события `{ finished: true }` или ошибке/закрытии
 *       SSE локальный флаг `active` сбрасывается в `false` в течение 1 секунды.
 * 5.7 — если SSE-канал не получает ни сообщения, ни heartbeat в течение
 *       `Anti_Ban_Config.sse_client_timeout_seconds` секунд (дефолт 60),
 *       соединение закрывается, флаг сбрасывается, пользователю показывается
 *       сообщение об ошибке таймаута.
 *
 * Дизайн (`design.md`, секция «Хук `useBulkOperation`»):
 *   - state: `active`, `progress`, `state`, `operationRunId`;
 *   - `start(payload, options?)` — POST на `/api/check-contacts-bulk` или
 *     `/api/broadcast`, после успешного ответа открывает SSE на
 *     `/api/check-contacts/progress` или `/api/broadcast/progress`;
 *   - `stop()` — POST на `/api/bulk-operation/stop` с `operation_run_id`;
 *   - SSE-событие `{ type: "state", value: <Instance_State> }` обновляет
 *     отдельное поле `state` (см. `StateMonitor` в `anti_ban/state_monitor.py`).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { InstanceState } from "@/lib/anti-ban";

/** Тип массовой операции. */
export type BulkKind = "check" | "broadcast";

/**
 * Снапшот прогресса. SSE-канал отдаёт произвольную JSON-структуру
 * (на разных тиках разные ключи: `phone`/`status`/`exists`/...). Мы
 * фиксируем только обязательные `done`/`total` и оставляем остальное
 * как открытый словарь — потребители (страницы dashboard) сами читают
 * нужные ключи.
 */
export interface BulkProgress {
  done: number;
  total: number;
  [key: string]: unknown;
}

export interface StartOptions {
  /**
   * Переопределить адрес запуска (по умолчанию: `/api/check-contacts-bulk`
   * для `check`, `/api/broadcast` для `broadcast`). Полезно, если
   * фронтенд хочет подменить путь на проксированный или абсолютный URL.
   */
  endpoint?: string;
  /**
   * Дополнительные заголовки запроса (например, `X-Green-Api-*` в
   * соответствии с `getFlaskHeaders` из `lib/api.ts`).
   */
  headers?: Record<string, string>;
  /**
   * Если эндпойнт принимает `multipart/form-data` (рассылка с
   * вложением — `/api/broadcast`), передайте `FormData` сюда вместо
   * `payload`. В этом случае `Content-Type` НЕ выставляется вручную,
   * чтобы браузер сам сформировал boundary.
   */
  formData?: FormData;
  /**
   * Таймаут heartbeat в секундах (Requirement 5.7). По умолчанию 60,
   * что соответствует `Anti_Ban_Config.sse_client_timeout_seconds`.
   */
  heartbeatTimeoutSeconds?: number;
}

export interface BulkOperationApi {
  active: boolean;
  progress: BulkProgress | null;
  state: InstanceState;
  operationRunId: number | null;
  error: string | null;
  start: (payload: unknown, options?: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
}

// Пути SSE-каналов прогресса (см. design.md, таблица «API»). Имена
// каналов совпадают с полем `RunHandle.kind` в `anti_ban.registry`.
const PROGRESS_PATH: Record<BulkKind, string> = {
  check: "/api/check-contacts/progress",
  broadcast: "/api/broadcast/progress",
};

// Пути запуска массовой операции по умолчанию.
const START_PATH: Record<BulkKind, string> = {
  check: "/api/check-contacts-bulk",
  broadcast: "/api/broadcast",
};

// Таймаут heartbeat по умолчанию (Requirement 5.7).
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 60;

// Endpoint остановки одинаков для обоих типов операций
// (`POST /api/bulk-operation/stop`, см. design.md → API).
const STOP_PATH = "/api/bulk-operation/stop";

// Базовый адрес Flask backend. Совпадает с `API_BASE` в `lib/api.ts`,
// чтобы SSE и POST уходили на тот же origin, а не на Next.js dev-сервер.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

/** Дописывает `API_BASE`, если путь относительный. */
function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE}${pathOrUrl}`;
}

/**
 * Хук-хелпер для управления массовой операцией. Возвращает удобный
 * фасад поверх REST + SSE; вся логика автосброса флага `active` (через
 * `{finished:true}`, ошибку SSE, закрытие соединения и heartbeat
 * таймаут) сосредоточена здесь — страницы дашборда не должны
 * дублировать её.
 */
export function useBulkOperation(kind: BulkKind): BulkOperationApi {
  const [active, setActive] = useState<boolean>(false);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [state, setState] = useState<InstanceState>("unknown");
  const [operationRunId, setOperationRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SSE-источник и heartbeat-таймер живут в ref-ах, чтобы их можно было
  // закрывать как из обработчиков событий, так и при размонтировании
  // компонента (cleanup в useEffect).
  const eventSourceRef = useRef<EventSource | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const heartbeatTimeoutMsRef = useRef<number>(
    DEFAULT_HEARTBEAT_TIMEOUT_SECONDS * 1000,
  );

  // Дополнительный ref на operationRunId — нужен внутри стабильного
  // `stop`, чтобы не пересоздавать callback на каждое обновление id и
  // при этом всегда видеть актуальное значение.
  const operationRunIdRef = useRef<number | null>(null);

  /** Закрыть SSE и снять heartbeat-таймер; идемпотентен. */
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  /**
   * Пере-арм heartbeat-таймера. Вызывается на каждое успешно
   * принятое SSE-сообщение или ping-комментарий. По истечении
   * таймера (Requirement 5.7) — закрываем соединение, ставим
   * `active = false` и сообщаем об ошибке таймаута.
   */
  const resetHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearTimeout(heartbeatTimerRef.current);
    }
    heartbeatTimerRef.current = setTimeout(() => {
      setError(
        "Соединение с сервером прервано: не получено heartbeat за отведённое время.",
      );
      setActive(false);
      cleanup();
    }, heartbeatTimeoutMsRef.current);
  }, [cleanup]);

  // Гарантированный cleanup при размонтировании компонента:
  // зависший SSE не должен жить дольше владеющего его компонента.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const start = useCallback(
    async (payload: unknown, options: StartOptions = {}): Promise<void> => {
      // Сбрасываем артефакты предыдущего запуска (если был).
      cleanup();
      setError(null);
      setProgress(null);
      setState("unknown");
      setOperationRunId(null);
      operationRunIdRef.current = null;

      const endpoint = resolveUrl(options.endpoint ?? START_PATH[kind]);
      const heartbeatSeconds =
        options.heartbeatTimeoutSeconds ?? DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
      heartbeatTimeoutMsRef.current = heartbeatSeconds * 1000;

      // ── 1. POST на endpoint запуска ────────────────────────────────
      let response: Response;
      try {
        if (options.formData) {
          // multipart/form-data: Content-Type выставляет браузер.
          response = await fetch(endpoint, {
            method: "POST",
            body: options.formData,
            headers: options.headers,
          });
        } else {
          response = await fetch(endpoint, {
            method: "POST",
            body: JSON.stringify(payload ?? {}),
            headers: {
              "Content-Type": "application/json",
              ...(options.headers ?? {}),
            },
          });
        }
      } catch (err) {
        setError(`Ошибка запроса: ${(err as Error).message}`);
        return;
      }

      if (!response.ok) {
        let body = `HTTP ${response.status}`;
        try {
          const json = (await response.json()) as { error?: string };
          body = json.error ?? JSON.stringify(json);
        } catch {
          // Тело не JSON — оставим только код статуса.
        }
        setError(body);
        return;
      }

      // ── 2. operation_run_id из ответа ──────────────────────────────
      let runId: number | null = null;
      try {
        const data = (await response.json()) as {
          operation_run_id?: number;
        };
        if (typeof data?.operation_run_id === "number") {
          runId = data.operation_run_id;
        }
      } catch {
        // Тело может быть пустым — не ошибка для старта.
      }
      setOperationRunId(runId);
      operationRunIdRef.current = runId;
      setActive(true);

      // ── 3. Открыть SSE прогресса ────────────────────────────────────
      const sse = new EventSource(resolveUrl(PROGRESS_PATH[kind]));
      eventSourceRef.current = sse;
      resetHeartbeat();

      sse.onmessage = (event: MessageEvent) => {
        // Любое полученное сообщение продлевает heartbeat-таймер
        // (Requirement 5.7).
        resetHeartbeat();

        let data: Record<string, unknown> | null = null;
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!data) return;

        // Событие смены `Instance_State` (`StateMonitor`):
        // `{ "type": "state", "value": "<state>" }`.
        if (data.type === "state" && typeof data.value === "string") {
          setState(data.value as InstanceState);
          return;
        }

        // Прогресс батча: ожидаем как минимум `done`/`total` или
        // финальное `finished: true`.
        if (typeof data.done === "number" && typeof data.total === "number") {
          setProgress(data as BulkProgress);
        } else if (data.finished !== true) {
          // Свободный формат события (например, `{phone, status}`):
          // мерджим поверх предыдущего прогресса, чтобы не терять
          // ранее накопленные `done`/`total`.
          setProgress((prev) => ({
            done: prev?.done ?? 0,
            total: prev?.total ?? 0,
            ...data,
          }));
        }

        // Финальное событие — Requirement 5.6: `active = false` в
        // течение 1 секунды (здесь — синхронно).
        if (data.finished === true) {
          if (typeof data.reason === "string" && data.reason !== "completed") {
            setError(`Операция завершена: ${data.reason}`);
          }
          setActive(false);
          cleanup();
        }
      };

      sse.onerror = () => {
        // Закрытие соединения / сетевая ошибка — Requirement 5.6.
        setActive(false);
        cleanup();
      };
    },
    [kind, resetHeartbeat, cleanup],
  );

  const stop = useCallback(async (): Promise<void> => {
    const runId = operationRunIdRef.current;
    if (runId == null) {
      // Без `operation_run_id` останавливать нечего; это безопасный
      // no-op для двойного клика по «Стоп» до старта SSE.
      return;
    }
    try {
      await fetch(resolveUrl(STOP_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation_run_id: runId }),
      });
      // Сам `setActive(false)` произойдёт по SSE-событию
      // `{ finished: true, reason: "cancelled" }`, чтобы UI и backend
      // синхронизировались по одному источнику истины.
    } catch (err) {
      setError(`Ошибка остановки: ${(err as Error).message}`);
    }
  }, []);

  return { active, progress, state, operationRunId, error, start, stop };
}
