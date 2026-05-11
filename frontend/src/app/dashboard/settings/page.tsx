"use client";

import { useState, useEffect } from "react";
import { apiGet, apiPost } from "@/lib/api";

interface AccountSettings {
  phone?: string;
  avatar?: string;
  wid?: string;
  stateInstance?: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [qrData, setQrData] = useState<string | null>(null);
  const [qrType, setQrType] = useState<string>("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    try { setSettings(await apiGet<AccountSettings>("/api/account-settings")); } catch { /* */ }
  }

  async function getQR() {
    try {
      const data = await apiGet<{ type: string; data?: string }>("/api/qr");
      setQrType(data.type);
      if (data.type === "qrCode" && data.data) setQrData(data.data);
      else setQrData(null);
    } catch { /* */ }
  }

  async function reboot() {
    await apiPost("/api/reboot", {});
    loadSettings();
  }

  async function setupWebhook() {
    if (!webhookUrl.trim()) return;
    setSaving(true);
    try { await apiPost("/api/setup-webhook", { url: webhookUrl.trim() }); } catch { /* */ } finally { setSaving(false); }
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">⚙️ Настройки</h1>
        <p className="text-text-muted text-sm mt-1">Управление инстансом и профилем</p>
      </div>

      {/* Instance status */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">📡 Инстанс</h3>
        {settings && (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-text-muted text-xs">Телефон</span><div className="text-text font-medium">{settings.phone || "—"}</div></div>
            <div><span className="text-text-muted text-xs">WID</span><div className="text-text font-mono text-xs">{settings.wid || "—"}</div></div>
          </div>
        )}
        <div className="flex gap-3">
          <button onClick={getQR} className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-text hover:border-accent/40 transition-colors">
            📱 QR-код
          </button>
          <button onClick={reboot} className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-text hover:border-warning/40 transition-colors">
            🔄 Перезапуск
          </button>
        </div>
        {qrData && (
          <div className="flex justify-center p-4 bg-white rounded-xl">
            <img src={`data:image/png;base64,${qrData}`} alt="QR Code" className="w-48 h-48" />
          </div>
        )}
        {qrType === "alreadyLogged" && (
          <div className="px-4 py-3 bg-success-bg border border-success/20 rounded-xl text-success text-sm">
            ✅ Инстанс уже авторизован
          </div>
        )}
      </div>

      {/* Webhook */}
      <div className="settings-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">🔗 Webhook</h3>
        <div className="flex gap-3">
          <input type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your-domain.com/webhook"
            className="flex-1 px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                       focus:outline-none focus:border-accent/50 transition-colors" />
          <button onClick={setupWebhook} disabled={saving}
            className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95">
            {saving ? "..." : "Установить"}
          </button>
        </div>
      </div>
    </div>
  );
}
