/**
 * Client-safe re-exports для фичи `green-api-shared-instance-auth`.
 *
 * ВАЖНО: этот модуль безопасно импортировать в client-компоненты.
 * Серверные singletone (`throttleGate`, `greenApiClient`, `auditLog`)
 * лежат в `./server.ts` — он импортирует `prisma` и не должен попадать
 * в client-bundle.
 */

export {
  mapHttpToDiagnostic,
  diagnosticTextFor,
  diagnosticTextForErrorCode,
} from "./diagnostic";
export * from "./types/contracts";

/**
 * Утилита: `wid` = "79991234567@c.us" → "79991234567".
 */
export function extractPhoneFromWid(
  wid: string | undefined | null,
): string | null {
  if (typeof wid !== "string" || wid.length === 0) return null;
  const idx = wid.indexOf("@");
  return idx > 0 ? wid.slice(0, idx) : wid;
}

/**
 * `Shared_Instance_Warning` — pure-функция от `getSettings` ответа (Property 12).
 */
export function computeSharedInstanceWarning(
  webhookUrl: string | undefined | null,
  outgoingWebhook: "yes" | "no" | undefined | null,
): boolean {
  return Boolean(
    (typeof webhookUrl === "string" && webhookUrl.trim().length > 0) ||
      outgoingWebhook === "yes",
  );
}
