"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Loader2,
  LogOut,
  Pencil,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { apiPost, apiUpload } from "@/lib/api";
import { Chat, GroupData } from "@/lib/types";

interface GroupSettingsPanelProps {
  chat: Chat;
  open: boolean;
  onClose: () => void;
  /**
   * Called when the panel changes data that affects how chat appears in
   * the sidebar (e.g., name change, picture change, leave group).
   */
  onChatUpdated?: (next: Partial<Chat>) => void;
  /**
   * Called when user successfully leaves the group, so the parent can drop
   * the active chat and refresh the chat list.
   */
  onLeft?: () => void;
}

function normalizeGroupId(chatId: string): string {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us") || chatId.endsWith("@c.us")) return chatId;
  if (chatId.includes("-")) return `${chatId}@g.us`;
  return chatId;
}

export function GroupSettingsPanel({
  chat,
  open,
  onClose,
  onChatUpdated,
  onLeft,
}: GroupSettingsPanelProps) {
  const [data, setData] = useState<GroupData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(chat.name || "");
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [savingPicture, setSavingPicture] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isGroup = chat.type === "group";
  const groupId = normalizeGroupId(chat.chatId);

  useEffect(() => {
    setName(chat.name || "");
  }, [chat.name]);

  useEffect(() => {
    if (!open || !isGroup) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    apiPost<GroupData>("/api/group-details", { groupId })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Не удалось загрузить данные группы";
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isGroup, groupId]);

  async function refresh() {
    if (!isGroup) return;
    try {
      const res = await apiPost<GroupData>("/api/group-details", { groupId });
      setData(res);
    } catch {
      // ignore — error already shown for the action that triggered refresh
    }
  }

  async function handleSaveName() {
    const trimmed = name.trim();
    if (!isGroup) return;
    if (!trimmed || trimmed === chat.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      await apiPost("/api/update-group-name", { groupId, groupName: trimmed });
      onChatUpdated?.({ name: trimmed });
      setEditingName(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось переименовать группу");
    } finally {
      setSavingName(false);
    }
  }

  async function handleUploadPicture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !isGroup) return;
    if (!file.type.startsWith("image/")) {
      setError("Файл должен быть изображением");
      e.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Размер изображения не должен превышать 5 МБ");
      e.target.value = "";
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("groupId", groupId);
    setSavingPicture(true);
    setError(null);
    try {
      await apiUpload("/api/set-group-picture", fd);
      onChatUpdated?.({ avatarUrl: URL.createObjectURL(file) });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить фото");
    } finally {
      setSavingPicture(false);
      e.target.value = "";
    }
  }

  async function handleAddParticipant() {
    if (!isGroup) return;
    const cleaned = addPhone.replace(/\D/g, "");
    if (cleaned.length < 10) {
      setError("Введите номер длиной минимум 10 цифр");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await apiPost("/api/add-participant", {
        groupId,
        participantId: `${cleaned}@c.us`,
      });
      setAddPhone("");
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось добавить участника");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!isGroup) return;
    if (!confirm("Удалить участника из группы?")) return;
    setError(null);
    try {
      await apiPost("/api/remove-participant", { groupId, participantId });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось удалить участника");
    }
  }

  async function handleSetAdmin(participantId: string) {
    if (!isGroup) return;
    setError(null);
    try {
      await apiPost("/api/set-admin", { groupId, participantId });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось назначить администратора");
    }
  }

  async function handleRemoveAdmin(participantId: string) {
    if (!isGroup) return;
    setError(null);
    try {
      await apiPost("/api/remove-admin", { groupId, participantId });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось снять администратора");
    }
  }

  async function handleLeave() {
    if (!isGroup) return;
    if (!confirm("Покинуть группу?")) return;
    setError(null);
    try {
      await apiPost("/api/leave-group", { groupId });
      onLeft?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось выйти из группы");
    }
  }

  if (!open) return null;

  return (
    <aside className="absolute inset-y-0 right-0 z-30 w-full max-w-sm border-l border-border bg-surface shadow-lg flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <h3 className="text-sm font-bold text-text">{isGroup ? "Настройки группы" : "О чате"}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Avatar + name */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => isGroup && fileInputRef.current?.click()}
            disabled={!isGroup || savingPicture}
            className="relative shrink-0 h-20 w-20 rounded-full overflow-hidden bg-gradient-to-br from-emerald-600 to-emerald-400 flex items-center justify-center text-white shadow-md group disabled:cursor-default"
            aria-label={isGroup ? "Сменить фото группы" : ""}
          >
            {chat.avatarUrl ? (
              <img src={chat.avatarUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : isGroup ? (
              <Users className="h-7 w-7" strokeWidth={2} aria-hidden="true" />
            ) : (
              <span className="text-xl font-bold">
                {(chat.name || "?").slice(0, 2).toUpperCase()}
              </span>
            )}
            {isGroup && (
              <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[10px] font-bold uppercase tracking-wider">
                {savingPicture ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-5 w-5" />}
              </span>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleUploadPicture}
          />
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                  autoFocus
                  className="flex-1 min-w-0 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25"
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  disabled={savingName}
                  className="px-3 py-2 bg-accent text-bg text-xs font-bold rounded-lg shadow-md disabled:opacity-50"
                >
                  {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "OK"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setName(chat.name || "");
                    setEditingName(false);
                  }}
                  className="px-3 py-2 bg-surface text-text text-xs font-bold rounded-lg border border-border"
                >
                  Отмена
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="text-base font-bold text-text truncate">{chat.name || "Без имени"}</div>
                {isGroup && (
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    aria-label="Переименовать группу"
                    className="p-1 rounded text-text-muted hover:text-accent-light hover:bg-bg-elevated transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <div className="text-[11px] text-text-muted truncate font-mono mt-0.5">{chat.chatId}</div>
            {isGroup && data && (
              <div className="text-[11px] text-text-muted mt-1">
                Участников: {data.participants?.length ?? 0}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
            {error}
          </div>
        )}

        {isGroup && (
          <>
            {/* Add participant */}
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest">
                Добавить участника
              </label>
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={addPhone}
                  onChange={(e) => setAddPhone(e.target.value)}
                  placeholder="79001112233"
                  className="flex-1 min-w-0 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25"
                />
                <button
                  type="button"
                  onClick={handleAddParticipant}
                  disabled={adding || !addPhone.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg shadow-md disabled:opacity-50 disabled:shadow-none"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                  Добавить
                </button>
              </div>
            </div>

            {/* Participants */}
            <div>
              <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">
                Участники
              </h4>
              {loading ? (
                <div className="flex items-center justify-center py-8 text-text-muted">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                </div>
              ) : data?.participants?.length ? (
                <div className="rounded-xl border border-border bg-bg-elevated divide-y divide-border/60">
                  {data.participants.map((p, idx) => (
                    <div
                      key={`${p.id}-${idx}`}
                      className="flex items-center justify-between gap-3 px-3 py-2.5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
                            p.isAdmin ? "bg-accent shadow-md" : "bg-text-muted"
                          }`}
                        >
                          {(p.name || "?").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-text flex items-center gap-1.5 truncate">
                            {p.name || p.id}
                            {p.isAdmin && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent-light border border-accent-light/20 font-bold uppercase">
                                Admin
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-text-muted truncate">{p.id}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {p.isAdmin ? (
                          <button
                            type="button"
                            onClick={() => handleRemoveAdmin(p.id)}
                            aria-label="Снять администратора"
                            title="Снять администратора"
                            className="p-1.5 rounded-lg text-text-muted hover:text-warning hover:bg-warning-bg transition-colors"
                          >
                            <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSetAdmin(p.id)}
                            aria-label="Сделать администратором"
                            title="Сделать администратором"
                            className="p-1.5 rounded-lg text-text-muted hover:text-accent-light hover:bg-accent-subtle transition-colors"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveParticipant(p.id)}
                          aria-label="Удалить участника"
                          title="Удалить участника"
                          className="p-1.5 rounded-lg text-text-muted hover:text-error hover:bg-error-bg transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-text-muted">Список участников пуст</div>
              )}
            </div>

            {/* Leave */}
            <div className="border-t border-border pt-4">
              <button
                type="button"
                onClick={handleLeave}
                className="inline-flex items-center gap-2 px-3 py-2 bg-error-bg text-error border border-error/20 rounded-lg text-xs font-bold hover:bg-error hover:text-white transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Выйти из группы
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

export default GroupSettingsPanel;
