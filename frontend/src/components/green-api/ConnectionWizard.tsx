"use client";

/**
 * `ConnectionWizard` — 4-шаговый мастер привязки чужого инстанса GREEN-API.
 *
 * Шаги:
 *   1. instructions    — статичная инструкция «попроси у владельца id+token»
 *   2. credentials     — форма ввода id/token/name
 *   3. status_branch   — спиннер пока летит POST
 *   4. terminal        — один из success | qr | starting | yellow_card |
 *                        blocked | sleep_mode | error
 *
 * Никогда не вызывает GREEN-API напрямую — всё через `POST /api/green-instances`
 * + новые эндпойнты state/qr/reauth/credentials.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  KeyRound,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";

import { nxPost } from "@/lib/api";
import type {
  InstanceStatus,
  PostReauthResponse,
} from "@/lib/green-api";

import { DiagnosticMessage } from "./DiagnosticMessage";
import { QRModal } from "./QRModal";
import { SharedInstanceWarningBanner } from "./SharedInstanceWarningBanner";

type WizardStep =
  | "instructions"
  | "credentials"
  | "status_branch"
  | "qr"
  | "starting"
  | "success"
  | "yellow_card"
  | "blocked"
  | "sleep_mode"
  | "error";

interface InstanceCreatedResponse {
  id: number;
  name: string;
  id_instance: string;
  status: InstanceStatus;
  phone: string | null;
  shared_instance_warning?: boolean;
  is_primary: boolean;
}

export interface ConnectionWizardProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (instance: { id: number; status: InstanceStatus }) => void;
  /** Если задан — wizard стартует сразу с reauth-flow для существующего инстанса. */
  reauthInstanceId?: bigint | string | number | null;
  /** Если задан — wizard стартует с пред-заполненными credentials (например, для миграции). */
  initialIdInstance?: string;
}

export function ConnectionWizard({
  open,
  onClose,
  onSuccess,
  reauthInstanceId = null,
  initialIdInstance = "",
}: ConnectionWizardProps) {
  const [step, setStep] = useState<WizardStep>(
    reauthInstanceId ? "qr" : "instructions",
  );
  const [idInstance, setIdInstance] = useState(initialIdInstance);
  const [apiToken, setApiToken] = useState("");
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("https://api.green-api.com");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdInstance, setCreatedInstance] =
    useState<InstanceCreatedResponse | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [sharedWarning, setSharedWarning] = useState(false);

  const activeInstanceId =
    reauthInstanceId ?? (createdInstance ? createdInstance.id : null);

  if (!open) return null;

  function reset() {
    setStep(reauthInstanceId ? "qr" : "instructions");
    setError(null);
    setSubmitting(false);
    setCreatedInstance(null);
    setPhone(null);
    setSharedWarning(false);
  }

  function close() {
    reset();
    setIdInstance(initialIdInstance);
    setApiToken("");
    setName("");
    onClose();
  }

  function fieldError(): string | null {
    if (!idInstance.trim()) return "Поле idInstance обязательно";
    if (!apiToken.trim()) return "Поле apiTokenInstance обязательно";
    return null;
  }

  async function submitCredentials() {
    const fe = fieldError();
    if (fe) {
      setError(fe);
      return;
    }
    setError(null);
    setSubmitting(true);
    setStep("status_branch");

    try {
      const trimmedName = name.trim();
      const finalName =
        trimmedName || `Инстанс ${idInstance.trim().slice(-4)}`;
      const created = await nxPost<InstanceCreatedResponse>(
        "/api/green-instances",
        {
          name: finalName,
          id_instance: idInstance.trim(),
          api_token: apiToken.trim(),
          api_url: apiUrl.trim() || "https://api.green-api.com",
        },
      );
      setCreatedInstance(created);
      setSharedWarning(Boolean(created.shared_instance_warning));
      setPhone(created.phone);

      // Маппинг статуса → шаг (Property 10).
      const map: Record<InstanceStatus, WizardStep> = {
        authorized: "success",
        notAuthorized: "qr",
        starting: "starting",
        yellowCard: "yellow_card",
        blocked: "blocked",
        sleepMode: "sleep_mode",
        unknown: "error",
      };
      setStep(map[created.status] ?? "error");
      if (created.status === "authorized") {
        onSuccess?.({ id: created.id, status: created.status });
      }
    } catch (e: unknown) {
      const message =
        e instanceof Error
          ? e.message
          : "Не удалось создать инстанс. Попробуйте ещё раз.";
      setError(message);
      setStep("credentials");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQrAuthorized(snapshot: {
    phone: string | null;
    sharedInstanceWarning: boolean;
  }) {
    setPhone(snapshot.phone);
    setSharedWarning((prev) => prev || snapshot.sharedInstanceWarning);
    setStep("success");
    if (createdInstance) {
      onSuccess?.({ id: createdInstance.id, status: "authorized" });
    } else if (reauthInstanceId) {
      onSuccess?.({
        id: Number(reauthInstanceId),
        status: "authorized",
      });
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">
            {reauthInstanceId
              ? "Перепривязать инстанс"
              : "Подключить новый инстанс GREEN API"}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Закрыть"
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {step === "instructions" && (
            <InstructionsStep onNext={() => setStep("credentials")} />
          )}

          {step === "credentials" && (
            <CredentialsForm
              idInstance={idInstance}
              setIdInstance={setIdInstance}
              apiToken={apiToken}
              setApiToken={setApiToken}
              name={name}
              setName={setName}
              apiUrl={apiUrl}
              setApiUrl={setApiUrl}
              error={error}
              submitting={submitting}
              onSubmit={submitCredentials}
              onBack={() => setStep("instructions")}
            />
          )}

          {step === "status_branch" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-muted">
              <Loader2 className="h-8 w-8 animate-spin" strokeWidth={2} />
              <p className="text-sm">Проверяем credentials…</p>
            </div>
          )}

          {step === "qr" && activeInstanceId !== null && (
            <>
              <p className="text-sm text-text-secondary">
                Откройте приложение MAX и отсканируйте QR-код.
              </p>
              <QRModal
                instanceId={activeInstanceId}
                open={true}
                onAuthorized={handleQrAuthorized}
                onClose={close}
                onError={(m) => setError(m)}
              />
            </>
          )}

          {step === "starting" && activeInstanceId !== null && (
            <>
              <DiagnosticMessage status="starting" variant="banner" />
              <QRModal
                instanceId={activeInstanceId}
                open={true}
                title="Инициализация инстанса"
                onAuthorized={handleQrAuthorized}
                onClose={close}
                onError={(m) => setError(m)}
              />
            </>
          )}

          {step === "yellow_card" && (
            <TerminalScreen
              kind="warning"
              title="Жёлтая карточка"
              status="yellowCard"
              onClose={close}
            />
          )}

          {step === "blocked" && (
            <TerminalScreen
              kind="error"
              title="Инстанс заблокирован"
              status="blocked"
              onClose={close}
            />
          )}

          {step === "sleep_mode" && (
            <TerminalScreen
              kind="warning"
              title="Инстанс в режиме сна"
              status="sleepMode"
              onClose={close}
            />
          )}

          {step === "error" && (
            <TerminalScreen
              kind="error"
              title="Не удалось подключить инстанс"
              customMessage={
                error ?? "Неизвестная ошибка. Попробуйте ещё раз."
              }
              onClose={close}
              onRetry={() => setStep("credentials")}
            />
          )}

          {step === "success" && (
            <SuccessScreen
              phone={phone}
              sharedWarning={sharedWarning}
              isPrimary={createdInstance?.is_primary ?? false}
              onClose={close}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function InstructionsStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-accent-subtle/40 border border-accent/20 p-4">
        <div className="flex items-start gap-3">
          <Info
            className="h-5 w-5 mt-0.5 shrink-0 text-accent"
            strokeWidth={2}
          />
          <div className="space-y-2 text-sm text-text-secondary">
            <p className="font-semibold text-text">
              Что нужно от владельца инстанса GREEN API
            </p>
            <p>
              Попросите у владельца аккаунта <strong>ровно два значения</strong>:
            </p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <span className="font-mono text-text">idInstance</span> —
                цифровой идентификатор инстанса (10+ цифр)
              </li>
              <li>
                <span className="font-mono text-text">apiTokenInstance</span> —
                токен доступа к этому инстансу
              </li>
            </ul>
            <p className="text-xs text-text-muted">
              Доступ к консоли{" "}
              <a
                href="https://console.green-api.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                console.green-api.com
              </a>{" "}
              вам не нужен — мы привяжем MAX к этому инстансу через QR-код
              на следующем шаге.
            </p>
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all active:scale-95"
        >
          Дальше
          <ArrowRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

interface CredentialsFormProps {
  idInstance: string;
  setIdInstance: (v: string) => void;
  apiToken: string;
  setApiToken: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  apiUrl: string;
  setApiUrl: (v: string) => void;
  error: string | null;
  submitting: boolean;
  onSubmit: () => void;
  onBack: () => void;
}

function CredentialsForm({
  idInstance,
  setIdInstance,
  apiToken,
  setApiToken,
  name,
  setName,
  apiUrl,
  setApiUrl,
  error,
  submitting,
  onSubmit,
  onBack,
}: CredentialsFormProps) {
  const canSubmit =
    idInstance.trim().length > 0 && apiToken.trim().length > 0 && !submitting;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            <KeyRound className="inline h-3 w-3 mr-1" />
            idInstance *
          </label>
          <input
            type="text"
            value={idInstance}
            onChange={(e) => setIdInstance(e.target.value)}
            placeholder="1101000001"
            autoComplete="off"
            className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            apiTokenInstance *
          </label>
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="b1c2d3e4..."
            autoComplete="off"
            className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-text-muted mb-1">
          Имя (необязательно)
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Инстанс ${idInstance.trim().slice(-4) || "0000"}`}
          className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer select-none hover:text-text transition-colors">
          Дополнительно: GREEN API URL
        </summary>
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://api.green-api.com"
          className="mt-2 w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
        />
      </details>

      {error && <DiagnosticMessage variant="banner" customMessage={error} />}

      <div className="flex justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text transition-colors"
        >
          ← Назад
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              Проверяем…
            </>
          ) : (
            <>
              Подключить
              <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </>
          )}
        </button>
      </div>
    </form>
  );
}

interface TerminalScreenProps {
  kind: "warning" | "error";
  title: string;
  status?: InstanceStatus;
  customMessage?: string;
  onClose: () => void;
  onRetry?: () => void;
}

function TerminalScreen({
  kind,
  title,
  status,
  customMessage,
  onClose,
  onRetry,
}: TerminalScreenProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-4">
        <div
          className={`flex h-14 w-14 items-center justify-center rounded-full ${
            kind === "error"
              ? "bg-error-bg text-error"
              : "bg-warning-bg text-warning"
          }`}
        >
          <AlertTriangle className="h-8 w-8" strokeWidth={2} />
        </div>
        <h3 className="text-lg font-semibold text-text">{title}</h3>
        <div className="max-w-md text-center">
          <DiagnosticMessage
            status={status}
            customMessage={customMessage}
            variant="inline"
          />
        </div>
      </div>
      <div className="flex justify-center gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-5 py-2 bg-surface border border-border text-text-secondary text-sm font-medium rounded-xl hover:border-accent/40 transition-colors"
          >
            Попробовать снова
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}

interface SuccessScreenProps {
  phone: string | null;
  sharedWarning: boolean;
  isPrimary: boolean;
  onClose: () => void;
}

function SuccessScreen({
  phone,
  sharedWarning,
  isPrimary,
  onClose,
}: SuccessScreenProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2 className="h-8 w-8" strokeWidth={2.2} />
        </div>
        <h3 className="text-lg font-semibold text-text">
          Инстанс успешно подключён
        </h3>
        {phone && (
          <p className="text-sm text-text-secondary">
            Номер MAX: <span className="font-mono">{phone}</span>
          </p>
        )}
        {isPrimary && (
          <p className="inline-flex items-center gap-1 text-xs text-accent">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} /> Основной
            инстанс
          </p>
        )}
      </div>
      <SharedInstanceWarningBanner visible={sharedWarning} />
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all"
        >
          Готово
        </button>
      </div>
    </div>
  );
}
