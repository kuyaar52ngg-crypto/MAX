"use client";

/**
 * `/dashboard/settings/instances` — список GREEN-API инстансов пользователя.
 *
 * Что умеет:
 *   - показать до 5 инстансов с именем, idInstance, телефоном, статусом;
 *   - открыть `ConnectionWizard` для подключения нового;
 *   - на каждой строке: «Перепривязать», «Проверить сейчас», «Сменить
 *     credentials», «Сделать основным», «Удалить»;
 *   - копировать idInstance в буфер обмена;
 *   - запоминать в localStorage, что для инстанса видели shared_instance_warning,
 *     чтобы показывать баннер до явного dismissOf пользователем.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";

import { nxDelete, nxGet, nxPut } from "@/lib/api";
import {
  ChangeCredentialsModal,
  ConnectionWizard,
  DiagnosticMessage,
  InstanceStatusBadge,
  SharedInstanceWarningBanner,
} from "@/components/green-api";
import type {
  GetStateResponse,
  InstanceStatus,
} from "@/lib/green-api";

interface InstanceRow {
  id: number;
  user_id: string;
  name: string;
  id_instance: string;
  api_url: string;
  status: InstanceStatus;
  phone: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

const SHARED_WARNING_STORAGE_PREFIX = "green-instance:shared-warning:";

function readSharedWarning(instanceId: number): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${SHARED_WARNING_STORAGE_PREFIX}${instanceId}`) === "1";
  } catch {
    return false;
  }
}
function writeSharedWarning(instanceId: number, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(`${SHARED_WARNING_STORAGE_PREFIX}${instanceId}`, "1");
    } else {
      window.localStorage.removeItem(`${SHARED_WARNING_STORAGE_PREFIX}${instanceId}`);
    }
  } catch {
    /* noop */
  }
}

export default function InstancesPage() {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [reauthInstanceId, setReauthInstanceId] = useState<number | null>(null);
  const [credentialsTarget, setCredentialsTarget] =
    useState<InstanceRow | null>(null);
  const [sharedWarnings, setSharedWarnings] = useState<Record<number, boolean>>(
    {},
  );

  const load = useCallback(async () => {
    try {
      const data = await nxGet<InstanceRow[]>("/api/green-instances");
      setInstances(Array.isArray(data) ? data : []);
      const map: Record<number, boolean> = {};
      for (const row of data) map[row.id] = readSharedWarning(row.id);
      setSharedWarnings(map);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить инстансы");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* silently fail — too small to surface */
    }
  }

  async function checkNow(row: InstanceRow) {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await nxGet<GetStateResponse>(
        `/api/green-instances/${row.id}/state`,
      );
      setInstances((prev) =>
        prev.map((it) =>
          it.id === row.id
            ? { ...it, status: res.status, phone: res.phone ?? it.phone }
            : it,
        ),
      );
      if (res.shared_instance_warning) {
        writeSharedWarning(row.id, true);
        setSharedWarnings((prev) => ({ ...prev, [row.id]: true }));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось получить статус");
    } finally {
      setBusyId(null);
    }
  }

  async function makePrimary(row: InstanceRow) {
    if (row.is_primary) return;
    setBusyId(row.id);
    setError(null);
    try {
      // PUT /api/green-instances/[id] — поддерживает is_primary тоггл,
      // сервер сам снимет флаг с других.
      await nxPut(`/api/green-instances/${row.id}`, { is_primary: true });
      setInstances((prev) =>
        prev.map((it) => ({
          ...it,
          is_primary: it.id === row.id,
        })),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сменить основной");
    } finally {
      setBusyId(null);
    }
  }

  async function rename(row: InstanceRow) {
    const newName = window.prompt("Новое имя инстанса", row.name);
    if (newName === null || newName.trim() === "") return;
    setBusyId(row.id);
    try {
      await nxPut(`/api/green-instances/${row.id}`, { name: newName.trim() });
      setInstances((prev) =>
        prev.map((it) =>
          it.id === row.id ? { ...it, name: newName.trim() } : it,
        ),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось переименовать");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: InstanceRow) {
    const ok = window.confirm(
      `Удалить инстанс «${row.name}»? Запланированные рассылки, использующие этот инстанс, могут перестать работать.`,
    );
    if (!ok) return;
    setBusyId(row.id);
    try {
      await nxDelete(`/api/green-instances/${row.id}`);
      writeSharedWarning(row.id, false);
      setInstances((prev) => prev.filter((it) => it.id !== row.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-text">
            GREEN API инстансы
          </h1>
          <p className="text-text-muted text-sm mt-1">
            До 5 инстансов на аккаунт. Подключайте свои или попросите у
            владельца{" "}
            <span className="font-mono">idInstance</span> и{" "}
            <span className="font-mono">apiTokenInstance</span> чужого инстанса.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setReauthInstanceId(null);
            setWizardOpen(true);
          }}
          disabled={instances.length >= 5}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all disabled:opacity-50 active:scale-95"
        >
          <Plus className="h-4 w-4" strokeWidth={2.4} />
          Подключить инстанс
        </button>
      </header>

      {error && <DiagnosticMessage variant="banner" customMessage={error} />}

      {loading ? (
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Загрузка…
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <Wand2
            className="mx-auto h-10 w-10 text-text-muted mb-3"
            strokeWidth={1.5}
          />
          <h3 className="text-base font-semibold text-text">
            Ни одного инстанса не подключено
          </h3>
          <p className="text-sm text-text-muted mt-1 mb-4">
            Нажмите «Подключить инстанс», чтобы привязать MAX через QR-код.
          </p>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-xl transition-all"
          >
            <Plus className="h-4 w-4" strokeWidth={2.4} />
            Подключить инстанс
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {instances.map((row) => (
            <article
              key={row.id}
              className="rounded-2xl border border-border bg-surface p-5 space-y-3"
            >
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <ShieldCheck className="h-5 w-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold text-text truncate max-w-[260px]">
                      {row.name}
                    </h3>
                    {row.is_primary && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent text-xs px-2 py-0.5">
                        <Star className="h-3 w-3" strokeWidth={2} /> Основной
                      </span>
                    )}
                    <InstanceStatusBadge status={row.status} />
                  </div>
                  <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>
                      idInstance:{" "}
                      <span className="font-mono text-text">
                        {row.id_instance}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => copyId(row.id_instance)}
                      aria-label="Копировать idInstance"
                      className="text-text-muted hover:text-text transition-colors"
                    >
                      <Copy className="h-3 w-3" strokeWidth={2} />
                    </button>
                    {row.phone && (
                      <span>
                        ·{" "}
                        <span className="font-mono text-text">
                          {row.phone}
                        </span>
                      </span>
                    )}
                  </div>
                  <DiagnosticMessage
                    variant="inline"
                    status={row.status}
                    className="mt-1"
                  />
                </div>
              </div>

              <SharedInstanceWarningBanner
                visible={Boolean(sharedWarnings[row.id])}
                onDismiss={() => {
                  writeSharedWarning(row.id, false);
                  setSharedWarnings((prev) => ({ ...prev, [row.id]: false }));
                }}
              />

              <div className="flex flex-wrap gap-1.5 pt-1">
                <ActionButton
                  onClick={() => checkNow(row)}
                  busy={busyId === row.id}
                >
                  <RefreshCw
                    className={`h-3 w-3 ${busyId === row.id ? "animate-spin" : ""}`}
                    strokeWidth={2.5}
                  />
                  Проверить сейчас
                </ActionButton>
                {(row.status === "notAuthorized" ||
                  row.status === "yellowCard" ||
                  row.status === "blocked" ||
                  row.status === "sleepMode" ||
                  row.status === "unknown") && (
                  <ActionButton
                    onClick={() => {
                      setReauthInstanceId(row.id);
                      setWizardOpen(true);
                    }}
                  >
                    Перепривязать
                  </ActionButton>
                )}
                <ActionButton onClick={() => setCredentialsTarget(row)}>
                  Сменить credentials
                </ActionButton>
                <ActionButton onClick={() => rename(row)} busy={busyId === row.id}>
                  <Edit3 className="h-3 w-3" strokeWidth={2.5} />
                  Переименовать
                </ActionButton>
                {!row.is_primary && (
                  <ActionButton
                    onClick={() => makePrimary(row)}
                    busy={busyId === row.id}
                  >
                    <Star className="h-3 w-3" strokeWidth={2.5} />
                    Сделать основным
                  </ActionButton>
                )}
                <ActionButton
                  onClick={() => remove(row)}
                  variant="danger"
                  busy={busyId === row.id}
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2.5} />
                  Удалить
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConnectionWizard
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          setReauthInstanceId(null);
          load();
        }}
        onSuccess={() => {
          load();
        }}
        reauthInstanceId={reauthInstanceId}
      />

      {credentialsTarget && (
        <ChangeCredentialsModal
          open
          instanceId={credentialsTarget.id}
          currentIdInstance={credentialsTarget.id_instance}
          currentApiUrl={credentialsTarget.api_url}
          onClose={() => setCredentialsTarget(null)}
          onSuccess={(res) => {
            setInstances((prev) =>
              prev.map((it) =>
                it.id === credentialsTarget.id
                  ? {
                      ...it,
                      id_instance: res.id_instance,
                      api_url: res.api_url,
                      status: res.status,
                      phone: res.phone ?? it.phone,
                    }
                  : it,
              ),
            );
          }}
        />
      )}
    </div>
  );
}

interface ActionButtonProps {
  onClick: () => void;
  busy?: boolean;
  variant?: "default" | "danger";
  children: React.ReactNode;
}

function ActionButton({
  onClick,
  busy = false,
  variant = "default",
  children,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
        variant === "danger"
          ? "bg-bg-elevated border border-border text-error hover:border-error/40"
          : "bg-bg-elevated border border-border text-text-secondary hover:border-accent/40 hover:text-text"
      }`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
      ) : null}
      {children}
    </button>
  );
}

// Re-export the success icon so eslint won't think it's unused after refactors.
void CheckCircle2;
