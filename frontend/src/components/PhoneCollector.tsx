"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  FileUp,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { apiUpload } from "@/lib/api";
import { nxGet } from "@/lib/api";

interface Segment {
  id: number;
  name: string;
  color: string;
  description: string | null;
  member_count: number;
}

interface SegmentDetails {
  id: number;
  name: string;
  members: { id: number; phone: string; name: string | null; notes: string | null }[];
}

interface PhoneCollectorProps {
  phones: string[];
  onPhonesChange: (phones: string[]) => void;
  className?: string;
}

function parsePhones(raw: string): string[] {
  return raw
    .replace(/,/g, " ")
    .replace(/;/g, " ")
    .split(/\s+/)
    .map((p) => p.replace(/\D/g, ""))
    .filter((p) => p.length >= 10);
}

export function PhoneCollector({
  phones,
  onPhonesChange,
  className,
}: PhoneCollectorProps) {
  const [manualInput, setManualInput] = useState("");
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [segLoading, setSegLoading] = useState(false);
  const [segPickerOpen, setSegPickerOpen] = useState(false);
  const [segBusy, setSegBusy] = useState<number | null>(null);
  const [segError, setSegError] = useState<string | null>(null);

  async function ensureSegments() {
    if (segments.length > 0 || segLoading) return;
    setSegLoading(true);
    try {
      const data = await nxGet<Segment[]>("/api/contact-segments");
      setSegments(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      setSegError(e instanceof Error ? e.message : "Не удалось загрузить сегменты");
    } finally {
      setSegLoading(false);
    }
  }

  useEffect(() => {
    if (segPickerOpen) ensureSegments();
  }, [segPickerOpen]);

  function addManual() {
    const parsed = parsePhones(manualInput);
    if (parsed.length === 0) return;
    const existing = new Set(phones);
    const fresh = parsed.filter((p) => !existing.has(p));
    onPhonesChange([...phones, ...fresh]);
    setManualInput("");
  }

  async function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvLoading(true);
    setCsvError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiUpload<{ phones: string[] }>("/api/upload-contacts", fd);
      const incoming = res.phones || [];
      const existing = new Set(phones);
      const fresh = incoming.filter((p: string) => !existing.has(p));
      onPhonesChange([...phones, ...fresh]);
    } catch (err: unknown) {
      setCsvError(err instanceof Error ? err.message : "Ошибка загрузки CSV");
    } finally {
      setCsvLoading(false);
      if (csvRef.current) csvRef.current.value = "";
    }
  }

  async function loadSegment(seg: Segment) {
    setSegBusy(seg.id);
    setSegError(null);
    try {
      const details = await nxGet<SegmentDetails>(`/api/contact-segments/${seg.id}`);
      const incoming = details.members.map((m) => m.phone);
      const existing = new Set(phones);
      const fresh = incoming.filter((p) => !existing.has(p));
      onPhonesChange([...phones, ...fresh]);
      setSegPickerOpen(false);
    } catch (e: unknown) {
      setSegError(e instanceof Error ? e.message : "Не удалось загрузить сегмент");
    } finally {
      setSegBusy(null);
    }
  }

  function removePhone(phone: string) {
    onPhonesChange(phones.filter((p) => p !== phone));
  }

  return (
    <div className={className}>
      <div className="space-y-3">
        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest">
            Добавить участников
          </label>

          <div className="flex gap-2">
            <textarea
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="Номера через пробел, запятую или с новой строки"
              rows={1}
              className="flex-1 min-w-0 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 resize-none"
            />
            <button
              type="button"
              onClick={addManual}
              disabled={!manualInput.trim()}
              className="px-3 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <div className="flex gap-2">
            <input
              ref={csvRef}
              type="file"
              accept=".csv"
              onChange={handleCSV}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => csvRef.current?.click()}
              disabled={csvLoading}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-xs text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-50"
            >
              {csvLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <FileUp className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              Загрузить CSV
            </button>

            <div className="relative flex-1">
              <button
                type="button"
                onClick={() => setSegPickerOpen((v) => !v)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-xs text-text-secondary hover:border-accent/40 transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5" strokeWidth={2.5} />
                Из сегмента
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${segPickerOpen ? "rotate-180" : ""}`}
                  strokeWidth={2.5}
                />
              </button>
              {segPickerOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setSegPickerOpen(false)}
                  />
                  <div className="absolute left-0 top-full mt-1 z-40 w-full min-w-[200px] rounded-lg border border-border bg-surface shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                    {segLoading ? (
                      <div className="px-3 py-2 text-xs text-text-muted inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                        Загрузка…
                      </div>
                    ) : segments.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-text-muted">
                        Нет сегментов.{" "}
                        <Link
                          href="/dashboard/segments"
                          className="text-accent hover:underline"
                        >
                          Создать →
                        </Link>
                      </div>
                    ) : (
                      segments.map((seg) => (
                        <button
                          key={seg.id}
                          type="button"
                          onClick={() => loadSegment(seg)}
                          disabled={segBusy === seg.id}
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
                          {segBusy === seg.id && (
                            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {csvError && (
            <div className="text-[11px] text-error">{csvError}</div>
          )}
          {segError && (
            <div className="text-[11px] text-error">{segError}</div>
          )}
        </div>

        {phones.length > 0 && (
          <div>
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Номера ({phones.length})
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {phones.map((phone) => (
                <span
                  key={phone}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-bg-elevated border border-border rounded-lg text-xs text-text"
                >
                  {phone}
                  <button
                    type="button"
                    onClick={() => removePhone(phone)}
                    className="text-text-muted hover:text-error transition-colors"
                    aria-label={`Удалить ${phone}`}
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
