"use client";

import { useEffect, useState } from "react";
import { Bell, CheckCircle2, Loader2, Send } from "lucide-react";

import { nxGet, nxPut } from "@/lib/api";

interface NotificationSettings {
  telegram_bot_token_set: boolean;
  telegram_chat_id: string | null;
}

export function NotificationSettingsForm() {
  const [data, setData] = useState<NotificationSettings | null>(null);
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
        const fresh = await nxGet<NotificationSettings>("/api/profile/suite-settings");
        if (cancelled) return;
        setData(fresh);
        setTelegramChatId(fresh.telegram_chat_id ?? "");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Не удалось загрузить настройки уведомлений");
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
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        telegram_chat_id: telegramChatId.trim() || null,
      };
      if (telegramToken.trim().length > 0) {
        body.telegram_bot_token = telegramToken.trim();
      }
      const fresh = await nxPut<NotificationSettings>("/api/profile/suite-settings", body);
      setData(fresh);
      setTelegramToken("");
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить настройки уведомлений");
    } finally {
      setBusy(false);
    }
  }

  async function clearTelegramToken() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await nxPut<NotificationSettings>("/api/profile/suite-settings", {
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-4"
    >
      <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-4">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-text">
            <Bell className="h-4 w-4 text-accent" strokeWidth={2} />
            Telegram для уведомлений
          </label>
          <p className="text-xs text-text-muted mt-1">
            Эти уведомления используются во всей системе: рассылки, проверка номеров,
            планировщик, ошибки и важные события. Создайте бота через @BotFather,
            скопируйте HTTP API token и укажите chat_id. Токен хранится зашифрованным.
          </p>
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">
            Bot HTTP API token{" "}
            {data?.telegram_bot_token_set && (
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
                data?.telegram_bot_token_set
                  ? "оставьте пустым, чтобы не менять"
                  : "1234567:ABCdefghIJK..."
              }
              autoComplete="new-password"
              className="flex-1 px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 font-mono"
            />
            {data?.telegram_bot_token_set && (
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
            placeholder="123456789 или -1001234567890"
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
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          ) : (
            <Send className="h-4 w-4" strokeWidth={2} />
          )}
          Сохранить уведомления
        </button>
      </div>
    </form>
  );
}
