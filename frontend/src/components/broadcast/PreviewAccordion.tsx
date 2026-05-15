"use client";

import { ChevronDown, Eye } from "lucide-react";

import type { BroadcastContact } from "@/lib/types";

import { PREVIEW_RECIPIENT_LIMIT } from "./types";

/**
 * Preview_Accordion props.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 4.9
 */
export interface PreviewAccordionProps {
  /** Current expand/collapse state. The component is fully controlled. */
  expanded: boolean;
  /** Invoked when the toggle button is activated. */
  onToggle(): void;
  /** Final broadcast message text rendered verbatim (no substitution). */
  message: string;
  /** Recipient list — the first `PREVIEW_RECIPIENT_LIMIT` are shown. */
  contacts: BroadcastContact[];
}

const EMPTY_MESSAGE_PLACEHOLDER = "Файл без текстовой подписи";
const EMPTY_CONTACTS_PLACEHOLDER =
  "Добавьте номера или загрузите CSV, чтобы увидеть примеры сообщений.";

/**
 * Right-column preview block rendered as a collapsible accordion.
 *
 * Shows the broadcast message as-is for the first
 * `min(contacts.length, PREVIEW_RECIPIENT_LIMIT)` recipients, without any
 * variable substitution or randomisation (Requirement 4.9). The toggle
 * button reflects the current state via `aria-expanded` (Requirement 2.7).
 */
export function PreviewAccordion({
  expanded,
  onToggle,
  message,
  contacts,
}: PreviewAccordionProps) {
  const shown = contacts.slice(0, PREVIEW_RECIPIENT_LIMIT);
  const displayMessage = message.length > 0 ? message : EMPTY_MESSAGE_PLACEHOLDER;

  return (
    <section className="broadcast-section glass rounded-xl p-6 space-y-4">
      <header className="flex items-center justify-between">
        <h3
          id="preview-heading"
          className="flex items-center gap-2 text-sm font-semibold text-text-secondary"
        >
          <Eye className="h-4 w-4 text-accent-light" strokeWidth={2} />
          Предпросмотр
        </h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="preview-panel"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary transition-colors hover:border-border-focus"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="sr-only">
            {expanded ? "Свернуть предпросмотр" : "Развернуть предпросмотр"}
          </span>
        </button>
      </header>

      {expanded && (
        <div
          id="preview-panel"
          role="region"
          aria-labelledby="preview-heading"
          className="space-y-2"
        >
          {shown.length === 0 ? (
            <p className="text-sm text-text-muted">{EMPTY_CONTACTS_PLACEHOLDER}</p>
          ) : (
            shown.map((contact, index) => {
              // Если у контакта есть персональный `_message` (проставлен
              // кнопкой «Использовать AI»), показываем именно его — это
              // тот текст, который реально уйдёт получателю. Иначе
              // показываем общий `message`.
              const personal = (contact as { _message?: string })._message;
              const cardMessage =
                typeof personal === "string" && personal.length > 0
                  ? personal
                  : displayMessage;
              return (
                <article
                  key={`${contact.phone}-${index}`}
                  className="rounded-xl border border-border bg-bg-elevated p-3"
                >
                  <div className="mb-1 text-xs text-text-muted">{contact.phone}</div>
                  <div className="whitespace-pre-wrap text-sm text-text">
                    {cardMessage}
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

export default PreviewAccordion;
