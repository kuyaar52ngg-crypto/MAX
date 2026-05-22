/**
 * Эвристический анализатор anti-ban конфигурации.
 *
 * Принимает текущий `AntiBanConfig`, возвращает список проблем, каждая
 * из которых содержит:
 *   - id          — уникальный ключ (для React-ключей и тестов)
 *   - severity    — уровень угрозы (info / warning / danger)
 *   - title       — короткий заголовок для UI
 *   - description — пояснение, что это значит и почему опасно
 *   - patch       — Partial<AntiBanConfig>, который можно применить
 *                   одним кликом, чтобы привести конфиг к безопасному
 *                   значению.
 *
 * Правила здесь — это «здравый смысл», накопленный из практики
 * GREEN-API: меньше тонких настроек, больше понятных last-mile
 * рекомендаций.
 */

import type { AntiBanConfig } from "@/lib/anti-ban";

export type AnalysisSeverity = "info" | "warning" | "danger";

export interface AnalyzerIssue {
  id: string;
  severity: AnalysisSeverity;
  title: string;
  description: string;
  patch: Partial<AntiBanConfig>;
  patchLabel: string;
}

export interface AnalysisResult {
  /** «Очки риска» 0..100, где 0 — безопаснее всего, 100 — крайне опасно. */
  riskScore: number;
  /** «Человечность» 0..100 — как сильно темп похож на человеческий. */
  humanScore: number;
  issues: AnalyzerIssue[];
}

const SEVERITY_WEIGHT: Record<AnalysisSeverity, number> = {
  info: 5,
  warning: 15,
  danger: 30,
};

export function analyzeAntiBanConfig(config: AntiBanConfig): AnalysisResult {
  const issues: AnalyzerIssue[] = [];

  // 1. Слишком короткая минимальная пауза при большом дневном лимите.
  if (config.delay_min < 3 && config.daily_message_limit > 300) {
    issues.push({
      id: "short_delay_high_volume",
      severity: "danger",
      title: "Короткая пауза при большом объёме",
      description: `Минимальная пауза ${config.delay_min} сек + лимит ${config.daily_message_limit} сообщений в сутки — высокий риск получить 429-ban от GREEN-API. Рекомендуется не ниже 3 сек или снизить лимит.`,
      patch: { delay_min: 3.0, delay_max: Math.max(config.delay_max, 7.0) },
      patchLabel: "Поднять паузу до 3 сек",
    });
  }

  // 2. Узкий разброс — детектится как авто-бот.
  if (config.delay_max - config.delay_min < 1) {
    issues.push({
      id: "narrow_jitter",
      severity: "warning",
      title: "Слишком предсказуемый темп",
      description:
        "Разница между min и max паузой меньше 1 сек — поведение слишком ровное, легко детектится как бот. Расширьте разброс хотя бы до 3 сек.",
      patch: {
        delay_max: config.delay_min + 4.0,
      },
      patchLabel: "Расширить разброс до +4 сек",
    });
  }

  // 3. Нет длинных пауз при крупных рассылках.
  if (config.long_pause_every_n === 0 && config.batch_size >= 50) {
    issues.push({
      id: "no_long_pauses",
      severity: "warning",
      title: "Нет длинных пауз",
      description:
        "При размере батча 50+ контактов бот шлёт без отдыха — это нетипично для человека и привлекает фильтры. Включите длинную паузу каждые 50 запросов.",
      patch: { long_pause_every_n: 50, long_pause_seconds: 60 },
      patchLabel: "Включить паузу каждые 50",
    });
  }

  // 4. Длинная пауза = 0 секунд = по сути выключена, при том что every_n > 0.
  if (config.long_pause_every_n > 0 && config.long_pause_seconds < 10) {
    issues.push({
      id: "tiny_long_pause",
      severity: "info",
      title: "Длинная пауза слишком короткая",
      description: `Пауза в ${config.long_pause_seconds} сек не даёт настоящего «отдыха». Имитация человеческого перерыва — от 30 секунд.`,
      patch: { long_pause_seconds: 60 },
      patchLabel: "Поднять до 60 сек",
    });
  }

  // 5. Часовой лимит непропорционально велик относительно дневного.
  if (config.hourly_check_limit > config.daily_check_limit / 5) {
    issues.push({
      id: "hourly_too_high",
      severity: "warning",
      title: "Часовой лимит завышен",
      description: `Часовой лимит проверок ${config.hourly_check_limit} больше 1/5 от дневного (${config.daily_check_limit}) — за 5 часов выработаете весь дневной запас и получите паузу. Снизьте часовой или поднимите дневной.`,
      patch: {
        hourly_check_limit: Math.max(20, Math.floor(config.daily_check_limit / 6)),
      },
      patchLabel: "Сбалансировать (1/6 от дневного)",
    });
  }

  // 6. Watchdog timeout слишком мал — может ложно сбрасывать.
  if (config.watchdog_timeout_seconds < 60) {
    issues.push({
      id: "watchdog_short",
      severity: "info",
      title: "Watchdog слишком чувствителен",
      description: `Таймаут ${config.watchdog_timeout_seconds} сек может ложно срабатывать на медленных сетях (особенно при отправке файлов). Рекомендуется не ниже 120 сек.`,
      patch: { watchdog_timeout_seconds: 120 },
      patchLabel: "Установить 120 сек",
    });
  }

  // 7. Слишком агрессивный SSE timeout.
  if (config.sse_client_timeout_seconds < 30) {
    issues.push({
      id: "sse_too_short",
      severity: "info",
      title: "SSE-таймаут слишком короткий",
      description:
        "UI будет переподключаться слишком часто — возможны мерцания прогресса.",
      patch: { sse_client_timeout_seconds: 60 },
      patchLabel: "Установить 60 сек",
    });
  }

  // 8. broadcast_delay_min слишком мал.
  if (config.broadcast_delay_min < 3) {
    issues.push({
      id: "broadcast_delay_low",
      severity: "danger",
      title: "Слишком быстрая рассылка",
      description: `Минимальная пауза рассылки ${config.broadcast_delay_min} сек ниже 3 сек — это очень быстро для отправки сообщений и существенно повышает риск бана.`,
      patch: { broadcast_delay_min: 5.0 },
      patchLabel: "Поднять до 5 сек",
    });
  }

  // 9. max_consecutive_429 слишком толерантный.
  if (config.max_consecutive_429 > 5) {
    issues.push({
      id: "rate429_too_lenient",
      severity: "warning",
      title: "Слишком толерантный к 429",
      description: `${config.max_consecutive_429} подряд 429 — продолжать опасно, нужно остановиться раньше. Рекомендуем 3.`,
      patch: { max_consecutive_429: 3 },
      patchLabel: "Снизить до 3",
    });
  }

  // 10. Sliding window слишком плотное.
  if (
    config.sliding_window_n > 0 &&
    config.sliding_window_t > 0 &&
    config.sliding_window_n / config.sliding_window_t > 1
  ) {
    issues.push({
      id: "sliding_window_dense",
      severity: "warning",
      title: "Sliding window > 1 запрос/сек",
      description: `Окно ${config.sliding_window_n} запросов за ${config.sliding_window_t} сек = больше одного запроса в секунду — это слишком быстро.`,
      patch: { sliding_window_n: 20, sliding_window_t: 60 },
      patchLabel: "Привести к 20 за 60 сек",
    });
  }

  // ── Считаем итоговые метрики ───────────────────────────────────────────
  let risk = 0;
  for (const issue of issues) {
    risk += SEVERITY_WEIGHT[issue.severity];
  }
  risk = Math.min(100, risk);

  const human = computeHumanScore(config);

  return { riskScore: risk, humanScore: human, issues };
}

/** «Человечность» на основе разброса пауз, наличия длинных пауз и jitter. */
export function computeHumanScore(config: AntiBanConfig): number {
  let score = 0;

  // Spread: чем шире — тем человечнее (max +30)
  const spread = Math.max(0, config.delay_max - config.delay_min);
  score += Math.min(30, spread * 5);

  // Длинные паузы (max +25)
  if (config.long_pause_every_n > 0 && config.long_pause_seconds >= 30) {
    score += 25;
  } else if (config.long_pause_every_n > 0) {
    score += 10;
  }

  // Базовый минимум — паузы ≥ 3 сек (max +25)
  if (config.delay_min >= 3) score += 25;
  else score += Math.floor((config.delay_min / 3) * 25);

  // Jitter рассылки (max +10)
  if (config.broadcast_jitter_max >= 2) score += 10;
  else score += Math.floor((config.broadcast_jitter_max / 2) * 10);

  // Не превышаем разумные лимиты (max +10)
  if (config.daily_message_limit <= 1000) score += 10;
  else if (config.daily_message_limit <= 2000) score += 5;

  return Math.min(100, score);
}
