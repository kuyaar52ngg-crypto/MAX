"use client";

import { useState } from "react";
import { Loader2, UserPlus, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import { PhoneCollector } from "./PhoneCollector";

interface InviteModalProps {
  open: boolean;
  groupId: string;
  onClose: () => void;
  onInvited: () => void;
}

interface InviteResult {
  phone: string;
  success: boolean;
  error?: string;
}

export function InviteModal({
  open,
  groupId,
  onClose,
  onInvited,
}: InviteModalProps) {
  const [phones, setPhones] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResult[] | null>(null);

  if (!open) return null;

  async function handleInvite() {
    if (phones.length === 0 || inviting) return;
    setInviting(true);
    setError(null);
    setResults(null);
    try {
      const res = await apiPost<{ results: InviteResult[] }>(
        `/api/group/${encodeURIComponent(groupId)}/add-bulk`,
        { phones },
      );
      setResults(res.results || []);
      onInvited();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось пригласить участников");
    } finally {
      setInviting(false);
    }
  }

  function handleClose() {
    setPhones([]);
    setError(null);
    setResults(null);
    onClose();
  }

  const successCount = results ? results.filter((r) => r.success).length : 0;
  const failCount = results ? results.filter((r) => !r.success).length : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-bold text-text flex items-center gap-2">
            <UserPlus className="h-4 w-4" strokeWidth={2} />
            Пригласить участников
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
              {error}
            </div>
          )}

          {results && (
            <div className="space-y-2">
              <div className="px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-xs space-y-1">
                <div className="text-success">
                  Добавлено: {successCount} из {results.length}
                </div>
                {failCount > 0 && (
                  <div className="text-warning">
                    Не найдены: {failCount}
                  </div>
                )}
              </div>
              {results.filter((r) => !r.success).length > 0 && (
                <div className="rounded-lg border border-border bg-bg-elevated divide-y divide-border/60 max-h-32 overflow-y-auto">
                  {results
                    .filter((r) => !r.success)
                    .map((r, i) => (
                      <div
                        key={`${r.phone}-${i}`}
                        className="flex items-center justify-between px-3 py-1.5 text-xs"
                      >
                        <span className="text-text">{r.phone}</span>
                        <span className="text-text-muted">
                          {r.error || "Не найден"}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs text-text-muted hover:text-text transition-colors"
          >
            {results ? "Закрыть" : "Отмена"}
          </button>
          <button
            type="button"
            onClick={handleInvite}
            disabled={inviting || phones.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {inviting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Приглашение...
              </>
            ) : (
              <>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                Пригласить ({phones.length})
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
