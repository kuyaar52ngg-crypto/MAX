"use client";

import { useEffect, useState } from "react";
import { apiPost, apiUpload, apiSSE, nxGet, nxPost } from "@/lib/api";
import { Template } from "@/lib/types";

interface ProgressEvent {
  done: number;
  total: number;
  phone?: string;
  status?: string;
  message_id?: string;
  broadcast_id?: number;
  sent?: number;
  not_found?: number;
  failed?: number;
  finished?: boolean;
}

export default function BroadcastPage() {
  const [phones, setPhones] = useState<string[]>([]);
  const [phoneInput, setPhoneInput] = useState("");
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState(3);
  const [useTyping, setUseTyping] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [results, setResults] = useState<{ phone: string; status: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    nxGet<Template[]>("/api/templates").then(res => {
      setTemplates(Array.isArray(res) ? res : []);
    }).catch(() => {});
  }, []);

  function addPhone(raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (cleaned.length >= 10 && cleaned.length <= 15 && !phones.includes(cleaned)) {
      setPhones((p) => [...p, cleaned]);
    }
    setPhoneInput("");
  }

  function removePhone(idx: number) {
    setPhones((p) => p.filter((_, i) => i !== idx));
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
      const data = await apiUpload<{ phones: string[] }>("/api/upload-contacts", fd);
      if (data.phones) setPhones((p) => [...new Set([...p, ...data.phones])]);
    } catch { /* error */ }
  }

  async function startBroadcast() {
    if (!phones.length || (!message.trim())) return;
    setBroadcasting(true);
    setResults([]);
    setProgress(null);

    try {
      const broadcast = await nxPost<{ id: number }>("/api/broadcasts", {
        message: message.trim(),
        total: phones.length,
        use_typing: useTyping,
      });

      await apiPost("/api/broadcast", {
        broadcast_id: broadcast.id,
        phones,
        message: message.trim(),
        delay,
        use_typing: useTyping,
      });

      // Listen to SSE progress
      apiSSE("/api/broadcast/progress", (data) => {
        const d = data as unknown as ProgressEvent;
        setProgress(d);
        if (d.phone && d.status) {
          setResults((r) => [...r, { phone: d.phone!, status: d.status! }]);
          nxPost(`/api/broadcasts/${broadcast.id}/recipients`, {
            phone: d.phone,
            status: d.status,
            message_id: d.message_id,
          }).catch(() => {});
        }
        if (d.finished) {
          nxPost(`/api/broadcasts/${broadcast.id}/finish`, {
            sent: d.sent || 0,
            not_found: d.not_found || 0,
            failed: d.failed || 0,
          }).catch(() => {});
          setBroadcasting(false);
        }
      }, () => setBroadcasting(false));
    } catch {
      setBroadcasting(false);
    }
  }

  const progressPct = progress ? Math.round((progress.done / progress.total) * 100) : 0;


  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">📢 Рассылка</h1>
        <p className="text-text-muted text-sm mt-1">Массовая отправка сообщений</p>
      </div>

      {/* Phone input */}
      <div className="broadcast-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">Получатели</h3>
        <div className="flex flex-wrap gap-2 p-3 bg-bg/50 border border-border rounded-xl min-h-[48px]">
          {phones.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent/15 border border-accent/20 rounded-lg text-xs text-accent-light">
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
          <label className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-xl text-xs text-text-secondary cursor-pointer hover:border-accent/40 transition-colors">
            📁 CSV файл
            <input type="file" accept=".csv" onChange={handleCSV} className="hidden" />
          </label>
          <span className="text-xs text-text-muted self-center">{phones.length} контактов</span>
        </div>
      </div>

      {/* Message */}
      <div className="broadcast-section glass rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-secondary">Сообщение</h3>
          {templates.length > 0 && (
            <select
              onChange={(e) => {
                if (e.target.value) setMessage(e.target.value);
                e.target.value = "";
              }}
              className="text-xs bg-surface border border-border rounded-lg px-2 py-1 text-text-muted outline-none"
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
          className="w-full px-4 py-3 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                     resize-none focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* Settings */}
      <div className="broadcast-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">Настройки</h3>
        <div className="flex flex-wrap gap-6">
          <div>
            <label className="text-xs text-text-muted">Задержка (сек)</label>
            <input
              type="number"
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
              min={1}
              max={30}
              className="mt-1 w-20 px-3 py-2 bg-bg/50 border border-border rounded-xl text-sm text-text text-center"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer self-end">
            <input type="checkbox" checked={useTyping} onChange={(e) => setUseTyping(e.target.checked)} className="accent-accent" />
            <span className="text-sm text-text-secondary">⌨️ Имитация набора</span>
          </label>
        </div>
      </div>

      {/* Progress */}
      {progress && (
        <div className="glass rounded-2xl p-6 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Прогресс</span>
            <span className="text-text font-medium">{progress.done}/{progress.total}</span>
          </div>
          <div className="w-full h-2 bg-bg rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {results.slice(-10).map((r, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span className="text-text-muted">{r.phone}</span>
                <span className={r.status === "sent" ? "text-success" : r.status === "not_found" ? "text-warning" : "text-error"}>
                  {r.status === "sent" ? "✅" : r.status === "not_found" ? "❓" : "❌"} {r.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Start button */}
      <button
        onClick={startBroadcast}
        disabled={broadcasting || !phones.length || !message.trim()}
        className="w-full py-3.5 bg-accent hover:bg-accent-hover text-white font-semibold rounded-2xl transition-all duration-200
                   hover:shadow-glow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
      >
        {broadcasting ? `📡 Рассылка... ${progressPct}%` : `📢 Начать рассылку (${phones.length} контактов)`}
      </button>
    </div>
  );
}
