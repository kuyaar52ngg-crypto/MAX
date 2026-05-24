"use client";

/**
 * `AccountHealthPanel` — большая UI-карточка с анализом здоровья
 * primary-инстанса и рекомендациями. Используется на странице health,
 * а также внутри dashboard-overview.
 */

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";

import type {
  AccountHealthData,
  AccountHealthStatus,
} from "@/lib/anti-ban/health";
import { useAccountHealth } from "@/lib/hooks/useAccountHealth";

const HEALTH_META: Record<
  AccountHealthStatus,
  {
    icon: typeof ShieldCheck;
    label: string;
    description: string;
    tone: "success" | "info" | "warning" | "error";
  }
> = {
  ok: {
    icon: ShieldCheck,
    label: "Здоров",
    description: "Можно запускать массовые операции в нормальном темпе.",
    tone: "success",
  },
  warming_up: {
    icon: Sparkles,
    label: "Прогревается",
    description:
      "Аккаунту меньше 7 дней или мало двусторонней переписки. Ограничьте темп пока он не наберётся.",
    tone: "info",
  },
  fresh: {
    icon: AlertCircle,
    label: "Свежий, без истории",
    description:
      "MAX считает такие аккаунты подозрительными. Сначала прогрейте — отправьте сообщений знакомым и получите ответы.",
    tone: "warning",
  },
  at_risk: {
    icon: AlertTriangle,
    label: "Повышенный риск",
    description:
      "За последние 24 часа был инцидент. Снизьте темп или подождите окончания cooldown.",
    tone: "warning",
  },
  cooldown: {
    icon: ShieldAlert,
    label: "Cooldown — 24 часа",
    description:
      "GREEN-API дал жёлтую карточку. Любая активность в эти 24 часа поднимает шанс полного бана.",
    tone: "error",
  },
  blocked: {
    icon: XCircle,
    label: "Заблокирован",
    description:
      "Аккаунт заблокирован GREEN-API. Только владелец инстанса может разблокировать через консоль.",
    tone: "error",
  },
};

const TONE_CARD: Record<"success" | "info" | "warning" | "error", string> = {
  success: "bg-success-bg border-success/30 text-success",
  info: "bg-accent/10 border-accent/30 text-accent",
  warning: "bg-warning-bg border-warning/30 text-warning",
  error: "bg-error-bg border-error/30 text-error",
};

export function AccountHealthPanel() {
  const { primary, loading, error, refetch } = useAccountHealth(60_000);

  if (loading && primary === null) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-6 flex items-center gap-3 text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        Загрузка состояния аккаунта…
      </div>
    );
  }

  if (error && primary === null) {
    return (
      <div className="rounded-2xl border border-error/30 bg-error-bg p-6 text-sm text-error flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
        {error}
      </div>
    );
  }

  if (!primary) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-6 text-sm text-text-muted">
        Нет подключённого инстанса GREEN-API. Подключите в{" "}
        <a href="/dashboard/settings/instances" className="text-accent underline">
          настройках инстансов
        </a>
        .
      </div>
    );
  }

  const meta = HEALTH_META[primary.status];
  const Icon = meta.icon;

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-5 ${TONE_CARD[meta.tone]}`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg/50">
              <Icon className="h-6 w-6" strokeWidth={2} />
            </div>
            <div>
              <h3 className="text-lg font-semibold">{meta.label}</h3>
              <p className="text-sm opacity-90 mt-0.5">{meta.description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={refetch}
            className="inline-flex items-center gap-1 rounded-lg bg-bg/50 px-3 py-1.5 text-xs hover:bg-bg/70 transition-colors"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} />
            Обновить
          </button>
        </div>
        {primary.reasons.length > 0 && (
          <ul className="mt-3 text-sm space-y-1 ml-14">
            {primary.reasons.map((r, i) => (
              <li key={i} className="opacity-95">
                · {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Возраст инстанса" value={`${primary.age_days} дн`} />
        <Stat label="Текущий статус" value={primary.current_status} mono />
        <Stat label="Входящих за всё время" value={primary.total_incoming.toLocaleString("ru-RU")} />
        <Stat
          label="Inbound / Outbound 7д"
          value={`${primary.incoming_last_7d} / ${primary.outgoing_last_7d}`}
        />
        <Stat label="Проверок за 24ч" value={primary.checks_last_24h} />
        <Stat label="Рассылок за 24ч" value={primary.broadcasts_last_24h} />
        <Stat
          label="Инцидентов за 24ч"
          value={primary.incidents_last_24h}
          valueClass={primary.incidents_last_24h > 0 ? "text-warning" : undefined}
        />
        <Stat
          label="Рек. лимит проверок/сутки"
          value={primary.recommended_daily_check_limit}
          icon={<Clock className="h-3 w-3" strokeWidth={2} />}
        />
      </div>

      {primary.status !== "ok" && primary.status !== "blocked" && (
        <WarmUpChecklist health={primary} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
  icon,
  mono = false,
}: {
  label: string;
  value: string | number;
  valueClass?: string;
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl bg-surface border border-border px-3 py-2.5">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div
        className={`mt-1 font-semibold inline-flex items-center gap-1 ${valueClass ?? "text-text"} ${mono ? "font-mono text-sm" : "text-base"}`}
      >
        {icon}
        {value}
      </div>
    </div>
  );
}

function WarmUpChecklist({ health }: { health: AccountHealthData }) {
  const items: { done: boolean; text: string }[] = [
    {
      done: health.age_days >= 7,
      text: `Аккаунту минимум 7 дней (сейчас ${health.age_days})`,
    },
    {
      done: health.total_incoming >= 5,
      text: `Получено минимум 5 входящих сообщений (сейчас ${health.total_incoming})`,
    },
    {
      done: health.incoming_last_7d >= 3,
      text: `Минимум 3 входящих за последние 7 дней (сейчас ${health.incoming_last_7d})`,
    },
    {
      done: health.incidents_last_24h === 0,
      text: `За последние 24 часа без инцидентов (сейчас ${health.incidents_last_24h})`,
    },
  ];
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <h3 className="text-sm font-semibold text-text mb-3">
        Чеклист прогрева MAX-аккаунта
      </h3>
      <ul className="space-y-2 text-sm">
        {items.map((it, i) => (
          <li
            key={i}
            className={`flex items-start gap-2 ${
              it.done ? "text-success" : "text-text-muted"
            }`}
          >
            {it.done ? (
              <CheckCircle2
                className="h-4 w-4 mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
            ) : (
              <AlertCircle
                className="h-4 w-4 mt-0.5 shrink-0"
                strokeWidth={2}
              />
            )}
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-muted mt-3 leading-relaxed">
        Прогрев — это нормальный двусторонний трафик: отправь 5–10 сообщений
        знакомым контактам и получи ответы. MAX отслеживает паттерн «pure
        outbound» (только исходящие, нет ответов) и быстро банит такие
        аккаунты.
      </p>
    </div>
  );
}
