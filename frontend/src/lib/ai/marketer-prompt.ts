/**
 * Marketer system prompt construction utilities.
 *
 * The functions are pure (no I/O, no globals) and intentionally framework-free
 * so they can be imported from both the Next.js route handler
 * (`/api/ai/generate`) and the property tests in `__tests__/`.
 *
 * Validates: Requirements 7.2, 7.3, 7.4
 */

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * Returns `true` when the input is predominantly Cyrillic.
 *
 * Rules (Requirement 7.3):
 * - Only counts code points whose Unicode script is `Cyrillic` or `Latin`.
 *   Digits, punctuation, whitespace and other scripts are ignored.
 * - Threshold is 50%: if `cyrillic / (cyrillic + latin) >= 0.5` → `true`.
 * - When the string contains no Latin/Cyrillic letters at all
 *   (including the empty string), returns `true`. This makes the default
 *   marketer prompt Russian-first when the user gives no textual hint.
 */
export function isPredominantlyCyrillic(input: string): boolean {
  let cyrillic = 0;
  let latin = 0;
  for (const ch of input) {
    if (CYRILLIC_LETTER.test(ch)) cyrillic++;
    else if (LATIN_LETTER.test(ch)) latin++;
  }
  const total = cyrillic + latin;
  if (total === 0) return true;
  return cyrillic / total >= 0.5;
}

/**
 * Builds the system prompt for the AI marketer role used by `Ollama_Proxy`.
 *
 * The result always contains:
 * 1. an explicit mention of the marketer role and mass broadcasts
 *    (Requirement 7.2);
 * 2. a ban on Markdown formatting and explanatory comments
 *    (Requirement 7.4);
 * 3. a language directive consistent with `isPredominantlyCyrillic(userInput)`
 *    — Russian when the function returns `true`, "same language as the user"
 *    otherwise (Requirement 7.3).
 */
export function buildMarketerSystemPrompt(userInput: string): string {
  const ru = isPredominantlyCyrillic(userInput);
  const lang = ru
    ? "Отвечай только на русском языке."
    : "Reply in the same language the user used.";
  return [
    "Ты — AI-маркетолог, специализирующийся на коротких маркетинговых сообщениях для массовых рассылок.",
    "Твоя задача — написать готовый текст рассылки.",
    "Возвращай ТОЛЬКО итоговый текст рассылки, без поясняющих комментариев и без Markdown-форматирования.",
    lang,
  ].join(" ");
}
