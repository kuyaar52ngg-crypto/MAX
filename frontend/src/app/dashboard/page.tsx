"use client";

import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";
import { InstanceStatus } from "@/lib/types";

export default function DashboardPage() {
  const [status, setStatus] = useState<InstanceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStatus();
    const intervalId = setInterval(loadStatus, 15000);
    return () => clearInterval(intervalId);
  }, []);

  async function loadStatus() {
    try {
      const data = await apiGet<InstanceStatus>("/api/status");
      setStatus(data);
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
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text">Панель управления</h1>
          <p className="text-text-muted text-sm mt-1">Обзор состояния MAX Bot</p>
        </div>
        <div className="status-badge flex items-center gap-2 px-4 py-2 rounded-full glass border border-border">
          <span className={`w-2 h-2 rounded-full ${status?.state === "authorized" ? "bg-success animate-pulse" : "bg-warning"}`} />
          <span className={`text-sm font-medium ${current.color}`}>{loading ? "..." : current.text}</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Всего контактов" value={status?.stats.total ?? 0} icon="👥" color="accent" />
        <StatCard label="Отправлено" value={status?.stats.sent ?? 0} icon="✅" color="success" />
        <StatCard label="Не найдено" value={status?.stats.not_found ?? 0} icon="❓" color="warning" />
        <StatCard label="Доставка" value={`${status?.stats.success_rate ?? 0}%`} icon="📈" color="accent" />
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <QuickAction href="/dashboard/messenger" icon="💬" title="Мессенджер" desc="Открыть чаты и группы" />
        <QuickAction href="/dashboard/broadcast" icon="📢" title="Рассылка" desc="Создать новую рассылку" />
        <QuickAction href="/dashboard/contacts" icon="🔍" title="Проверка номеров" desc="Массовая проверка контактов" />
      </div>

      {/* Instance Info */}
      {status && (
        <div className="glass rounded-2xl p-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">Инстанс</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <InfoItem label="Статус" value={current.text} />
            <InfoItem label="Рассылка" value={status.broadcast_active ? "🔴 Активна" : "💤 Нет"} />
            <InfoItem label="Непрочитанные" value={String(status.unread_count)} />
            <InfoItem label="Успешность" value={`${status.stats.success_rate}%`} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: number | string; icon: string; color: string }) {
  const colorMap: Record<string, string> = {
    accent: "border-accent/20 bg-accent-subtle",
    success: "border-success/20 bg-success-bg",
    warning: "border-warning/20 bg-warning-bg",
    error: "border-error/20 bg-error-bg",
  };

  return (
    <div className={`stat-card rounded-2xl border ${colorMap[color] || colorMap.accent} p-5 transition-all duration-300 hover:scale-[1.02] hover:shadow-glow cursor-default`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-2xl">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-text">{value}</div>
      <div className="text-xs text-text-muted mt-1">{label}</div>
    </div>
  );
}

function QuickAction({ href, icon, title, desc }: { href: string; icon: string; title: string; desc: string }) {
  return (
    <a
      href={href}
      className="stat-card group flex items-center gap-4 p-5 rounded-2xl glass border border-border
                 hover:border-accent/30 hover:shadow-glow transition-all duration-300"
    >
      <span className="text-3xl group-hover:scale-110 transition-transform duration-200">{icon}</span>
      <div>
        <div className="text-sm font-semibold text-text group-hover:text-accent-light transition-colors">{title}</div>
        <div className="text-xs text-text-muted">{desc}</div>
      </div>
    </a>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-text-muted text-xs">{label}</div>
      <div className="text-text font-medium">{value}</div>
    </div>
  );
}
