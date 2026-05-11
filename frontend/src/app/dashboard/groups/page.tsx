"use client";

import { useState, useEffect } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Chat, GroupData, GroupParticipant } from "@/lib/types";

export default function GroupsPage() {
  const [groups, setGroups] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState<Chat | null>(null);
  const [groupData, setGroupData] = useState<GroupData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  
  // Create group state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupPhones, setNewGroupPhones] = useState("");
  const [creating, setCreating] = useState(false);

  // Add participant state
  const [showAddModal, setShowAddModal] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMethod, setAddMethod] = useState<'manual' | 'csv'>('manual');

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    setLoading(true);
    try {
      const [allChats, localGroups] = await Promise.all([
        apiGet<Chat[]>("/api/chats").catch(() => []),
        apiGet<any[]>("/api/groups").catch(() => []),
      ]);

      // Преобразуем локальные группы в формат Chat
      const localAsChats: Chat[] = localGroups.map(g => ({
        id: String(g.group_id || ""),
        chatId: g.group_id,
        name: g.name,
        type: "group" as const,
        preview: "",
        timestamp: 0,
        avatarUrl: null,
      }));

      // Объединяем списки, удаляя дубликаты
      const combined = [...allChats];
      localAsChats.forEach(lg => {
        if (!combined.some(c => c.chatId === lg.chatId)) {
          combined.push(lg);
        }
      });

      // Фильтруем только группы
      const filtered = combined.filter(c => 
        c.type === "group" || 
        c.chatId.endsWith("@g.us") || 
        c.chatId.includes("-")
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

  async function handleCreateGroup() {
    if (!newGroupName) return;
    setCreating(true);
    try {
      // Разбиваем по переносу строки, запятым или пробелам
      const phones = newGroupPhones.split(/[\n,\s]+/).map(p => p.trim()).filter(p => p);
      await apiPost("/api/create-group", { name: newGroupName, phones });
      setShowCreateModal(false);
      setNewGroupName("");
      setNewGroupPhones("");
      loadGroups();
    } catch (err: any) {
      alert(err.message || "Ошибка при создании группы");
    } finally {
      setCreating(false);
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
    const fd = new FormData();
    fd.append("file", file);
    fd.append("groupId", activeGroup.chatId);
    try {
      await fetch("/api/set-group-picture", {
        method: "POST",
        body: fd
      });
      loadGroups();
      if (activeGroup) loadGroupData(activeGroup);
    } catch (err: any) {
      alert(err.message || "Ошибка");
    }
  }


  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* Sidebar */}
      <div className="w-80 border-r border-border bg-bg-elevated flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-bold text-text flex items-center gap-2">
            👥 Группы
          </h2>
          <button
            onClick={() => setShowCreateModal(true)}
            className="p-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            title="Создать группу"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
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
                  ) : (
                    (group.name || "ГР").slice(0, 2).toUpperCase()
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
                    ) : (
                      (activeGroup.name || "ГР").slice(0, 2).toUpperCase()
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
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
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
                  <span>➕ Добавить</span>
                </button>
                <button
                  onClick={async () => {
                    if (confirm("Выйти из группы и полностью удалить её из всех списков?")) {
                      await apiPost("/api/groups/delete", { groupId: activeGroup.chatId });
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
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
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
                              >
                                🛡️
                              </button>
                            ) : (
                              <button
                                onClick={() => handleSetAdmin(p.id)}
                                className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                                title="Сделать админом"
                              >
                                ✨
                              </button>
                            )}
                            <button
                              onClick={() => handleRemoveParticipant(p.id)}
                              className="p-1.5 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                              title="Удалить"
                            >
                              🗑️
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
              <span className="text-4xl">👥</span>
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => !creating && setShowCreateModal(false)} />
          <div className="relative w-full max-w-md bg-[#121315] border border-border/50 rounded-3xl shadow-2xl p-8 animate-modal-in overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-accent to-transparent" />
            <h3 className="text-xl font-bold text-text mb-6 flex items-center gap-3">
              <span className="p-2 bg-accent/10 rounded-xl text-accent">✨</span>
              Новая группа
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">Название группы</label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  className="w-full bg-[#1A1B1E] border border-border/50 rounded-2xl px-4 py-3.5 text-sm text-text focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
                  placeholder="Напр. Отдел маркетинга"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">Номера участников (каждый с новой строки, необязательно)</label>
                <textarea
                  value={newGroupPhones}
                  onChange={e => setNewGroupPhones(e.target.value)}
                  className="w-full bg-[#1A1B1E] border border-border/50 rounded-2xl px-4 py-3.5 text-sm text-text focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all h-32 resize-none"
                  placeholder="79001112233&#10;79002223344"
                />
              </div>
              
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowCreateModal(false)}
                  disabled={creating}
                  className="flex-1 px-4 py-3.5 bg-surface hover:bg-surface-hover text-text font-bold rounded-2xl transition-all border border-border/50 disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={handleCreateGroup}
                  disabled={creating || !newGroupName}
                  className="flex-1 px-4 py-3.5 bg-accent hover:bg-accent-hover text-white font-bold rounded-2xl transition-all shadow-glow disabled:opacity-50 disabled:shadow-none"
                >
                  {creating ? "Создание..." : "Создать группу"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => !adding && setShowAddModal(false)} />
          <div className="relative w-full max-w-md bg-[#121315] border border-border/50 rounded-3xl shadow-2xl p-8 animate-modal-in overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-accent to-transparent" />
            <h3 className="text-xl font-bold text-text mb-6">Добавить участников</h3>
            
            <div className="space-y-4">
              <div className="flex bg-[#1A1B1E] p-1 rounded-xl mb-4">
                <button 
                  onClick={() => setAddMethod('manual')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${addMethod === 'manual' ? 'bg-accent text-white shadow-glow' : 'text-text-muted hover:text-text'}`}
                >
                  Ручной ввод
                </button>
                <button 
                  onClick={() => setAddMethod('csv')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${addMethod === 'csv' ? 'bg-accent text-white shadow-glow' : 'text-text-muted hover:text-text'}`}
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
                    className="w-full bg-[#1A1B1E] border border-border/50 rounded-2xl px-4 py-3.5 text-sm text-text focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all h-40 resize-none"
                    placeholder="79001112233&#10;79002223344"
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-border/30 rounded-2xl bg-surface/30">
                  <span className="text-3xl mb-3">📄</span>
                  <input
                    type="file"
                    accept=".csv"
                    id="csv-upload"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      // Простой парсинг: ищем все последовательности цифр от 10 до 15 знаков
                      const found = text.match(/\d{10,15}/g);
                      if (found) {
                        setAddPhone(found.join('\n'));
                        setAddMethod('manual'); // Переключаем на ручной ввод чтобы пользователь увидел результат
                      }
                    }}
                  />
                  <label htmlFor="csv-upload" className="cursor-pointer px-6 py-2.5 bg-accent/10 text-accent hover:bg-accent/20 text-sm font-bold rounded-xl transition-all border border-accent/20">
                    Выбрать файл
                  </label>
                  <p className="mt-3 text-[10px] text-text-muted">Будут извлечены все номера из файла</p>
                </div>
              )}
              
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowAddModal(false)}
                  disabled={adding}
                  className="flex-1 px-4 py-3.5 bg-surface hover:bg-surface-hover text-text font-bold rounded-2xl transition-all border border-border/50 disabled:opacity-50"
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
                  className="flex-1 px-4 py-3.5 bg-accent hover:bg-accent-hover text-white font-bold rounded-2xl transition-all shadow-glow disabled:opacity-50 disabled:shadow-none"
                >
                  {adding ? "Добавление..." : "Добавить всех"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
