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
 * Tone presets supported by the AI marketer.
 *
 * Each tone maps to a short directive injected into the system prompt.
 * The list is small and intentional — too many tones blur the marketer's
 * style and confuse the model.
 */
export type AiTone = "friendly" | "formal" | "sales" | "urgent" | "casual";

export const AI_TONE_LABELS: Record<AiTone, string> = {
  friendly: "Дружелюбный",
  formal: "Официальный",
  sales: "Продающий",
  urgent: "Срочный",
  casual: "Разговорный",
};

const AI_TONE_DIRECTIVES_RU: Record<AiTone, string> = {
  friendly:
    "Тон дружелюбный, тёплый, как сообщение знакомому. Без официоза, можно лёгкие смайлы.",
  formal:
    "Тон официально-деловой, на «вы», без эмодзи. Уважительно, ёмко, без лишних слов.",
  sales:
    "Тон продающий: цепляющий заголовок, выгода, лёгкое побуждение к действию. Без агрессивных «КУПИ СЕЙЧАС». Без капслока.",
  urgent:
    "Тон срочный, краткий, с акцентом на ограниченное время. Чётко, без воды, не больше 2 коротких предложений.",
  casual:
    "Тон разговорный, как переписка между друзьями. Можно сленг и смайлики, но без перебора.",
};

const AI_TONE_DIRECTIVES_EN: Record<AiTone, string> = {
  friendly: "Tone: friendly and warm, like talking to a friend. No formality.",
  formal: "Tone: formal business style, no emojis, respectful, concise.",
  sales:
    "Tone: persuasive, value-first, soft call to action. No ALL CAPS, no aggressive 'BUY NOW'.",
  urgent:
    "Tone: urgent and brief. Emphasise limited time. Max two short sentences.",
  casual: "Tone: casual chat between friends. Light slang and emojis are ok.",
};

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
 *    otherwise (Requirement 7.3);
 * 4. an optional tone directive when `tone` is provided.
 */
export function buildMarketerSystemPrompt(
  userInput: string,
  tone?: AiTone,
): string {
  const ru = isPredominantlyCyrillic(userInput);
  const lang = ru
    ? "Отвечай только на русском языке."
    : "Reply in the same language the user used.";
  const toneDirective = tone
    ? ru
      ? AI_TONE_DIRECTIVES_RU[tone]
      : AI_TONE_DIRECTIVES_EN[tone]
    : "";
  return [
    "Ты — AI-маркетолог, специализирующийся на коротких маркетинговых сообщениях для массовых рассылок.",
    "Твоя задача — написать готовый текст рассылки.",
    "Возвращай ТОЛЬКО итоговый текст рассылки, без поясняющих комментариев и без Markdown-форматирования.",
    lang,
    toneDirective,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Build a system prompt that asks the model to randomise an existing text
 * into `{a|b|c}` placeholders — this lets users wrap their own message
 * into a "spam-pattern-resistant" variant in one click.
 */
export function buildRandomizeSystemPrompt(userInput: string): string {
  const ru = isPredominantlyCyrillic(userInput);
  const lang = ru
    ? "Отвечай только на русском языке."
    : "Reply in the same language the user used.";
  return [
    "Ты — AI-помощник по уникализации маркетинговых текстов.",
    "Тебе пришлют готовое сообщение. Твоя задача — заменить ключевые слова и фразы синонимами, обернув их в плейсхолдеры формата {вариант1|вариант2|вариант3}.",
    "Каждый получатель потом получит свой случайный вариант — это снижает спам-паттерн одинаковых текстов и риск бана.",
    "Правила: 2-4 синонима в каждом плейсхолдере, сохраняй смысл и тон оригинала, не добавляй новой информации, не меняй структуру.",
    "Возвращай ТОЛЬКО итоговый текст с плейсхолдерами. Без объяснений, без markdown.",
    lang,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Build a prompt that asks for N distinct variants of one message —
 * use case: A/B-test variants for ABTimeTest или ABTest with text variants.
 */
export function buildVariantsSystemPrompt(
  userInput: string,
  variantCount: number,
  tone?: AiTone,
): string {
  const n = Math.max(2, Math.min(5, Math.floor(variantCount)));
  const ru = isPredominantlyCyrillic(userInput);
  const lang = ru
    ? "Отвечай только на русском языке."
    : "Reply in the same language the user used.";
  const toneDirective = tone
    ? ru
      ? AI_TONE_DIRECTIVES_RU[tone]
      : AI_TONE_DIRECTIVES_EN[tone]
    : "";
  const sep = "\n---VARIANT---\n";
  const intro = ru
    ? `Сгенерируй ${n} ОТЛИЧАЮЩИХСЯ варианта одного и того же маркетингового сообщения для A/B-теста.`
    : `Generate ${n} DISTINCT variants of the same marketing message for an A/B test.`;
  const ruleVariants = ru
    ? `Каждый вариант должен иметь свою структуру и формулировки, но передавать одну и ту же ключевую идею.`
    : `Each variant must have a different structure and wording but convey the same core idea.`;
  const ruleSep = ru
    ? `Раздели варианты строкой "${sep.trim()}" (без кавычек). Не нумеруй варианты.`
    : `Separate variants with the line "${sep.trim()}" (no quotes). Do not number them.`;
  return [
    "Ты — AI-маркетолог.",
    intro,
    ruleVariants,
    ruleSep,
    "Возвращай ТОЛЬКО варианты с разделителями. Без markdown, без поясняющих комментариев.",
    lang,
    toneDirective,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Splits a multi-variant response by the canonical separator. Trims and
 * drops empty entries. Always returns at least one element (the original
 * trimmed string) when no separator is found — defensive for models that
 * don't follow the directive perfectly.
 */
export function parseVariantsResponse(text: string): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  const split = trimmed
    .split(/-{3,}\s*VARIANT\s*-{3,}/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return split.length > 0 ? split : [trimmed];
}
