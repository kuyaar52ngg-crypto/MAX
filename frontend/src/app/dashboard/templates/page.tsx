"use client";

import { useState, useEffect } from "react";
import { nxGet, nxPost, nxDelete } from "@/lib/api";
import { Template } from "@/lib/types";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadTemplates(); }, []);

  async function loadTemplates() {
    setLoading(true);
    try {
      const data = await nxGet<Template[]>("/api/templates");
      setTemplates(Array.isArray(data) ? data : []);
    } catch { /* */ } finally { setLoading(false); }
  }

  async function createTemplate() {
    if (!name.trim() || !text.trim()) return;
    setCreating(true);
    try {
      await nxPost("/api/templates", { name: name.trim(), text: text.trim() });
      setName("");
      setText("");
      loadTemplates();
    } catch { /* */ } finally { setCreating(false); }
  }

  async function deleteTemplate(id: number) {
    try {
      await nxDelete(`/api/templates/${id}`);
      setTemplates((t) => t.filter((x) => x.id !== id));
    } catch { /* */ }
  }

  function copyToClipboard(t: string) {
    navigator.clipboard.writeText(t);
  }


  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">📝 Шаблоны</h1>
        <p className="text-text-muted text-sm mt-1">Готовые тексты для рассылок</p>
      </div>

      {/* Create form */}
      <div className="glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">Новый шаблон</h3>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название шаблона"
          className="w-full px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                     focus:outline-none focus:border-accent/50 transition-colors"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Текст сообщения..."
          rows={4}
          className="w-full px-4 py-3 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                     resize-none focus:outline-none focus:border-accent/50 transition-colors"
        />
        <button
          onClick={createTemplate}
          disabled={creating || !name.trim() || !text.trim()}
          className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all
                     disabled:opacity-40 active:scale-95"
        >
          {creating ? "Создание..." : "➕ Создать шаблон"}
        </button>
      </div>

      {/* Templates list */}
      <div className="space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 rounded-2xl skeleton" />)
        ) : templates.length === 0 ? (
          <div className="glass rounded-2xl p-12 text-center text-text-muted">Шаблонов пока нет</div>
        ) : (
          templates.map((t) => (
            <div key={t.id} className="template-card glass rounded-2xl p-5 space-y-2 hover:border-accent/20 transition-colors">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text">{t.name}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => copyToClipboard(t.text)}
                    className="px-2.5 py-1 text-xs text-text-muted hover:text-accent bg-surface hover:bg-surface-hover rounded-lg transition-colors"
                  >
                    📋 Копировать
                  </button>
                  <button
                    onClick={() => deleteTemplate(t.id)}
                    className="px-2.5 py-1 text-xs text-text-muted hover:text-error bg-surface hover:bg-error-bg rounded-lg transition-colors"
                  >
                    🗑️ Удалить
                  </button>
                </div>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap">{t.text}</p>
              <p className="text-[10px] text-text-muted">{t.created_at}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
