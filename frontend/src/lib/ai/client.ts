/**
 * AI helper-клиент.
 *
 * Тонкая обёртка над `POST /api/ai/generate` (см. `Ollama_Proxy` в design.md).
 * Сериализует тело как JSON `{ prompt }`, парсит ответ `{ text }`. На любую
 * не-2xx отвечающий статус извлекает поле `error` из тела (если оно валидный
 * JSON) и бросает `Error(body.error || res.statusText)`. Поддерживает
 * `AbortSignal` для отмены запроса со стороны вызывающей стороны
 * (например, при размонтировании страницы).
 *
 * Используется только из клиентских компонентов (`"use client"`),
 * поэтому намеренно не зависит от обёртки `apiUpload`/`nxFetch` —
 * прокси сам выполняет проверку Supabase-сессии через куку.
 *
 * Validates: Requirements 4.5, 4.6, 4.8
 */

import type { AIGenerateResponse } from "@/components/broadcast/types";

export async function requestAiText(
  prompt: string,
  signal?: AbortSignal,
  system?: string,
): Promise<string> {
  const res = await fetch("/api/ai/generate", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(system ? { prompt, system } : { prompt }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: unknown }));
    const message =
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : res.statusText;
    throw new Error(message);
  }

  const data = (await res.json()) as AIGenerateResponse;
  return data.text || "";
}
