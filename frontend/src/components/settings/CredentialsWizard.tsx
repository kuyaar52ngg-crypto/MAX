"use client";

/**
 * `CredentialsWizard` — 3-шаговый мастер подключения GREEN-API.
 *
 * Кейс: у пользователя есть только idInstance + apiTokenInstance от
 * админа GREEN-API, доступа к консоли green-api.com нет, MAX-аккаунт
 * на инстансе ещё не авторизован. Старая Settings-страница показывала
 * 3 несвязанные секции (credentials → инстанс → webhook) — было неясно,
 * с чего начинать. Wizard заменяет их единым линейным флоу:
 *
 *   1. Step_Credentials — ввод id/token, кнопка «Проверить» делает
 *      `GET /api/status` (Flask проксирует к GREEN-API getStateInstance)
 *      _до_ сохранения. Показывает реальный state и блокирует переход
 *      на Step 2 при ошибке credentials.
 *   2. Step_Qr        — большой QR + auto-polling state каждые 2 сек.
 *      При state==="authorized" автоматически переключается на Step 3.
 *      Реализовано в `<QrPoller>`.
 *   3. Step_Success   — зелёный экран, кнопки «Открыть рассылку» и
 *      «Изменить credentials» (вернуться на Step 1).
 *
 * Compact-режим: если на mount-е already credentials.has_credentials &&
 * state === "authorized" — wizard сворачивается в строку
 * «✓ Подключено: {phone}» с ссылкой «Изменить».
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Edit3,
  KeyRound,
  Loader2,
  QrCode,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

import { apiGet } from "@/lib/api";
import { invalidateCredentialsCache, nxGet, nxPost } from "@/lib/api";

import { QrPoller } from "./QrPoller";

interface GreenCredentials {
  green_api_id: string;
  green_api_token: string;
  green_api_url: string;
  has_credentials: boolean;
}

type Step = "credentials" | "qr" | "success";

const STEP_ORDER: Step[] = ["credentials", "qr", "success"];
const STEP_LABELS: Record<Step, string> = {
  credentials: "Credentials",
  qr: "Авторизация",
  success: "Готово",
};

export interface CredentialsWizardProps {
  /** Опциональный callback после успешного завершения. */
  onComplete?(): void;
}

export function CredentialsWizard({ onComplete }: CredentialsWizardProps) {
  const [credentials, setCredentials] = useState<GreenCredentials>({
    green_api_id: "",
    green_api_token: "",
    green_api_url: "https://api.green-api.com",
    has_credentials: false,
  });
  const [step, setStep] = useState<Step>("credentials");
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  // Шаг 1
  const [verifying, setVerifying] = useState(false);
  const [verifyState, setVerifyState] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await nxGet<GreenCredentials>("/api/profile/credentials");
        if (cancelled) return;
        setCredentials(data);
        // Автоопределение шага по факту подключения
        if (data.has_credentials) {
          // Проверим state — если authorized, схлопнем wizard.
          try {
            const status = await apiGet<{ state: string }>("/api/status");
            if (cancelled) return;
            if (status.state === "authorized") {
              try {
                const settings = await apiGet<{ phone?: string; wid?: string }>(
                  "/api/account-settings",
                );
                if (!cancelled) setPhone(settings.phone || settings.wid || null);
              } catch {
                /* phone optional */
              }
              setStep("success");
              setCollapsed(true);
            } else {
              setStep("qr");
            }
          } catch {
            // credentials есть, но Flask не достучался — оставим на step 1
            setStep("credentials");
          }
        }
      } catch {
        /* старт с пустого */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canVerify = useMemo(
    () =>
      credentials.green_api_id.trim().length > 0 &&
      credentials.green_api_token.trim().length > 0,
    [credentials.green_api_id, credentials.green_api_token],
  );

  async function saveAndVerify() {
    setVerifying(true);
    setVerifyError(null);
    setVerifyState(null);
    try {
      // 1. Сохраняем credentials в Supabase, чтобы Flask их сразу же подцепил.
      const saved = await nxPost<GreenCredentials>("/api/profile/credentials", {
        green_api_id: credentials.green_api_id.trim(),
        green_api_token: credentials.green_api_token.trim(),
        green_api_url:
          credentials.green_api_url.trim() || "https://api.green-api.com",
      });
      setCredentials(saved);
      invalidateCredentialsCache();

      // 2. Сразу проверяем state — это и есть проверка валидности.
      const status = await apiGet<{ state: string }>("/api/status");
      setVerifyState(status.state);

      if (status.state === "authorized") {
        // MAX уже подключён — пропускаем шаг 2.
        try {
          const settings = await apiGet<{ phone?: string; wid?: string }>(
            "/api/account-settings",
          );
          setPhone(settings.phone || settings.wid || null);
        } catch {
          /* */
        }
        setStep("success");
        onComplete?.();
      } else if (status.state === "blocked") {
        setVerifyError(
          "Инстанс заблокирован GREEN-API. Обратитесь к администратору аккаунта.",
        );
      } else {
        // notAuthorized / starting / sleepMode / yellowCard → переход на QR
        setStep("qr");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Ошибка проверки";
      setVerifyError(msg);
    } finally {
      setVerifying(false);
    }
  }

  function handleAuthorized() {
    // QrPoller сообщил, что state стал "authorized".
    setStep("success");
    apiGet<{ phone?: string; wid?: string }>("/api/account-settings")
      .then((s) => setPhone(s.phone || s.wid || null))
      .catch(() => {});
    onComplete?.();
  }

  const stepIndex = STEP_ORDER.indexOf(step);

  if (loading) {
    return (
      <div className="settings-section glass rounded-2xl p-6 flex items-center gap-3 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        Загрузка настроек GREEN-API…
      </div>
    );
  }

  // Compact-mode для уже авторизованного аккаунта
  if (collapsed && step === "success") {
    return (
      <div className="settings-section glass rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-success-bg text-success">
            <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">
              MAX подключен через GREEN-API
            </div>
            <div className="text-xs text-text-muted truncate">
              {phone ? `Номер: ${phone} · ` : ""}
              ID Instance: {credentials.green_api_id}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setCollapsed(false);
            setStep("credentials");
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:border-accent/40 transition-colors"
        >
          <Edit3 className="h-3.5 w-3.5" strokeWidth={2} />
          Изменить
        </button>
      </div>
    );
  }

  return (
    <div className="settings-section glass rounded-2xl p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Подключение GREEN-API
        </h3>
        <p className="text-xs text-text-muted mt-1">
          3 шага: введите credentials → отсканируйте QR в MAX → готово.
        </p>
      </div>

      {/* Степпер */}
      <div className="flex items-center gap-2">
        {STEP_ORDER.map((s, idx) => {
          const isActive = step === s;
          const isDone = idx < stepIndex;
          return (
            <div key={s} className="flex flex-1 items-center gap-2 min-w-0">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold flex-shrink-0 transition-colors ${
                  isDone
                    ? "bg-success text-bg"
                    : isActive
                      ? "bg-accent text-bg"
                      : "bg-bg-elevated text-text-muted border border-border"
                }`}
              >
                {isDone ? (
                  <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} />
                ) : (
                  idx + 1
                )}
              </div>
              <span
                className={`text-xs truncate ${
                  isActive
                    ? "text-text font-medium"
                    : isDone
                      ? "text-success"
                      : "text-text-muted"
                }`}
              >
                {STEP_LABELS[s]}
              </span>
              {idx < STEP_ORDER.length - 1 && (
                <div
                  className={`h-px flex-1 ${
                    isDone ? "bg-success/40" : "bg-border"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1 */}
      {step === "credentials" && (
        <div className="space-y-4">
          <div className="rounded-xl bg-accent-subtle/40 border border-accent/20 p-3 text-xs text-text-secondary">
            Получите{" "}
            <span className="font-mono">idInstance</span> и{" "}
            <span className="font-mono">apiTokenInstance</span> у администратора
            GREEN-API. Доступ к консоли green-api.com не нужен — MAX-аккаунт
            будем привязывать через QR-код на следующем шаге.
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">
                <KeyRound className="inline h-3 w-3 mr-1" />
                ID Instance
              </label>
              <input
                type="text"
                value={credentials.green_api_id}
                onChange={(e) =>
                  setCredentials((c) => ({ ...c, green_api_id: e.target.value }))
                }
                placeholder="1101000001"
                className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">
                API Token Instance
              </label>
              <input
                type="password"
                value={credentials.green_api_token}
                onChange={(e) =>
                  setCredentials((c) => ({ ...c, green_api_token: e.target.value }))
                }
                placeholder="b1c2d3e4..."
                className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono"
              />
            </div>
          </div>

          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer select-none hover:text-text transition-colors">
              Дополнительно: GREEN-API URL
            </summary>
            <input
              type="url"
              value={credentials.green_api_url}
              onChange={(e) =>
                setCredentials((c) => ({ ...c, green_api_url: e.target.value }))
              }
              placeholder="https://api.green-api.com"
              className="mt-2 w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
            />
          </details>

          {verifyError && (
            <div className="px-4 py-3 bg-error-bg border border-error/20 rounded-xl text-error text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
              {verifyError}
            </div>
          )}
          {verifyState && verifyState !== "authorized" && !verifyError && (
            <div className="px-4 py-3 bg-warning-bg border border-warning/20 rounded-xl text-warning text-sm">
              Credentials валидны, текущий статус инстанса:{" "}
              <span className="font-mono">{verifyState}</span>. Переходим к
              QR-авторизации…
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={saveAndVerify}
              disabled={!canVerify || verifying}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
            >
              {verifying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  Проверяем…
                </>
              ) : (
                <>
                  Проверить и продолжить
                  <ArrowRight className="h-4 w-4" strokeWidth={2} />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === "qr" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <QrCode className="h-4 w-4 text-accent" strokeWidth={2} />
            Отсканируйте QR из приложения MAX.
          </div>
          <QrPoller onAuthorized={handleAuthorized} />
          <div className="flex justify-between items-center text-xs">
            <button
              type="button"
              onClick={() => setStep("credentials")}
              className="text-text-muted hover:text-text transition-colors"
            >
              ← Изменить credentials
            </button>
            <span className="text-text-muted">
              Авторизация определится автоматически
            </span>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === "success" && (
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success-bg text-success">
              <CheckCircle2 className="h-9 w-9" strokeWidth={2.2} />
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold text-text">
                MAX успешно подключен
              </div>
              <div className="text-sm text-text-muted mt-1">
                {phone ? `Номер: ${phone}` : "Инстанс авторизован"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 justify-center">
            <Link
              href="/dashboard/broadcast"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all active:scale-95"
            >
              Перейти к рассылке
              <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </Link>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="px-5 py-2.5 bg-surface border border-border text-text-secondary text-sm font-medium rounded-xl hover:border-accent/40 transition-colors"
            >
              Свернуть
            </button>
            <button
              type="button"
              onClick={() => {
                setCollapsed(false);
                setStep("credentials");
                setVerifyState(null);
                setVerifyError(null);
              }}
              className="px-5 py-2.5 bg-surface border border-border text-text-secondary text-sm font-medium rounded-xl hover:border-accent/40 transition-colors"
            >
              Изменить credentials
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CredentialsWizard;
