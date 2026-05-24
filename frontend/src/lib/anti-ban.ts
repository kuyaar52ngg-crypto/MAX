export type InstanceState =
  | "authorized"
  | "yellowCard"
  | "blocked"
  | "notAuthorized"
  | "starting"
  | "sleepMode"
  | "unknown";

export interface AntiBanConfig {
  delay_min: number;
  delay_max: number;
  batch_size: number;
  long_pause_every_n: number;
  long_pause_seconds: number;
  daily_check_limit: number;
  hourly_check_limit: number;
  daily_message_limit: number;
  broadcast_delay_min: number;
  broadcast_jitter_max: number;
  state_poll_interval_seconds: number;
  watchdog_timeout_seconds: number;
  watchdog_check_interval_seconds: number;
  cancel_check_interval_seconds: number;
  sse_client_timeout_seconds: number;
  max_retries: number;
  max_consecutive_429: number;
  sliding_window_n: number;
  sliding_window_t: number;
  incident_history_limit: number;
  backoff_base_seconds: number;
  response_ratio_window_hours: number;
  response_ratio_min_outgoing: number;
  warn_on_zero_response_ratio: boolean;
}

/**
 * Real-world safe defaults — based on documented MAX limits at
 * https://max-catalog24.ru/limits.html (Sheiker community testing).
 *
 * Key insight after our own ban (150 contact checks):
 *   - MAX bans **immediately** at >20 number checks per day
 *   - 1-10 single checks chained with other activities = safe
 *   - >100 messages/day (без прогрева) = быстрый бан
 *   - delay <15с между сообщениями = красный флаг
 *
 * Старые значения (привели к бану):
 *   delay_min=3, delay_max=7, hourly=200, daily_check_limit=1000,
 *   long_pause_every_n=50
 *
 * Новые (после изучения реальных лимитов MAX):
 */
export const DEFAULT_ANTI_BAN_CONFIG: AntiBanConfig = {
  // Проверки номеров — самая рискованная операция в MAX.
  // Лимит 20/день, между ними 15+ секунд, не подряд.
  delay_min: 15.0,
  delay_max: 30.0,
  batch_size: 10,
  long_pause_every_n: 5,
  long_pause_seconds: 180.0,
  daily_check_limit: 20,
  hourly_check_limit: 10,
  // Сообщения — лимит 50/день после прогрева (10-20 для свежих).
  daily_message_limit: 50,
  // Между сообщениями ≥15 секунд (без задержки = спам-сигнал для MAX).
  broadcast_delay_min: 15.0,
  broadcast_jitter_max: 10.0,
  state_poll_interval_seconds: 30,
  watchdog_timeout_seconds: 240,
  watchdog_check_interval_seconds: 10,
  cancel_check_interval_seconds: 1.0,
  sse_client_timeout_seconds: 60,
  max_retries: 5,
  max_consecutive_429: 2,
  sliding_window_n: 20,
  sliding_window_t: 60,
  incident_history_limit: 100,
  backoff_base_seconds: 5.0,
  response_ratio_window_hours: 24,
  response_ratio_min_outgoing: 30,
  warn_on_zero_response_ratio: true,
};

/**
 * Ультра-консервативный preset для свежих или восстанавливающихся
 * аккаунтов. Применяй после yellowCard/blocked инцидентов или для
 * аккаунтов младше 7 дней.
 *
 * Соответствует "День 1" прогрева по гайду:
 *   - 1-2 личных сообщения
 *   - проверки только единичные
 *   - паузы > 30 секунд
 */
export const SAFE_ANTI_BAN_CONFIG: AntiBanConfig = {
  ...DEFAULT_ANTI_BAN_CONFIG,
  delay_min: 30.0,
  delay_max: 60.0,
  batch_size: 5,
  long_pause_every_n: 3,
  long_pause_seconds: 300.0,
  daily_check_limit: 5,
  hourly_check_limit: 3,
  daily_message_limit: 15,
  broadcast_delay_min: 30.0,
  broadcast_jitter_max: 20.0,
};

/**
 * Compute estimated duration of a bulk operation in seconds.
 * Formula:
 *   avg_per_request = (delay_min + delay_max) / 2 + 1.0
 *   long_pauses     = total // long_pause_every_n  (0 if long_pause_every_n == 0)
 *   eta_seconds     = total * avg_per_request + long_pauses * long_pause_seconds
 */
export function computeEta(config: AntiBanConfig, total: number): number {
  if (total <= 0) return 0;
  const avg = (config.delay_min + config.delay_max) / 2 + 1.0;
  const longPauses =
    config.long_pause_every_n > 0
      ? Math.floor(total / config.long_pause_every_n)
      : 0;
  return total * avg + longPauses * config.long_pause_seconds;
}

/**
 * Risk thresholds aligned with MAX documented limits.
 *   - low    < 10  (единичные проверки/сообщения, безопасно)
 *   - medium 10..50 (близко к дневному лимиту проверок/сообщений)
 *   - high   ≥ 50 (превышает безопасный дневной лимит для свежего аккаунта)
 */
export function computeRisk(total: number): "low" | "medium" | "high" {
  if (total < 10) return "low";
  if (total < 50) return "medium";
  return "high";
}
