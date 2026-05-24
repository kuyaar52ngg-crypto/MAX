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
 * Conservative defaults — пересмотрены после реального бана MAX-аккаунта
 * на 150 проверках с предыдущими, более агрессивными настройками.
 *
 * Старые значения (привели к бану):
 *   delay_min=3, delay_max=7, hourly=200, daily=1000, long_pause_every_n=50
 *
 * Новые: примерно вдвое медленнее, лимиты вниз. 150 номеров теперь идут
 * 25–35 минут с двумя long-pause посередине — это паттерн живого пользователя.
 */
export const DEFAULT_ANTI_BAN_CONFIG: AntiBanConfig = {
  delay_min: 6.0,
  delay_max: 12.0,
  batch_size: 30,
  long_pause_every_n: 25,
  long_pause_seconds: 120.0,
  daily_check_limit: 300,
  hourly_check_limit: 80,
  daily_message_limit: 200,
  broadcast_delay_min: 8.0,
  broadcast_jitter_max: 5.0,
  state_poll_interval_seconds: 30,
  watchdog_timeout_seconds: 180,
  watchdog_check_interval_seconds: 10,
  cancel_check_interval_seconds: 1.0,
  sse_client_timeout_seconds: 60,
  max_retries: 5,
  max_consecutive_429: 3,
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
 * 150 номеров с этими настройками идут ~50–60 минут — это безопасно
 * даже для совсем свежих аккаунтов MAX.
 */
export const SAFE_ANTI_BAN_CONFIG: AntiBanConfig = {
  ...DEFAULT_ANTI_BAN_CONFIG,
  delay_min: 12.0,
  delay_max: 25.0,
  batch_size: 20,
  long_pause_every_n: 15,
  long_pause_seconds: 180.0,
  daily_check_limit: 100,
  hourly_check_limit: 30,
  daily_message_limit: 80,
  broadcast_delay_min: 15.0,
  broadcast_jitter_max: 10.0,
};

/**
 * Compute estimated duration of a bulk operation in seconds.
 * Formula (Requirement 6.2):
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
 * Map total count to risk category. Пересмотрено после real-world бана.
 *   low    < 50
 *   medium 50..150
 *   high   > 150
 */
export function computeRisk(total: number): "low" | "medium" | "high" {
  if (total < 50) return "low";
  if (total < 150) return "medium";
  return "high";
}
