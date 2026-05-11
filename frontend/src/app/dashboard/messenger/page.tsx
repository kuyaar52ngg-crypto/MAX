"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiGet, apiPost, apiUpload } from "@/lib/api";
import { Chat, ChatMessage } from "@/lib/types";

export default function MessengerPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [msgInput, setMsgInput] = useState("");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "chats" | "groups">("all");
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [msgCount, setMsgCount] = useState(50);
  const [showAttach, setShowAttach] = useState(false);
  const [attachModal, setAttachModal] = useState<"contact" | "location" | null>(null);
  const [locLat, setLocLat] = useState("");
  const [locLon, setLocLon] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (attachRef.current && !attachRef.current.contains(event.target as Node)) {
        setShowAttach(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => { loadChats(); }, []);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  async function loadChats() {
    setLoadingChats(true);
    try {
      const [chatsRes, groupsRes] = await Promise.all([
        apiGet<Array<Record<string, unknown>>>("/api/chats").catch(() => []),
        apiGet<Array<Record<string, unknown>>>("/api/groups").catch(() => []),
      ]);

      const chatList: Chat[] = (Array.isArray(chatsRes) ? chatsRes : []).map((c) => ({
        id: String(c.chatId || c.id || ""),
        chatId: String(c.chatId || c.id || ""),
        name: String(c.name || c.chatId || "Без имени"),
        type: (c.type === "group" || 
               String(c.chatId).endsWith("@g.us") || 
               String(c.chatId).includes("-")) ? "group" as const : "chat" as const,
        preview: String((c.lastMessage as Record<string, unknown>)?.textMessage || "").slice(0, 50),
        timestamp: Number((c.lastMessage as Record<string, unknown>)?.timestamp || 0),
        avatarUrl: null,
      }));

      const groupList: Chat[] = (Array.isArray(groupsRes) ? groupsRes : []).map((g) => ({
        id: String(g.group_id || ""),
        chatId: String(g.group_id || ""),
        name: String(g.name || g.group_id || "Группа"),
        type: "group" as const,
        preview: "👥 Группа",
        timestamp: 0,
        avatarUrl: null,
      }));

      // Объединяем и удаляем дубликаты по chatId
      const combined = [...chatList];
      groupList.forEach(group => {
        if (!combined.some(c => c.chatId === group.chatId)) {
          combined.push(group);
        }
      });

      const all = combined.sort((a, b) => b.timestamp - a.timestamp);
      setChats(all);

      // Enrich contacts in background
      const chatIds = chatList.map((c) => c.chatId);
      if (chatIds.length) {
        apiPost<Record<string, { name?: string; avatar_url?: string }>>("/api/contacts/enrich", { chatIds })
          .then((data) => {
            setChats((prev) =>
              prev.map((c) => {
                const info = data[c.chatId];
                if (info) {
                  return {
                    ...c,
                    name: info.name || c.name,
                    avatarUrl: info.avatar_url || c.avatarUrl,
                  };
                }
                return c;
              })
            );
          })
          .catch(() => {});
      }
    } catch {
      /* offline */
    } finally {
      setLoadingChats(false);
    }
  }

  async function openChat(chat: Chat) {
    setActiveChat(chat);
    setLoadingMsgs(true);
    setMessages([]);
    try {
      const history = await apiPost<ChatMessage[]>("/api/chat-history", { chatId: chat.chatId, count: msgCount });
      setMessages(Array.isArray(history) ? [...history].reverse() : []);
      scrollToBottom();
    } catch {
      /* error */
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function sendMessage() {
    if (!activeChat || !msgInput.trim() || sending) return;
    setSending(true);
    try {
      await apiPost("/api/send-message", { chatId: activeChat.chatId, message: msgInput.trim() });
      setMsgInput("");
      // Reload history
      const history = await apiPost<ChatMessage[]>("/api/chat-history", { chatId: activeChat.chatId, count: msgCount });
      setMessages(Array.isArray(history) ? [...history].reverse() : []);
      scrollToBottom();
    } catch {
      /* error */
    } finally {
      setSending(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activeChat) return;
    setShowAttach(false);
    setSending(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("chatId", activeChat.chatId);
    try {
      const res = await apiUpload<{ success: boolean; idMessage: string }>("/api/send-file", fd);
      if (res.success) {
        const history = await apiPost<ChatMessage[]>("/api/chat-history", { chatId: activeChat.chatId, count: msgCount });
        setMessages(Array.isArray(history) ? [...history].reverse() : []);
        scrollToBottom();
      }
    } catch { /* */ } finally { 
      setSending(false); 
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSendLocation() {
    if (!locLat || !locLon || !activeChat) return;
    setSending(true);
    setAttachModal(null);
    try {
      const res = await apiPost<{ success: boolean; idMessage: string }>("/api/send-location", {
        chatId: activeChat.chatId,
        latitude: parseFloat(locLat),
        longitude: parseFloat(locLon),
        name: "Локация",
      });
      if (res.success) {
        const history = await apiPost<ChatMessage[]>("/api/chat-history", { chatId: activeChat.chatId, count: msgCount });
        setMessages(Array.isArray(history) ? [...history].reverse() : []);
        scrollToBottom();
      }
    } catch { /* */ } finally { 
      setSending(false);
      setLocLat(""); setLocLon("");
    }
  }

  async function handleSendContact() {
    if (!contactPhone || !contactName || !activeChat) return;
    setSending(true);
    setAttachModal(null);
    try {
      const res = await apiPost<{ success: boolean; idMessage: string }>("/api/send-contact", {
        chatId: activeChat.chatId,
        contactPhone: contactPhone.replace(/\D/g, ""),
        contactName: contactName,
      });
      if (res.success) {
        const history = await apiPost<ChatMessage[]>("/api/chat-history", { chatId: activeChat.chatId, count: msgCount });
        setMessages(Array.isArray(history) ? [...history].reverse() : []);
        scrollToBottom();
      }
    } catch { /* */ } finally { 
      setSending(false);
      setContactName(""); setContactPhone("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const tabFiltered = chats.filter((c) => {
    if (activeTab === "chats") return c.type === "chat";
    if (activeTab === "groups") return c.type === "group";
    return true;
  });

  const filteredChats = search
    ? tabFiltered.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.chatId.includes(search))
    : tabFiltered;

  function getMessageText(m: ChatMessage): string {
    const mt = m.typeMessage || "";
    if (mt === "textMessage" || mt === "extendedTextMessage") return m.textMessage || "";
    if (mt === "imageMessage") return `🖼️ ${m.caption || "Фото"}`;
    if (mt === "videoMessage") return `🎥 ${m.caption || "Видео"}`;
    if (mt === "audioMessage") return "🎵 Голосовое";
    if (mt === "documentMessage") return `📎 ${m.fileName || "Документ"}`;
    if (mt === "locationMessage") return "📍 Геолокация";
    if (mt === "contactMessage") return "👤 Контакт";
    if (mt === "stickerMessage") return "🏷️ Стикер";
    return m.textMessage || m.caption || `[${mt || "media"}]`;
  }


  return (
    <div className="flex h-full overflow-hidden">
      {/* Chat list sidebar */}
      <div
        ref={chatListRef}
        className={`w-80 flex-shrink-0 flex flex-col border-r border-border bg-bg-elevated
                    ${activeChat ? "hidden lg:flex" : "flex"} transition-all`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-bold text-text flex items-center gap-2">💬 Чаты</h2>
          <button
            onClick={() => { loadChats(); }}
            className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent text-sm"
          >
            ↻
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Поиск..."
            className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                       focus:outline-none focus:border-accent/50 transition-colors"
          />
          <div className="flex bg-surface p-1 rounded-xl border border-border">
            {(["all", "chats", "groups"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-1 text-xs font-medium rounded-lg transition-colors
                  ${activeTab === tab ? "bg-bg text-text shadow-sm border border-border" : "text-text-muted hover:text-text hover:bg-surface-hover"}`}
              >
                {tab === "all" ? "Все" : tab === "chats" ? "Чаты" : "Группы"}
              </button>
            ))}
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto">
          {loadingChats ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl">
                  <div className="w-10 h-10 rounded-full skeleton" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 rounded skeleton" />
                    <div className="h-2 w-16 rounded skeleton" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="p-8 text-center text-text-muted text-sm">Нет чатов</div>
          ) : (
            filteredChats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => openChat(chat)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-200 hover:bg-surface-hover
                  ${activeChat?.id === chat.id ? "bg-accent/10 border-l-2 border-accent" : "border-l-2 border-transparent"}`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0 overflow-hidden
                  ${chat.type === "group" ? "bg-gradient-to-br from-emerald-600 to-emerald-400" : "bg-gradient-to-br from-accent to-accent-light"}`}
                >
                  {chat.avatarUrl ? (
                    <img src={chat.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                  ) : chat.type === "group" ? "👥" : (
                    chat.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text truncate">{chat.name}</div>
                  <div className="text-xs text-text-muted truncate">{chat.preview || "—"}</div>
                </div>
                {chat.timestamp > 0 && (
                  <div className="text-[10px] text-text-muted flex-shrink-0">
                    {new Date(chat.timestamp * 1000).toLocaleDateString("ru", { day: "2-digit", month: "2-digit" })}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className={`flex-1 flex flex-col min-w-0 ${!activeChat ? "hidden lg:flex" : "flex"}`}>
        {activeChat ? (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-surface flex-shrink-0">
              {/* Back button (mobile) */}
              <button
                onClick={() => setActiveChat(null)}
                className="lg:hidden p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted"
              >
                ←
              </button>

              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white overflow-hidden
                ${activeChat.type === "group" ? "bg-gradient-to-br from-emerald-600 to-emerald-400" : "bg-gradient-to-br from-accent to-accent-light"}`}
              >
                {activeChat.avatarUrl ? (
                  <img src={activeChat.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                ) : activeChat.type === "group" ? "👥" : (
                  activeChat.name.slice(0, 2).toUpperCase()
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text truncate">{activeChat.name}</div>
                <div className="text-xs text-text-muted truncate">{activeChat.chatId}</div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={msgCount}
                  onChange={(e) => setMsgCount(Number(e.target.value))}
                  className="w-16 px-2 py-1 text-xs bg-bg border border-border rounded-lg text-text text-center"
                  min={10}
                  max={500}
                />
                <button
                  onClick={() => openChat(activeChat)}
                  className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent text-sm"
                >
                  ↻
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              {loadingMsgs ? (
                <div className="flex items-center justify-center h-full text-text-muted text-sm">⏳ Загрузка...</div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-text-muted text-sm">Сообщений нет</div>
              ) : (
                <>
                  {messages.map((m, i) => {
                    const isOut = m.type === "outgoing";
                    const text = getMessageText(m);
                    const ts = m.timestamp ? new Date(m.timestamp * 1000) : null;
                    const timeStr = ts?.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) || "";
                    const dateStr = ts?.toLocaleDateString("ru", { day: "2-digit", month: "short" }) || "";

                    // Date divider
                    const prevDate = i > 0 && messages[i - 1].timestamp
                      ? new Date(messages[i - 1].timestamp * 1000).toLocaleDateString("ru", { day: "2-digit", month: "short" })
                      : "";
                    const showDivider = dateStr && dateStr !== prevDate;

                    return (
                      <div key={m.idMessage || i}>
                        {showDivider && (
                          <div className="flex items-center gap-3 my-4">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-[10px] text-text-muted px-2">{dateStr}</span>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                        )}
                        <div className={`flex ${isOut ? "justify-end" : "justify-start"} gap-2`}>
                          {!isOut && (
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-accent-light flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-auto mb-1 overflow-hidden">
                              {activeChat.avatarUrl ? (
                                <img src={activeChat.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                              ) : (
                                activeChat.name.slice(0, 2).toUpperCase()
                              )}
                            </div>
                          )}
                          <div className={`max-w-[70%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                            isOut
                              ? "bg-accent/25 text-text rounded-br-sm"
                              : "bg-card border border-border text-text rounded-bl-sm"
                          }`}>
                            {!isOut && m.senderName && (
                              <div className="text-[11px] text-accent-light font-semibold mb-0.5">{m.senderName}</div>
                            )}
                            <span className="break-words">{text}</span>
                            <span className="text-[10px] text-text-muted ml-2 float-right mt-1">{timeStr}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* Input */}
            <div className="px-4 py-3 border-t border-border bg-[#0b141a] flex items-center gap-3 flex-shrink-0 relative">
              {/* Attach Menu */}
              <div ref={attachRef} className="relative flex items-center">
                <button
                  onClick={() => setShowAttach(!showAttach)}
                  className={`p-2 transition-colors rounded-full hover:bg-white/5 ${showAttach ? "bg-white/5 text-[#00b233]" : "text-[#aebac1]"}`}
                >
                  <svg className="w-6 h-6 transform -rotate-45" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>

                {showAttach && (
                  <div className="absolute bottom-full left-0 mb-2 w-48 bg-[#233138] border border-[#111b21] rounded-xl shadow-2xl overflow-hidden z-50 py-2">
                    <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                    <button onClick={() => fileInputRef.current?.click()} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#d1d7db]">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                      Файл
                    </button>
                    <button onClick={() => { setShowAttach(false); setAttachModal("contact"); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#00a884]">
                      <svg className="w-5 h-5 text-[#00a884]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                      Контакт
                    </button>
                    <button onClick={() => { setShowAttach(false); setAttachModal("location"); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#d1d7db]">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                      Локация
                    </button>
                  </div>
                )}
              </div>

              {/* Modals for Attachment Inputs */}
              {attachModal === "location" && (
                <div className="absolute bottom-full left-0 mb-4 bg-[#233138] border border-[#111b21] p-4 rounded-xl shadow-2xl z-50 w-72 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-[#d1d7db]">Отправить локацию</h4>
                  <input type="text" placeholder="Широта (Latitude)" value={locLat} onChange={e => setLocLat(e.target.value)} className="px-3 py-2 bg-[#2a3942] border border-transparent rounded-lg text-xs text-[#d1d7db] outline-none focus:border-[#00a884]" />
                  <input type="text" placeholder="Долгота (Longitude)" value={locLon} onChange={e => setLocLon(e.target.value)} className="px-3 py-2 bg-[#2a3942] border border-transparent rounded-lg text-xs text-[#d1d7db] outline-none focus:border-[#00a884]" />
                  <div className="flex gap-2 justify-end mt-2">
                    <button onClick={() => setAttachModal(null)} className="px-3 py-1.5 text-xs text-[#8696a0] hover:text-[#d1d7db]">Отмена</button>
                    <button onClick={handleSendLocation} disabled={sending} className="px-3 py-1.5 bg-[#00a884] hover:bg-[#008f6f] text-[#111b21] font-medium text-xs rounded-lg disabled:opacity-50">Отправить</button>
                  </div>
                </div>
              )}

              {attachModal === "contact" && (
                <div className="absolute bottom-full left-0 mb-4 bg-[#233138] border border-[#111b21] p-4 rounded-xl shadow-2xl z-50 w-72 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-[#d1d7db]">Отправить контакт</h4>
                  <input type="text" placeholder="Имя контакта" value={contactName} onChange={e => setContactName(e.target.value)} className="px-3 py-2 bg-[#2a3942] border border-transparent rounded-lg text-xs text-[#d1d7db] outline-none focus:border-[#00a884]" />
                  <input type="text" placeholder="Номер телефона (только цифры)" value={contactPhone} onChange={e => setContactPhone(e.target.value)} className="px-3 py-2 bg-[#2a3942] border border-transparent rounded-lg text-xs text-[#d1d7db] outline-none focus:border-[#00a884]" />
                  <div className="flex gap-2 justify-end mt-2">
                    <button onClick={() => setAttachModal(null)} className="px-3 py-1.5 text-xs text-[#8696a0] hover:text-[#d1d7db]">Отмена</button>
                    <button onClick={handleSendContact} disabled={sending} className="px-3 py-1.5 bg-[#00a884] hover:bg-[#008f6f] text-[#111b21] font-medium text-xs rounded-lg disabled:opacity-50">Отправить</button>
                  </div>
                </div>
              )}

              <input
                type="text"
                value={msgInput}
                onChange={(e) => setMsgInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Сообщение..."
                className="flex-1 bg-transparent border-none text-sm text-text placeholder:text-text-muted outline-none h-10"
              />

              <div className="flex items-center gap-1 text-text-muted">
                <button className="p-2 hover:text-text transition-colors rounded-full hover:bg-surface-hover">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                <button className="p-2 hover:text-text transition-colors rounded-full hover:bg-surface-hover">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </button>
              </div>

              {msgInput.trim() && (
                <button
                  onClick={sendMessage}
                  disabled={sending}
                  className="w-10 h-10 ml-2 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center
                             transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-90 hover:shadow-glow"
                >
                  {sending ? (
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-text-muted space-y-3">
              <div className="text-5xl opacity-30">💬</div>
              <p className="text-sm">Выберите чат слева</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
