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
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-gradient-to-r from-accent/5 to-transparent">
          <h3 className="text-base font-bold text-text flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-accent/10">
              <UserPlus className="h-5 w-5 text-accent" strokeWidth={2} />
            </div>
            Массовое приглашение участников
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="p-2 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
          >
            <X className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          {error && (
            <div className="px-4 py-3 rounded-xl bg-error-bg border-2 border-error/30 text-error text-sm flex items-start gap-2">
              <X className="h-5 w-5 shrink-0 mt-0.5" strokeWidth={2} />
              <div>
                <div className="font-semibold mb-0.5">Ошибка приглашения</div>
                <div className="text-xs opacity-90">{error}</div>
              </div>
            </div>
          )}

          {results && (
            <div className="space-y-3">
              <div className="px-4 py-3 rounded-xl bg-success-bg border-2 border-success/30 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-success">Результаты приглашения</span>
                  <div className="flex gap-2">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-success text-white rounded-lg text-xs font-bold">
                      ✓ {successCount}
                    </span>
                    {failCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-warning text-white rounded-lg text-xs font-bold">
                        ✗ {failCount}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-success/80">
                  Успешно добавлено: {successCount} из {results.length} участников
                </div>
              </div>
              {results.filter((r) => !r.success).length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-text mb-2">Не удалось добавить:</div>
                  <div className="rounded-xl border-2 border-border bg-bg-elevated divide-y divide-border/60 max-h-40 overflow-y-auto">
                    {results
                      .filter((r) => !r.success)
                      .map((r, i) => (
                        <div
                          key={`${r.phone}-${i}`}
                          className="flex items-center justify-between px-4 py-2.5 text-sm"
                        >
                          <span className="text-text font-medium">{r.phone}</span>
                          <span className="text-text-muted text-xs">
                            {r.error || "Номер не найден в WhatsApp"}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-bg-elevated/50">
          <div className="text-xs text-text-muted">
            {phones.length > 0 && !results && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 text-accent rounded-lg font-medium">
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                {phones.length} {phones.length === 1 ? 'участник' : phones.length < 5 ? 'участника' : 'участников'}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-5 py-2.5 text-sm text-text-muted hover:text-text hover:bg-surface rounded-xl transition-colors font-medium"
            >
              {results ? "Закрыть" : "Отмена"}
            </button>
            <button
              type="button"
              onClick={handleInvite}
              disabled={inviting || phones.length === 0}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-accent/25 transition-all"
            >
              {inviting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  Приглашаю...
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" strokeWidth={2} />
                  Пригласить ({phones.length})
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
