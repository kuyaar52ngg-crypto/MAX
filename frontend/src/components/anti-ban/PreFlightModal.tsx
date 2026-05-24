"use client";

/**
 * `PreFlightModal` — обязательный шаг перед запуском массовой операции.
 *
 * До запроса:
 *   1. Тянет `useAccountHealth` — оценку текущего инстанса.
 *   2. Если health.status ∈ {fresh, blocked, cooldown} — кнопка «Запустить»
 *      ЗАБЛОКИРОВАНА (пользователь не может игнорить ban-сигнал).
 *   3. Если health.status === "at_risk" или "warming_up" — kt опция:
 *      кнопка активна только после double-acknowledge.
 *   4. Если recommended_daily_check_limit < total — показываем warning
 *      «вы превышаете рекомендованный лимит».
 *   5. Если total > computeRisk-high порога — отдельный warning-блок.
 *
 * Источники:
 *   - реальный кейс с баном на 150 проверках (4 декабря 2026)
 *   - design.md `anti-ban-protection` (Requirement 6.x — PreFlight)
 *   - новые health-категории см. `lib/anti-ban/health.ts`
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HeartPulse,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";

import {
  AntiBanConfig,
  computeEta,
  computeRisk,
} from "@/lib/anti-ban";
import type {
  AccountHealthData,
  AccountHealthStatus,
} from "@/lib/anti-ban/health";
import { useAccountHealth } from "@/lib/hooks/useAccountHealth";

export interface PreFlightModalProps {
  open: boolean;
  kind: "check" | "broadcast";
  total: number;
  config: AntiBanConfig;
  onConfirm: () => void;
  onCancel: () => void;
}

const RISK_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
};

const RISK_COLOR: Record<"low" | "medium" | "high", string> = {
  low: "text-success",
  medium: "text-warning",
  high: "text-error",
};

const HEALTH_META: Record<
  AccountHealthStatus,
  {
    icon: typeof HeartPulse;
    label: string;
    tone: "success" | "info" | "warning" | "error";
  }
> = {
  ok: { icon: ShieldCheck, label: "Аккаунт здоров", tone: "success" },
  warming_up: {
    icon: Sparkles,
    label: "Аккаунт прогревается",
    tone: "info",
  },
  fresh: {
    icon: AlertCircle,
    label: "Свежий аккаунт без истории",
    tone: "warning",
  },
  at_risk: {
    icon: AlertTriangle,
    label: "Повышенный риск",
    tone: "warning",
  },
  cooldown: {
    icon: ShieldAlert,
    label: "Cooldown 24 часа",
    tone: "error",
  },
  blocked: {
    icon: XCircle,
    label: "Аккаунт заблокирован",
    tone: "error",
  },
};

const TONE_BG: Record<"success" | "info" | "warning" | "error", string> = {
  success: "bg-success-bg border-success/30 text-success",
  info: "bg-accent/10 border-accent/30 text-accent",
  warning: "bg-warning-bg border-warning/30 text-warning",
  error: "bg-error-bg border-error/30 text-error",
};

const HARD_BLOCKED_STATUSES: readonly AccountHealthStatus[] = [
  "blocked",
  "cooldown",
];

const REQUIRES_DOUBLE_ACK_STATUSES: readonly AccountHealthStatus[] = [
  "fresh",
  "at_risk",
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.floor(seconds % 60);
  if (minutes < 60)
    return `${minutes} мин ${remSec.toString().padStart(2, "0")} сек`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours} ч ${remMin.toString().padStart(2, "0")} мин`;
}

function formatRemainingCooldown(blockedUntilIso: string | null): string | null {
  if (!blockedUntilIso) return null;
  const releaseAt = new Date(blockedUntilIso);
  if (!Number.isFinite(releaseAt.getTime())) return null;
  const ms = releaseAt.getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

export function PreFlightModal({
  open,
  kind,
  total,
  config,
  onConfirm,
  onCancel,
}: PreFlightModalProps) {
  const [acknowledgedRisks, setAcknowledgedRisks] = useState(false);
  const [acknowledgedHealth, setAcknowledgedHealth] = useState(false);

  const { primary: health, loading: healthLoading } = useAccountHealth(open ? 30_000 : 0);

  // Сброс ack при закрытии — чтобы при повторном открытии человек явно подтвердил.
  useEffect(() => {
    if (!open) {
      setAcknowledgedRisks(false);
      setAcknowledgedHealth(false);
    }
  }, [open]);

  if (!open) return null;

  const eta = computeEta(config, total);
  const risk = computeRisk(total);
  const title = kind === "check" ? "Массовая проверка номеров" : "Рассылка сообщений";

  const hardBlocked =
    health !== null && HARD_BLOCKED_STATUSES.includes(health.status);
  const needsHealthAck =
    health !== null &&
    REQUIRES_DOUBLE_ACK_STATUSES.includes(health.status);

  const recommendedLimit =
    kind === "check"
      ? health?.recommended_daily_check_limit ?? Infinity
      : health?.recommended_daily_message_limit ?? Infinity;
  const overLimit = total > recommendedLimit;

  const cooldownRemaining = formatRemainingCooldown(health?.blocked_until ?? null);

  const canConfirm =
    !hardBlocked &&
    acknowledgedRisks &&
    (!needsHealthAck || acknowledgedHealth);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preflight-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg rounded-2xl border border-border shadow-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
      >
        <header className="px-6 py-4 border-b border-border flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <ShieldAlert className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h2 id="preflight-title" className="text-lg font-semibold text-text">
              {title}
            </h2>
            <p className="text-xs text-text-muted">Проверка перед запуском</p>
          </div>
        </header>

        <div className="px-6 py-5 space-y-4">
          {/* ── Health-карточка инстанса ─────────────────────────────────── */}
          {healthLoading && health === null ? (
            <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3 flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              Проверяем состояние аккаунта…
            </div>
          ) : health ? (
            <HealthCard health={health} cooldownRemaining={cooldownRemaining} />
          ) : (
            <div className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning flex gap-2">
              <AlertTriangle
                className="h-4 w-4 mt-0.5 shrink-0"
                strokeWidth={2}
              />
              Не удалось определить состояние аккаунта. Перед запуском убедитесь,
              что инстанс GREEN-API подключён.
            </div>
          )}

          {/* ── Сводка операции ──────────────────────────────────────────── */}
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Получателей" value={total.toLocaleString("ru-RU")} />
            <Stat label="Длительность" value={formatDuration(eta)} icon={<Clock className="h-3 w-3" strokeWidth={2} />} />
            <Stat
              label="Риск объёма"
              value={RISK_LABEL[risk]}
              valueClass={RISK_COLOR[risk]}
            />
          </div>

          {/* ── Warning: превышение recommended limit ────────────────────── */}
          {overLimit && health !== null && (
            <div className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning flex gap-2">
              <AlertTriangle
                className="h-4 w-4 mt-0.5 shrink-0"
                strokeWidth={2}
              />
              <div>
                Вы запускаете {total} {kind === "check" ? "проверок" : "сообщений"}, но для
                текущего состояния аккаунта рекомендуется не более{" "}
                <strong>{recommendedLimit}</strong> в сутки. Это повышает шанс
                бана.
              </div>
            </div>
          )}

          {/* ── Hard-block: cooldown / blocked ─────────────────────────── */}
          {hardBlocked && health && (
            <div className="rounded-xl border border-error/40 bg-error-bg px-4 py-3 text-sm text-error space-y-1">
              <div className="flex items-start gap-2 font-semibold">
                <ShieldAlert
                  className="h-4 w-4 mt-0.5 shrink-0"
                  strokeWidth={2.2}
                />
                Запуск заблокирован системой защиты
              </div>
              {health.reasons.map((r, i) => (
                <div key={i} className="text-xs ml-6">
                  · {r}
                </div>
              ))}
              {cooldownRemaining && (
                <div className="text-xs ml-6">
                  · До разблокировки: <strong>{cooldownRemaining}</strong>
                </div>
              )}
            </div>
          )}

          {/* ── Чеклист подтверждений ─────────────────────────────────── */}
          {!hardBlocked && (
            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-accent"
                  checked={acknowledgedRisks}
                  onChange={(e) => setAcknowledgedRisks(e.target.checked)}
                />
                <span className="text-sm text-text-secondary">
                  Я понимаю риски массовой операции и беру на себя ответственность
                  за возможный бан аккаунта.
                </span>
              </label>
              {needsHealthAck && (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-accent"
                    checked={acknowledgedHealth}
                    onChange={(e) => setAcknowledgedHealth(e.target.checked)}
                  />
                  <span className="text-sm text-warning">
                    Я понимаю, что аккаунт сейчас в категории «{
                      health ? HEALTH_META[health.status].label : ""
                    }», и риск бана выше обычного.
                  </span>
                </label>
              )}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-border flex justify-end gap-2 sticky bottom-0 bg-bg">
          <button
            type="button"
            className="px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:bg-bg-elevated transition-colors"
            onClick={onCancel}
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            className={`inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              hardBlocked
                ? "bg-bg-elevated text-text-muted"
                : "bg-accent text-bg hover:bg-accent-hover active:scale-95"
            }`}
            onClick={() => {
              if (canConfirm) onConfirm();
            }}
          >
            {hardBlocked ? (
              <>
                <ShieldAlert className="h-4 w-4" strokeWidth={2} />
                Запрещено системой защиты
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                Запустить
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
  icon,
}: {
  label: string;
  value: string;
  valueClass?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-bg-elevated border border-border px-3 py-2">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div
        className={`text-base font-semibold mt-0.5 inline-flex items-center gap-1 ${valueClass ?? "text-text"}`}
      >
        {icon}
        {value}
      </div>
    </div>
  );
}

function HealthCard({
  health,
  cooldownRemaining,
}: {
  health: AccountHealthData;
  cooldownRemaining: string | null;
}) {
  const meta = HEALTH_META[health.status];
  const Icon = meta.icon;
  return (
    <div
      className={`rounded-xl border px-4 py-3 space-y-2 ${TONE_BG[meta.tone]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
          <span className="text-sm font-semibold">{meta.label}</span>
        </div>
        <span className="text-xs opacity-75 font-mono">
          {health.current_status}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs opacity-90">
        <Metric label="Возраст" value={`${health.age_days} дн`} />
        <Metric label="Входящих" value={health.total_incoming} />
        <Metric label="Проверок 24ч" value={health.checks_last_24h} />
        <Metric label="Инцидентов 24ч" value={health.incidents_last_24h} />
      </div>
      {health.reasons.length > 0 && (
        <ul className="text-xs space-y-1 pt-1">
          {health.reasons.map((r, i) => (
            <li key={i} className="opacity-90">
              · {r}
            </li>
          ))}
        </ul>
      )}
      {cooldownRemaining && (
        <div className="text-xs font-semibold opacity-95">
          До разблокировки: {cooldownRemaining}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide opacity-70">
        {label}
      </div>
      <div className="font-mono mt-0.5">{value}</div>
    </div>
  );
}

export default PreFlightModal;
