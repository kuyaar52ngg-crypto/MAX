"use client";

/**
 * Broadcast_Page (`/dashboard/broadcast`).
 *
 * Three-column layout (Requirement 1) wiring together the leaf/composite
 * components implemented in tasks 6.x–8.1:
 *
 *   - left  column : `Recipients_Block` → `Settings_Block`
 *   - centre column: `Message_Block` (text, attachment, AI button,
 *                    "Начать рассылку" + progress)
 *   - right column : `Preview_Accordion`
 *
 * State is owned here and threaded into the blocks as props. AI generation
 * goes through `requestAiText` (task 3.1) — on error we set `aiError` and
 * leave the message text untouched (Requirement 4.8). Broadcast launches
 * via `postBroadcast` (task 8.1) and SSE progress is consumed through a
 * direct `EventSource` stored in a ref so the unmount-cleanup effect can
 * close it exactly once (Requirement 9.4).
 *
 * The legacy local-render helpers (`renderPreviewMessage`, `extractVariables`,
 * `countRandomBlocks`) and URL/file-name fields have been removed: the
 * message text is forwarded to the backend as-is (Requirement 4.9).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.6, 3.3, 3.7, 3.8,
 * 3.9, 4.5, 4.6, 4.7, 4.8, 4.9, 9.1, 9.2, 9.3, 9.4
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Megaphone } from "lucide-react";

import { apiUpload, nxGet, nxPost } from "@/lib/api";
import { requestAiText } from "@/lib/ai/client";
import { buildMarketerSystemPrompt } from "@/lib/ai/marketer-prompt";
import { postBroadcast } from "@/lib/broadcast/start";
import type { BroadcastContact, Template } from "@/lib/types";
import {
  MessageBlock,
  PreviewAccordion,
  RecipientsBlock,
  SettingsBlock,
  type AttachmentError,
  type AttachmentState,
  type ProgressEvent,
  type ResultRow,
} from "@/components/broadcast";

interface UploadContactsResponse {
  phones: string[];
  contacts: BroadcastContact[];
  fields: string[];
  count: number;
  warnings?: string[];
}

const FLASK_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export default function BroadcastPage() {
  // ── Canonical state (names per task 10.1) ────────────────────────────
  const [contacts, setContacts] = useState<BroadcastContact[]>([]);
  const [message, setMessage] = useState<string>("");
  const [delay, setDelay] = useState<number>(3);
  const [useTyping, setUseTyping] = useState<boolean>(false);
  const [attachment, setAttachment] = useState<AttachmentState>({ kind: "none" });
  const [aiPending, setAiPending] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [broadcasting, setBroadcasting] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [previewExpanded, setPreviewExpanded] = useState<boolean>(true); // Requirement 2.6

  // Map<phone, personalText> — заполняется кнопкой «Использовать AI», когда
  // в списке есть получатели. Каждому отправляется свой уникальный текст,
  // подмешиваемый к контакту через поле `_message` при запуске рассылки.
  // Сбрасывается, когда пользователь правит textarea вручную или меняет
  // список получателей.
  const [personalizedMessages, setPersonalizedMessages] = useState<
    Record<string, string>
  >({});

  // ── Auxiliary state (templates and CSV warnings) ─────────────────────
  const [templates, setTemplates] = useState<Template[]>([]);
  const [csvWarnings, setCsvWarnings] = useState<string[]>([]);

  // ── Refs for resources that live across renders ───────────────────────
  const sseRef = useRef<EventSource | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // ── Initial template fetch ────────────────────────────────────────────
  useEffect(() => {
    nxGet<Template[]>("/api/templates")
      .then((res) => setTemplates(Array.isArray(res) ? res : []))
      .catch(() => {});
  }, []);

  // ── Single unmount cleanup (Requirement 9.4) ──────────────────────────
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      if (aiAbortRef.current) {
        aiAbortRef.current.abort();
        aiAbortRef.current = null;
      }
    };
  }, []);

  function closeSse() {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }

  // Pure setter wrapper: ручное редактирование textarea сбрасывает пакет
  // персональных сообщений, чтобы UI не показывал устаревшее превью.
  function handleMessageChange(value: string) {
    setMessage(value);
    if (Object.keys(personalizedMessages).length > 0) {
      setPersonalizedMessages({});
    }
  }

  // ── Recipients handlers ──────────────────────────────────────────────
  function clearPersonalizedIfAny() {
    if (Object.keys(personalizedMessages).length > 0) {
      setPersonalizedMessages({});
    }
  }

  function handleAddPhone(phone: string) {
    setContacts((prev) =>
      prev.some((c) => c.phone === phone) ? prev : [...prev, { phone }],
    );
    clearPersonalizedIfAny();
  }

  function handleRemovePhone(index: number) {
    setContacts((prev) => prev.filter((_, i) => i !== index));
    clearPersonalizedIfAny();
  }

  async function handleCsvUpload(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await apiUpload<UploadContactsResponse>(
        "/api/upload-contacts",
        fd,
      );
      if (Array.isArray(data.contacts)) {
        setContacts((prev) => {
          const map = new Map(prev.map((contact) => [contact.phone, contact]));
          data.contacts.forEach((contact) => map.set(contact.phone, contact));
          return Array.from(map.values());
        });
      } else if (data.phones) {
        setContacts((prev) => {
          const map = new Map(prev.map((contact) => [contact.phone, contact]));
          data.phones.forEach((phone) => map.set(phone, { phone }));
          return Array.from(map.values());
        });
      }
      setCsvWarnings(data.warnings || []);
      clearPersonalizedIfAny();
    } catch {
      /* surfaced through inline warnings; CSV step is best-effort */
    }
  }

  // ── Settings handler ─────────────────────────────────────────────────
  function handleSettingsChange(
    patch: Partial<{ delay: number; useTyping: boolean }>,
  ) {
    if (patch.delay !== undefined) setDelay(patch.delay);
    if (patch.useTyping !== undefined) setUseTyping(patch.useTyping);
  }

  // ── Attachment handlers (Requirement 3.x) ────────────────────────────
  function handleAttachmentSelect(file: File) {
    setAttachment({ kind: "selected", file, sizeBytes: file.size });
    setUploadError(null);
  }

  function handleAttachmentRemove() {
    setAttachment({ kind: "none" });
    setUploadError(null);
  }

  function handleAttachmentReject(reason: AttachmentError) {
    if (reason.kind === "too_large") {
      const maxMb = Math.round(reason.maxBytes / (1024 * 1024));
      setUploadError(`Размер файла превышает ${maxMb} МБ`);
    }
  }

  // ── AI generation (Requirements 4.5–4.8) ─────────────────────────────
  /**
   * Build a per-recipient user prompt: includes the user's brief (if any)
   * plus every known field of the contact (phone, name and any extra CSV
   * columns) so the model can personalize the message.
   */
  function buildPerContactPrompt(
    brief: string,
    contact: BroadcastContact,
    index: number,
    total: number,
  ): string {
    const knownFields = Object.entries(contact)
      .filter(([k, v]) => v && k !== "phone" && !k.startsWith("_"))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    const lines: string[] = [];
    lines.push(
      brief.trim()
        ? `Тема рассылки: ${brief.trim()}`
        : "Сгенерируй маркетинговый текст для рассылки.",
    );
    lines.push("");
    lines.push(
      `Это сообщение №${index + 1} из ${total}. Каждое сообщение ОБЯЗАТЕЛЬНО должно отличаться от остальных по структуре, формулировкам и стилю.`,
    );
    lines.push(
      "Используй разные приветствия, разный порядок аргументов, разную длину предложений.",
    );
    lines.push(
      "Не используй обращение по номеру телефона. Если известно имя — обратись по имени.",
    );
    lines.push(
      "Верни ТОЛЬКО текст сообщения, без пояснений.",
    );
    if (knownFields) {
      lines.push("");
      lines.push("Данные получателя:");
      lines.push(knownFields);
    } else {
      lines.push("");
      lines.push("Данных о получателе нет — сделай текст универсальным, но уникальным по формулировке.");
    }
    return lines.join("\n");
  }

  async function handleAiClick() {
    // Abort any in-flight request — only one AI session at a time.
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
      aiAbortRef.current = null;
    }
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiPending(true);
    setAiError(null);

    try {
      // Branch A — no recipients yet: keep the original behaviour and just
      // generate a single shared text into the textarea.
      if (contacts.length === 0) {
        const text = await requestAiText(message, ctrl.signal);
        setMessage(text);
        setPersonalizedMessages({});
        return;
      }

      // Branch B — recipients present: generate one unique message PER
      // recipient in parallel, store the map, and surface the first one in
      // the textarea so the user has something to tweak if they want.
      const systemPrompt = buildMarketerSystemPrompt(message);
      const settled = await Promise.allSettled(
        contacts.map((contact, index) =>
          requestAiText(
            buildPerContactPrompt(message, contact, index, contacts.length),
            ctrl.signal,
            systemPrompt,
          ).then((text) => ({ phone: contact.phone, text: text.trim() })),
        ),
      );

      // If the user aborted, bail without touching state.
      if (ctrl.signal.aborted) return;

      const map: Record<string, string> = {};
      const failures: string[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.text) {
          map[result.value.phone] = result.value.text;
        } else if (result.status === "rejected") {
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : "ошибка генерации";
          failures.push(reason);
        }
      }

      if (Object.keys(map).length === 0) {
        const detail = failures[0] ?? "Не удалось сгенерировать тексты";
        setAiError(detail);
        return;
      }

      setPersonalizedMessages(map);
      // Mirror the first generated text into the textarea as the visible
      // example. Manual edits will reset `personalizedMessages` via
      // `handleMessageChange`, so the user opt-out is one keystroke away.
      const firstPhone = contacts.find((c) => map[c.phone])?.phone;
      if (firstPhone) {
        setMessage(map[firstPhone]);
      }

      if (failures.length > 0) {
        setAiError(
          `Сгенерировано ${Object.keys(map).length} из ${contacts.length}. Часть запросов не удалась: ${failures[0]}`,
        );
      }
    } catch (err: unknown) {
      const isAbort =
        err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        const messageText =
          err instanceof Error
            ? err.message
            : "Не удалось сгенерировать текст";
        setAiError(messageText);
        // Requirement 4.8: do NOT change `message` on failure.
      }
    } finally {
      setAiPending(false);
      if (aiAbortRef.current === ctrl) aiAbortRef.current = null;
    }
  }

  // ── Broadcast launch (Requirements 9.1, 9.2, 3.7, 3.8) ───────────────
  async function startBroadcast() {
    if (!contacts.length) return;
    if (broadcasting) return;
    if (message.trim() === "" && attachment.kind === "none") return;

    setBroadcasting(true);
    setUploadError(null);
    setResults([]);
    setProgress(null);

    try {
      const file =
        attachment.kind === "selected" ? attachment.file : null;

      // If the user generated per-recipient texts via the AI button, attach
      // them to the contact records under `_message` — `bot.broadcast` reads
      // that field and uses it as the per-recipient template, falling back
      // to the shared `message` when missing.
      const hasPersonalized = Object.keys(personalizedMessages).length > 0;
      const contactsToSend = hasPersonalized
        ? contacts.map((c) => {
            const personal = personalizedMessages[c.phone];
            return personal ? { ...c, _message: personal } : c;
          })
        : contacts;

      const broadcast = await nxPost<{ id: number }>("/api/broadcasts", {
        message: message.trim(),
        total: contacts.length,
        file_url: null,
        file_name: file ? file.name : null,
        use_typing: useTyping,
      });

      await postBroadcast({
        broadcast_id: broadcast.id,
        message: message.trim(),
        contacts: contactsToSend,
        delay,
        use_typing: useTyping,
        attachment: file,
      });

      // If a previous SSE connection is somehow still open, close it.
      closeSse();

      const source = new EventSource(`${FLASK_BASE}/api/broadcast/progress`);
      sseRef.current = source;

      source.onmessage = (event) => {
        let data: ProgressEvent | null = null;
        try {
          data = JSON.parse(event.data) as ProgressEvent;
        } catch {
          return;
        }
        if (!data) return;
        setProgress(data);

        if (data.phone && data.status) {
          const row: ResultRow = {
            phone: data.phone,
            status: data.status,
            rendered_message: data.rendered_message,
          };
          setResults((prev) => [...prev, row]);
          nxPost(`/api/broadcasts/${broadcast.id}/recipients`, {
            phone: data.phone,
            status: data.status,
            message_id: data.message_id,
            rendered_message: data.rendered_message,
            contact_data: data.contact_data,
          }).catch(() => {});
        }

        if (data.finished) {
          nxPost(`/api/broadcasts/${broadcast.id}/finish`, {
            sent: data.sent || 0,
            not_found: data.not_found || 0,
            failed: data.failed || 0,
          }).catch(() => {});
          setBroadcasting(false);
          closeSse();
        }
      };

      source.onerror = () => {
        setBroadcasting(false);
        closeSse();
      };
    } catch (err: unknown) {
      const messageText =
        err instanceof Error
          ? err.message
          : "Не удалось запустить рассылку";
      setUploadError(messageText);
      setBroadcasting(false);
    }
  }

  function handleAttachmentRetry() {
    // Re-attempt the broadcast with the same attachment (Requirement 3.9).
    startBroadcast();
  }

  // ── Derived values ───────────────────────────────────────────────────
  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  // Parent-level gate: at least one recipient must be configured. The
  // "message empty AND attachment none → disabled" rule is applied locally
  // inside `MessageBlock` and the `broadcasting` flag is AND-ed there too.
  const canStart = contacts.length > 0;

  // Превью использует персональные сообщения, если они есть: каждый
  // контакт получает свой текст через перегруженное поле `_message`,
  // которое `Preview_Accordion` достаёт через `contacts[i]._message`.
  const previewContacts = useMemo(() => {
    if (Object.keys(personalizedMessages).length === 0) return contacts;
    return contacts.map((c) => {
      const personal = personalizedMessages[c.phone];
      return personal ? { ...c, _message: personal } : c;
    });
  }, [contacts, personalizedMessages]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <Megaphone className="h-5 w-5" strokeWidth={2.2} aria-hidden="true" />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          Рассылка
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Массовая отправка сообщений
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)_minmax(280px,400px)] gap-6">
        {/* Left column — Recipients + Settings */}
        <div className="flex flex-col gap-6">
          <RecipientsBlock
            contacts={contacts}
            onAdd={handleAddPhone}
            onRemove={handleRemovePhone}
            onCsvUpload={handleCsvUpload}
            csvWarnings={csvWarnings}
          />
          <SettingsBlock
            delay={delay}
            useTyping={useTyping}
            onChange={handleSettingsChange}
          />
        </div>

        {/* Centre column — Message + start + progress */}
        <div>
          <MessageBlock
            message={message}
            onMessageChange={handleMessageChange}
            attachment={attachment}
            onAttachmentSelect={handleAttachmentSelect}
            onAttachmentRemove={handleAttachmentRemove}
            onAttachmentReject={handleAttachmentReject}
            onAttachmentRetry={handleAttachmentRetry}
            uploadError={uploadError}
            ai={{
              pending: aiPending,
              error: aiError,
              onClick: handleAiClick,
            }}
            templates={templates}
            onTemplateSelect={(text) => setMessage(text)}
            canStart={canStart}
            broadcasting={broadcasting}
            progressPct={progressPct}
            onStart={startBroadcast}
            progress={progress}
            results={results}
          />
        </div>

        {/* Right column — Preview accordion */}
        <div>
          <PreviewAccordion
            expanded={previewExpanded}
            onToggle={() => setPreviewExpanded((v) => !v)}
            message={message}
            contacts={previewContacts}
          />
        </div>
      </div>
    </div>
  );
}
