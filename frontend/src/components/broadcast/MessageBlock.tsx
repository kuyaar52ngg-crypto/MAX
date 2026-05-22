"use client";

/**
 * `Message_Block` — composite presentational block for the central column of
 * the redesigned `/dashboard/broadcast` page.
 *
 * Composes the leaf components implemented in tasks 6.x:
 *  - optional template selector (rendered only when `templates.length > 0`);
 *  - `Auto_Grow_Textarea` for the message body;
 *  - `Attachment_Uploader` for picking a single file from the local device;
 *  - `AI_Generator_Button` for triggering AI text generation (with inline
 *    error rendering near the button when `ai.error` is non-null);
 *  - "Начать рассылку" start button;
 *  - progress bar and recent-results list rendered while a broadcast is
 *    running or after it has finished.
 *
 * Per Requirement 4.1, this block does NOT render the legacy variables
 * panel, the "Переменные" / "Рандом-блоков" indicators, the "Проверить
 * текст" button, or the `{name}` / `{a|b|c}` help text — AI generation
 * fully replaces those affordances.
 *
 * The start button and progress block live inside this component so they
 * remain visible in the central column on both wide (≥1024px) and narrow
 * (<1024px) layouts (Requirement 1.6). Wiring into `Broadcast_Page` is
 * handled separately in task 10.1.
 *
 * Validates: Requirements 1.3, 1.6, 4.1, 4.2, 4.3, 4.4, 9.2, 9.3
 */

import { CalendarClock, Check, CircleHelp, Send, X } from "lucide-react";

import type { Template } from "@/lib/types";

import { AIGeneratorButton } from "./AIGeneratorButton";
import { AttachmentUploader } from "./AttachmentUploader";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import type {
  AttachmentError,
  AttachmentState,
  ProgressEvent,
  ResultRow,
} from "./types";

export interface MessageBlockProps {
  /** Current message text owned by the parent. */
  message: string;
  /** Called when the user edits the message text. */
  onMessageChange(value: string): void;

  /** Current attachment slot state (controlled by the parent). */
  attachment: AttachmentState;
  /** Called when the user picks a file that passes the size validation. */
  onAttachmentSelect(file: File): void;
  /** Called when the user clears the selected attachment. */
  onAttachmentRemove(): void;
  /**
   * Optional retry callback wired by the parent (`page.tsx`) to re-trigger
   * `startBroadcast` after a failed upload. Forwarded to
   * `Attachment_Uploader.onRetry`.
   */
  onAttachmentRetry?: () => void;
  /**
   * Optional rejection callback. Forwarded to `Attachment_Uploader.onReject`
   * so the parent can surface a size-rejection error message (e.g. set
   * `uploadError` with a "файл превышает 50 МБ" string in task 10.1).
   */
  onAttachmentReject?: (reason: AttachmentError) => void;
  /** Last upload error to display next to the attachment slot. */
  uploadError: string | null;

  /** AI generator state and click handler. */
  ai: { pending: boolean; error: string | null; onClick(): void };

  /** Available templates. When empty, the template selector is hidden. */
  templates: Template[];
  /** Called with the selected template's text when the user picks one. */
  onTemplateSelect(text: string): void;

  /**
   * Parent-supplied gate for starting the broadcast (e.g. "at least one
   * recipient is configured"). The local rule is AND-ed with this signal —
   * never overridden.
   */
  canStart: boolean;
  /** Whether a broadcast is currently in progress. */
  broadcasting: boolean;
  /** Progress percentage (0..100). Used in the start button label. */
  progressPct: number;
  /** Click handler for the "Начать рассылку" button. */
  onStart(): void;
  /** Optional handler for "Запланировать…" button. */
  onSchedule?(): void;

  /** Latest SSE progress event. When `null`, the progress block is hidden. */
  progress: ProgressEvent | null;
  /** Per-recipient result rows accumulated during the broadcast. */
  results: ResultRow[];
}

/**
 * Local enable rule for the start button: at least one of the message text
 * (after trimming) or the attachment slot must be non-empty.
 *
 * Per Requirement 9.3 / task 7.1 the button is `disabled` if and only if
 * `message.trim() === "" && attachment.kind === "none"`. The parent's
 * `canStart` flag and the `broadcasting` flag are AND-ed on top of this so
 * the parent can keep the button blocked for additional reasons (e.g.
 * empty recipients list) without this component overriding the rule.
 */
function isLocallyBlocked(message: string, attachment: AttachmentState): boolean {
  return message.trim() === "" && attachment.kind === "none";
}

export function MessageBlock({
  message,
  onMessageChange,
  attachment,
  onAttachmentSelect,
  onAttachmentRemove,
  onAttachmentRetry,
  onAttachmentReject,
  uploadError,
  ai,
  templates,
  onTemplateSelect,
  canStart,
  broadcasting,
  progressPct,
  onStart,
  onSchedule,
  progress,
  results,
}: MessageBlockProps) {
  const localBlocked = isLocallyBlocked(message, attachment);
  const startDisabled = localBlocked || broadcasting || !canStart;

  // The optional `onAttachmentReject` prop is bridged to a no-op when the
  // parent does not supply one, so `Attachment_Uploader` (which requires
  // `onReject`) keeps a stable contract regardless of parent wiring.
  const handleReject = onAttachmentReject ?? (() => {});

  return (
    <div className="space-y-6">
      {/* Message text + template selector + AI generator. */}
      <section className="broadcast-section glass rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-secondary">Сообщение</h3>
          {templates.length > 0 && (
            <select
              aria-label="Вставить шаблон"
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value;
                if (value) onTemplateSelect(value);
                e.target.value = "";
              }}
              className="text-xs bg-surface border border-border rounded-lg px-2 py-1 text-text-muted outline-none focus:border-border-focus"
            >
              <option value="">Вставить шаблон...</option>
              {templates.map((template) => (
                <option key={template.id} value={template.text}>
                  {template.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <AutoGrowTextarea
          value={message}
          onChange={onMessageChange}
          placeholder="Текст сообщения..."
          aria-label="Текст сообщения рассылки"
        />

        <div className="flex flex-wrap items-center gap-3">
          <AIGeneratorButton pending={ai.pending} onClick={ai.onClick} />
          {ai.error && (
            <p
              role="alert"
              className="flex-1 min-w-0 text-xs text-error whitespace-pre-wrap break-words"
            >
              {ai.error}
            </p>
          )}
        </div>
      </section>

      {/* Attachment uploader. */}
      <section className="broadcast-section glass rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary">Вложение</h3>
        <AttachmentUploader
          attachment={attachment}
          onSelect={onAttachmentSelect}
          onReject={handleReject}
          onRemove={onAttachmentRemove}
          uploadError={uploadError}
          onRetry={onAttachmentRetry}
        />
      </section>

      {/* Progress block. Rendered only when a broadcast event has arrived. */}
      {progress && (
        <section className="glass rounded-xl p-6 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Прогресс</span>
            <span className="text-text font-medium">
              {progress.done}/{progress.total}
            </span>
          </div>
          <div
            className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
          >
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {results.length > 0 && (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {results.slice(-10).map((row, i) => (
                <div
                  key={`${row.phone}-${i}`}
                  className="flex justify-between text-xs"
                >
                  <span className="text-text-muted">{row.phone}</span>
                  <span
                    className={`inline-flex items-center gap-1.5 ${
                      row.status === "sent"
                        ? "text-success"
                        : row.status === "not_found"
                          ? "text-warning"
                          : "text-error"
                    }`}
                  >
                    {row.status === "sent" ? (
                      <Check
                        className="h-3.5 w-3.5"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                    ) : row.status === "not_found" ? (
                      <CircleHelp
                        className="h-3.5 w-3.5"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                    ) : (
                      <X
                        className="h-3.5 w-3.5"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                    )}
                    {row.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Start + Schedule — must remain in the central column on both layouts. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onStart}
          disabled={startDisabled}
          className="flex-1 py-3.5 bg-accent hover:bg-accent-hover text-bg font-semibold rounded-lg transition-all duration-200 hover:shadow-glow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <span className="inline-flex items-center justify-center gap-2">
            <Send className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
            {broadcasting
              ? `Рассылка... ${progressPct}%`
              : "Начать рассылку"}
          </span>
        </button>
        {onSchedule && (
          <button
            type="button"
            onClick={onSchedule}
            disabled={localBlocked || broadcasting || !canStart}
            className="py-3.5 px-5 border border-accent text-accent hover:bg-accent/10 font-semibold rounded-lg transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
            title="Запланировать отложенную отправку"
          >
            <span className="inline-flex items-center justify-center gap-2">
              <CalendarClock className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
              Запланировать
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

export default MessageBlock;
