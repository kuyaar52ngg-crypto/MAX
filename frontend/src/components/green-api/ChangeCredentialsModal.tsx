"use client";

/**
 * `ChangeCredentialsModal` — окно смены idInstance/apiTokenInstance на
 * существующей записи GreenInstance.
 *
 * Backend атомарно валидирует новые credentials через `getStateInstance`
 * и перезаписывает запись. is_primary и name сохраняются (Property 6).
 */

import { useState } from "react";
import { ArrowRight, KeyRound, Loader2, X } from "lucide-react";

import { nxPost } from "@/lib/api";
import type {
  PostCredentialsResponse,
} from "@/lib/green-api";

import { DiagnosticMessage } from "./DiagnosticMessage";

export interface ChangeCredentialsModalProps {
  instanceId: bigint | string | number;
  currentIdInstance: string;
  currentApiUrl: string;
  open: boolean;
  onClose: () => void;
  onSuccess: (response: PostCredentialsResponse) => void;
}

export function ChangeCredentialsModal({
  instanceId,
  currentIdInstance,
  currentApiUrl,
  open,
  onClose,
  onSuccess,
}: ChangeCredentialsModalProps) {
  const [idInstance, setIdInstance] = useState(currentIdInstance);
  const [apiToken, setApiToken] = useState("");
  const [apiUrl, setApiUrl] = useState(currentApiUrl);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit() {
    setError(null);
    if (!idInstance.trim()) {
      setError("Поле idInstance обязательно");
      return;
    }
    if (!apiToken.trim()) {
      setError("Поле apiTokenInstance обязательно");
      return;
    }
    setSubmitting(true);
    try {
      const res = await nxPost<PostCredentialsResponse>(
        `/api/green-instances/${instanceId}/credentials`,
        {
          id_instance: idInstance.trim(),
          api_token: apiToken.trim(),
          api_url: apiUrl.trim() || "https://api.green-api.com",
        },
      );
      onSuccess(res);
      onClose();
      setApiToken("");
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Не удалось обновить credentials";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">
            Сменить credentials
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="p-5 space-y-4"
        >
          <p className="text-xs text-text-muted">
            Имя инстанса и метка «основной» сохранятся. Только idInstance,
            apiTokenInstance (и опционально URL) будут обновлены.
          </p>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              <KeyRound className="inline h-3 w-3 mr-1" />
              Новый idInstance
            </label>
            <input
              type="text"
              value={idInstance}
              onChange={(e) => setIdInstance(e.target.value)}
              autoComplete="off"
              className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text focus:outline-none focus:border-accent/50 transition-colors font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Новый apiTokenInstance
            </label>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="b1c2d3e4..."
              autoComplete="off"
              className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text focus:outline-none focus:border-accent/50 transition-colors font-mono"
            />
          </div>
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer select-none hover:text-text transition-colors">
              GREEN API URL
            </summary>
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              className="mt-2 w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text focus:outline-none focus:border-accent/50 transition-colors"
            />
          </details>

          {error && <DiagnosticMessage variant="inline" customMessage={error} />}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  Сохраняем…
                </>
              ) : (
                <>
                  Сохранить
                  <ArrowRight className="h-4 w-4" strokeWidth={2} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
