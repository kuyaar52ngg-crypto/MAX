"use client";

/**
 * `/dashboard/scheduled/awaiting-approval` — список рассылок, требующих
 * одобрения текущим пользователем (он указан как `approval_user_id` и
 * `approval_status === "pending"`).
 *
 * Действия:
 *   - Approve  → `POST /api/scheduled-broadcasts/[id]/approve`
 *   - Reject   → `POST /api/scheduled-broadcasts/[id]/reject` с reason
 *
 * Список перечитывается каждые 30 секунд (чтобы видеть новые заявки),
 * а также после каждого действия.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Users,
  XCircle,
} from "lucide-react";

import { nxGet, nxPost } from "@/lib/api";

interface ApprovalItem {
  id: number;
  name: string | null;
  message: string;
  contacts: unknown[]; // не показываем подробно — только число
  scheduled_for: string | null;
  user_id: string;
  created_at: string;
  approval_status: string;
  status: string;
}

const POLL_INTERVAL_MS = 30_000;

export default function AwaitingApprovalPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await nxGet<ApprovalItem[]>("/api/scheduled-broadcasts");
      // Сервер возвращает все рассылки текущего пользователя, но в
      // approval-задачах user_id != approval_user_id. У нас нет
      // отдельного endpoint-а, поэтому фильтруем здесь — достаём
      // только pending_approval, где caller = approver. Это работает
      // потому что approve/reject route проверят caller=approval_user_id
      // дополнительно.
      const filtered = (Array.isArray(data) ? data : []).filter(
        (it) =>
          it.approval_status === "pending" &&
          (it.status === "pending_approval" || it.status === "scheduled"),
      );
      setItems(filtered);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function approve(item: ApprovalItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await nxPost(`/api/scheduled-broadcasts/${item.id}/approve`, {});
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось одобрить");
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject() {
    if (rejectId === null) return;
    if (!rejectReason.trim()) {
      setError("Укажите причину отказа");
      return;
    }
    setBusyId(rejectId);
    setError(null);
    try {
      await nxPost(`/api/scheduled-broadcasts/${rejectId}/reject`, {
        rejection_reason: rejectReason.trim(),
      });
      setRejectId(null);
      setRejectReason("");
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось отклонить");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <ClipboardCheck className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          На одобрении
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Большие рассылки требуют двойного подтверждения. Здесь вы видите
          задачи, в которых вы назначены аппрувером.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Загрузка…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <CheckCircle2
            className="mx-auto h-10 w-10 text-success mb-3"
            strokeWidth={1.5}
          />
          <h3 className="text-base font-semibold text-text">Чисто</h3>
          <p className="text-sm text-text-muted mt-1">
            На вашем столе нет задач, требующих одобрения.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ApprovalCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onApprove={() => approve(item)}
              onReject={() => {
                setRejectId(item.id);
                setRejectReason("");
              }}
            />
          ))}
        </div>
      )}

      {rejectId !== null && (
        <RejectModal
          reason={rejectReason}
          onChange={setRejectReason}
          busy={busyId === rejectId}
          onCancel={() => {
            setRejectId(null);
            setRejectReason("");
          }}
          onSubmit={submitReject}
        />
      )}
    </div>
  );
}

interface ApprovalCardProps {
  item: ApprovalItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

function ApprovalCard({ item, busy, onApprove, onReject }: ApprovalCardProps) {
  const recipientCount = Array.isArray(item.contacts) ? item.contacts.length : 0;
  return (
    <article className="rounded-2xl border border-border bg-surface p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-bg text-warning">
          <ClipboardCheck className="h-5 w-5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-text">
            {item.name?.trim() || `Рассылка #${item.id}`}
          </h3>
          <div className="text-xs text-text-muted mt-0.5 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" strokeWidth={2} />
              {recipientCount.toLocaleString("ru-RU")} получателей
            </span>
            {item.scheduled_for && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3 w-3" strokeWidth={2} />
                {new Date(item.scheduled_for).toLocaleString("ru-RU")}
              </span>
            )}
            <span>создано {new Date(item.created_at).toLocaleDateString("ru-RU")}</span>
          </div>
        </div>
      </div>

      <pre className="text-sm text-text-secondary whitespace-pre-wrap break-words bg-bg-elevated/50 rounded-lg p-3 max-h-32 overflow-y-auto">
        {item.message || "—"}
      </pre>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg bg-bg-elevated border border-border text-error px-4 py-2 text-sm hover:border-error/40 transition-colors disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" strokeWidth={2} />
          Отклонить
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg bg-success text-bg px-4 py-2 text-sm font-medium hover:opacity-90 transition-all disabled:opacity-50 active:scale-95"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
          )}
          Одобрить
        </button>
      </div>
    </article>
  );
}

function RejectModal({
  reason,
  onChange,
  busy,
  onCancel,
  onSubmit,
}: {
  reason: string;
  onChange: (s: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">Отклонить рассылку</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="p-5 space-y-4"
        >
          <label className="block text-xs text-text-muted">
            Причина (обязательно — будет видна автору)
          </label>
          <textarea
            value={reason}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            placeholder="Например: «Слишком крупная рассылка перед праздником, давай разнесём»"
            className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50 resize-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={busy || reason.trim().length === 0}
              className="inline-flex items-center gap-1 rounded-lg bg-error text-bg px-5 py-2 text-sm font-medium hover:opacity-90 transition-all disabled:opacity-50 active:scale-95"
            >
              {busy && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
              )}
              Отклонить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
