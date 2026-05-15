import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { createClient } from "@/lib/supabase/server";
import { buildMarketerSystemPrompt } from "@/lib/ai/marketer-prompt";
import {
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_TIMEOUT_MS,
} from "@/components/broadcast";

/**
 * `Ollama_Proxy` — серверный прокси к Ollama Cloud REST API.
 *
 * Маршрут защищён Supabase-сессией (cookie), читает `OLLAMA_API_KEY` и
 * `OLLAMA_MODEL` только на сервере и НИКОГДА не возвращает значение ключа
 * клиенту (ни в теле, ни в заголовках). Запрос к upstream имеет жёсткий
 * таймаут `OLLAMA_TIMEOUT_MS` (60 c) через `AbortController`.
 *
 * Маппинг статусов:
 *  - 200 `{ text }`            — успешный ответ Ollama (`message.content` или `response`)
 *  - 400 `{ error }`           — тело не JSON или `prompt` не строка
 *  - 401 `{ error }`           — нет валидной Supabase-сессии
 *  - 500 `{ error }`           — `OLLAMA_API_KEY` не сконфигурирован
 *  - 502 `{ error }`           — upstream вернул не-2xx или сетевая ошибка
 *  - 504 `{ error }`           — `AbortError` по таймауту 60 c
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10,
 * 6.11, 7.1, 7.5, 8.1, 8.4
 */

export const dynamic = "force-dynamic";

const OLLAMA_URL = "https://ollama.com/api/chat";
const DEFAULT_USER_PROMPT = "Сгенерируй маркетинговый текст для рассылки";

/**
 * Best-effort извлечение человекочитаемого сообщения об ошибке из тела
 * upstream-ответа Ollama. Сначала пробуем JSON.parse и достать поле
 * `error` либо `message`; при провале парсинга — отдаём сырой текст
 * (без перевода строк по краям). Возвращает `null`, если тело пустое.
 *
 * Validates: Requirements 6.8
 */
function extractUpstreamMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === "string" && obj.error.trim()) {
        return obj.error;
      }
      if (typeof obj.message === "string" && obj.message.trim()) {
        return obj.message;
      }
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return trimmed;
}

export async function POST(req: NextRequest) {
  // 1. Auth (Requirement 6.10)
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Read server-only secrets (Requirements 6.3, 8.1, 8.4)
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "OLLAMA_API_KEY is not configured" },
      { status: 500 }
    );
  }
  const model = process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL;

  // 3. Parse and validate body (Requirement 6.2). 400 fires when the body is
  //    not JSON OR when `prompt` is not a string.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid body" }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;
  if (typeof fields.prompt !== "string") {
    return jsonResponse({ error: "Invalid body" }, { status: 400 });
  }

  const promptInput: string = fields.prompt;
  // Default user prompt when the trimmed input is empty (Requirement 7.5).
  const promptForModel = promptInput.trim() || DEFAULT_USER_PROMPT;
  // Use caller-provided system message if it's a non-empty string,
  // otherwise build the marketer system prompt from the user input
  // (Requirements 7.1, 7.2, 7.3, 7.4).
  const systemPrompt =
    typeof fields.system === "string" && fields.system.trim()
      ? fields.system
      : buildMarketerSystemPrompt(promptInput);

  // 4. Upstream call with 60 s timeout (Requirement 6.11).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(OLLAMA_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptForModel },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const name = (err as { name?: unknown } | null | undefined)?.name;
    if (name === "AbortError") {
      return jsonResponse(
        { error: "Ollama request timed out" },
        { status: 504 }
      );
    }
    return jsonResponse(
      { error: "Ollama upstream error" },
      { status: 502 }
    );
  }
  clearTimeout(timer);

  // 5. Map upstream non-2xx → 502 with extracted message (Requirement 6.8).
  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    const message = extractUpstreamMessage(errBody) || upstream.statusText;
    return jsonResponse({ error: message }, { status: 502 });
  }

  // 6. Successful response — extract text from `message.content` or
  //    `response` (Requirement 6.6).
  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    return jsonResponse(
      { error: "Ollama returned non-JSON response" },
      { status: 502 }
    );
  }

  let text = "";
  if (data && typeof data === "object") {
    const obj = data as { message?: unknown; response?: unknown };
    if (
      obj.message &&
      typeof obj.message === "object" &&
      typeof (obj.message as { content?: unknown }).content === "string"
    ) {
      text = (obj.message as { content: string }).content;
    } else if (typeof obj.response === "string") {
      text = obj.response;
    }
  }
  return jsonResponse({ text });
}
