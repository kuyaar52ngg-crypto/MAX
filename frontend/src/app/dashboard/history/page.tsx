"use client";

import { useState, useEffect, useMemo } from "react";
import {
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  Download,
  Paperclip,
  Search,
  Send,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { nxGet } from "@/lib/api";
import { Broadcast, Recipient } from "@/lib/types";

export default function HistoryPage() {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [selected, setSelected] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => { loadHistory(); }, []);

  const filteredBroadcasts = useMemo(() => broadcasts.filter((broadcast) => {
    const matchesStatus = statusFilter === "all" || broadcast.status === statusFilter;
    const matchesSearch = !search.trim() || broadcast.message.toLowerCase().includes(search.trim().toLowerCase());
    return matchesStatus && matchesSearch;
  }), [broadcasts, search, statusFilter]);

  const summary = useMemo(() => broadcasts.reduce(
    (acc, broadcast) => ({
      total: acc.total + broadcast.total,
      sent: acc.sent + broadcast.sent,
      notFound: acc.notFound + broadcast.not_found,
      failed: acc.failed + broadcast.failed,
    }),
    { total: 0, sent: 0, notFound: 0, failed: 0 }
  ), [broadcasts]);

  async function loadHistory() {
    setLoading(true);
    try {
      const data = await nxGet<Broadcast[]>("/api/broadcasts");
      setBroadcasts(Array.isArray(data) ? data : []);
    } catch { /* */ } finally { setLoading(false); }
  }

  async function showDetails(b: Broadcast) {
    setSelected(b);
    try {
      const data = await nxGet<Recipient[]>(`/api/broadcasts/${b.id}`);
      setRecipients(Array.isArray(data) ? data : []);
    } catch { /* */ }
  }

  function successRate(b: Broadcast) {
    return b.total > 0 ? Math.round((b.sent / b.total) * 100) : 0;
  }

  function downloadRecipientsCSV() {
    if (!selected || recipients.length === 0) return;
    const escapeCsv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["phone", "status", "delivery_status", "message_id", "rendered_message", "sent_at"],
      ...recipients.map((recipient) => [
        recipient.phone,
        recipient.status,
        recipient.delivery_status,
        recipient.message_id || "",
        recipient.rendered_message || "",
        recipient.sent_at || "",
      ]),
    ];
    const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `broadcast_${selected.id}_recipients.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }


  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <ClipboardList className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">История рассылок</h1>
        <p className="text-text-muted text-sm mt-1">Все выполненные рассылки</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="glass rounded-xl p-4">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-bg-elevated text-text"><Users className="h-4 w-4" strokeWidth={2} /></div>
          <div className="text-xs text-text-muted">Всего получателей</div>
          <div className="mt-1 text-xl font-bold text-text">{summary.total}</div>
        </div>
        <div className="glass rounded-xl p-4">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-success-bg text-success"><Send className="h-4 w-4" strokeWidth={2} /></div>
          <div className="text-xs text-text-muted">Отправлено</div>
          <div className="mt-1 text-xl font-bold text-success">{summary.sent}</div>
        </div>
        <div className="glass rounded-xl p-4">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-warning-bg text-warning"><CircleHelp className="h-4 w-4" strokeWidth={2} /></div>
          <div className="text-xs text-text-muted">Не найдено</div>
          <div className="mt-1 text-xl font-bold text-warning">{summary.notFound}</div>
        </div>
        <div className="glass rounded-xl p-4">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-error-bg text-error"><TriangleAlert className="h-4 w-4" strokeWidth={2} /></div>
          <div className="text-xs text-text-muted">Ошибки</div>
          <div className="mt-1 text-xl font-bold text-error">{summary.failed}</div>
        </div>
      </div>

      <div className="glass rounded-xl p-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" strokeWidth={2} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по тексту рассылки..."
            className="w-full px-4 py-2.5 pl-9 bg-surface border border-border rounded-xl text-sm text-text placeholder:text-text-muted outline-none focus:border-border-focus transition-colors"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-text outline-none focus:border-border-focus transition-colors"
        >
          <option value="all">Все статусы</option>
          <option value="running">Активные</option>
          <option value="done">Завершённые</option>
          <option value="cancelled">Отменённые</option>
        </select>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-xl skeleton" />)}
        </div>
      ) : broadcasts.length === 0 ? (
        <div className="glass rounded-xl p-12 text-center text-text-muted">Рассылок ещё не было</div>
      ) : filteredBroadcasts.length === 0 ? (
        <div className="glass rounded-xl p-12 text-center text-text-muted">По фильтрам ничего не найдено</div>
      ) : (
        <div className="space-y-3">
          {filteredBroadcasts.map((b) => (
            <button
              key={b.id}
              onClick={() => showDetails(b)}
              className={`history-card w-full text-left glass rounded-xl p-5 transition-all duration-200 hover:border-border-focus hover:shadow-glow
                ${selected?.id === b.id ? "border-border-focus bg-accent-subtle" : "border-border"}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-text">Рассылка #{b.id}</span>
                <div className="flex items-center gap-2">
                  {b.file_url && <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full bg-accent-subtle text-accent-light"><Paperclip className="h-3 w-3" strokeWidth={2} /> файл</span>}
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                    b.status === "done" ? "bg-success-bg text-success" : "bg-warning-bg text-warning"
                  }`}>
                    {b.status === "done" ? "Завершена" : "Активна"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-text-muted truncate mb-2">{b.message?.slice(0, 80) || "—"}</p>
              <div className="flex gap-4 text-xs text-text-muted">
                <span>Всего: {b.total}</span>
                <span className="text-success">Отправлено: {b.sent}</span>
                <span className="text-warning">Не найдено: {b.not_found}</span>
                <span className="text-error">Ошибки: {b.failed}</span>
                <span>{successRate(b)}%</span>
                <span className="ml-auto">{b.created_at}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Details modal */}
      {selected && (
        <div className="glass rounded-xl p-6 space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-sm font-semibold text-text">Детали рассылки #{selected.id}</h3>
              <p className="text-xs text-text-muted mt-1">Успешность: {successRate(selected)}%</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={downloadRecipientsCSV} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-secondary hover:border-border-focus transition-colors">
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
                CSV
              </button>
              <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text transition-colors">
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
          </div>
          {selected.file_url && (
            <div className="rounded-xl bg-bg-elevated border border-border p-3 text-xs text-text-muted">
              <span className="inline-flex items-center gap-2"><Paperclip className="h-3.5 w-3.5" strokeWidth={2} />Вложение: {selected.file_name || selected.file_url}</span>
            </div>
          )}
          <div className="max-h-60 overflow-y-auto space-y-1">
            {recipients.map((r) => (
              <div key={r.id} className="px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-xs">
                <div className="flex justify-between items-center gap-3">
                  <span className="text-text font-mono">{r.phone}</span>
                  <div className="flex gap-3">
                    <span className={r.status === "sent" ? "inline-flex items-center gap-1 text-success" : r.status === "not_found" ? "text-warning" : "text-error"}>
                      {r.status === "sent" && <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />}
                      {r.status}
                    </span>
                    {r.delivery_status && <span className="text-text-muted">{r.delivery_status}</span>}
                  </div>
                </div>
                {r.rendered_message && <div className="mt-1 text-text-muted truncate">{r.rendered_message}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
