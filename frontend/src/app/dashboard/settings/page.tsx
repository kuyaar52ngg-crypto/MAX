"use client";

import { useState, useEffect } from "react";
import {
  KeyRound,
  Link2,
  RefreshCw,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import { AntiBanSettingsForm } from "@/components/anti-ban/AntiBanSettingsForm";
import { AntiBanConfig, DEFAULT_ANTI_BAN_CONFIG } from "@/lib/anti-ban";
import { CredentialsWizard } from "@/components/settings/CredentialsWizard";
import { SuiteSettingsForm } from "@/components/scheduling";
import { usePersistedState } from "@/lib/hooks/usePersistedState";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export default function SettingsPage() {
  const [webhookUrl, setWebhookUrl] = usePersistedState<string>(
    "settings:webhookUrl",
    "",
  );
  const [saving, setSaving] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const [antiBanConfig, setAntiBanConfig] = useState<AntiBanConfig | null>(null);
  const [antiBanError, setAntiBanError] = useState<string | null>(null);

  useEffect(() => {
    loadAntiBanConfig();
  }, []);

  async function loadAntiBanConfig() {
    setAntiBanError(null);
    try {
      const data = await apiGet<AntiBanConfig>("/api/anti-ban-config");
      setAntiBanConfig(data);
    } catch (err: unknown) {
      // Fall back to defaults if the endpoint is unreachable so the form is still usable.
      setAntiBanConfig(DEFAULT_ANTI_BAN_CONFIG);
      setAntiBanError(
        err instanceof Error
          ? err.message
          : "Не удалось загрузить конфиг анти-бан защиты",
      );
    }
  }

  async function reboot() {
    setInstanceError(null);
    setRebooting(true);
    try {
      await apiPost("/api/reboot", {});
    } catch (err: unknown) {
      setInstanceError(
        err instanceof Error ? err.message : "Не удалось перезапустить инстанс",
      );
    } finally {
      setRebooting(false);
    }
  }

  async function setupWebhook() {
    if (!webhookUrl.trim()) return;
    setSaving(true);
    setInstanceError(null);
    try {
      await apiPost("/api/setup-webhook", { url: webhookUrl.trim() });
    } catch (err: unknown) {
      setInstanceError(
        err instanceof Error ? err.message : "Не удалось установить webhook",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text flex items-center gap-2">
          <SettingsIcon
            className="h-6 w-6 text-text-muted"
            strokeWidth={2}
            aria-hidden="true"
          />
          Настройки
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Подключение GREEN-API, анти-бан защита и сервисные действия
        </p>
      </div>

      {/* Wizard подключения GREEN-API (credentials → QR → success) */}
      <CredentialsWizard />

      {/* Управление несколькими инстансами через chuжие credentials */}
      <Link
        href="/dashboard/settings/instances"
        className="settings-section glass rounded-2xl p-6 flex items-center justify-between gap-4 hover:border-accent/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <KeyRound className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">
              GREEN API инстансы (до 5 шт.)
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              Подключайте свои или чужие инстансы — нужны только{" "}
              <span className="font-mono">idInstance</span> и{" "}
              <span className="font-mono">apiTokenInstance</span>. Привязка
              MAX через QR.
            </div>
          </div>
        </div>
        <span className="text-text-muted">→</span>
      </Link>

      {instanceError && (
        <div className="px-4 py-3 bg-error-bg border border-error/20 rounded-xl text-error text-sm">
          {instanceError}
        </div>
      )}

      {/* Сервисные действия */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Сервис
        </h3>
        <p className="text-xs text-text-muted">
          Перезапуск инстанса GREEN-API. Используйте, если бот «завис» или после
          смены настроек webhook.
        </p>
        <button
          onClick={reboot}
          disabled={rebooting}
          className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-text hover:border-warning/40 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${rebooting ? "animate-spin" : ""}`}
            strokeWidth={2}
            aria-hidden="true"
          />
          {rebooting ? "Перезапуск…" : "Перезапустить инстанс"}
        </button>
      </div>

      {/* Webhook */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <Link2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Webhook
        </h3>
        <p className="text-xs text-text-muted">
          URL, на который GREEN-API будет присылать входящие сообщения и события
          доставки. Опционально.
        </p>
        <div className="flex gap-3">
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your-domain.com/webhook"
            className="flex-1 px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
          />
          <button
            onClick={setupWebhook}
            disabled={saving}
            className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
          >
            {saving ? "..." : "Установить"}
          </button>
        </div>
      </div>

      {/* Anti-ban protection */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
            <Shield className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Анти-бан защита
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Параметры пауз, лимитов и watchdog для безопасной работы с GREEN-API
          </p>
        </div>
        {antiBanError && (
          <div className="px-4 py-3 bg-warning-bg border border-warning/20 rounded-xl text-warning text-sm">
            {antiBanError}
          </div>
        )}
        {antiBanConfig === null ? (
          <div className="text-text-muted text-sm">Загрузка конфигурации...</div>
        ) : (
          <AntiBanSettingsForm
            initialConfig={antiBanConfig}
            endpoint={`${API_BASE}/api/anti-ban-config`}
            onSaved={(fresh) => setAntiBanConfig(fresh)}
          />
        )}
      </div>

      {/* Broadcast Scheduling Suite settings */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
            <KeyRound className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Планирование рассылок
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Approval gate, лимиты Burst и канал Telegram-уведомлений.
          </p>
        </div>
        <SuiteSettingsForm />
      </div>
    </div>
  );
}
