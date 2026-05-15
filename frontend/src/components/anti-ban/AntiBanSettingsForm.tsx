"use client";

import { useState } from "react";
import {
  AntiBanConfig,
  DEFAULT_ANTI_BAN_CONFIG,
} from "@/lib/anti-ban";

export interface AntiBanSettingsFormProps {
  /** Initial config (typically loaded from GET /api/anti-ban-config). */
  initialConfig?: AntiBanConfig;
  /** Callback after successful save; receives the freshly returned config. */
  onSaved?: (config: AntiBanConfig) => void;
  /** Custom endpoint override; defaults to /api/anti-ban-config. */
  endpoint?: string;
}

interface FieldGroup {
  title: string;
  fields: { key: keyof AntiBanConfig; label: string; type: "number" | "checkbox" }[];
}

const GROUPS: FieldGroup[] = [
  {
    title: "Паузы между запросами",
    fields: [
      { key: "delay_min", label: "Минимальная пауза (сек)", type: "number" },
      { key: "delay_max", label: "Максимальная пауза (сек)", type: "number" },
      { key: "broadcast_delay_min", label: "Мин. пауза для рассылки (сек)", type: "number" },
      { key: "broadcast_jitter_max", label: "Макс. jitter рассылки (сек)", type: "number" },
    ],
  },
  {
    title: "Батчи и длинные паузы",
    fields: [
      { key: "batch_size", label: "Размер батча", type: "number" },
      { key: "long_pause_every_n", label: "Длинная пауза каждые N запросов", type: "number" },
      { key: "long_pause_seconds", label: "Длительность длинной паузы (сек)", type: "number" },
    ],
  },
  {
    title: "Лимиты",
    fields: [
      { key: "daily_check_limit", label: "Дневной лимит проверок", type: "number" },
      { key: "hourly_check_limit", label: "Часовой лимит проверок", type: "number" },
      { key: "daily_message_limit", label: "Дневной лимит сообщений", type: "number" },
    ],
  },
  {
    title: "Состояние и watchdog",
    fields: [
      { key: "state_poll_interval_seconds", label: "Интервал опроса состояния (сек)", type: "number" },
      { key: "watchdog_timeout_seconds", label: "Таймаут watchdog (сек)", type: "number" },
      { key: "watchdog_check_interval_seconds", label: "Интервал проверки watchdog (сек)", type: "number" },
      { key: "cancel_check_interval_seconds", label: "Интервал проверки отмены (сек)", type: "number" },
      { key: "sse_client_timeout_seconds", label: "Таймаут SSE-клиента (сек)", type: "number" },
    ],
  },
  {
    title: "Retry и backoff",
    fields: [
      { key: "max_retries", label: "Макс. ретраев на 429", type: "number" },
      { key: "max_consecutive_429", label: "Макс. подряд 429", type: "number" },
      { key: "backoff_base_seconds", label: "База backoff (сек)", type: "number" },
    ],
  },
  {
    title: "Скользящее окно и история",
    fields: [
      { key: "sliding_window_n", label: "Размер окна (запросов)", type: "number" },
      { key: "sliding_window_t", label: "Длительность окна (сек)", type: "number" },
      { key: "incident_history_limit", label: "Лимит истории инцидентов", type: "number" },
    ],
  },
  {
    title: "Zero-response предупреждение",
    fields: [
      { key: "warn_on_zero_response_ratio", label: "Предупреждать при отсутствии ответов", type: "checkbox" },
      { key: "response_ratio_window_hours", label: "Окно проверки (часов)", type: "number" },
      { key: "response_ratio_min_outgoing", label: "Мин. отправленных для проверки", type: "number" },
    ],
  },
];

function clientValidate(config: AntiBanConfig): string[] {
  const violations: string[] = [];
  if (config.delay_min < 1.0)
    violations.push(`delay_min должен быть >= 1.0, получено ${config.delay_min}`);
  if (config.delay_max < config.delay_min)
    violations.push(`delay_max должен быть >= delay_min (${config.delay_min}), получено ${config.delay_max}`);
  if (config.batch_size < 1)
    violations.push(`batch_size должен быть >= 1, получено ${config.batch_size}`);
  if (config.long_pause_seconds < 0)
    violations.push(`long_pause_seconds должен быть >= 0, получено ${config.long_pause_seconds}`);
  if (config.daily_check_limit < 1)
    violations.push(`daily_check_limit должен быть >= 1, получено ${config.daily_check_limit}`);
  if (config.hourly_check_limit < 1)
    violations.push(`hourly_check_limit должен быть >= 1, получено ${config.hourly_check_limit}`);
  return violations;
}

export function AntiBanSettingsForm({
  initialConfig,
  onSaved,
  endpoint = "/api/anti-ban-config",
}: AntiBanSettingsFormProps) {
  const [config, setConfig] = useState<AntiBanConfig>(initialConfig ?? DEFAULT_ANTI_BAN_CONFIG);
  const [violations, setViolations] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const updateField = <K extends keyof AntiBanConfig>(key: K, value: AntiBanConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const showDelayMinWarning = config.delay_min < 1.0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local = clientValidate(config);
    if (local.length > 0) {
      setViolations(local);
      return;
    }
    setViolations([]);
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (Array.isArray((data as { violations?: unknown }).violations)) {
          setViolations((data as { violations: string[] }).violations);
        } else {
          setViolations([`HTTP ${response.status}: ${JSON.stringify(data)}`]);
        }
        return;
      }
      const fresh = (await response.json()) as AntiBanConfig;
      setConfig(fresh);
      setSavedAt(Date.now());
      onSaved?.(fresh);
    } catch (err) {
      setViolations([`Ошибка сохранения: ${(err as Error).message}`]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {showDelayMinWarning && (
        <div role="alert" className="p-3 border border-yellow-300 bg-yellow-50 text-yellow-900 rounded">
          Текущее значение <code>delay_min</code> повышает риск блокировки. Рекомендуется значение не ниже 3.0 секунды.
        </div>
      )}
      {violations.length > 0 && (
        <div role="alert" className="p-3 border border-red-300 bg-red-50 text-red-900 rounded">
          <ul className="list-disc list-inside">
            {violations.map((v, i) => <li key={i}>{v}</li>)}
          </ul>
        </div>
      )}
      {savedAt !== null && violations.length === 0 && !saving && (
        <div role="status" className="p-3 border border-green-300 bg-green-50 text-green-900 rounded">
          Настройки сохранены.
        </div>
      )}
      {GROUPS.map(group => (
        <fieldset key={group.title} className="border border-gray-200 rounded p-4">
          <legend className="text-sm font-semibold px-2">{group.title}</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
            {group.fields.map(({ key, label, type }) => (
              <label key={key as string} className="flex flex-col text-sm">
                <span className="mb-1">{label}</span>
                {type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(config[key])}
                    onChange={e => updateField(key, e.target.checked as AntiBanConfig[typeof key])}
                  />
                ) : (
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1"
                    value={Number(config[key])}
                    onChange={e => {
                      const val = e.target.value === "" ? 0 : Number(e.target.value);
                      updateField(key, val as AntiBanConfig[typeof key]);
                    }}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700"
        >
          {saving ? "Сохранение..." : "Сохранить"}
        </button>
      </div>
    </form>
  );
}

export default AntiBanSettingsForm;
