/**
 * Helper-загрузчик рассылки.
 *
 * Конструирует multipart/form-data payload и отправляет его на Flask-эндпоинт
 * `POST /api/broadcast` через существующий `apiUpload` (см. `frontend/src/lib/api.ts`).
 *
 * Поле `file` добавляется только при наличии вложения; остальные поля пишутся всегда:
 * `broadcast_id`, `message`, `contacts` (JSON), `phones` (JSON), `delay`, `use_typing`
 * (`"0"`/`"1"`).
 */

import { apiUpload } from "@/lib/api";
import type { BroadcastContact } from "@/lib/types";

export interface PostBroadcastPayload {
  broadcast_id: number;
  message: string;
  contacts: BroadcastContact[];
  delay: number;
  use_typing: boolean;
  attachment: File | null;
}

export interface PostBroadcastResponse {
  broadcast_id: number;
  total: number;
}

export async function postBroadcast(
  payload: PostBroadcastPayload,
): Promise<PostBroadcastResponse> {
  const fd = new FormData();
  fd.append("broadcast_id", String(payload.broadcast_id));
  fd.append("message", payload.message);
  fd.append("contacts", JSON.stringify(payload.contacts));
  fd.append("phones", JSON.stringify(payload.contacts.map((c) => c.phone)));
  fd.append("delay", String(payload.delay));
  fd.append("use_typing", payload.use_typing ? "1" : "0");
  if (payload.attachment) {
    fd.append("file", payload.attachment, payload.attachment.name);
  }
  return apiUpload<PostBroadcastResponse>("/api/broadcast", fd);
}
