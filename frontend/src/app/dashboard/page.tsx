"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Activity,
  CircleHelp,
  Megaphone,
  MessageCircle,
  SearchCheck,
  Send,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { apiGet, nxGet } from "@/lib/api";
import { InstanceStatus } from "@/lib/types";

export default function DashboardPage() {
  const [status, setStatus] = useState<InstanceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(loadStatus, 15000);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    // Первый прогон сразу. Дальше — поллинг только пока вкладка видна,
    // чтобы не ходить в сеть, когда дашборд скрыт.
    (async () => {
      await loadStatus();
      if (cancelled) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        start();
      }
    })();

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        loadStatus();
        start();
      } else {
        stop();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  async function loadStatus() {
    try {
      const [flask, db] = await Promise.all([
        apiGet<{ state: string; broadcast_active: boolean }>("/api/status").catch(() => ({ state: "error", broadcast_active: false })),
        nxGet<{ stats: InstanceStatus["stats"]; unread_count: number }>("/api/status").catch(() => ({ stats: { total: 0, sent: 0, not_found: 0, failed: 0, success_rate: 0 }, unread_count: 0 })),
      ]);
      setStatus({
        state: flask.state,
        broadcast_active: flask.broadcast_active,
        stats: db.stats,
        unread_count: db.unread_count,
      });
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }

  const stateLabel: Record<string, { text: string; color: string }> = {
    authorized: { text: "Подключён", color: "text-success" },
    notAuthorized: { text: "Не авторизован", color: "text-warning" },
    blocked: { text: "Заблокирован", color: "text-error" },
    sleepMode: { text: "Спящий режим", color: "text-warning" },
    error: { text: "Ошибка", color: "text-error" },
  };

  const current = stateLabel[status?.state || "error"] || stateLabel.error;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-5 py-8 lg:px-8 lg:py-10">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-bg-elevated p-6 shadow-sm lg:p-8">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent-light/15 blur-3xl" />
        <div className="absolute -bottom-28 left-1/3 h-72 w-72 rounded-full bg-info/15 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-xs font-medium text-text-secondary shadow-sm">
              <Activity className="h-3.5 w-3.5 text-accent-light" strokeWidth={2.2} />
              Live dashboard
            </div>
            <h1 className="max-w-xl text-4xl font-black leading-none tracking-[-0.04em] text-text lg:text-5xl">
              Панель управления MAX Bot
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-text-muted">
              Рассылки, входящие сообщения и проверка контактов в одном рабочем пространстве.
            </p>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 shadow-sm">
            <span className={`h-2 w-2 rounded-full ${status?.state === "authorized" ? "bg-success animate-pulse" : "bg-warning"}`} />
            <span className={`text-sm font-semibold ${current.color}`}>{loading ? "Проверка..." : current.text}</span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Всего контактов" value={status?.stats.total ?? 0} icon={Users} tone="neutral" />
        <StatCard label="Отправлено" value={status?.stats.sent ?? 0} icon={Send} tone="success" />
        <StatCard label="Не найдено" value={status?.stats.not_found ?? 0} icon={CircleHelp} tone="warning" />
        <StatCard label="Доставка" value={`${status?.stats.success_rate ?? 0}%`} icon={TrendingUp} tone="info" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <QuickAction href="/dashboard/messenger" icon={MessageCircle} title="Мессенджер" desc="Открыть чаты и группы" />
        <QuickAction href="/dashboard/broadcast" icon={Megaphone} title="Рассылка" desc="Создать новую кампанию" />
        <QuickAction href="/dashboard/contacts" icon={SearchCheck} title="Проверка номеров" desc="Очистить базу перед отправкой" />
      </div>

      {status && (
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-text-muted">Инстанс</h3>
          <div className="mt-5 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
            <InfoItem label="Статус" value={current.text} />
            <InfoItem label="Рассылка" value={status.broadcast_active ? "Активна" : "Нет"} />
            <InfoItem label="Непрочитанные" value={String(status.unread_count)} />
            <InfoItem label="Успешность" value={`${status.stats.success_rate}%`} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: number | string; icon: LucideIcon; tone: string }) {
  const toneMap: Record<string, string> = {
    neutral: "bg-surface text-text",
    success: "bg-success-bg text-success",
    warning: "bg-warning-bg text-warning",
    info: "bg-bg-elevated text-info",
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-glow">
      <div className="mb-5 flex items-center justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${toneMap[tone] || toneMap.neutral}`}>
          <Icon className="h-5 w-5" strokeWidth={2.2} />
        </div>
      </div>
      <div className="text-3xl font-black tracking-[-0.03em] text-text">{value}</div>
      <div className="mt-2 text-xs font-medium text-text-muted">{label}</div>
    </div>
  );
}

function QuickAction({ href, icon: Icon, title, desc }: { href: string; icon: LucideIcon; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-border-focus hover:shadow-glow"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg-elevated text-text transition-all group-hover:bg-accent group-hover:text-bg">
        <Icon className="h-5 w-5" strokeWidth={2.2} />
      </div>
      <div>
        <div className="text-sm font-bold text-text">{title}</div>
        <div className="mt-1 text-xs text-text-muted">{desc}</div>
      </div>
    </Link>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg-elevated p-4">
      <div className="text-xs font-medium text-text-muted">{label}</div>
      <div className="mt-1 text-sm font-bold text-text">{value}</div>
    </div>
  );
}
