"use client";

/**
 * `SegmentLoader` — компонент в карточке Recipients, который позволяет:
 *   - загрузить телефоны из ранее созданного сегмента в текущий список
 *     получателей одной кнопкой;
 *   - сохранить текущий список получателей как новый сегмент.
 *
 * Используется на странице рассылки. CRUD сегментов — на отдельной
 * странице /dashboard/segments.
 */

import { useEffect, useState } from "react";
import {
  Bookmark,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Plus,
  Tag,
} from "lucide-react";
import Link from "next/link";

import { nxGet, nxPost } from "@/lib/api";

interface Segment {
  id: number;
  name: string;
  color: string;
  description: string | null;
  member_count: number;
}

interface SegmentMember {
  id: number;
  phone: string;
  name: string | null;
  notes: string | null;
}

interface SegmentDetails {
  id: number;
  name: string;
  members: SegmentMember[];
}

export interface SegmentLoaderProps {
  /** Текущие телефоны в списке получателей. */
  currentPhones: string[];
  /** Колбэк когда пользователь выбрал сегмент — даст массив контактов. */
  onLoad: (members: { phone: string; name?: string | null }[]) => void;
  className?: string;
}

export function SegmentLoader({
  currentPhones,
  onLoad,
  className,
}: SegmentLoaderProps) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<{
    segmentName: string;
    addedCount: number;
  } | null>(null);

  // Lazy load — берём список сегментов только при первом открытии picker'а.
  async function ensureLoaded() {
    if (segments.length > 0 || loading) return;
    setLoading(true);
    try {
      const data = await nxGet<Segment[]>("/api/contact-segments");
      setSegments(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (pickerOpen || savePickerOpen) ensureLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, savePickerOpen]);

  async function loadSegment(seg: Segment) {
    setBusy(`load-${seg.id}`);
    setError(null);
    try {
      const details = await nxGet<SegmentDetails>(
        `/api/contact-segments/${seg.id}`,
      );
      const incoming = details.members.map((m) => ({
        phone: m.phone,
        name: m.name,
      }));
      // Дедупликация на стороне клиента — отдадим только новые номера.
      const existing = new Set(currentPhones);
      const fresh = incoming.filter((c) => !existing.has(c.phone));
      onLoad(fresh);
      setLastLoaded({
        segmentName: seg.name,
        addedCount: fresh.length,
      });
      setPickerOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить сегмент");
    } finally {
      setBusy(null);
    }
  }

  async function saveAsNewSegment() {
    const name = window.prompt("Название нового сегмента:")?.trim();
    if (!name) return;
    setBusy("save-new");
    setError(null);
    try {
      const seg = await nxPost<Segment>("/api/contact-segments", { name });
      await nxPost(`/api/contact-segments/${seg.id}/members`, {
        phones: currentPhones,
      });
      setSegments((prev) => [
        { ...seg, member_count: currentPhones.length },
        ...prev,
      ]);
      setLastLoaded({
        segmentName: name,
        addedCount: currentPhones.length,
      });
      setSavePickerOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(null);
    }
  }

  async function appendToSegment(seg: Segment) {
    setBusy(`append-${seg.id}`);
    setError(null);
    try {
      const res = await nxPost<{ inserted: number; skipped: number }>(
        `/api/contact-segments/${seg.id}/members`,
        { phones: currentPhones },
      );
      // Локально обновим счётчик.
      setSegments((prev) =>
        prev.map((s) =>
          s.id === seg.id
            ? { ...s, member_count: s.member_count + res.inserted }
            : s,
        ),
      );
      setLastLoaded({
        segmentName: seg.name,
        addedCount: res.inserted,
      });
      setSavePickerOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`rounded-xl border border-border bg-bg-elevated p-3 space-y-2 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <Tag className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
        <h4 className="text-xs font-semibold text-text">Сегменты</h4>
        <Link
          href="/dashboard/segments"
          className="ml-auto text-[11px] text-text-muted hover:text-accent"
        >
          Управлять →
        </Link>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {/* Load from segment */}
        <div className="relative flex-1 min-w-[140px]">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="w-full inline-flex items-center justify-between gap-1.5 px-3 py-2 rounded-lg bg-bg border border-border text-xs text-text-secondary hover:border-accent/40 transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <Bookmark className="h-3 w-3" strokeWidth={2.5} />
              Загрузить
            </span>
            <ChevronDown
              className={`h-3 w-3 transition-transform ${pickerOpen ? "rotate-180" : ""}`}
              strokeWidth={2.5}
            />
          </button>
          {pickerOpen && (
            <Picker
              segments={segments}
              loading={loading}
              busy={busy}
              busyPrefix="load-"
              emptyMessage="Нет сохранённых сегментов"
              onSelect={loadSegment}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        {/* Save current as segment (with append-or-create) */}
        <div className="relative flex-1 min-w-[140px]">
          <button
            type="button"
            onClick={() => {
              if (currentPhones.length === 0) {
                setError("Сначала добавьте номера в список");
                return;
              }
              setSavePickerOpen((v) => !v);
            }}
            disabled={currentPhones.length === 0}
            className="w-full inline-flex items-center justify-between gap-1.5 px-3 py-2 rounded-lg bg-bg border border-border text-xs text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-3 w-3" strokeWidth={2.5} />
              Сохранить как
            </span>
            <ChevronDown
              className={`h-3 w-3 transition-transform ${savePickerOpen ? "rotate-180" : ""}`}
              strokeWidth={2.5}
            />
          </button>
          {savePickerOpen && (
            <SavePicker
              segments={segments}
              loading={loading}
              busy={busy}
              currentPhonesCount={currentPhones.length}
              onCreateNew={saveAsNewSegment}
              onAppend={appendToSegment}
              onClose={() => setSavePickerOpen(false)}
            />
          )}
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-error">{error}</div>
      )}
      {lastLoaded && (
        <div className="text-[11px] text-success inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
          {lastLoaded.addedCount > 0
            ? `Добавлено ${lastLoaded.addedCount} в «${lastLoaded.segmentName}»`
            : `Все номера из «${lastLoaded.segmentName}» уже в списке`}
        </div>
      )}
    </div>
  );
}

interface PickerProps {
  segments: Segment[];
  loading: boolean;
  busy: string | null;
  busyPrefix: string;
  emptyMessage: string;
  onSelect: (seg: Segment) => void;
  onClose: () => void;
}

function Picker({
  segments,
  loading,
  busy,
  busyPrefix,
  emptyMessage,
  onSelect,
  onClose,
}: PickerProps) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-40 w-full min-w-[200px] rounded-lg border border-border bg-surface shadow-lg overflow-hidden max-h-64 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-2 text-xs text-text-muted inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            Загрузка…
          </div>
        ) : segments.length === 0 ? (
          <div className="px-3 py-3 text-xs text-text-muted">
            {emptyMessage}
          </div>
        ) : (
          segments.map((seg) => (
            <button
              key={seg.id}
              type="button"
              onClick={() => onSelect(seg)}
              disabled={busy === `${busyPrefix}${seg.id}`}
              className="w-full text-left px-3 py-2 hover:bg-bg-elevated transition-colors flex items-center gap-2 text-xs disabled:opacity-50"
            >
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ background: seg.color }}
              />
              <span className="flex-1 min-w-0 truncate text-text">
                {seg.name}
              </span>
              <span className="text-text-muted">
                {seg.member_count.toLocaleString("ru-RU")}
              </span>
              {busy === `${busyPrefix}${seg.id}` && (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              )}
            </button>
          ))
        )}
      </div>
    </>
  );
}

interface SavePickerProps {
  segments: Segment[];
  loading: boolean;
  busy: string | null;
  currentPhonesCount: number;
  onCreateNew: () => void;
  onAppend: (seg: Segment) => void;
  onClose: () => void;
}

function SavePicker({
  segments,
  loading,
  busy,
  currentPhonesCount,
  onCreateNew,
  onAppend,
  onClose,
}: SavePickerProps) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-40 w-full min-w-[220px] rounded-lg border border-border bg-surface shadow-lg overflow-hidden max-h-64 overflow-y-auto">
        <button
          type="button"
          onClick={onCreateNew}
          disabled={busy === "save-new"}
          className="w-full text-left px-3 py-2.5 hover:bg-accent/10 transition-colors flex items-center gap-2 text-xs border-b border-border"
        >
          <Plus className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} />
          <span className="flex-1 text-accent font-medium">
            Создать новый сегмент
          </span>
          {busy === "save-new" && (
            <Loader2 className="h-3 w-3 animate-spin text-accent" strokeWidth={2} />
          )}
        </button>
        {loading ? (
          <div className="px-3 py-2 text-xs text-text-muted">Загрузка…</div>
        ) : segments.length > 0 ? (
          <>
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted bg-bg-elevated/50">
              Или добавить в существующий
            </div>
            {segments.map((seg) => (
              <button
                key={seg.id}
                type="button"
                onClick={() => onAppend(seg)}
                disabled={busy === `append-${seg.id}`}
                className="w-full text-left px-3 py-2 hover:bg-bg-elevated transition-colors flex items-center gap-2 text-xs disabled:opacity-50"
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ background: seg.color }}
                />
                <span className="flex-1 min-w-0 truncate text-text">
                  {seg.name}
                </span>
                <span className="text-text-muted">
                  +{currentPhonesCount}
                </span>
                {busy === `append-${seg.id}` && (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                )}
              </button>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}
