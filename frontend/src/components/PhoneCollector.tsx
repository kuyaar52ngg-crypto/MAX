"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  FileUp,
  Loader2,
  Plus,
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
      <div className="space-y-4">
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-text">
            Добавить участников
          </label>

          <div className="space-y-3">
            <div className="flex gap-2">
              <textarea
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="Введите номера телефонов через пробел, запятую или с новой строки&#10;Например: 79001234567, 79001234568&#10;79001234569"
                rows={4}
                className="flex-1 min-w-0 px-4 py-3 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all resize-none"
              />
              <button
                type="button"
                onClick={addManual}
                disabled={!manualInput.trim()}
                className="px-4 h-[116px] bg-accent hover:bg-accent-hover text-bg text-sm font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-accent/25 transition-all flex flex-col items-center justify-center gap-1"
              >
                <Plus className="h-5 w-5" strokeWidth={2.5} />
                <span className="text-xs">Добавить</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
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
                className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-bg-elevated border-2 border-border hover:border-accent/50 rounded-xl text-sm font-medium text-text transition-all disabled:opacity-50"
              >
                {csvLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                    Загрузка...
                  </>
                ) : (
                  <>
                    <FileUp className="h-4 w-4" strokeWidth={2} />
                    Загрузить CSV
                  </>
                )}
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSegPickerOpen((v) => !v)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-bg-elevated border-2 border-border hover:border-accent/50 rounded-xl text-sm font-medium text-text transition-all"
                >
                  <Bookmark className="h-4 w-4" strokeWidth={2} />
                  Из сегмента
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${segPickerOpen ? "rotate-180" : ""}`}
                    strokeWidth={2}
                  />
                </button>
                {segPickerOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setSegPickerOpen(false)}
                    />
                    <div className="absolute left-0 top-full mt-2 z-40 w-full rounded-xl border-2 border-border bg-surface shadow-2xl overflow-hidden max-h-64 overflow-y-auto">
                      {segLoading ? (
                        <div className="px-4 py-3 text-sm text-text-muted inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                          Загрузка сегментов…
                        </div>
                      ) : segments.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-text-muted">
                          Нет сохраненных сегментов.{" "}
                          <Link
                            href="/dashboard/segments"
                            className="text-accent hover:underline font-medium"
                          >
                            Создать сегмент →
                          </Link>
                        </div>
                      ) : (
                        segments.map((seg) => (
                          <button
                            key={seg.id}
                            type="button"
                            onClick={() => loadSegment(seg)}
                            disabled={segBusy === seg.id}
                            className="w-full text-left px-4 py-3 hover:bg-accent/5 transition-colors flex items-center gap-3 text-sm disabled:opacity-50 border-b border-border/50 last:border-0"
                          >
                            <span
                              className="h-3 w-3 rounded-full shrink-0 shadow-sm"
                              style={{ background: seg.color }}
                            />
                            <span className="flex-1 min-w-0 truncate text-text font-medium">
                              {seg.name}
                            </span>
                            <span className="text-text-muted text-xs font-medium px-2 py-0.5 bg-bg-elevated rounded-full">
                              {seg.member_count.toLocaleString("ru-RU")}
                            </span>
                            {segBusy === seg.id && (
                              <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2} />
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
              <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/30 text-error text-xs flex items-start gap-2">
                <X className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
                {csvError}
              </div>
            )}
            {segError && (
              <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/30 text-error text-xs flex items-start gap-2">
                <X className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
                {segError}
              </div>
            )}
          </div>
        </div>

        {phones.length > 0 && (
          <div className="p-4 bg-accent/5 border-2 border-accent/20 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-text">
                Добавлено участников
              </div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-accent text-bg rounded-lg text-xs font-bold">
                {phones.length}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {phones.map((phone) => (
                <span
                  key={phone}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text font-medium shadow-sm hover:shadow-md transition-shadow"
                >
                  {phone}
                  <button
                    type="button"
                    onClick={() => removePhone(phone)}
                    className="text-text-muted hover:text-error transition-colors ml-0.5"
                    aria-label={`Удалить ${phone}`}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2.5} />
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
