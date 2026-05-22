"use client";

/**
 * `ScheduleModal` — модалка планирования рассылки.
 *
 * Открывается из меню split-кнопки «Начать сейчас / Запланировать…»
 * на странице рассылки. Получает на вход уже подготовленный payload
 * (контакты, текст, файл, persona-сообщения) и собирает оставшиеся
 * параметры расписания: тип (once/drip/recurring) и connected фичи —
 * тихие часы, локальная tz получателя, окно окончания.
 *
 * При сабмите делает `POST /api/scheduled-broadcasts` и закрывается;
 * родительский компонент опционально показывает toast и редиректит.
 */

import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Clock,
  Droplet,
  Globe2,
  Moon,
  Repeat,
  X,
  AlertTriangle,
  Loader2,
} from "lucide-react";

import { nxPost } from "@/lib/api";
import type { BroadcastContact } from "@/lib/types";
import type {
  CreateScheduledBroadcastInput,
  RecurringKind,
  ScheduleType,
} from "@/lib/scheduled/types";

export interface ScheduleModalProps {
  open: boolean;
  onClose(): void;
  onScheduled?(id: number): void;

  // Подготовленный контент рассылки (приходит из BroadcastPage).
  message: string;
  contacts: BroadcastContact[];
  personalizedMessages?: Record<string, string>;
  delaySeconds: number;
  useTyping: boolean;
  fileName: string | null;
  fileUrl: string | null;
}

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

function defaultScheduledFor(): string {
  // Через 30 минут от now, округлено до 5 минут — типичное "запустить через полчаса".
  const d = new Date(Date.now() + 30 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5);
  // datetime-local format: YYYY-MM-DDTHH:mm
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  return iso;
}

export function ScheduleModal({
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
}: ScheduleModalProps) {
  const [tab, setTab] = useState<ScheduleType>("once");
  const [name, setName] = useState("");

  // ── Once / Drip ────────────────────────────────────────────────────────
  const [scheduledFor, setScheduledFor] = useState<string>(defaultScheduledFor());

  // ── Drip ───────────────────────────────────────────────────────────────
  const [dripBatch, setDripBatch] = useState<number>(100);
  const [dripInterval, setDripInterval] = useState<number>(30);

  // ── Recurring ──────────────────────────────────────────────────────────
  const [recurringKind, setRecurringKind] = useState<RecurringKind>("daily");
  const [recurringHour, setRecurringHour] = useState<number>(10);
  const [recurringMinute, setRecurringMinute] = useState<number>(0);
  const [recurringDow, setRecurringDow] = useState<number>(0);
  const [recurringDom, setRecurringDom] = useState<number>(1);
  const [recurringUntil, setRecurringUntil] = useState<string>("");

  // ── Тихие часы и таймзоны ──────────────────────────────────────────────
  const [quietEnabled, setQuietEnabled] = useState<boolean>(true);
  const [quietStart, setQuietStart] = useState<number>(22);
  const [quietEnd, setQuietEnd] = useState<number>(8);
  const [respectRecipientTz, setRespectRecipientTz] = useState<boolean>(false);
  const [userTz, setUserTz] = useState<string>(detectBrowserTz());

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
    }
  }, [open]);

  // Computed: количество волн drip
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

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateScheduledBroadcastInput = {
        name: name.trim() || null,
        message,
        contacts,
        personalized_messages: personalizedMessages ?? null,
        use_typing: useTyping,
        delay_seconds: delaySeconds,
        file_name: fileName,
        file_url: fileUrl,
        schedule_type: tab,
        scheduled_for:
          tab === "once" || tab === "drip"
            ? new Date(scheduledFor).toISOString()
            : null,
        drip_batch_size: tab === "drip" ? dripBatch : null,
        drip_interval_minutes: tab === "drip" ? dripInterval : null,
        recurring_kind: tab === "recurring" ? recurringKind : null,
        recurring_hour: tab === "recurring" ? recurringHour : null,
        recurring_minute: tab === "recurring" ? recurringMinute : null,
        recurring_day_of_week:
          tab === "recurring" && recurringKind === "weekly"
            ? recurringDow
            : null,
        recurring_day_of_month:
          tab === "recurring" && recurringKind === "monthly"
            ? recurringDom
            : null,
        recurring_until:
          tab === "recurring" && recurringUntil
            ? new Date(recurringUntil).toISOString()
            : null,
        quiet_hours_enabled: quietEnabled,
        quiet_hours_start: quietStart,
        quiet_hours_end: quietEnd,
        respect_recipient_tz: respectRecipientTz,
        user_tz: userTz,
      };
      const created = await nxPost<{ id: number }>(
        "/api/scheduled-broadcasts",
        payload,
      );
      onScheduled?.(Number(created.id));
      onClose();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Не удалось создать запланированную рассылку";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const TABS: { id: ScheduleType; label: string; icon: typeof Clock; desc: string }[] = [
    { id: "once", label: "Однократно", icon: Clock, desc: "В указанное время" },
    { id: "drip", label: "Drip", icon: Droplet, desc: "Волнами по N контактов" },
    { id: "recurring", label: "Повтор", icon: Repeat, desc: "Ежедневно/неделя/месяц" },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl bg-bg border border-border shadow-2xl"
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
            className="p-2 rounded-lg text-text-muted hover:bg-surface hover:text-text transition-colors"
          >
            <X className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Название (необязательно) */}
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Название (необязательно, для удобства в списке)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: «Утренняя ноябрьская рассылка»"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
          </div>

          {/* Tab selector */}
          <div className="grid grid-cols-3 gap-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all ${
                    isActive
                      ? "border-accent bg-accent-subtle ring-1 ring-accent/40"
                      : "border-border bg-surface hover:border-border-focus"
                  }`}
                >
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

          {/* Tab content */}
          {tab === "once" && (
            <fieldset className="rounded-xl border border-border bg-surface p-4 space-y-3">
              <legend className="px-2 text-sm font-semibold text-text">
                Дата и время старта
              </legend>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
              />
              <p className="text-xs text-text-muted">
                Время в вашей таймзоне ({userTz}). Рассылка запустится в
                указанный момент. Если в этот момент действуют тихие часы — стартует
                после их окончания.
              </p>
            </fieldset>
          )}

          {tab === "drip" && (
            <fieldset className="rounded-xl border border-border bg-surface p-4 space-y-4">
              <legend className="px-2 text-sm font-semibold text-text">
                Drip-кампания
              </legend>
              <p className="text-xs text-text-muted -mt-1">
                Контакты разбиваются на волны и отправляются с интервалом —
                это снижает риск бана и нагрузку на инстанс.
              </p>
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Время старта первой волны
                </label>
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Размер волны (контактов)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={dripBatch}
                    onChange={(e) =>
                      setDripBatch(Math.max(1, Number(e.target.value) || 0))
                    }
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Интервал между волнами (минут)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={dripInterval}
                    onChange={(e) =>
                      setDripInterval(Math.max(1, Number(e.target.value) || 0))
                    }
                    className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                  />
                </div>
              </div>
              <div className="rounded-lg bg-bg-elevated px-3 py-2 text-xs text-text-secondary">
                Получится {dripWaves} {dripWaves === 1 ? "волна" : "волн"}.
                {dripFinishEta != null && dripFinishEta > 0
                  ? ` Между первой и последней — ≈${formatDuration(dripFinishEta)}.`
                  : ""}
              </div>
            </fieldset>
          )}

          {tab === "recurring" && (
            <fieldset className="rounded-xl border border-border bg-surface p-4 space-y-4">
              <legend className="px-2 text-sm font-semibold text-text">
                Повторение
              </legend>
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
                    {k === "daily" ? "Ежедневно" : k === "weekly" ? "Еженедельно" : "Ежемесячно"}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Час (0–23)
                  </label>
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
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Минута (0–59)
                  </label>
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
                </div>
              </div>

              {recurringKind === "weekly" && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    День недели
                  </label>
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
                </div>
              )}

              {recurringKind === "monthly" && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Число месяца (1–28)
                  </label>
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
                </div>
              )}

              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Дата окончания (необязательно)
                </label>
                <input
                  type="date"
                  value={recurringUntil}
                  onChange={(e) => setRecurringUntil(e.target.value)}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
                />
              </div>
            </fieldset>
          )}

          {/* Тихие часы */}
          <fieldset className="rounded-xl border border-border bg-surface p-4 space-y-3">
            <legend className="px-2 text-sm font-semibold text-text flex items-center gap-2">
              <Moon className="h-4 w-4 text-accent" strokeWidth={2} /> Тихие часы
            </legend>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={quietEnabled}
                onChange={(e) => setQuietEnabled(e.target.checked)}
                className="accent-accent"
              />
              <span className="text-text">Не отправлять в эти часы</span>
            </label>
            {quietEnabled && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    С (час)
                  </label>
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
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    До (час)
                  </label>
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
                </div>
                <div className="col-span-2">
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
                  <p className="text-xs text-text-muted mt-1 ml-6">
                    Таймзона определяется по country code номера. Получатели,
                    у которых сейчас тишина, переносятся на следующее «разрешённое»
                    окно.
                  </p>
                </div>
              </div>
            )}
          </fieldset>

          {error && (
            <div className="px-4 py-3 bg-error-bg border border-error/20 rounded-xl text-error text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
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
            disabled={submitting || contacts.length === 0 || !message.trim()}
            onClick={submit}
            className="px-5 py-2 rounded-lg bg-accent text-bg text-sm font-medium hover:bg-accent-hover transition-all disabled:opacity-50 active:scale-95 inline-flex items-center gap-2"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? "Сохранение…" : "Запланировать"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

export default ScheduleModal;
