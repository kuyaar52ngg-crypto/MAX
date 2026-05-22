"use client";

/**
 * `SuiteSettingsForm` — операторские настройки broadcast-suite:
 *   - approval_required_above_n
 *   - burst_recipient_limit
 *   - telegram_bot_token (encrypted on server)
 *   - telegram_chat_id
 *
 * Используется в `/dashboard/settings`.
 */

import { useEffect, useState } from "react";
import {
  Bell,
  Bolt,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Users,
} from "lucide-react";

import { nxGet, nxPut } from "@/lib/api";

interface SuiteSettings {
  approval_required_above_n: number;
  burst_recipient_limit: number;
  telegram_bot_token_set: boolean;
  telegram_chat_id: string | null;
}

export function SuiteSettingsForm() {
  const [data, setData] = useState<SuiteSettings | null>(null);
  const [approvalThreshold, setApprovalThreshold] = useState(0);
  const [burstLimit, setBurstLimit] = useState(100);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await nxGet<SuiteSettings>("/api/profile/suite-settings");
        if (cancelled) return;
        setData(fresh);
        setApprovalThreshold(fresh.approval_required_above_n);
        setBurstLimit(fresh.burst_recipient_limit);
        setTelegramChatId(fresh.telegram_chat_id ?? "");
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить настройки",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setError(null);
    setSavedAt(null);
    if (
      !Number.isInteger(approvalThreshold) ||
      approvalThreshold < 0 ||
      approvalThreshold > 100000
    ) {
      setError("Порог одобрения должен быть целым в диапазоне 0–100000");
      return;
    }
    if (!Number.isInteger(burstLimit) || burstLimit < 1 || burstLimit > 10000) {
      setError("Burst-лимит должен быть целым в диапазоне 1–10000");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        approval_required_above_n: approvalThreshold,
        burst_recipient_limit: burstLimit,
        telegram_chat_id: telegramChatId.trim() || null,
      };
      if (telegramToken.trim().length > 0) {
        body.telegram_bot_token = telegramToken.trim();
      }
      const fresh = await nxPut<SuiteSettings>(
        "/api/profile/suite-settings",
        body,
      );
      setData(fresh);
      setTelegramToken("");
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function clearTelegramToken() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await nxPut<SuiteSettings>("/api/profile/suite-settings", {
        telegram_bot_token: "",
      });
      setData(fresh);
      setTelegramToken("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось очистить токен");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-text-muted text-sm">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        Загрузка…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-error/30 bg-error-bg p-4 text-sm text-error">
        Не удалось загрузить настройки suite
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-5"
    >
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <ShieldCheck className="h-4 w-4 text-accent" strokeWidth={2} />
          Требовать одобрение для рассылок больше N получателей
        </label>
        <p className="text-xs text-text-muted">
          0 — отключено (одобрение не требуется ни для каких рассылок). Если
          указать N &gt; 0, любая рассылка с количеством получателей &gt; N
          будет требовать подтверждения от назначенного аппрувера.
        </p>
        <input
          type="number"
          min={0}
          max={100000}
          value={approvalThreshold}
          onChange={(e) => setApprovalThreshold(Number(e.target.value) || 0)}
          className="w-40 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50 font-mono"
        />
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <Bolt className="h-4 w-4 text-warning" strokeWidth={2} />
          Лимит получателей для Burst-режима
        </label>
        <p className="text-xs text-text-muted">
          Burst идёт без long-pause и игнорирует тихие часы — это рискованный
          режим. Лимит защищает от случайных гигантских отправок. По умолчанию
          100. Любая попытка burst-рассылки больше лимита будет отклонена.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={10000}
            value={burstLimit}
            onChange={(e) => setBurstLimit(Number(e.target.value) || 1)}
            className="w-40 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50 font-mono"
          />
          <span className="text-xs text-text-muted inline-flex items-center gap-1">
            <Users className="h-3 w-3" strokeWidth={2} /> получателей
          </span>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-bg-elevated p-4">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-text">
            <Bell className="h-4 w-4 text-accent" strokeWidth={2} />
            Telegram для уведомлений
          </label>
          <p className="text-xs text-text-muted mt-1">
            Получайте уведомления (старт/пауза/завершение/ошибки рассылок) в
            личный Telegram-чат. Создайте бота через @BotFather, скопируйте
            HTTP API token и узнайте ваш chat_id (например, через @userinfobot).
            Токен сохраняется в зашифрованном виде.
          </p>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Bot HTTP API token{" "}
            {data.telegram_bot_token_set && (
              <span className="text-success inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
                сохранён
              </span>
            )}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
              placeholder={
                data.telegram_bot_token_set
                  ? "оставьте пустым, чтобы не менять"
                  : "1234567:ABCdefghIJK..."
              }
              autoComplete="new-password"
              className="flex-1 px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 font-mono"
            />
            {data.telegram_bot_token_set && (
              <button
                type="button"
                onClick={clearTelegramToken}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-xs text-error hover:bg-error/10 transition-colors disabled:opacity-50"
              >
                Очистить
              </button>
            )}
          </div>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Chat ID</label>
          <input
            type="text"
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
            placeholder="123456789 (для личного чата) или -1001234567890 (для группы)"
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 font-mono"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-muted">
          {savedAt && Date.now() - savedAt < 5000 ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> Сохранено
            </span>
          ) : null}
        </span>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-bg text-sm font-medium transition-all disabled:opacity-50 active:scale-95"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
          Сохранить
        </button>
      </div>
    </form>
  );
}
