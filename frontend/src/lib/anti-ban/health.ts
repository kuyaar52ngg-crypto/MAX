/**
 * Account Health — агрегирует характеристики инстанса GREEN-API
 * и возвращает оценку риска бана.
 *
 * Категории здоровья (от лучшей к худшей):
 *   - "fresh"      : инстанс есть, но MAX никогда не получал входящих
 *                    → активно проверять/рассылать запрещено
 *   - "warming_up" : аккаунт младше 7 дней OR < 5 incoming за всю историю
 *                    → soft-limit (низкие дневные лимиты)
 *   - "ok"         : всё в норме
 *   - "at_risk"    : был хоть один инцидент yellowCard/quota_466/rate_429
 *                    за последние 24ч → рекомендуем подождать
 *   - "cooldown"   : текущий статус yellowCard/sleepMode → 24h блок
 *   - "blocked"    : status=blocked → запрещено всё
 *
 * Используется как backend-логика (`/api/instances/[id]/health` route)
 * и зеркальная клиентская проверка перед запуском.
 */

export type AccountHealthStatus =
  | "fresh"
  | "warming_up"
  | "ok"
  | "at_risk"
  | "cooldown"
  | "blocked";

export interface AccountHealthData {
  /** ID инстанса в нашей БД (BigInt сериализован как number). */
  instance_id: number;
  /** Текущий статус GREEN-API (из последнего health-check-а). */
  current_status: string;
  /** Сколько дней назад создан инстанс. */
  age_days: number;
  /** Сколько incoming сообщений получено за всю историю. */
  total_incoming: number;
  /** Сколько incoming за последние 7 дней. */
  incoming_last_7d: number;
  /** Сколько исходящих сообщений отправлено за последние 7 дней. */
  outgoing_last_7d: number;
  /** Кол-во проверок номеров за последние 24 часа. */
  checks_last_24h: number;
  /** Кол-во рассылок за последние 24 часа. */
  broadcasts_last_24h: number;
  /** Кол-во "плохих" инцидентов (yellowCard, quota_466, rate_limit_429,
   *  blocked, response_ratio_zero) за последние 24 часа. */
  incidents_last_24h: number;
  /** ISO ts последнего инцидента yellowCard/blocked. null если не было. */
  last_bad_incident_at: string | null;
  /** Финальная оценка. */
  status: AccountHealthStatus;
  /** Список причин (для UI). */
  reasons: string[];
  /** До какого момента UI должен блокировать массовые операции
   *  (cooldown). null если блока нет. ISO timestamp. */
  blocked_until: string | null;
  /** Рекомендованный дневной лимит проверок для этого инстанса. */
  recommended_daily_check_limit: number;
  /** Рекомендованный дневной лимит рассылок. */
  recommended_daily_message_limit: number;
}

interface ComputeHealthInput {
  instanceId: number;
  currentStatus: string;
  createdAt: Date;
  totalIncoming: number;
  incomingLast7d: number;
  outgoingLast7d: number;
  checksLast24h: number;
  broadcastsLast24h: number;
  incidentsLast24h: number;
  lastBadIncidentAt: Date | null;
  now?: Date;
}

const COOLDOWN_HOURS_AFTER_BAD_INCIDENT = 24;
const WARMING_UP_DAYS = 7;
const WARMING_UP_MIN_INCOMING = 5;

/**
 * Pure-функция оценки здоровья. Вынесена отдельно, чтобы её можно было
 * прогнать в unit-тестах без обращения к БД.
 */
export function computeAccountHealth(input: ComputeHealthInput): AccountHealthData {
  const now = input.now ?? new Date();
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - input.createdAt.getTime()) / 86_400_000),
  );
  const reasons: string[] = [];
  let blockedUntil: string | null = null;
  let status: AccountHealthStatus = "ok";

  // ── Tier 1: blocked (HARD STOP) ────────────────────────────────────
  if (input.currentStatus === "blocked") {
    status = "blocked";
    reasons.push(
      "Аккаунт заблокирован GREEN API. Только владелец инстанса может разблокировать.",
    );
  }
  // ── Tier 2: cooldown (yellowCard / sleepMode / недавний инцидент) ──
  else if (
    input.currentStatus === "yellowCard" ||
    input.currentStatus === "sleepMode"
  ) {
    status = "cooldown";
    reasons.push(
      input.currentStatus === "yellowCard"
        ? "Жёлтая карточка от GREEN API. Нужно подождать минимум 24 часа без активности."
        : "Инстанс в режиме сна. Откройте MAX на телефоне для пробуждения.",
    );
    // Cooldown окно — либо 24ч от lastBadIncidentAt, либо 24ч от now
    const baseTime = input.lastBadIncidentAt ?? now;
    const releaseAt = new Date(
      baseTime.getTime() + COOLDOWN_HOURS_AFTER_BAD_INCIDENT * 3_600_000,
    );
    if (releaseAt.getTime() > now.getTime()) {
      blockedUntil = releaseAt.toISOString();
    }
  }
  // ── Tier 3: at_risk (был инцидент за 24ч, но статус ОК) ────────────
  else if (
    input.lastBadIncidentAt &&
    now.getTime() - input.lastBadIncidentAt.getTime() <
      COOLDOWN_HOURS_AFTER_BAD_INCIDENT * 3_600_000
  ) {
    status = "at_risk";
    const hoursAgo = Math.floor(
      (now.getTime() - input.lastBadIncidentAt.getTime()) / 3_600_000,
    );
    reasons.push(
      `За последние ${hoursAgo}ч был инцидент. Снизьте темп или подождите.`,
    );
    const releaseAt = new Date(
      input.lastBadIncidentAt.getTime() +
        COOLDOWN_HOURS_AFTER_BAD_INCIDENT * 3_600_000,
    );
    blockedUntil = releaseAt.toISOString();
  }
  // ── Tier 4: fresh / warming_up ─────────────────────────────────────
  else if (input.totalIncoming === 0) {
    status = "fresh";
    reasons.push(
      "Аккаунт не получил ни одного входящего сообщения. Прогрейте — отправьте 5–10 сообщений знакомым контактам и получите ответы.",
    );
  } else if (
    ageDays < WARMING_UP_DAYS ||
    input.totalIncoming < WARMING_UP_MIN_INCOMING
  ) {
    status = "warming_up";
    if (ageDays < WARMING_UP_DAYS) {
      reasons.push(
        `Аккаунту ${ageDays} ${formatDays(ageDays)}. Сначала прогрейте — минимум 7 дней нормального общения.`,
      );
    }
    if (input.totalIncoming < WARMING_UP_MIN_INCOMING) {
      reasons.push(
        `Получено ${input.totalIncoming} входящих за всю историю. MAX подозревает бот-аккаунты с низким двусторонним трафиком.`,
      );
    }
  } else {
    // ok — но проверим перегрев
    if (input.checksLast24h > 200) {
      reasons.push(
        `За 24ч проверено ${input.checksLast24h} номеров. Это близко к подозрительному паттерну.`,
      );
    }
    if (input.outgoingLast7d > 0 && input.incomingLast7d === 0) {
      reasons.push(
        "За 7 дней нет ни одного входящего ответа. Это сигнал «pure outbound» аккаунта для MAX.",
      );
    }
  }

  // ── Recommended limits — пропорциональны категории ─────────────────
  // Базируются на документированных лимитах MAX:
  //   https://max-catalog24.ru/limits.html
  //   - Проверки номеров: 1-10 единичные / 20 максимум для прогретого
  //   - Сообщения: 10-20 для свежего → 50 после 7д прогрева → 100 max
  let recCheck: number;
  let recMsg: number;
  switch (status) {
    case "blocked":
    case "cooldown":
      recCheck = 0;
      recMsg = 0;
      break;
    case "fresh":
      recCheck = 0; // Свежим аккаунтам — ноль проверок номеров
      recMsg = 5; // Только личные сообщения для прогрева
      break;
    case "at_risk":
      recCheck = 5; // Резко снижаем после инцидента
      recMsg = 20;
      break;
    case "warming_up":
      recCheck = 10;
      recMsg = 30;
      break;
    case "ok":
    default:
      recCheck = 20; // Документированный безопасный лимит MAX
      recMsg = 50; // 50/день после прогрева
      break;
  }

  return {
    instance_id: input.instanceId,
    current_status: input.currentStatus,
    age_days: ageDays,
    total_incoming: input.totalIncoming,
    incoming_last_7d: input.incomingLast7d,
    outgoing_last_7d: input.outgoingLast7d,
    checks_last_24h: input.checksLast24h,
    broadcasts_last_24h: input.broadcastsLast24h,
    incidents_last_24h: input.incidentsLast24h,
    last_bad_incident_at: input.lastBadIncidentAt
      ? input.lastBadIncidentAt.toISOString()
      : null,
    status,
    reasons,
    blocked_until: blockedUntil,
    recommended_daily_check_limit: recCheck,
    recommended_daily_message_limit: recMsg,
  };
}

function formatDays(n: number): string {
  if (n === 1) return "день";
  if (n >= 2 && n <= 4) return "дня";
  return "дней";
}

/**
 * Список kind-ов IncidentLog, которые считаются «плохими» — то есть
 * сигналят про деградацию инстанса. Используется при подсчёте
 * `incidents_last_24h` и для определения `last_bad_incident_at`.
 */
export const BAD_INCIDENT_KINDS: readonly string[] = [
  "yellowCard",
  "blocked",
  "instance_status_degraded",
  "quota_466",
  "rate_limit_429",
  "watchdog_reset",
  "throttle_paused",
  "zero_response_ratio",
] as const;
