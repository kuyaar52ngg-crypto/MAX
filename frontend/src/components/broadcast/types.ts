/**
 * Shared types and constants for the Broadcast page redesign.
 *
 * This module is the single source of truth for the broadcast UI types
 * (`AttachmentState`, `AttachmentError`, AI proxy contracts, progress and
 * result shapes) and for the numeric/string constants used by the
 * `Attachment_Uploader`, `Auto_Grow_Textarea`, `Preview_Accordion` and
 * `Ollama_Proxy` components.
 *
 * Validates: Requirements 3.6, 5.3, 5.4, 6.5, 6.11, 8.4
 */

// ---------------------------------------------------------------------------
// Attachment state
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing the local state of the attachment slot in
 * the Message_Block. Stored in `Broadcast_Page` state.
 */
export type AttachmentState =
  | { kind: "none" }
  | { kind: "selected"; file: File; sizeBytes: number };

/**
 * Discriminated union describing why a file was rejected by
 * `Attachment_Uploader`. Currently only the size check produces a rejection,
 * but the union is left open for future kinds.
 */
export type AttachmentError = {
  kind: "too_large";
  sizeBytes: number;
  maxBytes: number;
};

// ---------------------------------------------------------------------------
// AI proxy contracts (`/api/ai/generate`)
// ---------------------------------------------------------------------------

/** Request body accepted by `Ollama_Proxy`. */
export interface AIGenerateRequest {
  prompt: string;
  system?: string;
}

/** Successful (200) response body returned by `Ollama_Proxy`. */
export interface AIGenerateResponse {
  text: string;
}

/** Error response body returned by `Ollama_Proxy` for any non-2xx status. */
export interface AIGenerateError {
  error: string;
}

// ---------------------------------------------------------------------------
// Broadcast progress / result shapes
// ---------------------------------------------------------------------------

/** Per-recipient row displayed after a broadcast run. */
export interface ResultRow {
  phone: string;
  status: "sent" | "not_found" | "error";
  rendered_message?: string;
}

/**
 * Event payload emitted by the Flask SSE progress endpoint. The fields are
 * optional because the same shape is used both for incremental updates and
 * for the terminal `finished: true` event with aggregated counters.
 */
export interface ProgressEvent {
  done: number;
  total: number;
  phone?: string;
  status?: "sent" | "not_found" | "error";
  message_id?: string;
  rendered_message?: string;
  contact_data?: Record<string, string>;
  broadcast_id?: number;
  sent?: number;
  not_found?: number;
  failed?: number;
  finished?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed attachment size: 50 MB. Validates Requirement 3.6. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/** Minimum visible lines in `Auto_Grow_Textarea`. Validates Requirement 5.3. */
export const TEXTAREA_MIN_LINES = 5;

/** Maximum visible lines in `Auto_Grow_Textarea`. Validates Requirement 5.4. */
export const TEXTAREA_MAX_LINES = 20;

/** Number of recipients shown in the `Preview_Accordion`. */
export const PREVIEW_RECIPIENT_LIMIT = 5;

/** Upstream timeout (ms) for `Ollama_Proxy`. Validates Requirement 6.11. */
export const OLLAMA_TIMEOUT_MS = 60_000;

/** Default Ollama model id used when `OLLAMA_MODEL` is not set. Validates Requirements 6.5 and 8.4. */
export const OLLAMA_DEFAULT_MODEL = "gemma3:27b-cloud";
