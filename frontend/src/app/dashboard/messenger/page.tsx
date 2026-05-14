"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ChevronLeft, FileImage, Loader2, MapPin, MessageCircle, MessageSquare, Mic, Paperclip, RotateCw, Search, Send, Smile, User, Users } from "lucide-react";
import { apiGet, apiPost, apiUpload, nxPost } from "@/lib/api";
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior }));
  }, []);

  async function loadChats() {
    setLoadingChats(true);
    try {
      // Берём чаты только из GREEN-API. Старый /api/groups Flask-эндпоинт
      // отдаёт пустой список и тратил впустую один запрос на каждом открытии
      // мессенджера — убрали его из параллельной загрузки.
      const chatsRes = await apiGet<Array<Record<string, unknown>>>("/api/chats").catch(() => []);

      const chatList: Chat[] = (Array.isArray(chatsRes) ? chatsRes : []).map((c) => {
        const chatId = String(c.chatId || c.id || "");
        const isGroup =
          c.type === "group" || chatId.endsWith("@g.us") || chatId.includes("-");
        return {
          id: chatId,
          chatId,
          name: String(c.name || chatId || "Без имени"),
          type: isGroup ? ("group" as const) : ("chat" as const),
          preview: String((c.lastMessage as Record<string, unknown>)?.textMessage || "").slice(0, 50),
          timestamp: Number((c.lastMessage as Record<string, unknown>)?.timestamp || 0),
          avatarUrl: null,
        };
      });

      const all = chatList.sort((a, b) => b.timestamp - a.timestamp);
      setChats(all);

      // Enrich contacts in background
      const chatIds = chatList.map((c) => c.chatId);
      if (chatIds.length) {
        nxPost<Record<string, { name?: string; avatar_url?: string }>>("/api/contacts/enrich", { chatIds })
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
      // первый рендер истории — без анимации, чтобы открытие чата было мгновенным
      scrollToBottom("auto");
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

  const tabFiltered = useMemo(
    () => chats.filter((c) => {
      if (activeTab === "chats") return c.type === "chat";
      if (activeTab === "groups") return c.type === "group";
      return true;
    }),
    [chats, activeTab],
  );

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tabFiltered;
    return tabFiltered.filter(
      (c) => c.name.toLowerCase().includes(q) || c.chatId.includes(search.trim()),
    );
  }, [tabFiltered, search]);

  function getMessageText(m: ChatMessage): string {
    const mt = m.typeMessage || "";
    if (mt === "textMessage" || mt === "extendedTextMessage") return m.textMessage || "";
    if (mt === "imageMessage") return m.caption || "Фото";
    if (mt === "videoMessage") return m.caption || "Видео";
    if (mt === "audioMessage") return "Голосовое";
    if (mt === "documentMessage") return m.fileName || "Документ";
    if (mt === "locationMessage") return "Геолокация";
    if (mt === "contactMessage") return "Контакт";
    if (mt === "stickerMessage") return "Стикер";
    return m.textMessage || m.caption || `[${mt || "media"}]`;
  }


  return (
    <div className="flex h-[calc(100vh-88px)] overflow-hidden px-5 pb-6 lg:px-8">
      {/* Chat list sidebar */}
      <div
        ref={chatListRef}
        className={`w-80 flex-shrink-0 flex flex-col rounded-2xl border border-border bg-surface shadow-md
                    ${activeChat ? "hidden lg:flex" : "flex"} transition-all`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-bold text-text flex items-center gap-2">
            <MessageCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Чаты
          </h2>
          <button
            onClick={() => { loadChats(); }}
            className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent"
            title="Обновить список"
            aria-label="Обновить список чатов"
          >
            <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-3 space-y-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              strokeWidth={2}
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск..."
              className="w-full pl-9 pr-3 py-2 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                         focus:outline-none focus:border-border-focus transition-colors"
            />
          </div>
          <div className="flex bg-bg-elevated p-1 rounded-xl border border-border">
            {(["all", "chats", "groups"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-1 text-xs font-medium rounded-lg transition-colors
                  ${activeTab === tab ? "bg-surface text-text shadow-sm border border-border" : "text-text-muted hover:text-text hover:bg-surface-hover"}`}
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
                className={`mx-2 mb-1 flex w-[calc(100%-16px)] items-center gap-3 rounded-xl px-3 py-3 text-left transition-all duration-200 hover:bg-surface-hover
                  ${activeChat?.id === chat.id ? "bg-accent-subtle ring-1 ring-accent-light/25" : "ring-1 ring-transparent"}`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0 overflow-hidden
                  ${chat.type === "group" ? "bg-gradient-to-br from-emerald-600 to-emerald-400" : "bg-gradient-to-br from-accent to-accent-light"}`}
                >
                  {chat.avatarUrl ? (
                    <img src={chat.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                  ) : chat.type === "group" ? (
                    <Users className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                  ) : (
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
      <div className={`ml-4 min-w-0 flex-1 flex-col rounded-2xl border border-border bg-surface shadow-md ${!activeChat ? "hidden lg:flex" : "flex"}`}>
        {activeChat ? (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-surface flex-shrink-0 rounded-t-2xl">
              {/* Back button (mobile) */}
              <button
                onClick={() => setActiveChat(null)}
                className="lg:hidden p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted"
                aria-label="Назад к списку чатов"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
              </button>

              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white overflow-hidden
                ${activeChat.type === "group" ? "bg-gradient-to-br from-emerald-600 to-emerald-400" : "bg-gradient-to-br from-accent to-accent-light"}`}
              >
                {activeChat.avatarUrl ? (
                  <img src={activeChat.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                ) : activeChat.type === "group" ? (
                  <Users className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                ) : (
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
                  className="w-16 px-2 py-1 text-xs bg-bg-elevated border border-border rounded-lg text-text text-center"
                  min={10}
                  max={500}
                />
                <button
                  onClick={() => openChat(activeChat)}
                  className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent"
                  title="Обновить историю"
                  aria-label="Обновить историю сообщений"
                >
                  <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-1 bg-bg-elevated/45">
              {loadingMsgs ? (
                <div className="flex items-center justify-center h-full text-text-muted text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Загрузка...
                </div>
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
                  aria-label="Прикрепить вложение"
                  aria-expanded={showAttach}
                >
                  <Paperclip className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
                </button>

                {showAttach && (
                  <div className="absolute bottom-full left-0 mb-2 w-48 bg-[#233138] border border-[#111b21] rounded-xl shadow-2xl overflow-hidden z-50 py-2">
                    <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                    <button onClick={() => fileInputRef.current?.click()} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#d1d7db]">
                      <FileImage className="h-5 w-5 text-white" strokeWidth={2} aria-hidden="true" />
                      Файл
                    </button>
                    <button onClick={() => { setShowAttach(false); setAttachModal("contact"); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#00a884]">
                      <User className="h-5 w-5 text-[#00a884]" strokeWidth={2} aria-hidden="true" />
                      Контакт
                    </button>
                    <button onClick={() => { setShowAttach(false); setAttachModal("location"); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[#111b21] transition-colors text-left text-sm text-[#d1d7db]">
                      <MapPin className="h-5 w-5 text-white" strokeWidth={2} aria-hidden="true" />
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
                <button className="p-2 hover:text-text transition-colors rounded-full hover:bg-surface-hover" aria-label="Эмодзи">
                  <Smile className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
                </button>
                <button className="p-2 hover:text-text transition-colors rounded-full hover:bg-surface-hover" aria-label="Голосовое сообщение">
                  <Mic className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>

              {msgInput.trim() && (
                <button
                  onClick={sendMessage}
                  disabled={sending}
                  className="w-10 h-10 ml-2 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center
                             transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-90 hover:shadow-glow"
                  aria-label={sending ? "Сообщение отправляется" : "Отправить сообщение"}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-text-muted space-y-3">
              <MessageSquare className="mx-auto h-14 w-14 opacity-30" strokeWidth={1.5} aria-hidden="true" />
              <p className="text-sm">Выберите чат слева</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
