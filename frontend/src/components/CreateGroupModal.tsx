"use client";

import { useState } from "react";
import { Loader2, Plus, Users, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import { PhoneCollector } from "./PhoneCollector";

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (groupId: string, groupName: string) => void;
}

export function CreateGroupModal({
  open,
  onClose,
  onCreated,
}: CreateGroupModalProps) {
  const [name, setName] = useState("");
  const [phones, setPhones] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    group_id: string;
    members: number;
    not_found: string[];
  } | null>(null);

  if (!open) return null;

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName || creating) return;
    setCreating(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<{
        group_id: string;
        name: string;
        members: number;
        not_found: string[];
        message_sent: boolean;
      }>("/api/create-group", {
        name: trimmedName,
        phones,
        message: message.trim() || undefined,
      });
      setResult({
        group_id: res.group_id,
        members: res.members,
        not_found: res.not_found || [],
      });
      onCreated(res.group_id, res.name);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать группу");
    } finally {
      setCreating(false);
    }
  }

  function handleClose() {
    setName("");
    setPhones([]);
    setMessage("");
    setError(null);
    setResult(null);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-gradient-to-r from-accent/5 to-transparent backdrop-blur-md sticky top-0 z-10">
          <h3 className="text-base font-bold text-text flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-accent/10">
              <Plus className="h-5 w-5 text-accent" strokeWidth={2} />
            </div>
            Создание новой группы
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
          <div>
            <label className="block text-xs font-semibold text-text mb-2">
              Название группы <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Клиенты Москва"
              maxLength={100}
              className="w-full px-4 py-2.5 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
            />
          </div>

          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          <div>
            <label className="block text-xs font-semibold text-text mb-2">
              Приветственное сообщение <span className="text-text-muted text-[11px] font-normal">(опционально)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Сообщение, которое будет отправлено участникам при добавлении в группу"
              rows={3}
              className="w-full px-4 py-2.5 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all resize-none"
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
              {error}
            </div>
          )}

          {result && (
            <div className="px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-success text-xs space-y-1">
              <div>Группа создана! ID: {result.group_id}</div>
              <div>Добавлено участников: {result.members}</div>
              {result.not_found.length > 0 && (
                <div className="text-warning">
                  Не найдены: {result.not_found.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-surface/95 backdrop-blur-md sticky bottom-0 z-10">
          <div className="text-xs text-text-muted">
            {phones.length > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 text-accent rounded-lg font-medium">
                <Users className="h-3.5 w-3.5" strokeWidth={2} />
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
              {result ? "Закрыть" : "Отмена"}
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-accent/25 transition-all"
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  Создаю группу...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  Создать группу
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
