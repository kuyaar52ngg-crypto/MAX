"use client";

import { useState, useEffect } from "react";
import { nxGet } from "@/lib/api";
import { Broadcast, Recipient } from "@/lib/types";

export default function HistoryPage() {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [selected, setSelected] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadHistory(); }, []);

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


  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">📋 История рассылок</h1>
        <p className="text-text-muted text-sm mt-1">Все выполненные рассылки</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-2xl skeleton" />)}
        </div>
      ) : broadcasts.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center text-text-muted">Рассылок ещё не было</div>
      ) : (
        <div className="space-y-3">
          {broadcasts.map((b) => (
            <button
              key={b.id}
              onClick={() => showDetails(b)}
              className={`history-card w-full text-left glass rounded-2xl p-5 transition-all duration-200 hover:border-accent/30 hover:shadow-glow
                ${selected?.id === b.id ? "border-accent/40 bg-accent-subtle" : "border-border"}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-text">Рассылка #{b.id}</span>
                <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                  b.status === "done" ? "bg-success-bg text-success" : "bg-warning-bg text-warning"
                }`}>
                  {b.status === "done" ? "✅ Завершена" : "🔄 Активна"}
                </span>
              </div>
              <p className="text-xs text-text-muted truncate mb-2">{b.message?.slice(0, 80) || "—"}</p>
              <div className="flex gap-4 text-xs text-text-muted">
                <span>📊 Всего: {b.total}</span>
                <span className="text-success">✅ {b.sent}</span>
                <span className="text-warning">❓ {b.not_found}</span>
                <span className="text-error">❌ {b.failed}</span>
                <span className="ml-auto">{b.created_at}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Details modal */}
      {selected && (
        <div className="glass rounded-2xl p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-semibold text-text">Детали рассылки #{selected.id}</h3>
            <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text transition-colors">✕</button>
          </div>
          <div className="max-h-60 overflow-y-auto space-y-1">
            {recipients.map((r) => (
              <div key={r.id} className="flex justify-between items-center px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-xs">
                <span className="text-text font-mono">{r.phone}</span>
                <div className="flex gap-3">
                  <span className={r.status === "sent" ? "text-success" : r.status === "not_found" ? "text-warning" : "text-error"}>
                    {r.status}
                  </span>
                  {r.delivery_status && <span className="text-text-muted">{r.delivery_status}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
