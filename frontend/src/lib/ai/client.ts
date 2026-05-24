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
import {
  buildMarketerSystemPrompt,
  buildRandomizeSystemPrompt,
  buildVariantsSystemPrompt,
  parseVariantsResponse,
  type AiTone,
} from "./marketer-prompt";

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

/**
 * Generate a marketing message from scratch with optional tone preset.
 */
export async function generateMessage(
  brief: string,
  tone: AiTone | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const system = buildMarketerSystemPrompt(brief || "", tone);
  return requestAiText(
    brief.trim() || "Сгенерируй маркетинговое сообщение для рассылки.",
    signal,
    system,
  );
}

/**
 * Wrap an existing user message into {a|b|c} placeholders to reduce the
 * spam-pattern signal of identical texts. Pure transformation: takes the
 * original text and returns an enriched version.
 */
export async function randomizeMessage(
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Пустой текст — нечего уникализировать");
  }
  const system = buildRandomizeSystemPrompt(trimmed);
  return requestAiText(trimmed, signal, system);
}

/**
 * Generate N distinct variants of one core idea for A/B testing.
 */
export async function generateVariants(
  brief: string,
  count: number,
  tone: AiTone | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const trimmed = brief.trim();
  const system = buildVariantsSystemPrompt(trimmed || "", count, tone);
  const raw = await requestAiText(
    trimmed || "Сгенерируй варианты маркетингового сообщения.",
    signal,
    system,
  );
  return parseVariantsResponse(raw);
}
