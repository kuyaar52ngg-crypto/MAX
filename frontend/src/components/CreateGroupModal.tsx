"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-bold text-text flex items-center gap-2">
            <Plus className="h-4 w-4" strokeWidth={2} />
            Новая группа
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
          <div>
            <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Название группы *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Клиенты Москва"
              maxLength={100}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25"
            />
          </div>

          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          <div>
            <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Приветственное сообщение
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Опционально: сообщение при создании группы"
              rows={2}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 resize-none"
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

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs text-text-muted hover:text-text transition-colors"
          >
            {result ? "Закрыть" : "Отмена"}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Создание...
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                Создать группу
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
