"use client";

/**
 * `AntiBanSettingsForm` — форма анти-бан настроек с пресетами и
 * сворачиваемыми разделами.
 *
 * UX-цели (см. design.md, Requirement 9.1, 9.3, 9.4):
 *   - дать пользователю выбрать готовый пресет одним кликом, не
 *     разбираясь в 24 параметрах;
 *   - показать только базовые поля, скрыть технические в «Расширенные»;
 *   - под каждым полем — короткое объяснение «что это и на что влияет»;
 *   - живой ETA-калькулятор сверху, чтобы видеть последствия настроек
 *     до сохранения;
 *   - валидация на клиенте по Requirement 9.3, плюс предупреждение при
 *     `delay_min < 1.0` (Requirement 9.4).
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  Info,
  Rabbit,
  Shield,
  Snail,
} from "lucide-react";

import {
  AntiBanConfig,
  computeEta,
  computeRisk,
  DEFAULT_ANTI_BAN_CONFIG,
} from "@/lib/anti-ban";
import { AntiBanWizard } from "./AntiBanWizard";
import { SmartWarnings } from "./SmartWarnings";
import { TimingSimulator } from "./TimingSimulator";

export interface AntiBanSettingsFormProps {
  /** Initial config (typically loaded from GET /api/anti-ban-config). */
  initialConfig?: AntiBanConfig;
  /** Callback after successful save; receives the freshly returned config. */
  onSaved?: (config: AntiBanConfig) => void;
  /** Custom endpoint override; defaults to /api/anti-ban-config. */
  endpoint?: string;
}

// ─── Presets ───────────────────────────────────────────────────────────────

interface Preset {
  id: "safe" | "balanced" | "fast";
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  values: Partial<AntiBanConfig>;
}

const PRESETS: Preset[] = [
  {
    id: "safe",
    label: "Бережный",
    description: "Для свежих и восстанавливающихся аккаунтов. ~1 час на 150 номеров",
    icon: Snail,
    values: {
      delay_min: 12,
      delay_max: 25,
      batch_size: 20,
      long_pause_every_n: 15,
      long_pause_seconds: 180,
      broadcast_delay_min: 15,
      broadcast_jitter_max: 10,
      daily_check_limit: 100,
      hourly_check_limit: 30,
      daily_message_limit: 80,
      max_retries: 5,
      max_consecutive_429: 2,
    },
  },
  {
    id: "balanced",
    label: "Сбалансированный",
    description: "Рекомендуется для большинства задач",
    icon: Shield,
    values: {
      delay_min: DEFAULT_ANTI_BAN_CONFIG.delay_min,
      delay_max: DEFAULT_ANTI_BAN_CONFIG.delay_max,
      batch_size: DEFAULT_ANTI_BAN_CONFIG.batch_size,
      long_pause_every_n: DEFAULT_ANTI_BAN_CONFIG.long_pause_every_n,
      long_pause_seconds: DEFAULT_ANTI_BAN_CONFIG.long_pause_seconds,
      broadcast_delay_min: DEFAULT_ANTI_BAN_CONFIG.broadcast_delay_min,
      broadcast_jitter_max: DEFAULT_ANTI_BAN_CONFIG.broadcast_jitter_max,
      daily_check_limit: DEFAULT_ANTI_BAN_CONFIG.daily_check_limit,
      hourly_check_limit: DEFAULT_ANTI_BAN_CONFIG.hourly_check_limit,
      daily_message_limit: DEFAULT_ANTI_BAN_CONFIG.daily_message_limit,
      max_retries: DEFAULT_ANTI_BAN_CONFIG.max_retries,
      max_consecutive_429: DEFAULT_ANTI_BAN_CONFIG.max_consecutive_429,
    },
  },
  {
    id: "fast",
    label: "Быстрый",
    description: "Только для прогретых аккаунтов >30 дней с активной перепиской",
    icon: Rabbit,
    values: {
      delay_min: 4,
      delay_max: 8,
      batch_size: 50,
      long_pause_every_n: 40,
      long_pause_seconds: 60,
      broadcast_delay_min: 6,
      broadcast_jitter_max: 4,
      daily_check_limit: 600,
      hourly_check_limit: 150,
      daily_message_limit: 400,
      max_retries: 3,
      max_consecutive_429: 3,
    },
  },
];

// Точное сравнение текущих значений с пресетом — определяет, какой
// пресет «активен» и подсвечивается сверху.
function detectActivePreset(config: AntiBanConfig): Preset["id"] | null {
  for (const preset of PRESETS) {
    const matches = (Object.keys(preset.values) as Array<keyof AntiBanConfig>).every(
      (key) => Number(config[key]) === Number(preset.values[key]),
    );
    if (matches) return preset.id;
  }
  return null;
}

// ─── Field metadata ────────────────────────────────────────────────────────

interface Field {
  key: keyof AntiBanConfig;
  label: string;
  hint: string;
  type: "number" | "checkbox";
  unit?: string;
}

interface FieldGroup {
  title: string;
  description?: string;
  fields: Field[];
  /** Если ``true`` — группа скрыта в раскрывающемся блоке «Расширенные». */
  advanced?: boolean;
}

const GROUPS: FieldGroup[] = [
  {
    title: "Темп проверки и рассылки",
    description: "Базовые паузы между запросами к GREEN-API",
    fields: [
      {
        key: "delay_min",
        label: "Минимальная пауза",
        unit: "сек",
        hint: "Меньше — быстрее, выше риск бана. Рекомендуется не ниже 3.",
        type: "number",
      },
      {
        key: "delay_max",
        label: "Максимальная пауза",
        unit: "сек",
        hint: "Чем шире разброс с минимальной — тем «человечнее» поведение.",
        type: "number",
      },
      {
        key: "broadcast_delay_min",
        label: "Минимальная пауза для рассылки",
        unit: "сек",
        hint: "Для отправки сообщений безопаснее держать ≥ 5 сек.",
        type: "number",
      },
    ],
  },
  {
    title: "Лимиты",
    description: "Защита от превышения дневной/часовой нормы",
    fields: [
      {
        key: "daily_check_limit",
        label: "Проверок в сутки",
        hint: "Сколько checkAccount разрешено за календарные сутки.",
        type: "number",
      },
      {
        key: "hourly_check_limit",
        label: "Проверок в час",
        hint: "При достижении — текущая операция ставится на паузу.",
        type: "number",
      },
      {
        key: "daily_message_limit",
        label: "Сообщений в сутки",
        hint: "Лимит исходящих сообщений рассылки за сутки.",
        type: "number",
      },
    ],
  },
  {
    title: "Батчи и длинные паузы",
    description: "«Человеческая» имитация — пауза каждые N запросов",
    fields: [
      {
        key: "batch_size",
        label: "Размер батча",
        hint: "Сколько контактов обрабатывается одной серией.",
        type: "number",
      },
      {
        key: "long_pause_every_n",
        label: "Длинная пауза каждые N запросов",
        hint: "0 — отключить длинные паузы.",
        type: "number",
      },
      {
        key: "long_pause_seconds",
        label: "Длительность длинной паузы",
        unit: "сек",
        hint: "Эмулирует «отвлечение» — снижает риск детекции автоматизации.",
        type: "number",
      },
    ],
  },
  {
    title: "Jitter и отказоустойчивость",
    description: "Тонкая настройка повторов и случайных задержек",
    advanced: true,
    fields: [
      {
        key: "broadcast_jitter_max",
        label: "Макс. дополнительный jitter рассылки",
        unit: "сек",
        hint: "Случайная добавка к минимальной паузе для разнообразия.",
        type: "number",
      },
      {
        key: "max_retries",
        label: "Макс. ретраев на HTTP 429",
        hint: "Сколько раз повторять запрос с экспоненциальной паузой.",
        type: "number",
      },
      {
        key: "max_consecutive_429",
        label: "Макс. подряд 429",
        hint: "Если столько подряд — операция останавливается.",
        type: "number",
      },
      {
        key: "backoff_base_seconds",
        label: "База backoff",
        unit: "сек",
        hint: "Стартовая пауза экспоненциального ожидания после 429.",
        type: "number",
      },
    ],
  },
  {
    title: "Сторожевые интервалы",
    description: "Watchdog, мониторинг состояния, таймауты SSE",
    advanced: true,
    fields: [
      {
        key: "state_poll_interval_seconds",
        label: "Опрос состояния инстанса",
        unit: "сек",
        hint: "Чем чаще — тем быстрее реакция на yellowCard, но больше запросов.",
        type: "number",
      },
      {
        key: "watchdog_timeout_seconds",
        label: "Таймаут зависшей операции",
        unit: "сек",
        hint: "Если worker не пишет прогресс N сек — Watchdog сбрасывает.",
        type: "number",
      },
      {
        key: "watchdog_check_interval_seconds",
        label: "Интервал проверки watchdog",
        unit: "сек",
        hint: "Как часто фоновый поток проверяет реестр операций.",
        type: "number",
      },
      {
        key: "cancel_check_interval_seconds",
        label: "Интервал проверки отмены",
        unit: "сек",
        hint: "После «Стоп» worker ждёт не дольше этого, чтобы остановиться.",
        type: "number",
      },
      {
        key: "sse_client_timeout_seconds",
        label: "Таймаут SSE-клиента",
        unit: "сек",
        hint: "UI закроет соединение, если столько нет heartbeat.",
        type: "number",
      },
    ],
  },
  {
    title: "Скользящее окно и аудит",
    description: "Sliding window на запросы и история инцидентов",
    advanced: true,
    fields: [
      {
        key: "sliding_window_n",
        label: "Кол-во запросов в окне",
        hint: "Не больше N запросов в любом окне T секунд.",
        type: "number",
      },
      {
        key: "sliding_window_t",
        label: "Длительность окна",
        unit: "сек",
        hint: "В паре с N задаёт максимальный мгновенный темп.",
        type: "number",
      },
      {
        key: "incident_history_limit",
        label: "Лимит истории инцидентов",
        hint: "Сколько последних записей показывать на странице История.",
        type: "number",
      },
    ],
  },
  {
    title: "Предупреждение об отсутствии ответов",
    description: "Сигнал о возможном попадании рассылки в спам",
    advanced: true,
    fields: [
      {
        key: "warn_on_zero_response_ratio",
        label: "Включить предупреждение",
        hint: "Будет предупреждать перед стартом, если на N исходящих 0 входящих.",
        type: "checkbox",
      },
      {
        key: "response_ratio_window_hours",
        label: "Окно проверки",
        unit: "ч",
        hint: "За какое окно считать соотношение исходящих/входящих.",
        type: "number",
      },
      {
        key: "response_ratio_min_outgoing",
        label: "Мин. исходящих для проверки",
        hint: "Меньше — не хватает данных для статистики.",
        type: "number",
      },
    ],
  },
];

// ─── Validation (Requirement 9.3) ──────────────────────────────────────────

function clientValidate(config: AntiBanConfig): string[] {
  const violations: string[] = [];
  if (config.delay_min < 1.0)
    violations.push(`Минимальная пауза должна быть ≥ 1.0 сек (сейчас ${config.delay_min}).`);
  if (config.delay_max < config.delay_min)
    violations.push(
      `Максимальная пауза должна быть ≥ минимальной (${config.delay_min}), сейчас ${config.delay_max}.`,
    );
  if (config.batch_size < 1)
    violations.push(`Размер батча должен быть ≥ 1 (сейчас ${config.batch_size}).`);
  if (config.long_pause_seconds < 0)
    violations.push(
      `Длительность длинной паузы должна быть ≥ 0 (сейчас ${config.long_pause_seconds}).`,
    );
  if (config.daily_check_limit < 1)
    violations.push(`Дневной лимит проверок должен быть ≥ 1 (сейчас ${config.daily_check_limit}).`);
  if (config.hourly_check_limit < 1)
    violations.push(`Часовой лимит проверок должен быть ≥ 1 (сейчас ${config.hourly_check_limit}).`);
  return violations;
}

// ─── ETA preview helpers ───────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0 мин";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours} ч ${remMin.toString().padStart(2, "0")} мин`;
}

const ETA_SAMPLES: { label: string; total: number }[] = [
  { label: "100", total: 100 },
  { label: "500", total: 500 },
  { label: "1000", total: 1000 },
];

// ─── Component ─────────────────────────────────────────────────────────────

export function AntiBanSettingsForm({
  initialConfig,
  onSaved,
  endpoint = "/api/anti-ban-config",
}: AntiBanSettingsFormProps) {
  const [config, setConfig] = useState<AntiBanConfig>(
    initialConfig ?? DEFAULT_ANTI_BAN_CONFIG,
  );
  const [violations, setViolations] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [simpleMode, setSimpleMode] = useState(false);

  const activePreset = useMemo(() => detectActivePreset(config), [config]);

  const updateField = <K extends keyof AntiBanConfig>(
    key: K,
    value: AntiBanConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  };

  const applyPreset = (preset: Preset) => {
    setConfig((prev) => ({ ...prev, ...preset.values }));
    setSavedAt(null);
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
        const data = (await response.json().catch(() => ({}))) as {
          violations?: string[];
          detail?: string;
        };
        if (Array.isArray(data.violations)) {
          setViolations(data.violations);
        } else {
          setViolations([
            data.detail ?? `HTTP ${response.status}: ${JSON.stringify(data)}`,
          ]);
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
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Mode toggle */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setSimpleMode((v) => !v)}
          className="text-xs text-text-muted hover:text-text underline-offset-2 hover:underline transition-colors"
        >
          {simpleMode ? "→ режим эксперта" : "→ простой режим"}
        </button>
      </div>

      {/* Wizard for simple mode */}
      {simpleMode && (
        <AntiBanWizard
          onApply={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
          onClose={() => setSimpleMode(false)}
        />
      )}

      {/* Smart warnings + autofix */}
      <SmartWarnings
        config={config}
        onApplyPatch={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
      />

      {/* Live timing simulator */}
      <TimingSimulator config={config} />

      {/* Presets */}
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((preset) => {
          const Icon = preset.icon;
          const isActive = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${
                isActive
                  ? "border-accent bg-accent-subtle ring-1 ring-accent/40"
                  : "border-border bg-surface hover:border-border-focus"
              }`}
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0 ${
                  isActive
                    ? "bg-accent text-bg"
                    : "bg-bg-elevated text-text-secondary"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-text">
                  {preset.label}
                </span>
                <span className="block text-xs text-text-muted leading-snug mt-0.5">
                  {preset.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ETA preview */}
      <div className="rounded-xl border border-border bg-bg-elevated p-3">
        <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-text-secondary">
          <Gauge className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Расчётная длительность массовой проверки
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {ETA_SAMPLES.map((sample) => {
            const eta = computeEta(config, sample.total);
            const risk = computeRisk(sample.total);
            return (
              <div
                key={sample.total}
                className="rounded-lg bg-surface px-3 py-2 border border-border"
              >
                <div className="text-text-muted">{sample.label} номеров</div>
                <div className="text-text font-semibold mt-0.5">
                  {formatDuration(eta)}
                </div>
                <div
                  className={`mt-0.5 ${
                    risk === "high"
                      ? "text-error"
                      : risk === "medium"
                        ? "text-warning"
                        : "text-success"
                  }`}
                >
                  риск:{" "}
                  {risk === "low"
                    ? "низкий"
                    : risk === "medium"
                      ? "средний"
                      : "высокий"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Warnings */}
      {showDelayMinWarning && (
        <div
          role="alert"
          className="flex gap-2 rounded-xl border border-warning/30 bg-warning-bg p-3 text-sm text-warning"
        >
          <Info className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span>
            Минимальная пауза ниже 1.0 сек повышает риск блокировки. Рекомендуется
            значение не ниже 3.0 секунды.
          </span>
        </div>
      )}
      {violations.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-error/30 bg-error-bg p-3 text-sm text-error"
        >
          <ul className="list-disc list-inside space-y-1">
            {violations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}
      {savedAt !== null && violations.length === 0 && !saving && (
        <div
          role="status"
          className="rounded-xl border border-success/30 bg-success-bg p-3 text-sm text-success"
        >
          Настройки сохранены.
        </div>
      )}

      {/* Basic groups */}
      {GROUPS.filter((g) => !g.advanced).map((group) => (
        <FieldGroupBlock
          key={group.title}
          group={group}
          config={config}
          updateField={updateField}
        />
      ))}

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text transition-colors"
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? (
          <ChevronDown className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        )}
        {showAdvanced ? "Скрыть" : "Показать"} расширенные настройки
      </button>

      {showAdvanced &&
        GROUPS.filter((g) => g.advanced).map((group) => (
          <FieldGroupBlock
            key={group.title}
            group={group}
            config={config}
            updateField={updateField}
          />
        ))}

      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-xl bg-accent text-bg text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-all active:scale-95"
        >
          {saving ? "Сохранение..." : "Сохранить"}
        </button>
      </div>
    </form>
  );
}

// ─── Sub-component: FieldGroupBlock ────────────────────────────────────────

interface FieldGroupBlockProps {
  group: FieldGroup;
  config: AntiBanConfig;
  updateField: <K extends keyof AntiBanConfig>(
    key: K,
    value: AntiBanConfig[K],
  ) => void;
}

function FieldGroupBlock({ group, config, updateField }: FieldGroupBlockProps) {
  return (
    <fieldset className="rounded-xl border border-border bg-surface p-4">
      <legend className="px-2 text-sm font-semibold text-text">
        {group.title}
      </legend>
      {group.description && (
        <p className="text-xs text-text-muted -mt-1 mb-3 px-1">
          {group.description}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2 mt-2">
        {group.fields.map((field) => (
          <FieldRow
            key={field.key as string}
            field={field}
            value={config[field.key]}
            onChange={(value) =>
              updateField(field.key, value as AntiBanConfig[typeof field.key])
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

interface FieldRowProps {
  field: Field;
  value: AntiBanConfig[keyof AntiBanConfig];
  onChange: (value: number | boolean) => void;
}

function FieldRow({ field, value, onChange }: FieldRowProps) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="flex-1">
          <span className="block text-text font-medium">{field.label}</span>
          <span className="block text-xs text-text-muted mt-0.5">
            {field.hint}
          </span>
        </span>
      </label>
    );
  }
  return (
    <label className="flex flex-col text-sm">
      <span className="flex items-center justify-between mb-1">
        <span className="text-text font-medium">{field.label}</span>
        {field.unit && (
          <span className="text-xs text-text-muted">{field.unit}</span>
        )}
      </span>
      <input
        type="number"
        step="any"
        className="border border-border rounded-lg px-3 py-2 bg-bg-elevated text-text text-sm focus:outline-none focus:border-border-focus transition-colors"
        value={Number(value)}
        onChange={(e) => {
          const v = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
      />
      <span className="text-xs text-text-muted mt-1 leading-snug">
        {field.hint}
      </span>
    </label>
  );
}

export default AntiBanSettingsForm;
