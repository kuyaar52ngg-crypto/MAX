/**
 * `GreenAPIClient` — серверная обёртка над GREEN-API HTTP-эндпойнтами.
 *
 * Все вызовы:
 *   1. Идут через `ThrottleGate` (защита от 429 + сериализация per-instance).
 *   2. Имеют timeout 15 секунд (`AbortSignal.timeout`).
 *   3. На ошибку маппятся через `mapHttpToDiagnostic`.
 *   4. Никогда не возвращают и не логируют расшифрованный `apiToken`.
 *
 * Используется внутри Next.js API route handlers и больше нигде:
 * расшифровка токена и его передача `fetch`-у происходят строго на сервере.
 */

import { mapHttpToDiagnostic } from "./diagnostic";
import { ThrottleGate, ThrottleTimeoutError } from "./throttle";
import type {
  ClientResult,
  GetQRData,
  GetSettingsData,
  GetStateInstanceData,
  InstanceStatus,
  LogoutData,
} from "./types/contracts";

/** Максимальное время в очереди throttle, после которого отвечаем 503. */
const DEFAULT_TIMEOUT_MS = 15000;

const ALL_STATUSES_SET = new Set<InstanceStatus>([
  "unknown",
  "notAuthorized",
  "authorized",
  "starting",
  "yellowCard",
  "blocked",
  "sleepMode",
]);

function normalizeStatus(raw: unknown): InstanceStatus {
  if (typeof raw === "string" && ALL_STATUSES_SET.has(raw as InstanceStatus)) {
    return raw as InstanceStatus;
  }
  return "unknown";
}

function buildUrl(apiUrl: string, path: string): string {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}${path}`;
}

export class GreenAPIClient {
  constructor(
    private readonly throttleGate: ThrottleGate,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Выполняет HTTP-запрос с throttle/timeout и нормализует ошибки в `DiagnosticError`.
   * Тело ответа возвращается в callback `parser`, чтобы вышестоящий метод сам решал,
   * как интерпретировать success-shape (тип может зависеть от endpoint-а).
   */
  private async request<T>(
    instanceDbId: bigint | string,
    url: string,
    parser: (body: unknown) => T,
  ): Promise<ClientResult<T>> {
    try {
      return await this.throttleGate.withGate(instanceDbId, async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(this.timeoutMs),
            cache: "no-store",
          });
        } catch (fetchErr: unknown) {
          // Внутри `AbortSignal.timeout` бросает `TimeoutError`.
          const name = fetchErr instanceof Error ? fetchErr.name : "";
          const cause: "timeout" | "network" | "abort" =
            name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
          return { ok: false, error: mapHttpToDiagnostic(null, null, cause) };
        }

        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          /* ignore — bodyText останется пустым */
        }

        if (!response.ok) {
          return {
            ok: false,
            error: mapHttpToDiagnostic(response.status, bodyText),
          };
        }

        try {
          const parsed: unknown = bodyText ? JSON.parse(bodyText) : {};
          return { ok: true, data: parser(parsed) };
        } catch {
          return {
            ok: false,
            error: mapHttpToDiagnostic(response.status, bodyText),
          };
        }
      });
    } catch (err) {
      if (err instanceof ThrottleTimeoutError) {
        return {
          ok: false,
          error: {
            code: "rate_limited",
            httpStatus: 503,
            message:
              "GREEN API занят: слишком много параллельных запросов к этому инстансу. Повторите через 5 секунд",
            upstreamHttpStatus: null,
            upstreamBody: null,
          },
        };
      }
      throw err;
    }
  }

  async getStateInstance(
    instanceDbId: bigint | string,
    idInstance: string,
    apiToken: string,
    apiUrl: string,
  ): Promise<ClientResult<GetStateInstanceData>> {
    const url = buildUrl(
      apiUrl,
      `/waInstance${encodeURIComponent(idInstance)}/getStateInstance/${encodeURIComponent(apiToken)}`,
    );
    return this.request(instanceDbId, url, (raw) => {
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return { stateInstance: normalizeStatus(obj.stateInstance) };
    });
  }

  async getQR(
    instanceDbId: bigint | string,
    idInstance: string,
    apiToken: string,
    apiUrl: string,
  ): Promise<ClientResult<GetQRData>> {
    const url = buildUrl(
      apiUrl,
      `/waInstance${encodeURIComponent(idInstance)}/qr/${encodeURIComponent(apiToken)}`,
    );
    return this.request(instanceDbId, url, (raw) => {
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const type = obj.type;
      const message = typeof obj.message === "string" ? obj.message : "";
      if (type === "qrCode" || type === "alreadyLogged" || type === "error") {
        return { type, message };
      }
      return { type: "error", message: "Unknown QR response from GREEN API" };
    });
  }

  async getSettings(
    instanceDbId: bigint | string,
    idInstance: string,
    apiToken: string,
    apiUrl: string,
  ): Promise<ClientResult<GetSettingsData>> {
    const url = buildUrl(
      apiUrl,
      `/waInstance${encodeURIComponent(idInstance)}/getSettings/${encodeURIComponent(apiToken)}`,
    );
    return this.request(instanceDbId, url, (raw) => {
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const result: GetSettingsData = {};
      if (typeof obj.wid === "string") result.wid = obj.wid;
      if (typeof obj.webhookUrl === "string") result.webhookUrl = obj.webhookUrl;
      if (obj.outgoingWebhook === "yes" || obj.outgoingWebhook === "no") {
        result.outgoingWebhook = obj.outgoingWebhook;
      }
      return result;
    });
  }

  async logout(
    instanceDbId: bigint | string,
    idInstance: string,
    apiToken: string,
    apiUrl: string,
  ): Promise<ClientResult<LogoutData>> {
    const url = buildUrl(
      apiUrl,
      `/waInstance${encodeURIComponent(idInstance)}/logout/${encodeURIComponent(apiToken)}`,
    );
    return this.request(instanceDbId, url, (raw) => {
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return { isLogout: obj.isLogout === true };
    });
  }
}
