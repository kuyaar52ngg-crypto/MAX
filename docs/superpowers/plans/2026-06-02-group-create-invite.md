# Group Create & Invite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add group creation and bulk invite functionality to the Messenger tab using manual input, CSV, and segments.

**Architecture:** Two new modals (CreateGroupModal, InviteModal) share a PhoneCollector sub-component for collecting phone numbers from 3 sources. CreateGroupModal is triggered from the chat sidebar header. InviteModal is triggered from GroupSettingsPanel. All backend endpoints already exist.

**Tech Stack:** Next.js 15, React, TypeScript, TailwindCSS, lucide-react, existing `apiPost`/`apiUpload`/`nxGet` clients, existing `SegmentLoader` component.

---

### Task 1: PhoneCollector Component

**Files:**
- Create: `frontend/src/components/PhoneCollector.tsx`

PhoneCollector is a shared sub-component that provides 3 input modes for collecting phone numbers. Both CreateGroupModal and InviteModal use it.

- [ ] **Step 1: Create PhoneCollector.tsx**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  FileUp,
  Loader2,
  Plus,
  Tag,
  Trash2,
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
      <div className="space-y-3">
        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest">
            Добавить участников
          </label>

          <div className="flex gap-2">
            <textarea
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="Номера через пробел, запятую или с новой строки"
              rows={1}
              className="flex-1 min-w-0 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 resize-none"
            />
            <button
              type="button"
              onClick={addManual}
              disabled={!manualInput.trim()}
              className="px-3 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <div className="flex gap-2">
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
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-xs text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-50"
            >
              {csvLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <FileUp className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              Загрузить CSV
            </button>

            <div className="relative flex-1">
              <button
                type="button"
                onClick={() => setSegPickerOpen((v) => !v)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-xs text-text-secondary hover:border-accent/40 transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5" strokeWidth={2.5} />
                Из сегмента
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${segPickerOpen ? "rotate-180" : ""}`}
                  strokeWidth={2.5}
                />
              </button>
              {segPickerOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setSegPickerOpen(false)}
                  />
                  <div className="absolute left-0 top-full mt-1 z-40 w-full min-w-[200px] rounded-lg border border-border bg-surface shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                    {segLoading ? (
                      <div className="px-3 py-2 text-xs text-text-muted inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                        Загрузка…
                      </div>
                    ) : segments.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-text-muted">
                        Нет сегментов.{" "}
                        <Link
                          href="/dashboard/segments"
                          className="text-accent hover:underline"
                        >
                          Создать →
                        </Link>
                      </div>
                    ) : (
                      segments.map((seg) => (
                        <button
                          key={seg.id}
                          type="button"
                          onClick={() => loadSegment(seg)}
                          disabled={segBusy === seg.id}
                          className="w-full text-left px-3 py-2 hover:bg-bg-elevated transition-colors flex items-center gap-2 text-xs disabled:opacity-50"
                        >
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ background: seg.color }}
                          />
                          <span className="flex-1 min-w-0 truncate text-text">
                            {seg.name}
                          </span>
                          <span className="text-text-muted">
                            {seg.member_count.toLocaleString("ru-RU")}
                          </span>
                          {segBusy === seg.id && (
                            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
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
            <div className="text-[11px] text-error">{csvError}</div>
          )}
          {segError && (
            <div className="text-[11px] text-error">{segError}</div>
          )}
        </div>

        {phones.length > 0 && (
          <div>
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Номера ({phones.length})
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {phones.map((phone) => (
                <span
                  key={phone}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-bg-elevated border border-border rounded-lg text-xs text-text"
                >
                  {phone}
                  <button
                    type="button"
                    onClick={() => removePhone(phone)}
                    className="text-text-muted hover:text-error transition-colors"
                    aria-label={`Удалить ${phone}`}
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/PhoneCollector.tsx
git commit -m "feat(messenger): PhoneCollector shared component for group modals"
```

---

### Task 2: CreateGroupModal Component

**Files:**
- Create: `frontend/src/components/CreateGroupModal.tsx`

- [ ] **Step 1: Create CreateGroupModal.tsx**

```tsx
"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import { PhoneCollector } from "./PhoneCollector";

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (groupId: string, groupName: string) => void;
}

export function CreateGroupModal({
  open,
  onClose,
  onCreated,
}: CreateGroupModalProps) {
  const [name, setName] = useState("");
  const [phones, setPhones] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    group_id: string;
    members: number;
    not_found: string[];
  } | null>(null);

  if (!open) return null;

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName || creating) return;
    setCreating(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<{
        group_id: string;
        name: string;
        members: number;
        not_found: string[];
        message_sent: boolean;
      }>("/api/create-group", {
        name: trimmedName,
        phones,
        message: message.trim() || undefined,
      });
      setResult({
        group_id: res.group_id,
        members: res.members,
        not_found: res.not_found || [],
      });
      onCreated(res.group_id, res.name);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать группу");
    } finally {
      setCreating(false);
    }
  }

  function handleClose() {
    setName("");
    setPhones([]);
    setMessage("");
    setError(null);
    setResult(null);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-bold text-text flex items-center gap-2">
            <Plus className="h-4 w-4" strokeWidth={2} />
            Новая группа
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Название группы *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Клиенты Москва"
              maxLength={100}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25"
            />
          </div>

          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          <div>
            <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Приветственное сообщение
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Опционально: сообщение при создании группы"
              rows={2}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 resize-none"
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
              {error}
            </div>
          )}

          {result && (
            <div className="px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-success text-xs space-y-1">
              <div>Группа создана! ID: {result.group_id}</div>
              <div>Добавлено участников: {result.members}</div>
              {result.not_found.length > 0 && (
                <div className="text-warning">
                  Не найдены: {result.not_found.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs text-text-muted hover:text-text transition-colors"
          >
            {result ? "Закрыть" : "Отмена"}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Создание...
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                Создать группу
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/CreateGroupModal.tsx
git commit -m "feat(messenger): CreateGroupModal component"
```

---

### Task 3: InviteModal Component

**Files:**
- Create: `frontend/src/components/InviteModal.tsx`

- [ ] **Step 1: Create InviteModal.tsx**

```tsx
"use client";

import { useState } from "react";
import { Loader2, UserPlus, X } from "lucide-react";
import { apiPost } from "@/lib/api";
import { PhoneCollector } from "./PhoneCollector";

interface InviteModalProps {
  open: boolean;
  groupId: string;
  onClose: () => void;
  onInvited: () => void;
}

interface InviteResult {
  phone: string;
  success: boolean;
  error?: string;
}

export function InviteModal({
  open,
  groupId,
  onClose,
  onInvited,
}: InviteModalProps) {
  const [phones, setPhones] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResult[] | null>(null);

  if (!open) return null;

  async function handleInvite() {
    if (phones.length === 0 || inviting) return;
    setInviting(true);
    setError(null);
    setResults(null);
    try {
      const res = await apiPost<{ results: InviteResult[] }>(
        `/api/group/${encodeURIComponent(groupId)}/add-bulk`,
        { phones },
      );
      setResults(res.results || []);
      onInvited();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось пригласить участников");
    } finally {
      setInviting(false);
    }
  }

  function handleClose() {
    setPhones([]);
    setError(null);
    setResults(null);
    onClose();
  }

  const successCount = results ? results.filter((r) => r.success).length : 0;
  const failCount = results ? results.filter((r) => !r.success).length : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-bold text-text flex items-center gap-2">
            <UserPlus className="h-4 w-4" strokeWidth={2} />
            Пригласить участников
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <PhoneCollector phones={phones} onPhonesChange={setPhones} />

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
              {error}
            </div>
          )}

          {results && (
            <div className="space-y-2">
              <div className="px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-xs space-y-1">
                <div className="text-success">
                  Добавлено: {successCount} из {results.length}
                </div>
                {failCount > 0 && (
                  <div className="text-warning">
                    Не найдены: {failCount}
                  </div>
                )}
              </div>
              {results.filter((r) => !r.success).length > 0 && (
                <div className="rounded-lg border border-border bg-bg-elevated divide-y divide-border/60 max-h-32 overflow-y-auto">
                  {results
                    .filter((r) => !r.success)
                    .map((r, i) => (
                      <div
                        key={`${r.phone}-${i}`}
                        className="flex items-center justify-between px-3 py-1.5 text-xs"
                      >
                        <span className="text-text">{r.phone}</span>
                        <span className="text-text-muted">
                          {r.error || "Не найден"}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs text-text-muted hover:text-text transition-colors"
          >
            {results ? "Закрыть" : "Отмена"}
          </button>
          <button
            type="button"
            onClick={handleInvite}
            disabled={inviting || phones.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-xs font-bold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {inviting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Приглашение...
              </>
            ) : (
              <>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                Пригласить ({phones.length})
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/InviteModal.tsx
git commit -m "feat(messenger): InviteModal component for bulk group invites"
```

---

### Task 4: Integrate CreateGroupModal into MessengerPage

**Files:**
- Modify: `frontend/src/app/dashboard/messenger/page.tsx`

- [ ] **Step 1: Add imports and state for CreateGroupModal**

In `messenger/page.tsx`, add the import at the top of the file after the existing imports:

```tsx
import { Plus } from "lucide-react";
import { CreateGroupModal } from "@/components/CreateGroupModal";
```

Note: `Plus` may already be imported from lucide-react. If so, skip the `Plus` import.

Add state inside `MessengerPage` component, after the existing state declarations (after `const [showInfo, setShowInfo] = useState(false);`):

```tsx
const [showCreateGroup, setShowCreateGroup] = useState(false);
```

- [ ] **Step 2: Add Plus button in sidebar header**

In the sidebar header section, add a Plus button. Find the header div that contains the "Чаты" h2 and the RotateCw refresh button. Add the Plus button between them:

Find this code (around line 401-414):
```tsx
<div className="flex items-center justify-between px-4 py-3 border-b border-border">
  <h2 className="text-sm font-bold text-text flex items-center gap-2">
    <MessageCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
    Чаты
  </h2>
  <button
    onClick={() => loadChats()}
    ...
  >
    <RotateCw ... />
  </button>
</div>
```

Replace the `<button>` for RotateCw with a flex container containing both buttons:

```tsx
<div className="flex items-center justify-between px-4 py-3 border-b border-border">
  <h2 className="text-sm font-bold text-text flex items-center gap-2">
    <MessageCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
    Чаты
  </h2>
  <div className="flex items-center gap-1">
    <button
      onClick={() => setShowCreateGroup(true)}
      className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent"
      title="Создать группу"
      aria-label="Создать группу"
    >
      <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
    </button>
    <button
      onClick={() => loadChats()}
      className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted hover:text-accent"
      title="Обновить список"
      aria-label="Обновить список чатов"
    >
      <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
    </button>
  </div>
</div>
```

- [ ] **Step 3: Add CreateGroupModal and handler at the end of the component**

Add the `onGroupCreated` handler and the modal JSX. Place the handler function before the `return` statement (after `onLeftGroup` callback, around line 371):

```tsx
async function handleGroupCreated(groupId: string, groupName: string) {
  await loadChats();
  const newChat = chats.find(
    (c) => c.chatId === groupId || c.chatId === `${groupId}@g.us`,
  );
  if (newChat) {
    openChat(newChat);
  }
  setShowCreateGroup(false);
}
```

Add the modal JSX just before the closing `</div>` of the root element (around line 881, before the last `</div>`):

```tsx
<CreateGroupModal
  open={showCreateGroup}
  onClose={() => setShowCreateGroup(false)}
  onCreated={handleGroupCreated}
/>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/dashboard/messenger/page.tsx
git commit -m "feat(messenger): integrate CreateGroupModal into chat sidebar"
```

---

### Task 5: Integrate InviteModal into GroupSettingsPanel

**Files:**
- Modify: `frontend/src/components/GroupSettingsPanel.tsx`

- [ ] **Step 1: Add imports and state**

Add import at the top, after the existing imports:

```tsx
import { InviteModal } from "./InviteModal";
```

Add state inside the component, after `const [adding, setAdding] = useState(false);` (around line 59):

```tsx
const [showInviteModal, setShowInviteModal] = useState(false);
```

- [ ] **Step 2: Add invite button and modal in the JSX**

Find the "Add participant" section (around lines 332-354). After the existing single-participant add form, add a "Массовый инвайт" button and the InviteModal:

After the existing `</div>` that closes the "Добавить участника" block (line 354), add:

```tsx
<div className="flex gap-2">
  <button
    type="button"
    onClick={() => setShowInviteModal(true)}
    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-elevated border border-border hover:border-accent/40 text-text text-xs font-medium rounded-lg transition-colors"
  >
    <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
    Массовый инвайт
  </button>
</div>

<InviteModal
  open={showInviteModal}
  groupId={groupId}
  onClose={() => setShowInviteModal(false)}
  onInvited={refresh}
/>
```

Note: `UserPlus` is already imported in GroupSettingsPanel.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GroupSettingsPanel.tsx
git commit -m "feat(messenger): integrate InviteModal into GroupSettingsPanel"
```

---

### Task 6: Verify and fix

- [ ] **Step 1: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -50
```

Fix any type errors.

- [ ] **Step 2: Run lint**

```bash
cd frontend && npm run lint 2>&1 | head -50
```

Fix any lint issues.

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: address type/lint issues in group create & invite"
```
