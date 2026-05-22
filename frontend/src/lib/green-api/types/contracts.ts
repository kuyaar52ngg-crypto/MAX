/**
 * Контракты для фичи `green-api-shared-instance-auth`.
 *
 * Все типы — из дизайна спеки (раздел Components and Interfaces / Data Models).
 * Никаких побочных эффектов, никаких импортов рантайма — чистые типы.
 */

// ── InstanceStatus ──────────────────────────────────────────────────────────

/**
 * Нормализованное значение `GreenInstance.status`. Совпадает с `stateInstance`
 * из GREEN-API, плюс наш собственный sentinel `unknown` для случая, когда
 * Health-проверка ещё не отработала.
 */
export type InstanceStatus =
  | "unknown"
  | "notAuthorized"
  | "authorized"
  | "starting"
  | "yellowCard"
  | "blocked"
  | "sleepMode";

export const ALL_INSTANCE_STATUSES: readonly InstanceStatus[] = [
  "unknown",
  "notAuthorized",
  "authorized",
  "starting",
  "yellowCard",
  "blocked",
  "sleepMode",
] as const;

// ── Diagnostic error model ─────────────────────────────────────────────────

export type DiagnosticErrorCode =
  | "invalid_credentials"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "not_found"
  | "server_error"
  | "network_error"
  | "unknown";

export interface DiagnosticError {
  code: DiagnosticErrorCode;
  /** Какой HTTP-код вернёт Next.js клиенту. */
  httpStatus: number;
  /** Русскоязычный текст для UI. */
  message: string;
  /** HTTP-код от GREEN-API (если был ответ). */
  upstreamHttpStatus: number | null;
  /** Тело ответа от GREEN-API, обрезанное до 512 символов. Только для server-side log. */
  upstreamBody: string | null;
}

export type ClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DiagnosticError };

// ── GREEN-API data shapes ──────────────────────────────────────────────────

export interface GetStateInstanceData {
  stateInstance: InstanceStatus;
}

export interface GetQRData {
  type: "qrCode" | "alreadyLogged" | "error";
  /** Для `qrCode` — base64 PNG; для `error` — текст; для `alreadyLogged` — отсутствует. */
  message: string;
}

export interface GetSettingsData {
  /** WID формата `79991234567@c.us`. */
  wid?: string;
  webhookUrl?: string;
  outgoingWebhook?: "yes" | "no";
}

export interface LogoutData {
  isLogout: boolean;
}

// ── Next.js API responses ──────────────────────────────────────────────────

export interface GetStateResponse {
  status: InstanceStatus;
  phone: string | null;
  shared_instance_warning: boolean;
}

export interface GetQRResponse {
  type: "qrCode" | "alreadyLogged" | "error";
  message?: string;
  /** ms epoch — для frontend race-detection между двумя in-flight запросами. */
  server_timestamp: number;
}

export type PostReauthRequest = Record<string, never>;

export interface PostReauthResponse {
  status: InstanceStatus;
  phone: string | null;
  shared_instance_warning: boolean;
}

export interface PostCredentialsRequest {
  id_instance: string;
  api_token: string;
  api_url?: string;
}

export interface PostCredentialsResponse {
  status: InstanceStatus;
  phone: string | null;
  id_instance: string;
  api_url: string;
}

export interface ApiErrorResponse {
  error: string;
  code?: DiagnosticErrorCode;
}

// ── Audit ──────────────────────────────────────────────────────────────────

export type AuditEventKind =
  | "instance_connected"
  | "instance_reauthorized"
  | "instance_credentials_changed"
  | "instance_status_degraded";

export interface AuditEventDetails {
  green_instance_id: string;
  id_instance?: string;
  previous_status?: InstanceStatus;
  new_status?: InstanceStatus;
  previous_id_instance?: string;
  shared_instance_warning?: boolean;
}
