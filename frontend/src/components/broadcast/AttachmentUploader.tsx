"use client";

/**
 * `Attachment_Uploader` — leaf component for selecting a single attachment file
 * for the broadcast Message_Block.
 *
 * Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.9
 *
 * Behaviour summary (see `design.md` → "Attachment_Uploader"):
 *  - native `<input type="file">` without `accept` (any MIME, requirement 3.2);
 *  - on file selection: `file.size > maxBytes` → `onReject({ kind: "too_large", ... })`,
 *    otherwise → `onSelect(file)` (requirement 3.6);
 *  - while a file is selected, shows the file name, formatted size (KiB/MiB)
 *    and a ✕ button that calls `onRemove` (requirements 3.4, 3.5);
 *  - when `uploadError` is present, renders an inline error message and a
 *    "Повторить" button (calls `onRetry`, if provided) without resetting the
 *    selected attachment (requirement 3.9).
 */

import { useRef } from "react";
import { Paperclip, RotateCw, Upload, X } from "lucide-react";

import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentError,
  type AttachmentState,
} from "./types";

export interface AttachmentUploaderProps {
  /** Current attachment slot state owned by `Broadcast_Page`. */
  attachment: AttachmentState;
  /** Called when the user picks a file that passes the size validation. */
  onSelect: (file: File) => void;
  /** Called when the user picks a file that fails the size validation. */
  onReject: (reason: AttachmentError) => void;
  /** Called when the user clears the selected attachment via the ✕ button. */
  onRemove: () => void;
  /**
   * Last upload error reported by the parent after a failed send attempt.
   * When non-null, the inline error and Retry button are rendered without
   * dropping the selected file.
   */
  uploadError: string | null;
  /**
   * Optional retry callback wired by the parent to re-trigger `startBroadcast`.
   * If omitted, the Retry button is hidden even when `uploadError` is set.
   */
  onRetry?: () => void;
  /** Maximum allowed file size in bytes. Defaults to `ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
}

/**
 * Format a byte count using binary units (KiB/MiB). Bytes below 1024 are
 * shown as bytes; below 1 MiB — as KiB; otherwise as MiB. Two fractional
 * digits are kept for KiB/MiB to be precise enough for the 50 MB limit.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 Б";
  if (bytes < 1024) return `${bytes} Б`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 100 ? 0 : 1)} КиБ`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 100 ? 0 : 1)} МиБ`;
}

export function AttachmentUploader({
  attachment,
  onSelect,
  onReject,
  onRemove,
  uploadError,
  onRetry,
  maxBytes = ATTACHMENT_MAX_BYTES,
}: AttachmentUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input value so picking the same file twice in a row still
    // fires `onChange`. We do this regardless of validation outcome.
    event.target.value = "";
    if (!file) return;
    if (file.size > maxBytes) {
      onReject({ kind: "too_large", sizeBytes: file.size, maxBytes });
      return;
    }
    onSelect(file);
  }

  const maxBytesLabel = formatBytes(maxBytes);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {attachment.kind === "none" ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-xl text-sm text-text-secondary hover:border-border-focus transition-colors"
        >
          <Upload className="h-4 w-4 text-accent-light" strokeWidth={2} />
          Выбрать файл
        </button>
      ) : (
        <div className="flex items-center gap-3 px-3 py-2 bg-bg-elevated border border-border rounded-xl">
          <Paperclip
            className="h-4 w-4 shrink-0 text-accent-light"
            strokeWidth={2}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-sm text-text"
              title={attachment.file.name}
            >
              {attachment.file.name}
            </div>
            <div className="text-xs text-text-muted">
              {formatBytes(attachment.sizeBytes)}
            </div>
          </div>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Удалить вложение"
            className="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-error hover:bg-error-bg/40 transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}

      <p className="text-xs text-text-muted">
        Максимальный размер файла: {maxBytesLabel}.
      </p>

      {uploadError && (
        <div className="flex items-start gap-3 rounded-xl border border-error/30 bg-error-bg/40 p-3 text-xs text-error">
          <span className="flex-1 whitespace-pre-wrap break-words">
            {uploadError}
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-error/40 bg-surface px-2.5 py-1 text-xs text-text-secondary hover:border-border-focus transition-colors"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Повторить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default AttachmentUploader;
