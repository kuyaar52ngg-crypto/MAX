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
 * Anti-ban integration (task 25.2 / Requirements 5.1, 5.6, 6.1, 6.6):
 *   - the centre-column "Начать рассылку" button no longer fires the
 *     POST to Flask directly; it builds the multipart `FormData` payload,
 *     stashes it into `pendingFormData`, and opens `<PreFlightModal>`;
 *   - on confirm, `useBulkOperation("broadcast").start()` issues the POST
 *     to `/api/broadcast` and owns the SSE lifecycle (heartbeat reset,
 *     `{finished:true}` auto-reset, watchdog timeout — see
 *     `useBulkOperation.ts`);
 *   - `<StopButton>` next to the progress block calls
 *     `useBulkOperation.stop()` which POSTs to `/api/bulk-operation/stop`
 *     with the current `operation_run_id`.
 *
 * The legacy local SSE setup, the inline `EventSource` ref and the
 * `broadcasting` boolean state were replaced by the hook's `active`
 * field. Per-recipient and finalize writes to the Next.js Prisma store
 * are kept intact; they're now driven by an effect that watches
 * `bulkOp.progress` and `bulkOp.active`.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.6, 3.3, 3.7, 3.8,
 * 3.9, 4.5, 4.6, 4.7, 4.8, 4.9, 9.1, 9.2, 9.3, 9.4
 *   plus (this task) 5.1, 5.6, 6.1, 6.6
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Megaphone } from "lucide-react";

import { apiGet, getFlaskHeaders, nxGet, nxPost } from "@/lib/api";
import { requestAiText } from "@/lib/ai/client";
import { buildMarketerSystemPrompt } from "@/lib/ai/marketer-prompt";
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
import { PreFlightModal } from "@/components/anti-ban/PreFlightModal";
import { StopButton } from "@/components/anti-ban/StopButton";
import { useBulkOperation } from "@/lib/hooks/useBulkOperation";
import {
  type AntiBanConfig,
  DEFAULT_ANTI_BAN_CONFIG,
} from "@/lib/anti-ban";

interface UploadContactsResponse {
  phones: string[];
  contacts: BroadcastContact[];
  fields: string[];
  count: number;
  warnings?: string[];
}

/**
 * Pending broadcast metadata stashed between the "Начать рассылку" click
 * and the user's confirmation in `<PreFlightModal>`. We keep the FormData
 * (multipart payload to `/api/broadcast`) plus the freshly created
 * `broadcast_id` (Next.js Prisma row) so the post-confirm SSE handler can
 * route per-recipient updates to `/api/broadcasts/:id/recipients`.
 */
interface PendingBroadcast {
  formData: FormData;
  broadcastId: number;
  total: number;
}

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

  // ── Anti-ban / pre-flight state (Requirements 5.1, 5.6, 6.1, 6.6) ────
  const [antiBanConfig, setAntiBanConfig] = useState<AntiBanConfig>(
    DEFAULT_ANTI_BAN_CONFIG,
  );
  const [preflightOpen, setPreflightOpen] = useState<boolean>(false);
  const [pendingBroadcast, setPendingBroadcast] =
    useState<PendingBroadcast | null>(null);
  const bulkOp = useBulkOperation("broadcast");

  // ── Refs for resources that live across renders ───────────────────────
  const aiAbortRef = useRef<AbortController | null>(null);
  const broadcastIdRef = useRef<number | null>(null);
  // Дедуп: SSE может прислать события с одинаковым `phone` повторно
  // (например, при ретрае). В Next.js пишем только первое попадание,
  // чтобы не плодить дубли в `Recipient`.
  const seenRecipientsRef = useRef<Set<string>>(new Set());
  const finalizedRunsRef = useRef<Set<number>>(new Set());

  // ── Initial fetches ───────────────────────────────────────────────────
  useEffect(() => {
    nxGet<Template[]>("/api/templates")
      .then((res) => setTemplates(Array.isArray(res) ? res : []))
      .catch(() => {});
    apiGet<AntiBanConfig>("/api/anti-ban-config")
      .then((cfg) => setAntiBanConfig(cfg))
      .catch(() => {
        // Falls back to defaults so the modal can still compute ETA/risk.
        setAntiBanConfig(DEFAULT_ANTI_BAN_CONFIG);
      });
  }, []);

  // ── Single unmount cleanup ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (aiAbortRef.current) {
        aiAbortRef.current.abort();
        aiAbortRef.current = null;
      }
    };
  }, []);

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
      const headers = await getFlaskHeaders(false);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000"}/api/upload-contacts`,
        { method: "POST", headers, body: fd },
      );
      if (!res.ok) return;
      const data = (await res.json()) as UploadContactsResponse;
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

  // ── Broadcast launch — handler called from MessageBlock's start button.
  // Builds the multipart payload (Requirement 6.1: pre-flight before POST)
  // and opens `<PreFlightModal>`. The actual POST + SSE happens in
  // `confirmBroadcast` below.
  async function startBroadcast() {
    if (!contacts.length) return;
    if (bulkOp.active) return;
    if (message.trim() === "" && attachment.kind === "none") return;

    setUploadError(null);
    setResults([]);
    setProgress(null);
    seenRecipientsRef.current = new Set();

    try {
      const file = attachment.kind === "selected" ? attachment.file : null;

      // Per-recipient personalisation — keep the same shape `bot.broadcast`
      // expects on the server (each contact carries an optional `_message`).
      const hasPersonalized = Object.keys(personalizedMessages).length > 0;
      const contactsToSend = hasPersonalized
        ? contacts.map((c) => {
            const personal = personalizedMessages[c.phone];
            return personal ? { ...c, _message: personal } : c;
          })
        : contacts;

      // 1. Создаём запись в Prisma `Broadcast` — нам нужен `id`, чтобы
      //    обновлять `Recipient` по мере поступления SSE-событий.
      const broadcast = await nxPost<{ id: number }>("/api/broadcasts", {
        message: message.trim(),
        total: contacts.length,
        file_url: null,
        file_name: file ? file.name : null,
        use_typing: useTyping,
      });
      broadcastIdRef.current = broadcast.id;

      // 2. Собираем multipart `FormData` под `/api/broadcast` — формат
      //    эквивалентен helper-у `postBroadcast`, но передадим его в
      //    `useBulkOperation.start({ formData })`, чтобы хук сам владел
      //    POST-ом и SSE.
      const fd = new FormData();
      fd.append("broadcast_id", String(broadcast.id));
      fd.append("message", message.trim());
      fd.append("contacts", JSON.stringify(contactsToSend));
      fd.append("phones", JSON.stringify(contactsToSend.map((c) => c.phone)));
      fd.append("delay", String(delay));
      fd.append("use_typing", useTyping ? "1" : "0");
      if (file) {
        fd.append("file", file, file.name);
      }

      setPendingBroadcast({
        formData: fd,
        broadcastId: broadcast.id,
        total: contacts.length,
      });
      setPreflightOpen(true);
    } catch (err: unknown) {
      const messageText =
        err instanceof Error
          ? err.message
          : "Не удалось подготовить рассылку";
      setUploadError(messageText);
    }
  }

  // ── PreFlightModal handlers (Requirement 6.1, 6.6) ───────────────────
  async function handlePreflightConfirm() {
    if (!pendingBroadcast) {
      setPreflightOpen(false);
      return;
    }
    setPreflightOpen(false);
    try {
      // multipart/form-data: Content-Type выставит браузер (boundary).
      const headers = await getFlaskHeaders(false);
      // `getFlaskHeaders(false)` уже снимает Content-Type, но JWT/GREEN-API
      // заголовки нужны Flask-у.
      await bulkOp.start(null, {
        formData: pendingBroadcast.formData,
        headers: headers as Record<string, string>,
      });
    } catch (err) {
      // useBulkOperation сам пишет в свой `error`, но защитимся на случай
      // отказа `getFlaskHeaders` (нет креденшелов).
      setUploadError(
        err instanceof Error
          ? err.message
          : "Не удалось запустить рассылку",
      );
    } finally {
      setPendingBroadcast(null);
    }
  }

  function handlePreflightCancel() {
    // Requirement 6.6: закрыть модалку и не отправлять запрос.
    setPreflightOpen(false);
    setPendingBroadcast(null);
  }

  // ── SSE event forwarding to Next.js ──────────────────────────────────
  // `useBulkOperation` владеет EventSource-ом и обновляет `bulkOp.progress`
  // на каждом событии; здесь мы дублируем «полезную нагрузку» в
  // локальные `progress`/`results` (для существующего UI MessageBlock) и
  // отправляем per-recipient запись в Prisma.
  useEffect(() => {
    const data = bulkOp.progress;
    if (!data) return;

    // Сохраняем последний снимок как ProgressEvent для MessageBlock —
    // структура ключей у обоих типов совместима.
    setProgress(data as unknown as ProgressEvent);

    const phone = typeof data.phone === "string" ? data.phone : null;
    const status = data.status as ResultRow["status"] | undefined;
    const broadcastId = broadcastIdRef.current;
    if (phone && status && !seenRecipientsRef.current.has(phone)) {
      seenRecipientsRef.current.add(phone);
      const renderedMessage =
        typeof data.rendered_message === "string"
          ? data.rendered_message
          : undefined;
      setResults((prev) => [
        ...prev,
        { phone, status, rendered_message: renderedMessage },
      ]);
      if (broadcastId) {
        nxPost(`/api/broadcasts/${broadcastId}/recipients`, {
          phone,
          status,
          message_id: data.message_id,
          rendered_message: renderedMessage,
          contact_data: data.contact_data,
        }).catch(() => {});
      }
    }
  }, [bulkOp.progress]);

  // Финализация: когда `bulkOp.active` уходит в `false` И у нас был старт
  // (есть `broadcastIdRef.current`), пишем итоги в Prisma. Дедуп по
  // `finalizedRunsRef` гарантирует один запрос на запуск даже при
  // пере-рендерах.
  useEffect(() => {
    if (bulkOp.active) return;
    const broadcastId = broadcastIdRef.current;
    if (!broadcastId) return;
    if (finalizedRunsRef.current.has(broadcastId)) return;
    // Финализируем только если действительно был прогресс (иначе это
    // первая отрисовка ещё до старта).
    const data = bulkOp.progress;
    if (!data) return;

    finalizedRunsRef.current.add(broadcastId);
    nxPost(`/api/broadcasts/${broadcastId}/finish`, {
      sent: typeof data.sent === "number" ? data.sent : 0,
      not_found: typeof data.not_found === "number" ? data.not_found : 0,
      failed: typeof data.failed === "number" ? data.failed : 0,
    }).catch(() => {});
  }, [bulkOp.active, bulkOp.progress]);

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
  // inside `MessageBlock` and the `bulkOp.active` flag is AND-ed there too.
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

  // Total used by `<PreFlightModal>` — берём из подготовленного payload-а,
  // чтобы число совпадало с тем, что уйдёт на сервер, даже если
  // пользователь успеет отредактировать список перед подтверждением.
  const preflightTotal = pendingBroadcast?.total ?? contacts.length;

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

      {bulkOp.error && (
        <div
          role="alert"
          className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error"
        >
          {bulkOp.error}
        </div>
      )}

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
        <div className="space-y-3">
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
            broadcasting={bulkOp.active}
            progressPct={progressPct}
            onStart={startBroadcast}
            progress={progress}
            results={results}
          />
          {bulkOp.active && (
            <div className="flex justify-end">
              <StopButton
                onStop={bulkOp.stop}
                active={bulkOp.active}
                label="Остановить рассылку"
              />
            </div>
          )}
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

      <PreFlightModal
        open={preflightOpen}
        kind="broadcast"
        total={preflightTotal}
        config={antiBanConfig}
        onConfirm={handlePreflightConfirm}
        onCancel={handlePreflightCancel}
      />
    </div>
  );
}
