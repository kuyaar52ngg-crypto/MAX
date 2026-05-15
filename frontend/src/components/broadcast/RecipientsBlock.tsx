"use client";

import { useState } from "react";
import { FileUp } from "lucide-react";
import type { BroadcastContact } from "@/lib/types";

/**
 * Props contract for `Recipients_Block`, matching the shape declared in
 * `design.md` ("Components and Interfaces" → "Recipients_Block").
 *
 * The parent owns the `contacts` array. The component is purely presentational
 * and only owns the transient phone-input draft. CSV upload is delegated to
 * the parent through `onCsvUpload`, which returns a `Promise<void>` so the
 * parent can perform the network request and surface warnings/errors back
 * via the `csvWarnings` prop.
 *
 * Validates: Requirements 1.2, 4.1
 */
export interface RecipientsBlockProps {
  contacts: BroadcastContact[];
  onAdd(phone: string): void;
  onRemove(index: number): void;
  onCsvUpload(file: File): Promise<void>;
  csvWarnings: string[];
}

/**
 * Presentational "Recipients" block: phone number input, recipient chips
 * and CSV upload entry point.
 *
 * Per Requirement 4.1, the legacy "Доступные переменные из CSV" panel and
 * the `{field}` insertion buttons are intentionally NOT rendered — clients
 * that previously relied on them must now rely on AI-generated text and a
 * server-side rendering pipeline that does not perform local variable
 * substitution.
 */
export function RecipientsBlock({
  contacts,
  onAdd,
  onRemove,
  onCsvUpload,
  csvWarnings,
}: RecipientsBlockProps) {
  const [phoneInput, setPhoneInput] = useState("");

  const phones = contacts.map((contact) => contact.phone);

  function tryAddPhone(raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (
      cleaned.length >= 10 &&
      cleaned.length <= 15 &&
      !phones.includes(cleaned)
    ) {
      onAdd(cleaned);
    }
    setPhoneInput("");
  }

  function handlePhoneKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      tryAddPhone(phoneInput);
      return;
    }
    if (e.key === "Backspace" && !phoneInput && phones.length > 0) {
      onRemove(phones.length - 1);
    }
  }

  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input value so re-selecting the same file fires `change`.
    e.target.value = "";
    if (!file) return;
    try {
      await onCsvUpload(file);
    } catch {
      /* parent is responsible for surfacing upload errors */
    }
  }

  return (
    <div className="broadcast-section glass rounded-xl p-6 space-y-4">
      <h3 className="text-sm font-semibold text-text-secondary">Получатели</h3>

      <div className="flex flex-wrap gap-2 p-3 bg-bg-elevated border border-border rounded-xl min-h-[48px]">
        {phones.map((phone, i) => (
          <span
            key={`${phone}-${i}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent-subtle border border-accent-light/20 rounded-lg text-xs text-accent-light"
          >
            {phone}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="hover:text-error transition-colors"
              aria-label={`Удалить ${phone}`}
            >
              ×
            </button>
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
        <label className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-lg text-xs text-text-secondary cursor-pointer hover:border-border-focus transition-colors">
          <FileUp className="h-4 w-4" strokeWidth={2} />
          CSV файл
          <input
            type="file"
            accept=".csv"
            onChange={handleCsvChange}
            className="hidden"
          />
        </label>
        <span className="text-xs text-text-muted self-center">
          {phones.length} контактов
        </span>
      </div>

      {csvWarnings.length > 0 && (
        <div className="space-y-1 text-xs text-warning">
          {csvWarnings.slice(0, 4).map((warning, i) => (
            <div key={i}>{warning}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default RecipientsBlock;
