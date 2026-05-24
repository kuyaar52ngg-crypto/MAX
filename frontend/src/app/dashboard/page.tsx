"use client";

/**
 * Главная страница дашборда — оперативная сводка состояния аккаунта,
 * активных операций, ближайших задач и недавних инцидентов.
 *
 * Раньше тут был статичный набор счётчиков, теперь страница активная:
 * показывает реальное состояние работы и навигирует к проблемам.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Flame,
  HeartPulse,
  Inbox,
  Loader2,
  Megaphone,
  Phone,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { nxGet } from "@/lib/api";
import { useAccountHealth } from "@/lib/hooks/useAccountHealth";
import type { AccountHealthData, AccountHealthStatus } from "@/lib/anti-ban/health";
import { OnboardingChecklist } from "@/components/dashboard/OnboardingChecklist";

interface ActiveRun {
  id: number;
  kind: string;
  status: string;
  processed: number;
  total: number;
  started_at: string;
}

interface UpcomingScheduled {
  id: number;
  name: string | null;
  schedule_type: string;
  next_run_at: string | null;
  recipient_count: number;
}

interface RecentIncident {
  id: number;
  kind: string;
  created_at: string;
  details: Record<string, unknown>;
}

interface DashboardOverview {
  active_runs: ActiveRun[];
  upcoming_scheduled: UpcomingScheduled[];
  recent_incidents: RecentIncident[];
  stats_24h: {
    checks_processed: number;
    broadcasts_started: number;
    incoming_received: number;
    incidents_count: number;
  };
  last_broadcasts: {
    id: number;
    created_at: string;
    total: number;
    sent: number;
    failed: number;
    not_found: number;
    status: string;
    success_rate: number;
  }[];
  has_ever_broadcast: boolean;
}

const HEALTH_TONE: Record<AccountHealthStatus, { card: string; text: string; icon: typeof ShieldCheck }> = {
  ok: { card: "border-success/30 bg-success-bg", text: "text-success", icon: ShieldCheck },
  warming_up: { card: "border-accent/30 bg-accent/10", text: "text-accent", icon: Sparkles },
  fresh: { card: "border-warning/30 bg-warning-bg", text: "text-warning", icon: Flame },
  at_risk: { card: "border-warning/30 bg-warning-bg", text: "text-warning", icon: AlertTriangle },
  cooldown: { card: "border-error/30 bg-error-bg", text: "text-error", icon: AlertTriangle },
  blocked: { card: "border-error/40 bg-error-bg", text: "text-error", icon: XCircle },
};

const HEALTH_LABEL: Record<AccountHealthStatus, string> = {
  ok: "Аккаунт здоров",
  warming_up: "Аккаунт прогревается",
  fresh: "Свежий аккаунт",
  at_risk: "Повышенный риск",
  cooldown: "Cooldown 24 часа",
  blocked: "Заблокирован",
};

const INCIDENT_LABEL: Record<string, string> = {
  yellowCard: "Жёлтая карточка",
  blocked: "Блокировка",
  rate_limit_429: "Rate limit 429",
  quota_466: "Превышена квота",
  watchdog_reset: "Watchdog reset",
  throttle_paused: "Throttle pause",
  zero_response_ratio: "Нет ответов",
  instance_status_degraded: "Деградация инстанса",
  instance_connected: "Инстанс подключён",
  instance_reauthorized: "Инстанс перепривязан",
};

export default function DashboardPage() {
  const { primary: health, loading: healthLoading } = useAccountHealth(60_000);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await nxGet<DashboardOverview>("/api/dashboard/overview");
      setOverview(data);
    } catch {
      /* offline tolerable */
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-5 py-8 lg:px-8 lg:py-10">
      <header>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-xs font-medium text-text-secondary border border-border">
          <Activity className="h-3 w-3 text-accent" strokeWidth={2.5} />
          Live dashboard · обновляется каждые 30 секунд
        </div>
        <h1 className="text-3xl lg:text-4xl font-black tracking-[-0.03em] text-text">
          Панель управления
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Состояние аккаунта, активные операции и ближайшие задачи в одном месте.
        </p>
      </header>

      {/* Health strip — самое важное на самом верху */}
      <HealthStrip health={health} loading={healthLoading} />

      {/* Onboarding checklist — auto-hides when complete */}
      <OnboardingChecklist
        health={health}
        broadcastsStarted24h={overview?.stats_24h.broadcasts_started ?? 0}
        hasEverBroadcast={overview?.has_ever_broadcast ?? false}
      />

      {/* Stats 24h */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Проверено за 24ч"
          value={overview?.stats_24h.checks_processed ?? 0}
          icon={Phone}
          tone="info"
          href="/dashboard/contacts"
        />
        <StatCard
          label="Рассылок за 24ч"
          value={overview?.stats_24h.broadcasts_started ?? 0}
          icon={Send}
          tone="success"
          href="/dashboard/scheduled"
        />
        <StatCard
          label="Входящих за 24ч"
          value={overview?.stats_24h.incoming_received ?? 0}
          icon={Inbox}
          tone="neutral"
          href="/dashboard/messenger"
        />
        <StatCard
          label="Инцидентов за 24ч"
          value={overview?.stats_24h.incidents_count ?? 0}
          icon={AlertTriangle}
          tone={overview && overview.stats_24h.incidents_count > 0 ? "warning" : "neutral"}
          href="/dashboard/health"
        />
      </div>

      {/* Two columns: active runs + upcoming scheduled */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ActiveRunsCard runs={overview?.active_runs ?? []} loading={overviewLoading} />
        <UpcomingScheduledCard items={overview?.upcoming_scheduled ?? []} loading={overviewLoading} />
      </div>

      {/* Recent incidents + last broadcasts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RecentIncidentsCard incidents={overview?.recent_incidents ?? []} loading={overviewLoading} />
        <LastBroadcastsCard broadcasts={overview?.last_broadcasts ?? []} loading={overviewLoading} />
      </div>

      {/* Quick actions */}
      <section>
        <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-text-muted mb-3">
          Быстрые действия
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <QuickAction href="/dashboard/broadcast" icon={Megaphone} title="Новая рассылка" />
          <QuickAction href="/dashboard/contacts" icon={Phone} title="Проверка номеров" />
          <QuickAction href="/dashboard/warmup" icon={Flame} title="Прогрев аккаунта" />
          <QuickAction href="/dashboard/health" icon={HeartPulse} title="Состояние" />
        </div>
      </section>
    </div>
  );
}

function HealthStrip({
  health,
  loading,
}: {
  health: AccountHealthData | null;
  loading: boolean;
}) {
  if (loading && !health) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5 flex items-center gap-3 text-text-muted text-sm">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        Проверяем состояние аккаунта…
      </div>
    );
  }

  if (!health) {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning-bg p-5 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-warning mt-0.5 shrink-0" strokeWidth={2} />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-warning">
            Нет подключённого инстанса GREEN-API
          </h3>
          <p className="text-xs text-warning/90 mt-1">
            Чтобы запускать рассылки и проверки, подключите инстанс в настройках.
          </p>
        </div>
        <Link
          href="/dashboard/settings/instances"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-warning text-bg text-xs font-medium hover:opacity-90 transition-all"
        >
          Подключить
          <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      </div>
    );
  }

  const tone = HEALTH_TONE[health.status];
  const Icon = tone.icon;
  const label = HEALTH_LABEL[health.status];

  return (
    <Link
      href="/dashboard/health"
      className={`block rounded-2xl border p-5 transition-all hover:shadow-glow ${tone.card}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg/50">
            <Icon className={`h-6 w-6 ${tone.text}`} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h3 className={`text-base font-semibold ${tone.text}`}>{label}</h3>
            <div className="text-xs text-text-muted mt-0.5 flex items-center gap-3 flex-wrap">
              <span>Возраст: {health.age_days} дн</span>
              <span>·</span>
              <span>Входящих: {health.total_incoming}</span>
              <span>·</span>
              <span className="font-mono">{health.current_status}</span>
            </div>
            {health.reasons.length > 0 && (
              <p className={`text-xs ${tone.text} mt-1.5 opacity-90`}>
                {health.reasons[0]}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {health.recommended_daily_check_limit > 0 && (
            <QuotaPill
              label="Проверки"
              used={health.checks_last_24h}
              limit={health.recommended_daily_check_limit}
            />
          )}
          {health.recommended_daily_message_limit > 0 && (
            <QuotaPill
              label="Сообщения"
              used={health.broadcasts_last_24h}
              limit={health.recommended_daily_message_limit}
            />
          )}
        </div>
      </div>
    </Link>
  );
}

function QuotaPill({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const exhausted = used >= limit;
  return (
    <div className="rounded-xl bg-bg/40 px-3 py-2 min-w-[120px]">
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-mono mt-0.5">
        {used} / {limit}
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-bg overflow-hidden">
        <div
          className={`h-full ${exhausted ? "bg-error" : "bg-current opacity-50"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone: "neutral" | "success" | "warning" | "info";
  href?: string;
}) {
  const toneMap = {
    neutral: "bg-surface text-text",
    success: "bg-success-bg text-success",
    warning: "bg-warning-bg text-warning",
    info: "bg-accent/10 text-accent",
  };
  const inner = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-xl ${toneMap[tone]}`}
        >
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        </div>
      </div>
      <div className="text-2xl font-black tracking-[-0.03em] text-text">
        {typeof value === "number" ? value.toLocaleString("ru-RU") : value}
      </div>
      <div className="mt-1 text-xs font-medium text-text-muted">{label}</div>
    </>
  );
  const className =
    "block rounded-2xl border border-border bg-surface p-5 transition-all hover:-translate-y-0.5 hover:shadow-glow";
  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function ActiveRunsCard({ runs, loading }: { runs: ActiveRun[]; loading: boolean }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text inline-flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" strokeWidth={2} />
          Активные операции
        </h3>
        {runs.length > 0 && (
          <Link
            href="/dashboard/history"
            className="text-xs text-text-muted hover:text-accent inline-flex items-center gap-1"
          >
            Все <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
          </Link>
        )}
      </div>
      {loading && runs.length === 0 ? (
        <Skeleton lines={2} />
      ) : runs.length === 0 ? (
        <Empty
          icon={CheckCircle2}
          title="Нет активных операций"
          description="Все рассылки и проверки завершены."
        />
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-border bg-bg-elevated/50 p-3 flex items-center gap-3"
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                  r.kind === "broadcast"
                    ? "bg-success-bg text-success"
                    : "bg-accent/10 text-accent"
                }`}
              >
                {r.kind === "broadcast" ? (
                  <Send className="h-4 w-4" strokeWidth={2} />
                ) : (
                  <Phone className="h-4 w-4" strokeWidth={2} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text inline-flex items-center gap-2">
                  {r.kind === "broadcast" ? "Рассылка" : "Проверка номеров"}
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      r.status === "running"
                        ? "bg-success/15 text-success"
                        : "bg-warning/15 text-warning"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  {r.processed} / {r.total} ·{" "}
                  {Math.round((r.processed / Math.max(1, r.total)) * 100)}%
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-bg overflow-hidden">
                  <div
                    className={`h-full ${r.kind === "broadcast" ? "bg-success" : "bg-accent"}`}
                    style={{
                      width: `${Math.min(100, (r.processed / Math.max(1, r.total)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UpcomingScheduledCard({
  items,
  loading,
}: {
  items: UpcomingScheduled[];
  loading: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text inline-flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-accent" strokeWidth={2} />
          Ближайшие запланированные
        </h3>
        <Link
          href="/dashboard/scheduled"
          className="text-xs text-text-muted hover:text-accent inline-flex items-center gap-1"
        >
          Все <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      </div>
      {loading && items.length === 0 ? (
        <Skeleton lines={3} />
      ) : items.length === 0 ? (
        <Empty
          icon={CalendarClock}
          title="Нет запланированных рассылок"
          description="Откройте «Рассылка» и нажмите «Запланировать»."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-border bg-bg-elevated/50 px-3 py-2.5 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-text truncate">
                  {item.name?.trim() || `Рассылка #${item.id}`}
                </div>
                <div className="text-xs text-text-muted mt-0.5 inline-flex items-center gap-2">
                  <span>{item.recipient_count.toLocaleString("ru-RU")} получ.</span>
                  <span>·</span>
                  <span className="font-mono">{item.schedule_type}</span>
                </div>
              </div>
              {item.next_run_at && (
                <div className="text-right text-xs text-text-muted whitespace-nowrap">
                  <div className="inline-flex items-center gap-1 text-text">
                    <Clock className="h-3 w-3" strokeWidth={2.5} />
                    {formatRelativeTime(item.next_run_at)}
                  </div>
                  <div className="font-mono mt-0.5 text-[10px]">
                    {new Date(item.next_run_at).toLocaleString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentIncidentsCard({
  incidents,
  loading,
}: {
  incidents: RecentIncident[];
  loading: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text inline-flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={2} />
          Инциденты за 24 часа
        </h3>
        <Link
          href="/dashboard/health"
          className="text-xs text-text-muted hover:text-accent inline-flex items-center gap-1"
        >
          Подробно <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      </div>
      {loading && incidents.length === 0 ? (
        <Skeleton lines={3} />
      ) : incidents.length === 0 ? (
        <Empty
          icon={CheckCircle2}
          title="Чисто"
          description="За последние 24 часа инцидентов не было."
          tone="success"
        />
      ) : (
        <ul className="space-y-2">
          {incidents.map((inc) => (
            <li
              key={inc.id}
              className="rounded-xl border border-border bg-bg-elevated/50 px-3 py-2 flex items-start gap-2"
            >
              <AlertTriangle
                className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0"
                strokeWidth={2}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text truncate">
                  {INCIDENT_LABEL[inc.kind] ?? inc.kind}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  {formatRelativeTime(inc.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LastBroadcastsCard({
  broadcasts,
  loading,
}: {
  broadcasts: DashboardOverview["last_broadcasts"];
  loading: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text inline-flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-accent" strokeWidth={2} />
          Последние рассылки
        </h3>
        <Link
          href="/dashboard/history"
          className="text-xs text-text-muted hover:text-accent inline-flex items-center gap-1"
        >
          История <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      </div>
      {loading && broadcasts.length === 0 ? (
        <Skeleton lines={3} />
      ) : broadcasts.length === 0 ? (
        <Empty
          icon={ClipboardList}
          title="Рассылок ещё не было"
          description="Создайте первую через «Рассылка»."
        />
      ) : (
        <ul className="space-y-2">
          {broadcasts.map((b) => (
            <li
              key={b.id}
              className="rounded-xl border border-border bg-bg-elevated/50 px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-text">
                  Рассылка #{b.id}
                </div>
                <div
                  className={`text-xs font-mono ${
                    b.success_rate >= 80
                      ? "text-success"
                      : b.success_rate >= 50
                        ? "text-warning"
                        : "text-error"
                  }`}
                >
                  {b.success_rate}%
                </div>
              </div>
              <div className="text-xs text-text-muted mt-0.5 inline-flex items-center gap-2">
                <span>{b.sent}/{b.total} отправлено</span>
                {b.failed > 0 && <span>· {b.failed} ошибок</span>}
                {b.not_found > 0 && <span>· {b.not_found} не найдено</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-4 transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-text group-hover:bg-accent group-hover:text-bg transition-all">
        <Icon className="h-4 w-4" strokeWidth={2.2} />
      </div>
      <span className="text-sm font-semibold text-text">{title}</span>
      <ArrowRight
        className="ml-auto h-3.5 w-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
        strokeWidth={2.5}
      />
    </Link>
  );
}

function Empty({
  icon: Icon,
  title,
  description,
  tone = "neutral",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone?: "neutral" | "success";
}) {
  const color = tone === "success" ? "text-success" : "text-text-muted";
  return (
    <div className="text-center py-6">
      <Icon className={`mx-auto h-8 w-8 ${color} mb-2`} strokeWidth={1.5} />
      <div className={`text-sm font-medium ${tone === "success" ? "text-success" : "text-text"}`}>
        {title}
      </div>
      <div className="text-xs text-text-muted mt-0.5">{description}</div>
    </div>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-xl bg-bg-elevated/50 animate-pulse"
        />
      ))}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const sign = diff >= 0 ? "через" : "";
  const ago = diff < 0 ? "назад" : "";
  if (days >= 1) return diff >= 0 ? `${sign} ${days} дн` : `${days} дн ${ago}`;
  if (hours >= 1) return diff >= 0 ? `${sign} ${hours} ч` : `${hours} ч ${ago}`;
  if (minutes >= 1) return diff >= 0 ? `${sign} ${minutes} мин` : `${minutes} мин ${ago}`;
  return diff >= 0 ? "сейчас" : "только что";
}
