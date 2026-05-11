"use client";

import { useState, useEffect } from "react";
import { apiGet, apiPost, apiSSE, apiUpload } from "@/lib/api";

interface Contact {
  id: string;
  name: string;
  chatId: string;
  type: string;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [checkPhone, setCheckPhone] = useState("");
  const [checkResult, setCheckResult] = useState<{ exists: boolean; chatId?: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // Mass check states
  const [massInput, setMassInput] = useState("");
  const [massPhones, setMassPhones] = useState<string[]>([]);
  const [massChecking, setMassChecking] = useState(false);
  const [massResults, setMassResults] = useState<{ phone: string; exists: boolean; chatId?: string }[]>([]);
  const [massProgress, setMassProgress] = useState<{ done: number; total: number } | null>(null);

  const [isAccordionOpen, setIsAccordionOpen] = useState(false);

  useEffect(() => { loadContacts(); }, []);

  async function loadContacts() {
    setLoading(true);
    try {
      const data = await apiGet<Contact[]>("/api/contacts");
      setContacts(Array.isArray(data) ? data : []);
    } catch { /* */ } finally { setLoading(false); }
  }

  async function checkContact() {
    if (!checkPhone.trim()) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const data = await apiPost<{ exists: boolean; chatId?: string }>("/api/check-contact", { phone: checkPhone.replace(/\D/g, "") });
      setCheckResult(data);
    } catch { /* */ } finally { setChecking(false); }
  }

  const filtered = search
    ? contacts.filter((c) => c.name?.toLowerCase().includes(search.toLowerCase()) || c.chatId?.includes(search))
    : contacts;

  function addMassPhone(raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (cleaned.length >= 10 && cleaned.length <= 15 && !massPhones.includes(cleaned)) {
      setMassPhones((p) => [...p, cleaned]);
    }
    setMassInput("");
  }

  function handleMassKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addMassPhone(massInput);
    }
    if (e.key === "Backspace" && !massInput && massPhones.length > 0) {
      setMassPhones((p) => p.slice(0, -1));
    }
  }

  async function handleMassCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await apiUpload<{ phones: string[] }>("/api/upload-contacts", fd);
      if (data.phones) setMassPhones((p) => [...new Set([...p, ...data.phones])]);
    } catch { /* */ }
  }

  async function startMassCheck() {
    if (!massPhones.length) return;
    setMassChecking(true);
    setMassResults([]);
    setMassProgress(null);
    try {
      await apiPost("/api/check-contacts-bulk", { phones: massPhones });
      apiSSE("/api/check-contacts/progress", (data: any) => {
        if (data.finished) {
          setMassChecking(false);
        } else {
          setMassProgress({ done: data.done, total: data.total });
          setMassResults((prev) => [...prev, { phone: data.phone, exists: data.exists, chatId: data.chatId }]);
        }
      }, () => setMassChecking(false));
    } catch {
      setMassChecking(false);
    }
  }

  function downloadValidCSV() {
    const valid = massResults.filter(r => r.exists).map(r => r.phone);
    if (!valid.length) return;
    const blob = new Blob([valid.join("\n")], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "valid_contacts.csv";
    a.click();
    window.URL.revokeObjectURL(url);
  }


  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">👤 Проверка номеров</h1>
        <p className="text-text-muted text-sm mt-1">Управление контактами</p>
      </div>

      {/* Check single contact */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">🔍 Проверка номера</h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={checkPhone}
            onChange={(e) => setCheckPhone(e.target.value)}
            placeholder="79001234567"
            className="flex-1 px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                       focus:outline-none focus:border-accent/50 transition-colors"
            onKeyDown={(e) => e.key === "Enter" && checkContact()}
          />
          <button
            onClick={checkContact}
            disabled={checking}
            className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all
                       disabled:opacity-50 active:scale-95"
          >
            {checking ? "..." : "Проверить"}
          </button>
        </div>
        {checkResult && (
          <div className={`px-4 py-3 rounded-xl text-sm ${checkResult.exists ? "bg-success-bg border border-success/20 text-success" : "bg-error-bg border border-error/20 text-error"}`}>
            {checkResult.exists ? `✅ Найден! chatId: ${checkResult.chatId}` : "❌ Не зарегистрирован в WhatsApp"}
          </div>
        )}
      </div>

      {/* Mass Check */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">📊 Массовая проверка</h3>
        <div className="flex flex-wrap gap-2 p-3 bg-bg/50 border border-border rounded-xl min-h-[48px]">
          {massPhones.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent/15 border border-accent/20 rounded-lg text-xs text-accent-light">
              {p}
              <button onClick={() => setMassPhones(ph => ph.filter((_, idx) => idx !== i))} className="hover:text-error transition-colors">×</button>
            </span>
          ))}
          <input
            type="text"
            value={massInput}
            onChange={(e) => setMassInput(e.target.value)}
            onKeyDown={handleMassKeyDown}
            placeholder={massPhones.length ? "" : "Вводите номера (Enter или запятая)..."}
            className="flex-1 min-w-[200px] bg-transparent text-sm text-text placeholder:text-text-muted outline-none"
          />
        </div>
        <div className="flex justify-between items-center">
          <div className="flex gap-3">
            <label className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-xl text-xs text-text-secondary cursor-pointer hover:border-accent/40 transition-colors">
              📁 Загрузить CSV
              <input type="file" accept=".csv" onChange={handleMassCSV} className="hidden" />
            </label>
            <button
              onClick={() => {
                setMassPhones([]);
                setMassResults([]);
                setMassProgress(null);
              }}
              disabled={(!massPhones.length && !massResults.length) || massChecking}
              className="px-4 py-2 bg-surface border border-border rounded-xl text-xs text-error hover:border-error/40 transition-colors disabled:opacity-40"
            >
              Очистить
            </button>
          </div>
          <button
            onClick={startMassCheck}
            disabled={!massPhones.length || massChecking}
            className="px-5 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
          >
            {massChecking ? "Проверка..." : `Проверить ${massPhones.length} номеров`}
          </button>
        </div>

        {massResults.length > 0 && (
          <div className="mt-4 p-4 bg-bg/50 rounded-xl space-y-3 border border-border">
            <div className="flex justify-between items-center">
              <div className="text-sm font-medium">
                Результат: {massResults.filter(r => r.exists).length} найдено / {massResults.length} проверено
              </div>
              <button
                onClick={downloadValidCSV}
                disabled={!massResults.some(r => r.exists)}
                className="px-3 py-1.5 bg-success/20 text-success text-xs font-medium rounded-lg hover:bg-success/30 transition-colors disabled:opacity-50"
              >
                📥 Скачать валидные (CSV)
              </button>
            </div>
            {massProgress && (
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(massProgress.done / massProgress.total) * 100}%` }} />
              </div>
            )}
            <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
              {massResults.map((r, i) => (
                <div key={i} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                  <span className="font-mono">{r.phone}</span>
                  <span className={r.exists ? "text-success" : "text-error"}>{r.exists ? "✅ Есть" : "❌ Нет"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
