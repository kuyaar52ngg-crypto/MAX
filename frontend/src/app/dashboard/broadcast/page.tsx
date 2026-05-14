"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleHelp,
  Eye,
  FileUp,
  Keyboard,
  Megaphone,
  Paperclip,
  RotateCw,
  Send,
  Settings2,
  X,
} from "lucide-react";
import { apiPost, apiUpload, apiSSE, nxGet, nxPost } from "@/lib/api";
import { BroadcastContact, Template } from "@/lib/types";

interface ProgressEvent {
  done: number;
  total: number;
  phone?: string;
  status?: string;
  message_id?: string;
  rendered_message?: string;
  contact_data?: Record<string, string>;
  broadcast_id?: number;
  sent?: number;
  not_found?: number;
  failed?: number;
  finished?: boolean;
}

type AttachmentMode = "none" | "url";

interface UploadContactsResponse {
  phones: string[];
  contacts: BroadcastContact[];
  fields: string[];
  count: number;
  warnings?: string[];
}

function renderPreviewMessage(template: string, contact: BroadcastContact) {
  return template.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    if (raw.includes("|")) {
      const variants = raw.split("|").map((item) => item.trim()).filter(Boolean);
      return variants.length ? variants[Math.floor(Math.random() * variants.length)] : "";
    }
    return contact[raw.trim()] || "";
  });
}

function extractVariables(template: string) {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const value = match[1].trim();
    if (value && !value.includes("|")) found.add(value);
  }
  return Array.from(found);
}

function countRandomBlocks(template: string) {
  return Array.from(template.matchAll(/\{([^{}]*\|[^{}]*)\}/g)).length;
}

function inferFileName(url: string) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || "attachment";
  } catch {
    return "attachment";
  }
}

export default function BroadcastPage() {
  const [contacts, setContacts] = useState<BroadcastContact[]>([]);
  const [phoneInput, setPhoneInput] = useState("");
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState(3);
  const [useTyping, setUseTyping] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [results, setResults] = useState<{ phone: string; status: string; rendered_message?: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [csvWarnings, setCsvWarnings] = useState<string[]>([]);
  const [previewSeed, setPreviewSeed] = useState(0);
  const [attachmentMode, setAttachmentMode] = useState<AttachmentMode>("none");
  const [fileUrl, setFileUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const sseCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    nxGet<Template[]>("/api/templates").then(res => {
      setTemplates(Array.isArray(res) ? res : []);
    }).catch(() => {});
  }, []);

  // Закрываем активный SSE при размонтировании, чтобы EventSource не висел
  // в фоне после ухода со страницы рассылки.
  useEffect(() => {
    return () => {
      if (sseCloseRef.current) {
        sseCloseRef.current();
        sseCloseRef.current = null;
      }
    };
  }, []);

  const phones = useMemo(() => contacts.map((contact) => contact.phone), [contacts]);
  const availableFields = useMemo(() => {
    const fields = new Set<string>(["phone"]);
    contacts.forEach((contact) => Object.keys(contact).forEach((field) => fields.add(field)));
    return Array.from(fields).sort((a, b) => a.localeCompare(b));
  }, [contacts]);
  const variables = useMemo(() => extractVariables(message), [message]);
  const unknownVariables = useMemo(
    () => variables.filter((variable) => !availableFields.includes(variable)),
    [availableFields, variables]
  );
  const randomBlocks = useMemo(() => countRandomBlocks(message), [message]);
  const previews = useMemo(
    () => contacts.slice(0, 5).map((contact) => ({
      phone: contact.phone,
      text: renderPreviewMessage(message, contact),
    })),
    [contacts, message, previewSeed]
  );

  function addPhone(raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (cleaned.length >= 10 && cleaned.length <= 15 && !phones.includes(cleaned)) {
      setContacts((prev) => [...prev, { phone: cleaned }]);
    }
    setPhoneInput("");
  }

  function removePhone(idx: number) {
    setContacts((prev) => prev.filter((_, i) => i !== idx));
  }

  function handlePhoneKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addPhone(phoneInput);
    }
    if (e.key === "Backspace" && !phoneInput && phones.length > 0) {
      removePhone(phones.length - 1);
    }
  }

  async function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await apiUpload<UploadContactsResponse>("/api/upload-contacts", fd);
      if (Array.isArray(data.contacts)) {
        setContacts((prev) => {
          const map = new Map(prev.map((contact) => [contact.phone, contact]));
          data.contacts.forEach((contact) => map.set(contact.phone, contact));
          return Array.from(map.values());
        });
      } else if (data.phones) {
        setContacts((prev) => {
          const map = new Map(prev.map((contact) => [contact.phone, contact]));
          data.phones.forEach((phone) => map.set(phone, { phone }));
          return Array.from(map.values());
        });
      }
      setCsvWarnings(data.warnings || []);
    } catch { /* error */ }
  }

  function insertVariable(field: string) {
    const token = `{${field}}`;
    setMessage((prev) => prev ? `${prev} ${token}` : token);
  }

  async function startBroadcast() {
    const effectiveFileUrl = attachmentMode === "url" ? fileUrl.trim() : "";
    const effectiveFileName = effectiveFileUrl ? (fileName.trim() || inferFileName(effectiveFileUrl)) : "";
    if (!contacts.length || (!message.trim() && !effectiveFileUrl)) return;
    setBroadcasting(true);
    setResults([]);
    setProgress(null);

    try {
      const broadcast = await nxPost<{ id: number }>("/api/broadcasts", {
        message: message.trim(),
        total: contacts.length,
        file_url: effectiveFileUrl || null,
        file_name: effectiveFileName || null,
        use_typing: useTyping,
      });

      await apiPost("/api/broadcast", {
        broadcast_id: broadcast.id,
        phones,
        contacts,
        message: message.trim(),
        delay,
        use_typing: useTyping,
        file_url: effectiveFileUrl || null,
        file_name: effectiveFileName || null,
      });

      // Сбрасываем предыдущий SSE на случай повторного запуска без перехода
      // между страницами.
      if (sseCloseRef.current) {
        sseCloseRef.current();
        sseCloseRef.current = null;
      }

      const close = apiSSE("/api/broadcast/progress", (data) => {
        const d = data as unknown as ProgressEvent;
        setProgress(d);
        if (d.phone && d.status) {
          setResults((r) => [...r, { phone: d.phone!, status: d.status!, rendered_message: d.rendered_message }]);
          nxPost(`/api/broadcasts/${broadcast.id}/recipients`, {
            phone: d.phone,
            status: d.status,
            message_id: d.message_id,
            rendered_message: d.rendered_message,
            contact_data: d.contact_data,
          }).catch(() => {});
        }
        if (d.finished) {
          nxPost(`/api/broadcasts/${broadcast.id}/finish`, {
            sent: d.sent || 0,
            not_found: d.not_found || 0,
            failed: d.failed || 0,
          }).catch(() => {});
          setBroadcasting(false);
          if (sseCloseRef.current) {
            sseCloseRef.current();
            sseCloseRef.current = null;
          }
        }
      }, () => {
        setBroadcasting(false);
        sseCloseRef.current = null;
      });
      sseCloseRef.current = close;
    } catch {
      setBroadcasting(false);
    }
  }

  const progressPct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const canStart = contacts.length > 0 && (!!message.trim() || (attachmentMode === "url" && !!fileUrl.trim()));


  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <Megaphone className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">Рассылка</h1>
        <p className="text-text-muted text-sm mt-1">Массовая отправка сообщений</p>
      </div>

      {/* Phone input */}
      <div className="broadcast-section glass rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">Получатели</h3>
        <div className="flex flex-wrap gap-2 p-3 bg-bg-elevated border border-border rounded-xl min-h-[48px]">
          {phones.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent-subtle border border-accent-light/20 rounded-lg text-xs text-accent-light">
              {p}
              <button onClick={() => removePhone(i)} className="hover:text-error transition-colors">×</button>
            </span>
          ))}
          <input
            type="text"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            onKeyDown={handlePhoneKeyDown}
            placeholder={phones.length ? "" : "Введите номер и нажмите Enter..."}
            className="flex-1 min-w-[140px] bg-transparent text-sm text-text placeholder:text-text-muted outline-none"
          />
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-lg text-xs text-text-secondary cursor-pointer hover:border-border-focus transition-colors">
            <FileUp className="h-4 w-4" strokeWidth={2} />
            CSV файл
            <input type="file" accept=".csv" onChange={handleCSV} className="hidden" />
          </label>
          <span className="text-xs text-text-muted self-center">{phones.length} контактов</span>
        </div>
        {availableFields.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">Доступные переменные из CSV:</p>
            <div className="flex flex-wrap gap-2">
              {availableFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => insertVariable(field)}
                  className="px-2.5 py-1 bg-accent-subtle border border-accent-light/20 rounded-lg text-xs text-accent-light hover:bg-accent-light/15 transition-colors"
                >
                  {`{${field}}`}
                </button>
              ))}
            </div>
          </div>
        )}
        {csvWarnings.length > 0 && (
          <div className="space-y-1 text-xs text-warning">
            {csvWarnings.slice(0, 4).map((warning, i) => <div key={i}>{warning}</div>)}
          </div>
        )}
      </div>

      {/* Message */}
      <div className="broadcast-section glass rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-secondary">Сообщение</h3>
          {templates.length > 0 && (
            <select
              onChange={(e) => {
                if (e.target.value) setMessage(e.target.value);
                e.target.value = "";
              }}
              className="text-xs bg-surface border border-border rounded-lg px-2 py-1 text-text-muted outline-none focus:border-border-focus"
            >
              <option value="">Вставить шаблон...</option>
              {templates.map(t => (
                <option key={t.id} value={t.text}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Текст сообщения..."
          rows={5}
          className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                     resize-none focus:outline-none focus:border-border-focus transition-colors"
        />
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
          <span>Переменные: {variables.length ? variables.map((item) => `{${item}}`).join(", ") : "нет"}</span>
          <span>Рандом-блоков: {randomBlocks}</span>
          <button
            type="button"
            onClick={() => setPreviewSeed((value) => value + 1)}
            className="ml-auto px-3 py-1.5 bg-surface border border-border rounded-lg text-text-secondary hover:border-border-focus transition-colors"
          >
            Проверить текст
          </button>
        </div>
        <p className="text-xs text-text-muted">Рандомизация: {`{Здравствуйте|Добрый день|Привет}`}. Персонализация: {`{name}`}.</p>
        {unknownVariables.length > 0 && (
          <div className="text-xs text-warning bg-warning-bg/40 border border-warning/20 rounded-xl p-3">
            Не найдены поля в CSV: {unknownVariables.map((item) => `{${item}}`).join(", ")}
          </div>
        )}
      </div>

      <div className="broadcast-section glass rounded-xl p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
          <Paperclip className="h-4 w-4 text-accent-light" strokeWidth={2} />
          Вложение
        </h3>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input type="radio" checked={attachmentMode === "none"} onChange={() => setAttachmentMode("none")} className="accent-accent" />
            Без вложения
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input type="radio" checked={attachmentMode === "url"} onChange={() => setAttachmentMode("url")} className="accent-accent" />
            Файл по URL
          </label>
        </div>
        {attachmentMode === "url" && (
          <div className="grid gap-3 md:grid-cols-[1fr_220px]">
            <input
              type="url"
              value={fileUrl}
              onChange={(e) => setFileUrl(e.target.value)}
              placeholder="https://example.com/file.pdf"
              className="px-4 py-3 bg-surface border border-border rounded-xl text-sm text-text placeholder:text-text-muted outline-none focus:border-border-focus transition-colors"
            />
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="file.pdf"
              className="px-4 py-3 bg-surface border border-border rounded-xl text-sm text-text placeholder:text-text-muted outline-none focus:border-border-focus transition-colors"
            />
          </div>
        )}
        {attachmentMode === "url" && (
          <div className="text-xs text-text-muted bg-bg-elevated border border-border rounded-xl p-3">
            Текст сообщения будет отправлен как подпись к файлу. Если текст пустой, будет отправлен только файл.
          </div>
        )}
      </div>

      <div className="broadcast-section glass rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
            <Eye className="h-4 w-4 text-accent-light" strokeWidth={2} />
            Предпросмотр
          </h3>
          <button
            type="button"
            onClick={() => setPreviewSeed((value) => value + 1)}
            className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-secondary hover:border-border-focus transition-colors"
          >
            <RotateCw className="h-3.5 w-3.5" strokeWidth={2} />
            Обновить варианты
          </button>
        </div>
        {previews.length === 0 ? (
          <div className="text-sm text-text-muted">Добавьте номера или загрузите CSV, чтобы увидеть примеры сообщений.</div>
        ) : (
          <div className="space-y-2">
            {previews.map((preview) => (
              <div key={`${preview.phone}-${preview.text}`} className="rounded-xl bg-bg-elevated border border-border p-3">
                <div className="text-xs text-text-muted mb-1">{preview.phone}</div>
                <div className="text-sm text-text whitespace-pre-wrap">{preview.text || "Файл без текстовой подписи"}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="broadcast-section glass rounded-xl p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
          <Settings2 className="h-4 w-4 text-accent-light" strokeWidth={2} />
          Настройки
        </h3>
        <div className="flex flex-wrap gap-6">
          <div>
            <label className="text-xs text-text-muted">Задержка (сек)</label>
            <input
              type="number"
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
              min={1}
              max={30}
              className="mt-1 w-20 px-3 py-2 bg-surface border border-border rounded-xl text-sm text-text text-center focus:outline-none focus:border-border-focus"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer self-end">
            <input type="checkbox" checked={useTyping} onChange={(e) => setUseTyping(e.target.checked)} className="accent-accent" />
            <Keyboard className="h-4 w-4 text-text-muted" strokeWidth={2} />
            <span className="text-sm text-text-secondary">Имитация набора</span>
          </label>
        </div>
      </div>

      {/* Progress */}
      {progress && (
        <div className="glass rounded-xl p-6 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Прогресс</span>
            <span className="text-text font-medium">{progress.done}/{progress.total}</span>
          </div>
          <div className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {results.slice(-10).map((r, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span className="text-text-muted">{r.phone}</span>
                <span className={`inline-flex items-center gap-1.5 ${r.status === "sent" ? "text-success" : r.status === "not_found" ? "text-warning" : "text-error"}`}>
                  {r.status === "sent" ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                  ) : r.status === "not_found" ? (
                    <CircleHelp className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                  ) : (
                    <X className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                  )}
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Start button */}
      <button
        onClick={startBroadcast}
        disabled={broadcasting || !canStart}
        className="w-full py-3.5 bg-accent hover:bg-accent-hover text-bg font-semibold rounded-lg transition-all duration-200
                   hover:shadow-glow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
      >
        <span className="inline-flex items-center justify-center gap-2">
          <Send className="h-4 w-4" strokeWidth={2.2} />
          {broadcasting ? `Рассылка... ${progressPct}%` : `Начать рассылку (${phones.length} контактов)`}
        </span>
      </button>
    </div>
  );
}
