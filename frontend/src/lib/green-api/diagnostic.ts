/**
 * Диагностический маппинг между ошибками GREEN-API и тем, что мы возвращаем
 * клиенту (Requirement 8). Тотален — для любого входа есть валидный
 * `DiagnosticError` с непустым русскоязычным `message`.
 */

import type {
  DiagnosticError,
  DiagnosticErrorCode,
  InstanceStatus,
} from "./types/contracts";

export type DiagnosticCause = "timeout" | "network" | "abort";

/**
 * Маппинг (upstream HTTP code, cause) → DiagnosticError.
 *
 * Cause приоритетен — если мы знаем что произошёл timeout/network,
 * upstream code будет null. В остальных случаях смотрим на код.
 */
export function mapHttpToDiagnostic(
  upstreamHttpStatus: number | null,
  upstreamBody: string | null,
  cause?: DiagnosticCause,
): DiagnosticError {
  const trimmedBody =
    typeof upstreamBody === "string" && upstreamBody.length > 512
      ? upstreamBody.slice(0, 512)
      : upstreamBody;

  if (cause === "timeout") {
    return {
      code: "timeout",
      httpStatus: 504,
      message: "GREEN API не ответил за 15 секунд. Повторите попытку через минуту",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  if (cause === "network" || cause === "abort") {
    return {
      code: "network_error",
      httpStatus: 503,
      message: "Не удалось подключиться к GREEN API. Проверьте интернет-соединение",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }

  if (upstreamHttpStatus === null) {
    return {
      code: "network_error",
      httpStatus: 503,
      message: "Не удалось подключиться к GREEN API. Проверьте интернет-соединение",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }

  if (upstreamHttpStatus === 401 || upstreamHttpStatus === 403) {
    return {
      code: "invalid_credentials",
      httpStatus: 400,
      message:
        "Неверные credentials: проверьте idInstance и apiTokenInstance",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  if (upstreamHttpStatus === 466) {
    return {
      code: "quota_exceeded",
      httpStatus: 402,
      message:
        "Превышена квота инстанса: подписка на стороне владельца исчерпана или закончилась. Обратитесь к владельцу аккаунта GREEN API",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  if (upstreamHttpStatus === 429) {
    return {
      code: "rate_limited",
      httpStatus: 429,
      message: "Слишком частые запросы к GREEN API. Подождите 30 секунд и повторите",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  if (upstreamHttpStatus === 404) {
    return {
      code: "not_found",
      httpStatus: 404,
      message: "Инстанс не найден на стороне GREEN API. Проверьте idInstance",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  if (upstreamHttpStatus >= 500 && upstreamHttpStatus <= 599) {
    return {
      code: "server_error",
      httpStatus: 502,
      message: "GREEN API временно недоступен. Повторите попытку через минуту",
      upstreamHttpStatus,
      upstreamBody: trimmedBody,
    };
  }
  return {
    code: "unknown",
    httpStatus: 500,
    message: `Неизвестная ошибка GREEN API (HTTP ${upstreamHttpStatus}). Свяжитесь с поддержкой`,
    upstreamHttpStatus,
    upstreamBody: trimmedBody,
  };
}

/**
 * Текст для UI по `InstanceStatus`. Используется badge-tooltip-ами
 * и сообщениями в QR-модалке (Requirement 8.5–8.8).
 */
export function diagnosticTextFor(status: InstanceStatus | null | undefined): string {
  switch (status) {
    case "authorized":
      return "Инстанс активен, MAX подключён, рассылка возможна.";
    case "notAuthorized":
      return "Инстанс не авторизован. Отсканируйте QR из приложения MAX.";
    case "starting":
      return "Инстанс инициализируется, ожидайте 10–30 секунд";
    case "yellowCard":
      return "Аккаунт под подозрением: GREEN API ограничил исходящие действия. Снизьте темп рассылок и подождите 24 часа";
    case "blocked":
      return "Аккаунт заблокирован GREEN API. Обратитесь к владельцу инстанса для разблокировки";
    case "sleepMode":
      return "Инстанс в режиме сна из-за долгой неактивности. Откройте MAX на телефоне для возобновления";
    case "unknown":
    case null:
    case undefined:
    default:
      return "Состояние инстанса не определено. Нажмите «Проверить сейчас» для актуализации.";
  }
}

/**
 * Текст для UI по `DiagnosticErrorCode`. Тот же текст, что в `mapHttpToDiagnostic`,
 * но допускает прямой вызов из клиентских компонентов.
 */
export function diagnosticTextForErrorCode(code: DiagnosticErrorCode): string {
  switch (code) {
    case "invalid_credentials":
      return "Неверные credentials: проверьте idInstance и apiTokenInstance";
    case "quota_exceeded":
      return "Превышена квота инстанса: подписка на стороне владельца исчерпана или закончилась. Обратитесь к владельцу аккаунта GREEN API";
    case "rate_limited":
      return "Слишком частые запросы к GREEN API. Подождите 30 секунд и повторите";
    case "timeout":
      return "GREEN API не ответил за 15 секунд. Повторите попытку через минуту";
    case "not_found":
      return "Инстанс не найден на стороне GREEN API. Проверьте idInstance";
    case "server_error":
      return "GREEN API временно недоступен. Повторите попытку через минуту";
    case "network_error":
      return "Не удалось подключиться к GREEN API. Проверьте интернет-соединение";
    case "unknown":
    default:
      return "Неизвестная ошибка GREEN API. Свяжитесь с поддержкой";
  }
}
