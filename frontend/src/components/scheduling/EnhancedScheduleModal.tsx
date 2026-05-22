"use client";

/**
 * `EnhancedScheduleModal` — расширенная модалка планирования рассылки.
 *
 * Поддерживает все режимы:
 *   - exact (был "once") — однократно в указанное время
 *   - drip — волнами по N контактов
 *   - recurring — ежедневно/неделя/месяц
 *   - window — равномерно в окне (NEW)
 *   - smart_time — лучшее время для каждого получателя (NEW)
 *   - burst — максимально быстро (NEW)
 *
 * Перед фактическим submit-ом открывает `SchedulingPreFlightModal`
 * с histogram + ETA + warnings.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bolt,
  CalendarClock,
  Clock,
  Droplet,
  Globe2,
  Loader2,
  Moon,
  Repeat,
  Target,
  X,
  Zap,
} from "lucide-react";

import { apiGet, nxGet, nxPost } from "@/lib/api";
import { DEFAULT_ANTI_BAN_CONFIG } from "@/lib/anti-ban";
import type { AntiBanConfig } from "@/lib/anti-ban";
import type { BroadcastContact } from "@/lib/types";
import type {
  CalendarException,
  GreenInstance,
  ScheduledBroadcastDraft,
  ScheduleType,
} from "@/lib/scheduling/types";

import { SchedulingPreFlightModal } from "./SchedulingPreFlightModal";

type RecurringKind = "daily" | "weekly" | "monthly";

interface ScheduleTabConfig {
  id: ScheduleType;
  label: string;
  icon: typeof Clock;
  desc: string;
  badge?: string;
}

const TABS: readonly ScheduleTabConfig[] = [
  { id: "exact", label: "Точное время", icon: Clock, desc: "Один раз в момент X" },
  {
    id: "window",
    label: "Send Window",
    icon: CalendarClock,
    desc: "Равномерно в окне",
    badge: "Pro",
  },
  {
    id: "smart_time",
    label: "Smart-Time",
    icon: Target,
    desc: "Лучший час для каждого",
    badge: "AI",
  },
  {
    id: "burst",
    label: "Burst",
    icon: Zap,
    desc: "Максимально быстро",
    badge: "Hot",
  },
  { id: "drip", label: "Drip", icon: Droplet, desc: "Волнами" },
  { id: "recurring", label: "Повтор", icon: Repeat, desc: "Регулярно" },
];

const WEEKDAY_LABELS = [
  { value: 0, label: "Пн" },
  { value: 1, label: "Вт" },
  { value: 2, label: "Ср" },
  { value: 3, label: "Чт" },
  { value: 4, label: "Пт" },
  { value: 5, label: "Сб" },
  { value: 6, label: "Вс" },
];

function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function defaultDateTime(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export interface EnhancedScheduleModalProps {
  open: boolean;
  onClose(): void;
  onScheduled?(id: number): void;

  // Подготовленный контент рассылки
  message: string;
  contacts: BroadcastContact[];
  personalizedMessages?: Record<string, string>;
  delaySeconds: number;
  useTyping: boolean;
  fileName: string | null;
  fileUrl: string | null;
}

export function EnhancedScheduleModal({
  open,
  onClose,
  onScheduled,
  message,
  contacts,
  personalizedMessages,
  delaySeconds,
  useTyping,
  fileName,
  fileUrl,
}: EnhancedScheduleModalProps) {
  // Active mode tab
  const [tab, setTab] = useState<ScheduleType>("exact");
  const [name, setName] = useState("");
  const userTz = useMemo(() => detectBrowserTz(), []);

  // Common time anchors
  const [scheduledFor, setScheduledFor] = useState<string>(defaultDateTime(30));

  // Window
  const [windowStart, setWindowStart] = useState<string>(defaultDateTime(60));
  const [windowEnd, setWindowEnd] = useState<string>(defaultDateTime(60 * 8));

  // Smart-Time
  const [smartWindowDays, setSmartWindowDays] = useState<number>(1);
  const [smartTopN, setSmartTopN] = useState<number>(3);

  // Drip
  const [dripBatch, setDripBatch] = useState<number>(100);
  const [dripInterval, setDripInterval] = useState<number>(30);

  // Recurring
  const [recurringKind, setRecurringKind] = useState<RecurringKind>("daily");
  const [recurringHour, setRecurringHour] = useState<number>(10);
  const [recurringMinute, setRecurringMinute] = useState<number>(0);
  const [recurringDow, setRecurringDow] = useState<number>(0);
  const [recurringDom, setRecurringDom] = useState<number>(1);
  const [recurringUntil, setRecurringUntil] = useState<string>("");

  // Quiet hours
  const [quietEnabled, setQuietEnabled] = useState<boolean>(true);
  const [quietStart, setQuietStart] = useState<number>(22);
  const [quietEnd, setQuietEnd] = useState<number>(8);
  const [respectRecipientTz, setRespectRecipientTz] = useState<boolean>(false);

  // Anti-ban / approval / instance
  const [antiBan, setAntiBan] = useState<AntiBanConfig>(DEFAULT_ANTI_BAN_CONFIG);
  const [exceptions, setExceptions] = useState<CalendarException[]>([]);
  const [primaryInstance, setPrimaryInstance] = useState<GreenInstance | null>(null);
  const [adaptiveThrottle, setAdaptiveThrottle] = useState<boolean>(true);
  const [autoSnoozeEnabled, setAutoSnoozeEnabled] = useState<boolean>(true);

  // Preflight state
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Загрузка контекста (anti-ban config, exceptions, primary instance) при открытии.
  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.allSettled([
      apiGet<AntiBanConfig>("/api/anti-ban-config")
        .then(setAntiBan)
        .catch(() => setAntiBan(DEFAULT_ANTI_BAN_CONFIG)),
      nxGet<CalendarException[]>("/api/calendar-exceptions")
        .then((rows) => setExceptions(Array.isArray(rows) ? rows : []))
        .catch(() => setExceptions([])),
      nxGet<GreenInstance[]>("/api/green-instances")
        .then((rows) => {
          if (!Array.isArray(rows)) return;
          const primary = rows.find((r) => r.is_primary) ?? rows[0] ?? null;
          setPrimaryInstance(primary ?? null);
        })
        .catch(() => setPrimaryInstance(null)),
    ]);
  }, [open]);

  const dripWaves = useMemo(() => {
    if (!dripBatch || dripBatch < 1) return 1;
    return Math.ceil((contacts.length || 1) / dripBatch);
  }, [dripBatch, contacts.length]);

  const dripFinishEta = useMemo(() => {
    if (tab !== "drip") return null;
    const totalMinutes = (dripWaves - 1) * Math.max(1, dripInterval);
    return totalMinutes;
  }, [tab, dripWaves, dripInterval]);

  if (!open) return null;

  function buildDraft(): ScheduledBroadcastDraft {
    return {
      name: name.trim() || null,
      message,
      contacts,
      personalizedMessages: personalizedMessages ?? null,
      use_typing: useTyping,
      delay_seconds: delaySeconds,
      file_url: fileUrl,
      file_name: fileName,
      schedule_type: tab,
      scheduled_for:
        tab === "exact" || tab === "drip" || tab === "burst" || tab === "smart_time"
          ? new Date(scheduledFor).toISOString()
          : null,
      send_window_start:
        tab === "window" ? new Date(windowStart).toISOString() : null,
      send_window_end:
        tab === "window" ? new Date(windowEnd).toISOString() : null,
      smart_time_window_days: tab === "smart_time" ? smartWindowDays : null,
      smart_time_top_n: tab === "smart_time" ? smartTopN : null,
      quiet_hours_enabled: quietEnabled,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
      respect_recipient_tz: respectRecipientTz,
      user_tz: userTz,
      adaptive_throttle: adaptiveThrottle,
      auto_snooze_enabled: autoSnoozeEnabled,
      auto_snooze_threshold: 3,
      auto_snooze_minutes: 30,
      auto_snooze_window_minutes: 15,
      instance_id: primaryInstance ? primaryInstance.id : null,
    };
  }

  function clientValidate(): string | null {
    if (!message.trim() && !fileUrl)
      return "Текст сообщения или файл обязательны";
    if (contacts.length === 0) return "Список получателей пуст";
    if (tab === "exact" || tab === "drip" || tab === "burst" || tab === "smart_time") {
      if (!scheduledFor) return "Укажите время старта";
      if (Number.isNaN(new Date(scheduledFor).getTime()))
        return "Некорректное время старта";
    }
    if (tab === "window") {
      const a = new Date(windowStart).getTime();
      const b = new Date(windowEnd).getTime();
      if (!Number.isFinite(a) || !Number.isFinite(b))
        return "Некорректные границы окна";
      if (b <= a) return "Конец окна должен быть позже начала";
      if (a <= Date.now()) return "Начало окна должно быть в будущем";
    }
    if (tab === "smart_time") {
      if (smartWindowDays < 1 || smartWindowDays > 14)
        return "Окно для Smart-Time должно быть от 1 до 14 дней";
      if (smartTopN < 1 || smartTopN > 6)
        return "Top-N для Smart-Time должно быть от 1 до 6";
    }
    if (tab === "burst") {
      if (quietEnabled)
        return "Burst-режим несовместим с тихими часами — отключите их";
    }
    if (tab === "recurring") {
      if (recurringHour < 0 || recurringHour > 23)
        return "Часы повторения 0–23";
      if (recurringMinute < 0 || recurringMinute > 59)
        return "Минуты повторения 0–59";
    }
    return null;
  }

  function openPreflight() {
    const v = clientValidate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setPreflightOpen(true);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const draft = buildDraft();
      const payload = {
        name: draft.name,
        message: draft.message,
        contacts: draft.contacts,
        personalized_messages: draft.personalizedMessages ?? null,
        use_typing: draft.use_typing,
        delay_seconds: draft.delay_seconds,
        file_url: draft.file_url,
        file_name: draft.file_name,
        schedule_type: tab,
        scheduled_for: draft.scheduled_for ?? null,
        // window
        send_window_start: draft.send_window_start ?? null,
        send_window_end: draft.send_window_end ?? null,
        // smart_time
        smart_time_window_days: draft.smart_time_window_days ?? null,
        smart_time_top_n: draft.smart_time_top_n ?? null,
        // drip
        drip_batch_size: tab === "drip" ? dripBatch : null,
        drip_interval_minutes: tab === "drip" ? dripInterval : null,
        // recurring
        recurring_kind: tab === "recurring" ? recurringKind : null,
        recurring_hour: tab === "recurring" ? recurringHour : null,
        recurring_minute: tab === "recurring" ? recurringMinute : null,
        recurring_day_of_week:
          tab === "recurring" && recurringKind === "weekly" ? recurringDow : null,
        recurring_day_of_month:
          tab === "recurring" && recurringKind === "monthly" ? recurringDom : null,
        recurring_until:
          tab === "recurring" && recurringUntil
            ? new Date(recurringUntil).toISOString()
            : null,
        // quiet hours
        quiet_hours_enabled: draft.quiet_hours_enabled,
        quiet_hours_start: draft.quiet_hours_start,
        quiet_hours_end: draft.quiet_hours_end,
        respect_recipient_tz: draft.respect_recipient_tz,
        user_tz: draft.user_tz,
        // anti-ban
        adaptive_throttle: draft.adaptive_throttle,
        auto_snooze_enabled: draft.auto_snooze_enabled,
        auto_snooze_threshold: draft.auto_snooze_threshold,
        auto_snooze_minutes: draft.auto_snooze_minutes,
        auto_snooze_window_minutes: draft.auto_snooze_window_minutes,
        instance_id: draft.instance_id ?? null,
      };
      const created = await nxPost<{ id: number }>(
        "/api/scheduled-broadcasts",
        payload,
      );
      onScheduled?.(Number(created.id));
      setPreflightOpen(false);
      onClose();
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : "Не удалось создать запланированную рассылку";
      setError(msg);
      setPreflightOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl mx-4 max-h-[92vh] overflow-y-auto rounded-2xl bg-bg border border-border shadow-2xl"
        >
          <div className="sticky top-0 bg-bg/95 backdrop-blur-xl border-b border-border p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <CalendarClock className="h-5 w-5" strokeWidth={2} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text">
                  Запланировать рассылку
                </h2>
                <p className="text-xs text-text-muted">
                  {contacts.length} получателей · ваша таймзона: {userTz}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="p-2 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>

          <div className="p-5 space-y-5">
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Название (необязательно)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: «Утренняя ноябрьская рассылка»"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50"
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {TABS.map((t) => {
                const Icon = t.icon;
                const isActive = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all relative ${
                      isActive
                        ? "border-accent bg-accent-subtle ring-1 ring-accent/40"
                        : "border-border bg-surface hover:border-border-focus"
                    }`}
                  >
                    {t.badge && (
                      <span className="absolute top-2 right-2 text-[9px] uppercase tracking-wide font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                        {t.badge}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <Icon
                        className={`h-4 w-4 ${
                          isActive ? "text-accent" : "text-text-muted"
                        }`}
                        strokeWidth={2}
                      />
                      <span className="text-sm font-medium text-text">
                        {t.label}
                      </span>
                    </div>
                    <span className="text-xs text-text-muted">{t.desc}</span>
                  </button>
                );
              })}
            </div>

            {tab === "exact" && (
              <Fieldset title="Дата и время старта">
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                />
                <p className="text-xs text-text-muted">
                  Время в вашей таймзоне ({userTz}). Если стартовое время
                  попадёт в тихие часы — рассылка дождётся их окончания.
                </p>
              </Fieldset>
            )}

            {tab === "window" && (
              <Fieldset
                title="Send Window — окно отправки"
                hint="Равномерно распределяет N сообщений в выбранном временном окне с учётом тихих часов и календарных исключений. Это снижает риск бана и не выглядит как «спам-выброс»."
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Начало окна">
                    <input
                      type="datetime-local"
                      value={windowStart}
                      onChange={(e) => setWindowStart(e.target.value)}
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                  <Field label="Конец окна">
                    <input
                      type="datetime-local"
                      value={windowEnd}
                      onChange={(e) => setWindowEnd(e.target.value)}
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                </div>
              </Fieldset>
            )}

            {tab === "smart_time" && (
              <Fieldset
                title="Smart-Time — лучший час для каждого получателя"
                hint="Анализируем историю входящих и delivery_status за период и подбираем индивидуальный момент для каждого. Если истории мало — fallback на operator-global или дефолтные часы пиков."
              >
                <Field label="Якорная дата (с какого момента можно начать)">
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Окно дней (1–14)">
                    <input
                      type="number"
                      min={1}
                      max={14}
                      value={smartWindowDays}
                      onChange={(e) =>
                        setSmartWindowDays(
                          Math.min(14, Math.max(1, Number(e.target.value) || 1)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                  <Field label="Top-N часов (1–6)">
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={smartTopN}
                      onChange={(e) =>
                        setSmartTopN(
                          Math.min(6, Math.max(1, Number(e.target.value) || 1)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                </div>
              </Fieldset>
            )}

            {tab === "burst" && (
              <Fieldset
                title="Burst — максимальная скорость"
                hint="Отправляем без long-pause, на минимальной задержке anti-ban. Adaptive_Throttle включён принудительно — если получим 429, темп замедлится автоматически. Несовместим с тихими часами."
              >
                <Field label="Старт">
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </Field>
                <div className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2 text-xs text-warning flex gap-2">
                  <Bolt className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
                  <span>
                    Burst — для срочных рассылок &lt; 100 контактов. Тихие часы
                    автоматически отключатся.
                  </span>
                </div>
              </Fieldset>
            )}

            {tab === "drip" && (
              <Fieldset title="Drip-кампания">
                <Field label="Время старта первой волны">
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Размер волны">
                    <input
                      type="number"
                      min={1}
                      value={dripBatch}
                      onChange={(e) =>
                        setDripBatch(Math.max(1, Number(e.target.value) || 0))
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                  <Field label="Интервал между волнами (мин)">
                    <input
                      type="number"
                      min={1}
                      value={dripInterval}
                      onChange={(e) =>
                        setDripInterval(Math.max(1, Number(e.target.value) || 0))
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                </div>
                <div className="rounded-lg bg-bg-elevated px-3 py-2 text-xs text-text-secondary">
                  Получится {dripWaves} {dripWaves === 1 ? "волна" : "волн"}.
                  {dripFinishEta != null && dripFinishEta > 0
                    ? ` Между первой и последней — ≈${formatDuration(dripFinishEta)}.`
                    : ""}
                </div>
              </Fieldset>
            )}

            {tab === "recurring" && (
              <Fieldset title="Повторение">
                <div className="flex flex-wrap gap-2">
                  {(["daily", "weekly", "monthly"] as RecurringKind[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setRecurringKind(k)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        recurringKind === k
                          ? "bg-accent text-bg"
                          : "bg-bg-elevated text-text-secondary border border-border"
                      }`}
                    >
                      {k === "daily"
                        ? "Ежедневно"
                        : k === "weekly"
                          ? "Еженедельно"
                          : "Ежемесячно"}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Час (0–23)">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={recurringHour}
                      onChange={(e) =>
                        setRecurringHour(
                          Math.min(23, Math.max(0, Number(e.target.value) || 0)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                  <Field label="Минута (0–59)">
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={recurringMinute}
                      onChange={(e) =>
                        setRecurringMinute(
                          Math.min(59, Math.max(0, Number(e.target.value) || 0)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                </div>
                {recurringKind === "weekly" && (
                  <Field label="День недели">
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAY_LABELS.map((d) => (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() => setRecurringDow(d.value)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                            recurringDow === d.value
                              ? "bg-accent text-bg"
                              : "bg-bg-elevated text-text-secondary border border-border"
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                {recurringKind === "monthly" && (
                  <Field label="Число месяца (1–28)">
                    <input
                      type="number"
                      min={1}
                      max={28}
                      value={recurringDom}
                      onChange={(e) =>
                        setRecurringDom(
                          Math.min(28, Math.max(1, Number(e.target.value) || 1)),
                        )
                      }
                      className="w-32 px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                )}
                <Field label="Дата окончания (необязательно)">
                  <input
                    type="date"
                    value={recurringUntil}
                    onChange={(e) => setRecurringUntil(e.target.value)}
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </Field>
              </Fieldset>
            )}

            <Fieldset
              title="Тихие часы и таймзоны"
              icon={<Moon className="h-4 w-4 text-accent" strokeWidth={2} />}
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={quietEnabled}
                  onChange={(e) => setQuietEnabled(e.target.checked)}
                  disabled={tab === "burst"}
                  className="accent-accent"
                />
                <span className="text-text">
                  Не отправлять в эти часы
                  {tab === "burst" && (
                    <span className="text-text-muted text-xs ml-2">
                      (отключено для burst)
                    </span>
                  )}
                </span>
              </label>
              {quietEnabled && tab !== "burst" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="С (час)">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={quietStart}
                      onChange={(e) =>
                        setQuietStart(
                          Math.min(23, Math.max(0, Number(e.target.value) || 0)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                  <Field label="До (час)">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={quietEnd}
                      onChange={(e) =>
                        setQuietEnd(
                          Math.min(23, Math.max(0, Number(e.target.value) || 0)),
                        )
                      }
                      className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                    />
                  </Field>
                </div>
              )}
              {quietEnabled && tab !== "burst" && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={respectRecipientTz}
                    onChange={(e) => setRespectRecipientTz(e.target.checked)}
                    className="accent-accent"
                  />
                  <Globe2 className="h-4 w-4 text-text-muted" strokeWidth={2} />
                  <span className="text-text-secondary">
                    По локальному времени каждого получателя
                  </span>
                </label>
              )}
            </Fieldset>

            <Fieldset
              title="Защита от блокировки"
              hint="Adaptive Throttle замедляет отправку при росте 429. Auto-Snooze автоматически ставит рассылку на паузу при критическом числе инцидентов."
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={adaptiveThrottle}
                  onChange={(e) => setAdaptiveThrottle(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-text">
                  Adaptive Throttle (рекомендуется)
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSnoozeEnabled}
                  onChange={(e) => setAutoSnoozeEnabled(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-text">
                  Auto-Snooze при 3 подряд инцидентах
                </span>
              </label>
            </Fieldset>

            {error && (
              <div className="px-4 py-3 bg-error-bg border border-error/20 rounded-xl text-error text-sm flex gap-2">
                <AlertTriangle
                  className="h-4 w-4 mt-0.5 shrink-0"
                  strokeWidth={2}
                />
                {error}
              </div>
            )}
          </div>

          <div className="sticky bottom-0 bg-bg/95 backdrop-blur-xl border-t border-border p-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:bg-surface transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={openPreflight}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-bg text-sm font-medium transition-all disabled:opacity-50 active:scale-95"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
              Предпросмотр расписания →
            </button>
          </div>
        </div>
      </div>

      <SchedulingPreFlightModal
        open={preflightOpen}
        draft={buildDraft()}
        antiBan={antiBan}
        exceptions={exceptions}
        instance={primaryInstance}
        submitting={submitting}
        onConfirm={submit}
        onClose={() => setPreflightOpen(false)}
      />
    </>
  );
}

function Fieldset({
  title,
  icon,
  hint,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <legend className="px-2 text-sm font-semibold text-text flex items-center gap-2">
        {icon} {title}
      </legend>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}
