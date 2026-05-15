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

export const DEFAULT_ANTI_BAN_CONFIG: AntiBanConfig = {
  delay_min: 3.0,
  delay_max: 7.0,
  batch_size: 50,
  long_pause_every_n: 50,
  long_pause_seconds: 60.0,
  daily_check_limit: 1000,
  hourly_check_limit: 200,
  daily_message_limit: 500,
  broadcast_delay_min: 5.0,
  broadcast_jitter_max: 3.0,
  state_poll_interval_seconds: 30,
  watchdog_timeout_seconds: 120,
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
  response_ratio_min_outgoing: 50,
  warn_on_zero_response_ratio: true,
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
 * Map total count to risk category (Requirement 6.3).
 *   low    if total < 200
 *   medium if 200 <= total < 1000
 *   high   if total >= 1000
 */
export function computeRisk(total: number): "low" | "medium" | "high" {
  if (total < 200) return "low";
  if (total < 1000) return "medium";
  return "high";
}
