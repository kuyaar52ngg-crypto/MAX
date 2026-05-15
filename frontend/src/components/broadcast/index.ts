/**
 * Barrel re-exports for the broadcast component module.
 *
 * Consumers can import shared broadcast types and constants without
 * depending on the internal file layout, e.g.:
 *
 *   import { AttachmentState, ATTACHMENT_MAX_BYTES } from "@/components/broadcast";
 */

export type {
  AttachmentState,
  AttachmentError,
  AIGenerateRequest,
  AIGenerateResponse,
  AIGenerateError,
  ResultRow,
  ProgressEvent,
} from "./types";

export {
  ATTACHMENT_MAX_BYTES,
  TEXTAREA_MIN_LINES,
  TEXTAREA_MAX_LINES,
  PREVIEW_RECIPIENT_LIMIT,
  OLLAMA_TIMEOUT_MS,
  OLLAMA_DEFAULT_MODEL,
} from "./types";

export { RecipientsBlock } from "./RecipientsBlock";
export type { RecipientsBlockProps } from "./RecipientsBlock";

export { AutoGrowTextarea } from "./AutoGrowTextarea";
export type { AutoGrowTextareaProps } from "./AutoGrowTextarea";

export { AttachmentUploader } from "./AttachmentUploader";
export type { AttachmentUploaderProps } from "./AttachmentUploader";

export { AIGeneratorButton } from "./AIGeneratorButton";
export type { AIGeneratorButtonProps } from "./AIGeneratorButton";

export { PreviewAccordion } from "./PreviewAccordion";
export type { PreviewAccordionProps } from "./PreviewAccordion";

export { SettingsBlock } from "./SettingsBlock";
export type { SettingsBlockProps } from "./SettingsBlock";

export { MessageBlock } from "./MessageBlock";
export type { MessageBlockProps } from "./MessageBlock";
