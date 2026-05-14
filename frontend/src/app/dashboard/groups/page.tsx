"use client";

import { useState, useEffect, useRef } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { apiGet, apiPost, apiUpload, nxGet, nxPost, nxDelete } from "@/lib/api";
import { Chat, GroupData, GroupParticipant } from "@/lib/types";

type CreateResult = {
  groupId: string;
  members: number;
  notFound: string[];
  messageSent: boolean;
  pictureUploaded: boolean;
  pictureError?: string;
};

export default function GroupsPage() {
  const [groups, setGroups] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatsLoadError, setChatsLoadError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<Chat | null>(null);
  const [groupData, setGroupData] = useState<GroupData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  
  // Create group state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [newGroupPhones, setNewGroupPhones] = useState("");
  const [newGroupPhotoFile, setNewGroupPhotoFile] = useState<File | null>(null);
  const [newGroupPhotoPreview, setNewGroupPhotoPreview] = useState<string | null>(null);
  const [newGroupPhoneMethod, setNewGroupPhoneMethod] = useState<"manual" | "csv">("manual");
  const [newGroupCsvError, setNewGroupCsvError] = useState<string | null>(null);
  const [newGroupError, setNewGroupError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingStep, setCreatingStep] = useState<"idle" | "creating" | "uploading">("idle");
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  const newGroupPhotoInputRef = useRef<HTMLInputElement>(null);
  const newGroupCsvInputRef = useRef<HTMLInputElement>(null);

  // Add participant state
  const [showAddModal, setShowAddModal] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMethod, setAddMethod] = useState<'manual' | 'csv'>('manual');

  useEffect(() => {
    loadGroups();
  }, []);

  // Освобождаем blob: URL превью аватара при размонтировании, чтобы не текла память.
  // (При смене файла предыдущий URL уже отзывается в handleNewGroupPhotoSelect/clearNewGroupPhoto.)
  useEffect(() => {
    return () => {
      if (newGroupPhotoPreview) URL.revokeObjectURL(newGroupPhotoPreview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadGroups() {
    setLoading(true);
    setChatsLoadError(null);

    // Локальные группы (Prisma) грузятся отдельно — они доступны даже без
    // настроенного GREEN-API.
    const localGroupsPromise = nxGet<Array<Record<string, unknown>>>("/api/groups").catch(() => []);

    // GREEN-API через Flask. Может упасть, если нет кредов / инстанс не авторизован.
    let chatsRes: Array<Record<string, unknown>> = [];
    try {
      chatsRes = await apiGet<Array<Record<string, unknown>>>("/api/chats");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось загрузить чаты";
      setChatsLoadError(message);
    }

    const localGroupsRes = await localGroupsPromise;

    try {
      // Нормализуем ответ Flask: поля могут называться chatId или id, type
      // приходит как "user" / "group" / "channel". Защищаемся от undefined,
      // иначе .endsWith / .includes падают с TypeError и список не загружается.
      const allChats: Chat[] = (Array.isArray(chatsRes) ? chatsRes : [])
        .map((c) => {
          const chatId = String(c.chatId || c.id || "");
          const rawType = String(c.type || "");
          const isGroup =
            rawType === "group" || chatId.endsWith("@g.us") || chatId.includes("-");
          return {
            id: chatId,
            chatId,
            name: String(c.name || chatId || "Без имени"),
            type: isGroup ? ("group" as const) : ("chat" as const),
            preview: "",
            timestamp: 0,
            avatarUrl: null,
          };
        })
        .filter((c) => c.chatId);

      // Локальные группы из Prisma. Тоже нормализуем chatId, чтобы не словить
      // undefined в фильтрах ниже.
      const localAsChats: Chat[] = (Array.isArray(localGroupsRes) ? localGroupsRes : [])
        .map((g) => {
          const chatId = String(g.group_id || "");
          return {
            id: chatId,
            chatId,
            name: String(g.name || chatId || "Группа"),
            type: "group" as const,
            preview: "",
            timestamp: 0,
            avatarUrl: null,
          };
        })
        .filter((g) => g.chatId);

      // Объединяем списки, удаляя дубликаты по chatId.
      // Локальные группы (созданные в этом UI) идут первыми, чтобы вновь
      // созданная группа сразу появилась в списке, не дожидаясь её появления
      // в кэше GREEN-API /api/chats.
      const combined: Chat[] = [];
      const seen = new Set<string>();
      for (const g of [...localAsChats, ...allChats]) {
        if (!seen.has(g.chatId)) {
          combined.push(g);
          seen.add(g.chatId);
        }
      }

      // Оставляем только группы. Локальные уже type === "group", из /api/chats
      // фильтруем по type/суффиксу.
      const filtered = combined.filter(
        (c) => c.type === "group" || c.chatId.endsWith("@g.us") || c.chatId.includes("-"),
      );
      setGroups(filtered);
    } catch (err) {
      console.error("Failed to load groups:", err);
    } finally {
      setLoading(false);
    }
  }

  async function loadGroupData(group: Chat) {
    setActiveGroup(group);
    setLoadingData(true);
    setGroupData(null);
    try {
      const data = await apiPost<GroupData>("/api/group-details", { groupId: group.chatId });
      setGroupData(data);
    } catch (err) {
      console.error("Failed to load group data:", err);
    } finally {
      setLoadingData(false);
    }
  }

  function parsePhonesFromText(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[\n,;\s]+/)
          .map((p) => p.replace(/[^\d]/g, ""))
          .filter((p) => p.length >= 10 && p.length <= 15),
      ),
    );
  }

  function resetCreateForm() {
    setNewGroupName("");
    setNewGroupDescription("");
    setNewGroupPhones("");
    setNewGroupPhotoFile(null);
    setNewGroupPhotoPreview(null);
    setNewGroupPhoneMethod("manual");
    setNewGroupCsvError(null);
    setNewGroupError(null);
    setCreateResult(null);
    setCreatingStep("idle");
    if (newGroupPhotoInputRef.current) newGroupPhotoInputRef.current.value = "";
    if (newGroupCsvInputRef.current) newGroupCsvInputRef.current.value = "";
  }

  function closeCreateModal() {
    if (creating) return;
    setShowCreateModal(false);
    resetCreateForm();
  }

  function handleNewGroupPhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNewGroupError("Файл должен быть изображением");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setNewGroupError("Размер изображения не должен превышать 5 МБ");
      return;
    }
    setNewGroupError(null);
    setNewGroupPhotoFile(file);
    if (newGroupPhotoPreview) URL.revokeObjectURL(newGroupPhotoPreview);
    setNewGroupPhotoPreview(URL.createObjectURL(file));
  }

  function clearNewGroupPhoto() {
    if (newGroupPhotoPreview) URL.revokeObjectURL(newGroupPhotoPreview);
    setNewGroupPhotoFile(null);
    setNewGroupPhotoPreview(null);
    if (newGroupPhotoInputRef.current) newGroupPhotoInputRef.current.value = "";
  }

  async function handleNewGroupCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setNewGroupCsvError(null);
    try {
      const text = await file.text();
      const phones = parsePhonesFromText(text);
      if (!phones.length) {
        setNewGroupCsvError("В файле не найдено ни одного номера");
        return;
      }
      setNewGroupPhones(phones.join("\n"));
      setNewGroupPhoneMethod("manual");
    } catch {
      setNewGroupCsvError("Не удалось прочитать файл");
    } finally {
      if (newGroupCsvInputRef.current) newGroupCsvInputRef.current.value = "";
    }
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim() || creating) return;
    setNewGroupError(null);
    setCreateResult(null);
    setCreating(true);
    setCreatingStep("creating");
    try {
      const phones = parsePhonesFromText(newGroupPhones);
      const created = await apiPost<{
        group_id?: string;
        chatId?: string;
        members?: number;
        not_found?: string[];
        message_sent?: boolean;
      }>("/api/create-group", {
        name: newGroupName.trim(),
        phones,
        message: newGroupDescription.trim(),
      });

      const newGroupId = String(created?.group_id || created?.chatId || "");
      if (!newGroupId) {
        throw new Error("Сервер не вернул идентификатор созданной группы");
      }

      // Сохраняем созданную группу локально, чтобы она сразу появилась в списке —
      // GREEN-API /api/chats возвращает свежие группы с задержкой.
      await nxPost("/api/groups", { group_id: newGroupId, name: newGroupName.trim() }).catch(() => {});

      // Опциональная загрузка аватарки
      let pictureUploaded = false;
      let pictureError: string | undefined;
      if (newGroupPhotoFile) {
        setCreatingStep("uploading");
        try {
          const fd = new FormData();
          fd.append("file", newGroupPhotoFile);
          fd.append("groupId", newGroupId);
          const picRes = await apiUpload<{ success?: boolean; error?: string }>(
            "/api/set-group-picture",
            fd,
          );
          pictureUploaded = !!picRes?.success;
          if (!pictureUploaded && picRes?.error) pictureError = picRes.error;
        } catch (err: any) {
          pictureError = err?.message || "Не удалось загрузить фото группы";
        }
      }

      setCreateResult({
        groupId: newGroupId,
        members: Number(created?.members ?? phones.length),
        notFound: Array.isArray(created?.not_found) ? created!.not_found! : [],
        messageSent: !!created?.message_sent,
        pictureUploaded,
        pictureError,
      });
      loadGroups();
    } catch (err: any) {
      setNewGroupError(err?.message || "Ошибка при создании группы");
    } finally {
      setCreating(false);
      setCreatingStep("idle");
    }
  }

  async function handleAddParticipant() {
    if (!addPhone || !activeGroup) return;
    setAdding(true);
    try {
      const phone = addPhone.replace(/\D/g, "");
      // First check if user exists and get chatId
      const checkRes = await apiPost<{ phone: string, exists: boolean, chatId?: string }>("/api/check-contacts-bulk", { phones: [phone] });
      // Bulk check is async, but for single number we might need a simpler way or wait for result.
      // Assuming for now the backend handles phone or chatId.
      // The current /api/add-participant expects participantId (chatId).
      
      // Let's use a simpler check for now or assume user provides chatId if they are advanced.
      // But usually they provide phone.
      await apiPost("/api/add-participant", { groupId: activeGroup.chatId, participantId: `${phone}@c.us` });
      setAddPhone("");
      setShowAddModal(false);
      loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка при добавлении");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!activeGroup || !confirm("Удалить участника?")) return;
    try {
      await apiPost("/api/remove-participant", { groupId: activeGroup.chatId, participantId });
      loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка при удалении");
    }
  }

  async function handleSetAdmin(participantId: string) {
    if (!activeGroup) return;
    try {
      await apiPost("/api/set-admin", { groupId: activeGroup.chatId, participantId });
      loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка");
    }
  }

  async function handleRemoveAdmin(participantId: string) {
    if (!activeGroup) return;
    try {
      await apiPost("/api/remove-admin", { groupId: activeGroup.chatId, participantId });
      loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка");
    }
  }

  async function handleLeaveGroup() {
    if (!activeGroup || !confirm("Покинуть группу?")) return;
    try {
      await apiPost("/api/leave-group", { groupId: activeGroup.chatId });
      setActiveGroup(null);
      setGroupData(null);
      loadGroups();
    } catch (err: any) {
      alert(err.message || "Ошибка");
    }
  }

  async function handleUpdateName() {
    if (!activeGroup || !newGroupName) return;
    try {
      await apiPost("/api/update-group-name", { groupId: activeGroup.chatId, groupName: newGroupName });
      setActiveGroup({ ...activeGroup, name: newGroupName });
      loadGroups();
    } catch (err: any) {
      alert(err.message || "Ошибка");
    }
  }

  async function handleUpdatePicture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activeGroup) return;
    if (!file.type.startsWith("image/")) {
      alert("Файл должен быть изображением");
      e.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("Размер изображения не должен превышать 5 МБ");
      e.target.value = "";
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("groupId", activeGroup.chatId);
    try {
      // Используем apiUpload, чтобы запрос ушёл на Flask с GREEN-API заголовками,
      // а не на относительный /api/set-group-picture (которого нет в Next).
      await apiUpload("/api/set-group-picture", fd);
      loadGroups();
      loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка");
    } finally {
      e.target.value = "";
    }
  }


  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* Sidebar */}
      <div className="w-80 border-r border-border bg-bg-elevated flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-bold text-text flex items-center gap-2">
            <Users className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Группы
          </h2>
          <button
            onClick={() => setShowCreateModal(true)}
            className="p-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            title="Создать группу"
            aria-label="Создать группу"
          >
            <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {chatsLoadError && (
            <div className="m-3 px-3 py-2 rounded-xl bg-warning-bg border border-warning/20 text-warning text-[11px] leading-snug">
              Не удалось загрузить группы из WhatsApp: {chatsLoadError}. Локально созданные группы остаются доступными. Проверьте настройки GREEN-API.
            </div>
          )}
          {loading ? (
            <div className="p-8 text-center text-text-muted text-xs">Загрузка...</div>
          ) : groups.length === 0 ? (
            <div className="p-8 text-center text-text-muted text-xs italic">Групп не найдено</div>
          ) : (
            groups.map((group, index) => (
              <button
                key={`${group.chatId}-${index}`}
                onClick={() => loadGroupData(group)}
                className={`w-full flex items-center gap-3 px-4 py-3 border-b border-border/50 transition-all hover:bg-surface-hover
                  ${activeGroup?.chatId === group.chatId ? "bg-accent/10 border-l-2 border-accent" : "border-l-2 border-transparent"}`}
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-400 flex items-center justify-center text-white font-bold text-sm shadow-sm">
                  {group.avatarUrl ? (
                    <img src={group.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                  ) : group.name ? (
                    group.name.slice(0, 2).toUpperCase()
                  ) : (
                    <Users className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                  )}
                </div>
                <div className="text-left min-w-0">
                  <div className="text-sm font-medium text-text truncate">
                    {group.name && group.name !== group.chatId ? group.name : `Группа (${group.chatId.slice(0, 8)}...)`}
                  </div>
                  <div className="text-[10px] text-text-muted truncate">{group.chatId}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col bg-bg relative">
        {activeGroup ? (
          <>
            <div className="px-6 py-4 border-b border-border bg-surface flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-4">
                <div className="relative group cursor-pointer" onClick={() => document.getElementById("group-pic-input")?.click()}>
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-400 flex items-center justify-center text-white font-bold text-lg shadow-glow-emerald overflow-hidden">
                    {activeGroup.avatarUrl ? (
                      <img src={activeGroup.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                    ) : activeGroup.name ? (
                      activeGroup.name.slice(0, 2).toUpperCase()
                    ) : (
                      <Users className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
                    )}
                  </div>
                  <div className="absolute inset-0 bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="text-[10px] text-white font-bold">Изм.</span>
                  </div>
                  <input type="file" id="group-pic-input" className="hidden" onChange={handleUpdatePicture} accept="image/*" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-text">{activeGroup.name}</h3>
                    <button 
                      onClick={() => {
                        const newName = prompt("Новое название группы:", activeGroup.name);
                        if (newName && newName !== activeGroup.name) {
                          apiPost("/api/update-group-name", { groupId: activeGroup.chatId, groupName: newName })
                            .then(() => {
                              setActiveGroup({ ...activeGroup, name: newName });
                              loadGroups();
                            });
                        }
                      }}
                      className="p-1 rounded hover:bg-white/5 text-text-muted hover:text-accent transition-colors"
                      aria-label="Редактировать название группы"
                    >
                      <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                  <p className="text-xs text-text-muted">{activeGroup.chatId}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddModal(true)}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-xl transition-all shadow-glow flex items-center gap-2"
                >
                  <UserPlus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  Добавить
                </button>
                <button
                  onClick={async () => {
                    if (confirm("Выйти из группы и полностью удалить её из всех списков?")) {
                      await nxDelete(`/api/groups/${activeGroup.chatId}`);
                      setActiveGroup(null);
                      loadGroups();
                    }
                  }}
                  className="px-4 py-2 bg-error/10 text-error hover:bg-error text-xs font-bold rounded-xl transition-all border border-error/20 hover:text-white"
                >
                  Удалить навсегда
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {loadingData ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="h-8 w-8 animate-spin text-accent" aria-label="Загрузка данных группы" />
                </div>
              ) : groupData ? (
                <div className="max-w-3xl mx-auto space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-surface border border-border rounded-2xl p-4 shadow-sm">
                      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Владелец</div>
                      <div className="text-sm font-bold text-text">{groupData.owner || "Неизвестно"}</div>
                    </div>
                    <div className="bg-surface border border-border rounded-2xl p-4 shadow-sm">
                      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Участников</div>
                      <div className="text-sm font-bold text-text">{groupData.participants?.length || 0}</div>
                    </div>
                  </div>

                  <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm">
                    <div className="px-4 py-3 border-b border-border bg-bg-elevated/50 flex items-center justify-between">
                      <h4 className="text-xs font-bold text-text uppercase tracking-widest">Участники</h4>
                    </div>
                    <div className="divide-y divide-border/50">
                      {groupData.participants?.map((p, pIndex) => (
                        <div key={`${p.id}-${pIndex}`} className="px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white
                              ${p.isAdmin ? "bg-accent shadow-glow" : "bg-text-muted"}`}>
                              {p.name?.slice(0, 2)?.toUpperCase() || "??"}
                            </div>
                            <div>
                              <div className="text-sm font-medium text-text flex items-center gap-2">
                                {p.name || p.id}
                                {p.isAdmin && <span className="text-[9px] px-1.5 py-0.5 bg-accent/20 text-accent rounded-full border border-accent/20 font-bold uppercase">Admin</span>}
                              </div>
                              <div className="text-[10px] text-text-muted">{p.id}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {p.isAdmin ? (
                              <button
                                onClick={() => handleRemoveAdmin(p.id)}
                                className="p-1.5 rounded-lg text-text-muted hover:text-warning hover:bg-warning/10 transition-colors"
                                title="Снять админа"
                                aria-label="Снять админа"
                              >
                                <ShieldOff className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleSetAdmin(p.id)}
                                className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                                title="Сделать админом"
                                aria-label="Сделать админом"
                              >
                                <ShieldCheck className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                              </button>
                            )}
                            <button
                              onClick={() => handleRemoveParticipant(p.id)}
                              className="p-1.5 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                              title="Удалить"
                              aria-label="Удалить участника"
                            >
                              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-text-muted text-sm italic">
                  <p>Не удалось загрузить данные группы</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
            <div className="w-24 h-24 rounded-full bg-accent/5 border border-accent/10 flex items-center justify-center mb-6">
              <Users className="h-10 w-10 text-accent/70" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h3 className="text-xl font-bold text-text mb-2">Управление группами</h3>
            <p className="text-text-muted text-sm max-w-md mx-auto leading-relaxed">
              Выберите группу из списка слева для управления участниками и настройками, или создайте новую.
            </p>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6">
          <div
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={closeCreateModal}
          />
          <div className="glass-strong relative w-full max-w-lg max-h-[calc(100vh-3rem)] overflow-y-auto rounded-3xl animate-modal-in">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-accent-light to-transparent rounded-t-3xl pointer-events-none" />
            <button
              onClick={closeCreateModal}
              disabled={creating}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors disabled:opacity-40"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </button>

            <div className="p-8 space-y-6">
              <div className="flex items-center gap-3">
                <span className="p-2 bg-accent-subtle rounded-xl text-accent-light">
                  <Sparkles className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <h3 className="text-xl font-bold text-text">Новая группа</h3>
              </div>

              {createResult ? (
                /* ── Сводка после успешного создания ─────────────────────── */
                <div className="space-y-4">
                  <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-success-bg border border-success/20 text-success">
                    <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                    <div className="text-sm">
                      <div className="font-semibold">Группа создана</div>
                      <div className="text-success/80 text-xs mt-0.5 font-mono break-all">{createResult.groupId}</div>
                    </div>
                  </div>

                  <ul className="space-y-2 text-sm">
                    <li className="flex items-start gap-2 text-text-secondary">
                      <Check className="h-4 w-4 mt-0.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden="true" />
                      Добавлено участников: <span className="font-semibold text-text">{createResult.members}</span>
                    </li>
                    {createResult.notFound.length > 0 && (
                      <li className="flex items-start gap-2 text-warning">
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                        <div>
                          Не найдены в WhatsApp ({createResult.notFound.length}):
                          <div className="mt-1 text-xs font-mono text-warning/80 break-words">
                            {createResult.notFound.slice(0, 8).join(", ")}
                            {createResult.notFound.length > 8 && ` и ещё ${createResult.notFound.length - 8}`}
                          </div>
                        </div>
                      </li>
                    )}
                    {newGroupDescription.trim() && (
                      <li className="flex items-start gap-2 text-text-secondary">
                        {createResult.messageSent ? (
                          <Check className="h-4 w-4 mt-0.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden="true" />
                        ) : (
                          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" strokeWidth={2} aria-hidden="true" />
                        )}
                        Приветственное сообщение {createResult.messageSent ? "отправлено" : "не отправлено"}
                      </li>
                    )}
                    {newGroupPhotoFile && (
                      <li className="flex items-start gap-2 text-text-secondary">
                        {createResult.pictureUploaded ? (
                          <Check className="h-4 w-4 mt-0.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden="true" />
                        ) : (
                          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" strokeWidth={2} aria-hidden="true" />
                        )}
                        Аватар группы {createResult.pictureUploaded ? "установлен" : `не установлен${createResult.pictureError ? `: ${createResult.pictureError}` : ""}`}
                      </li>
                    )}
                  </ul>

                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => resetCreateForm()}
                      className="flex-1 px-4 py-3 bg-surface hover:bg-surface-hover text-text font-bold rounded-2xl transition-all border border-border"
                    >
                      Создать ещё
                    </button>
                    <button
                      onClick={() => {
                        const created = createResult;
                        const groupChat: Chat = {
                          id: created.groupId,
                          chatId: created.groupId,
                          name: newGroupName.trim(),
                          type: "group",
                          preview: "",
                          timestamp: 0,
                          avatarUrl: null,
                        };
                        setShowCreateModal(false);
                        resetCreateForm();
                        loadGroupData(groupChat);
                      }}
                      className="flex-1 px-4 py-3 bg-accent hover:bg-accent-hover text-bg font-bold rounded-2xl transition-all shadow-md"
                    >
                      Открыть группу
                    </button>
                  </div>
                </div>
              ) : (
                /* ── Форма создания ──────────────────────────────────────── */
                <div className="space-y-5">
                  {/* Photo */}
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => newGroupPhotoInputRef.current?.click()}
                      className="relative shrink-0 w-20 h-20 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-400 flex items-center justify-center text-white shadow-md overflow-hidden group"
                      aria-label="Загрузить фото группы"
                    >
                      {newGroupPhotoPreview ? (
                        <img src={newGroupPhotoPreview} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Camera className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[10px] font-bold uppercase tracking-wider text-white">
                        {newGroupPhotoPreview ? "Изм." : "Фото"}
                      </span>
                    </button>
                    <input
                      ref={newGroupPhotoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleNewGroupPhotoSelect}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text">Фото группы</p>
                      <p className="text-xs text-text-muted">Необязательно. PNG/JPG, до 5 МБ.</p>
                      {newGroupPhotoFile && (
                        <button
                          type="button"
                          onClick={clearNewGroupPhoto}
                          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-error transition-colors"
                        >
                          <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                          Убрать
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">
                      Название группы <span className="text-error">*</span>
                    </label>
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      maxLength={64}
                      className="w-full bg-bg-elevated border border-border rounded-2xl px-4 py-3.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all"
                      placeholder="Напр. Отдел маркетинга"
                    />
                  </div>

                  {/* Description / welcome message */}
                  <div>
                    <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">
                      Описание / приветственное сообщение
                    </label>
                    <textarea
                      value={newGroupDescription}
                      onChange={(e) => setNewGroupDescription(e.target.value)}
                      maxLength={1024}
                      className="w-full bg-bg-elevated border border-border rounded-2xl px-4 py-3.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all h-24 resize-none"
                      placeholder="Это сообщение бот отправит первым в созданную группу"
                    />
                    <p className="mt-1 text-[10px] text-text-muted px-1">
                      WhatsApp не позволяет задать «о группе» через API — текст отправится первым сообщением.
                    </p>
                  </div>

                  {/* Phones — tabs */}
                  <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">
                        Участники
                      </label>
                      {(() => {
                        const count = parsePhonesFromText(newGroupPhones).length;
                        return (
                          <span className="text-[10px] font-bold text-text-muted">
                            {count > 0 ? `${count} номер${count === 1 ? "" : count < 5 ? "а" : "ов"}` : "необязательно"}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex bg-bg-elevated p-1 rounded-xl border border-border mb-3">
                      <button
                        type="button"
                        onClick={() => setNewGroupPhoneMethod("manual")}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                          newGroupPhoneMethod === "manual"
                            ? "bg-accent text-bg shadow-sm"
                            : "text-text-muted hover:text-text"
                        }`}
                      >
                        Ручной ввод
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewGroupPhoneMethod("csv")}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                          newGroupPhoneMethod === "csv"
                            ? "bg-accent text-bg shadow-sm"
                            : "text-text-muted hover:text-text"
                        }`}
                      >
                        Загрузить CSV
                      </button>
                    </div>

                    {newGroupPhoneMethod === "manual" ? (
                      <textarea
                        value={newGroupPhones}
                        onChange={(e) => setNewGroupPhones(e.target.value)}
                        className="w-full bg-bg-elevated border border-border rounded-2xl px-4 py-3.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all h-32 resize-none"
                        placeholder={"79001112233\n79002223344"}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center py-6 border-2 border-dashed border-border rounded-2xl bg-bg-elevated">
                        <FileSpreadsheet className="h-8 w-8 text-text-muted mb-3" strokeWidth={1.75} aria-hidden="true" />
                        <input
                          ref={newGroupCsvInputRef}
                          type="file"
                          accept=".csv,.txt"
                          className="hidden"
                          onChange={handleNewGroupCsvUpload}
                        />
                        <button
                          type="button"
                          onClick={() => newGroupCsvInputRef.current?.click()}
                          className="inline-flex items-center gap-2 px-5 py-2.5 bg-surface hover:bg-surface-hover text-text text-sm font-bold rounded-xl transition-all border border-border"
                        >
                          <Upload className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                          Выбрать CSV
                        </button>
                        <p className="mt-2 text-[10px] text-text-muted text-center px-4">
                          Из файла будут извлечены все номера длиной 10–15 цифр
                        </p>
                        {newGroupCsvError && (
                          <p className="mt-2 text-[10px] text-error">{newGroupCsvError}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {newGroupError && (
                    <div className="flex items-start gap-2 px-4 py-3 rounded-2xl bg-error-bg border border-error/20 text-error text-sm">
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      <span>{newGroupError}</span>
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={closeCreateModal}
                      disabled={creating}
                      className="flex-1 px-4 py-3.5 bg-surface hover:bg-surface-hover text-text font-bold rounded-2xl transition-all border border-border disabled:opacity-50"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateGroup}
                      disabled={creating || !newGroupName.trim()}
                      className="flex-1 px-4 py-3.5 bg-accent hover:bg-accent-hover text-bg font-bold rounded-2xl transition-all shadow-md disabled:opacity-50 disabled:shadow-none inline-flex items-center justify-center gap-2"
                    >
                      {creating ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          {creatingStep === "uploading" ? "Загрузка фото..." : "Создание..."}
                        </>
                      ) : (
                        "Создать группу"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6">
          <div
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
            onClick={() => !adding && setShowAddModal(false)}
          />
          <div className="glass-strong relative w-full max-w-lg max-h-[calc(100vh-3rem)] overflow-y-auto rounded-3xl animate-modal-in">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-accent-light to-transparent rounded-t-3xl pointer-events-none" />
            <button
              onClick={() => !adding && setShowAddModal(false)}
              disabled={adding}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors disabled:opacity-40"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </button>

            <div className="p-8 space-y-5">
              <div className="flex items-center gap-3">
                <span className="p-2 bg-accent-subtle rounded-xl text-accent-light">
                  <UserPlus className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <h3 className="text-xl font-bold text-text">Добавить участников</h3>
              </div>

              <div className="flex bg-bg-elevated p-1 rounded-xl border border-border">
                <button
                  onClick={() => setAddMethod('manual')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${addMethod === 'manual' ? 'bg-accent text-bg shadow-sm' : 'text-text-muted hover:text-text'}`}
                >
                  Ручной ввод
                </button>
                <button
                  onClick={() => setAddMethod('csv')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${addMethod === 'csv' ? 'bg-accent text-bg shadow-sm' : 'text-text-muted hover:text-text'}`}
                >
                  Загрузить CSV
                </button>
              </div>

              {addMethod === 'manual' ? (
                <div>
                  <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">Список номеров (каждый с новой строки)</label>
                  <textarea
                    value={addPhone}
                    onChange={e => setAddPhone(e.target.value)}
                    className="w-full bg-bg-elevated border border-border rounded-2xl px-4 py-3.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all h-40 resize-none"
                    placeholder={"79001112233\n79002223344"}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-border rounded-2xl bg-bg-elevated">
                  <FileText className="h-8 w-8 text-text-muted mb-3" strokeWidth={1.75} aria-hidden="true" />
                  <input
                    type="file"
                    accept=".csv"
                    id="csv-upload"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      const found = text.match(/\d{10,15}/g);
                      if (found) {
                        setAddPhone(found.join('\n'));
                        setAddMethod('manual');
                      }
                    }}
                  />
                  <label htmlFor="csv-upload" className="cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 bg-surface hover:bg-surface-hover text-text text-sm font-bold rounded-xl transition-all border border-border">
                    <Upload className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                    Выбрать файл
                  </label>
                  <p className="mt-3 text-[10px] text-text-muted">Будут извлечены все номера из файла</p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowAddModal(false)}
                  disabled={adding}
                  className="flex-1 px-4 py-3.5 bg-surface hover:bg-surface-hover text-text font-bold rounded-2xl transition-all border border-border disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={async () => {
                    if (!addPhone.trim() || !activeGroup) return;
                    setAdding(true);
                    try {
                      const res = await apiPost(`/api/group/${activeGroup.chatId}/add-bulk`, {
                        phones: addPhone
                      });
                      const results = (res as any).results || [];
                      const successCount = results.filter((r: any) => r.success).length;
                      alert(`Добавлено: ${successCount} из ${results.length}`);
                      setShowAddModal(false);
                      setAddPhone('');
                      loadGroupData(activeGroup);
                    } catch (err) {
                      alert("Ошибка при массовом добавлении");
                    } finally {
                      setAdding(false);
                    }
                  }}
                  disabled={adding || !addPhone.trim()}
                  className="flex-1 px-4 py-3.5 bg-accent hover:bg-accent-hover text-bg font-bold rounded-2xl transition-all shadow-md disabled:opacity-50 disabled:shadow-none inline-flex items-center justify-center gap-2"
                >
                  {adding ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Добавление...
                    </>
                  ) : (
                    "Добавить всех"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
