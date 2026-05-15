"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  Check,
  Download,
  FolderOpen,
  Search,
  UserCheck,
  X,
} from "lucide-react";
import { apiGet, apiPost, apiUpload } from "@/lib/api";
import { useBulkOperation } from "@/lib/hooks/useBulkOperation";
import { PreFlightModal } from "@/components/anti-ban/PreFlightModal";
import { StopButton } from "@/components/anti-ban/StopButton";
import {
  AntiBanConfig,
  DEFAULT_ANTI_BAN_CONFIG,
} from "@/lib/anti-ban";

interface Contact {
  id: string;
  name: string;
  chatId: string;
  type: string;
}

interface MassResult {
  phone: string;
  exists: boolean;
  chatId?: string;
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
  const [massResults, setMassResults] = useState<MassResult[]>([]);

  // Anti-ban integration: PreFlight modal + bulk operation hook + StopButton.
  // The hook owns the SSE channel and the active/progress/error state, so we
  // no longer maintain a local `massChecking` flag, sseCloseRef, or
  // `massProgress` snapshot — they're projected from `bulkOp` instead.
  const bulkOp = useBulkOperation("check");
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [pendingPhones, setPendingPhones] = useState<string[]>([]);
  const [antiBanConfig, setAntiBanConfig] = useState<AntiBanConfig>(DEFAULT_ANTI_BAN_CONFIG);

  const [isAccordionOpen, setIsAccordionOpen] = useState(false);

  useEffect(() => { loadContacts(); }, []);

  // Load anti-ban config on mount; fall back to defaults on failure so the
  // PreFlight modal can still render meaningful ETA/risk values.
  useEffect(() => {
    let cancelled = false;
    apiGet<AntiBanConfig>("/api/anti-ban-config")
      .then((cfg) => {
        if (!cancelled && cfg && typeof cfg === "object") setAntiBanConfig(cfg);
      })
      .catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  // Each SSE progress event carries a per-phone result (`phone`, `exists`,
  // `chatId`). The hook merges those into `bulkOp.progress` (replacing the
  // previous one), so we accumulate them into a local `massResults` array
  // here. Each `setProgress` call inside the hook creates a fresh object,
  // so the effect fires exactly once per server event.
  useEffect(() => {
    const p = bulkOp.progress as
      | (Record<string, unknown> & { phone?: unknown; exists?: unknown; chatId?: unknown })
      | null;
    if (!p) return;
    if (typeof p.phone === "string" && typeof p.exists === "boolean") {
      const chatId = typeof p.chatId === "string" ? p.chatId : undefined;
      setMassResults((prev) => [
        ...prev,
        { phone: p.phone as string, exists: p.exists as boolean, chatId },
      ]);
    }
  }, [bulkOp.progress]);

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

  // Open the PreFlight modal with the currently-staged phones. The actual
  // POST + SSE happens only after the user confirms the modal.
  function openPreflight() {
    if (!massPhones.length || bulkOp.active) return;
    setPendingPhones(massPhones);
    setPreflightOpen(true);
  }

  async function handlePreflightConfirm() {
    setPreflightOpen(false);
    setMassResults([]);
    await bulkOp.start({ phones: pendingPhones });
  }

  function handlePreflightCancel() {
    setPreflightOpen(false);
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

  const progressDone = typeof bulkOp.progress?.done === "number" ? bulkOp.progress.done : 0;
  const progressTotal = typeof bulkOp.progress?.total === "number" ? bulkOp.progress.total : 0;

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text flex items-center gap-2">
          <UserCheck className="h-6 w-6 text-text-muted" strokeWidth={2} aria-hidden="true" />
          Проверка номеров
        </h1>
        <p className="text-text-muted text-sm mt-1">Управление контактами</p>
      </div>

      {/* Check single contact */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <Search className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Проверка номера
        </h3>
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
          <div className={`px-4 py-3 rounded-xl text-sm flex items-center gap-2 ${checkResult.exists ? "bg-success-bg border border-success/20 text-success" : "bg-error-bg border border-error/20 text-error"}`}>
            {checkResult.exists ? (
              <>
                <Check className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                <span>Найден! chatId: {checkResult.chatId}</span>
              </>
            ) : (
              <>
                <X className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                <span>Не зарегистрирован в WhatsApp</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Mass Check */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <BarChart3 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Массовая проверка
        </h3>
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
              <FolderOpen className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Загрузить CSV
              <input type="file" accept=".csv" onChange={handleMassCSV} className="hidden" />
            </label>
            <button
              onClick={() => {
                setMassPhones([]);
                setMassResults([]);
              }}
              disabled={(!massPhones.length && !massResults.length) || bulkOp.active}
              className="px-4 py-2 bg-surface border border-border rounded-xl text-xs text-error hover:border-error/40 transition-colors disabled:opacity-40"
            >
              Очистить
            </button>
          </div>
          <div className="flex items-center gap-3">
            {bulkOp.active && (
              <StopButton onStop={bulkOp.stop} active={bulkOp.active} />
            )}
            <button
              onClick={openPreflight}
              disabled={!massPhones.length || bulkOp.active}
              className="px-5 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
            >
              {bulkOp.active ? "Проверка..." : `Проверить ${massPhones.length} номеров`}
            </button>
          </div>
        </div>

        {bulkOp.error && (
          <div role="alert" className="px-4 py-3 rounded-xl text-sm bg-error-bg border border-error/20 text-error">
            {bulkOp.error}
          </div>
        )}

        {(massResults.length > 0 || bulkOp.active) && (
          <div className="mt-4 p-4 bg-bg/50 rounded-xl space-y-3 border border-border">
            <div className="flex justify-between items-center">
              <div className="text-sm font-medium">
                Результат: {massResults.filter(r => r.exists).length} найдено / {massResults.length} проверено
              </div>
              <button
                onClick={downloadValidCSV}
                disabled={!massResults.some(r => r.exists)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-success/20 text-success text-xs font-medium rounded-lg hover:bg-success/30 transition-colors disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Скачать валидные (CSV)
              </button>
            </div>
            {progressTotal > 0 && (
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(progressDone / progressTotal) * 100}%` }} />
              </div>
            )}
            <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
              {massResults.map((r, i) => (
                <div key={i} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                  <span className="font-mono">{r.phone}</span>
                  <span className={`inline-flex items-center gap-1 ${r.exists ? "text-success" : "text-error"}`}>
                    {r.exists ? (
                      <>
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                        Есть
                      </>
                    ) : (
                      <>
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                        Нет
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <PreFlightModal
        open={preflightOpen}
        kind="check"
        total={pendingPhones.length}
        config={antiBanConfig}
        onConfirm={handlePreflightConfirm}
        onCancel={handlePreflightCancel}
      />
    </div>
  );
}
