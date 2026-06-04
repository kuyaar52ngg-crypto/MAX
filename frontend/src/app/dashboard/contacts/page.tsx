"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Loader2,
  Search,
  UserCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { apiGet, apiPost, apiUpload, getFlaskHeaders } from "@/lib/api";
import { useBulkOperation } from "@/lib/hooks/useBulkOperation";
import { usePersistedState } from "@/lib/hooks/usePersistedState";
import { PreFlightModal } from "@/components/anti-ban/PreFlightModal";
import { StopButton } from "@/components/anti-ban/StopButton";
import {
  AntiBanConfig,
  DEFAULT_ANTI_BAN_CONFIG,
} from "@/lib/anti-ban";

interface Contact {
  id: string;
  name: string;
  chatId: string;
  type: string;
}

interface MassResult {
  phone: string;
  exists: boolean;
  chatId?: string;
}

const DEFAULT_WEEKLY_CHECK_LIMIT = 140;

function weeklyToDailyLimit(weeklyLimit: number): number {
  const safeWeekly = Math.max(1, Math.floor(weeklyLimit || DEFAULT_WEEKLY_CHECK_LIMIT));
  return Math.max(1, Math.ceil(safeWeekly / 7));
}

function buildCheckSubmissionPlan(total: number, weeklyLimit: number): string {
  const rows = buildCheckPlanRows(total, weeklyLimit, 7);
  if (rows.length === 0) return "Нет номеров для подачи";
  const parts = rows.map((row) => `${row.label}: ${row.count}`);
  const planned = rows.reduce((sum, row) => sum + row.count, 0);
  const remaining = Math.max(0, total - planned);
  if (remaining > 0) parts.push(`ещё ${remaining} позже`);
  return parts.join(", ");
}

function buildCheckPlanRows(total: number, weeklyLimit: number, maxRows = 14) {
  if (total <= 0) return [];
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  });
  const rows: Array<{ label: string; count: number; remainingAfter: number }> = [];
  const dailyLimit = weeklyToDailyLimit(weeklyLimit);
  let remaining = total;
  const date = new Date();
  while (remaining > 0 && rows.length < maxRows) {
    const count = Math.min(dailyLimit, remaining);
    const label = rows.length === 0 ? "сегодня" : formatter.format(date);
    remaining -= count;
    rows.push({ label, count, remainingAfter: remaining });
    date.setDate(date.getDate() + 1);
  }
  return rows;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [checkPhone, setCheckPhone] = usePersistedState<string>("contacts:checkPhone", "");
  const [checkResult, setCheckResult] = useState<{ exists: boolean; chatId?: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // Mass check states — persisted between navigations so users don't
  // lose typed/imported phone lists when they jump to settings or
  // history (sessionStorage; cleared on tab close).
  const [massInput, setMassInput] = usePersistedState<string>("contacts:massInput", "");
  const [massPhones, setMassPhones] = usePersistedState<string[]>("contacts:massPhones", []);
  const [massResults, setMassResults] = usePersistedState<MassResult[]>("contacts:massResults", []);
  const [checkWeeklyLimit, setCheckWeeklyLimit] = usePersistedState<number>(
    "contacts:checkWeeklyLimit",
    DEFAULT_WEEKLY_CHECK_LIMIT,
  );
  const [massCsvLoading, setMassCsvLoading] = useState(false);
  const [massCsvError, setMassCsvError] = useState<string | null>(null);

  // Anti-ban integration: PreFlight modal + bulk operation hook + StopButton.
  // The hook owns the SSE channel and the active/progress/error state, so we
  // no longer maintain a local `massChecking` flag, sseCloseRef, or
  // `massProgress` snapshot — they're projected from `bulkOp` instead.
  const bulkOp = useBulkOperation("check");
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [pendingPhones, setPendingPhones] = useState<string[]>([]);
  const [antiBanConfig, setAntiBanConfig] = useState<AntiBanConfig>(DEFAULT_ANTI_BAN_CONFIG);

  const [isAccordionOpen, setIsAccordionOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDraftLimit, setScheduleDraftLimit] = useState(checkWeeklyLimit);

  useEffect(() => { loadContacts(); }, []);

  // Load anti-ban config on mount; fall back to defaults on failure so the
  // PreFlight modal can still render meaningful ETA/risk values.
  useEffect(() => {
    let cancelled = false;
    apiGet<AntiBanConfig>("/api/anti-ban-config")
      .then((cfg) => {
        if (!cancelled && cfg && typeof cfg === "object") setAntiBanConfig(cfg);
      })
      .catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  // Each SSE progress event carries a per-phone result (`phone`, `exists`,
  // `chatId`). The hook merges those into `bulkOp.progress` (replacing the
  // previous one), so we accumulate them into a local `massResults` array
  // here. Each `setProgress` call inside the hook creates a fresh object,
  // so the effect fires exactly once per server event.
  useEffect(() => {
    const p = bulkOp.progress as
      | (Record<string, unknown> & { phone?: unknown; exists?: unknown; chatId?: unknown })
      | null;
    if (!p) return;
    if (typeof p.phone === "string" && typeof p.exists === "boolean") {
      const chatId = typeof p.chatId === "string" ? p.chatId : undefined;
      setMassResults((prev) => [
        ...prev,
        { phone: p.phone as string, exists: p.exists as boolean, chatId },
      ]);
    }
  }, [bulkOp.progress]);

  async function loadContacts() {
    setLoading(true);
    try {
      const data = await apiGet<Contact[]>("/api/contacts");
      setContacts(Array.isArray(data) ? data : []);
    } catch { /* */ } finally { setLoading(false); }
  }

  async function checkContact() {
    if (!checkPhone.trim()) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const data = await apiPost<{ exists: boolean; chatId?: string }>("/api/check-contact", { phone: checkPhone.replace(/\D/g, "") });
      setCheckResult(data);
    } catch { /* */ } finally { setChecking(false); }
  }

  const filtered = search
    ? contacts.filter((c) => c.name?.toLowerCase().includes(search.toLowerCase()) || c.chatId?.includes(search))
    : contacts;

  function addMassPhone(raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (cleaned.length >= 10 && cleaned.length <= 15 && !massPhones.includes(cleaned)) {
      setMassPhones((p) => [...p, cleaned]);
    }
    setMassInput("");
  }

  function handleMassKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addMassPhone(massInput);
    }
    if (e.key === "Backspace" && !massInput && massPhones.length > 0) {
      setMassPhones((p) => p.slice(0, -1));
    }
  }

  async function handleMassCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMassCsvLoading(true);
    setMassCsvError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await apiUpload<{ phones: string[] }>("/api/upload-contacts", fd);
      if (data.phones) setMassPhones((p) => [...new Set([...p, ...data.phones])]);
    } catch (err: unknown) {
      setMassCsvError(err instanceof Error ? err.message : "Не удалось загрузить CSV");
    } finally {
      setMassCsvLoading(false);
      e.target.value = "";
    }
  }

  // Open the PreFlight modal with the currently-staged phones. The actual
  // POST + SSE happens only after the user confirms the modal.
  //
  // Дедупликация (важно для anti-ban):
  // MAX banит за повторные проверки уже-known номеров, особенно для
  // несуществующих ID — так что отфильтруем все, что есть в massResults
  // (один в сессии запуск даёт стабильный результат). Если пользователь
  // хочет реально ре-проверить — сначала очистите результаты кнопкой.
  function openPreflight() {
    if (!massPhones.length || bulkOp.active) return;
    const alreadyChecked = new Set(massResults.map((r) => r.phone));
    const fresh = massPhones.filter((p) => !alreadyChecked.has(p));
    if (fresh.length === 0) {
      // Все уже проверены — нечего запускать.
      return;
    }
    setPendingPhones(fresh);
    setPreflightOpen(true);
  }

  async function handlePreflightConfirm() {
    setPreflightOpen(false);
    setMassResults([]);
    // GREEN-API credentials live in Supabase per user; the hook owns the POST
    // + SSE, so we feed it the same JWT + X-Green-Api-* headers the rest of
    // the dashboard uses (see lib/api.ts → getFlaskHeaders).
    try {
      const headers = await getFlaskHeaders();
      await bulkOp.start(
        {
          phones: pendingPhones,
          auto_schedule_daily: true,
          check_schedule_weekly_limit: checkWeeklyLimit,
        },
        { headers: headers as Record<string, string> },
      );
    } catch (err) {
      // getFlaskHeaders throws when credentials are missing — surface the
      // message via the hook by rethrowing the start with no headers, which
      // will get the same backend 400 but at least populate bulkOp.error.
      // Otherwise the modal would just silently close.
      console.error("Не удалось собрать заголовки для запроса:", err);
    }
  }

  function handlePreflightCancel() {
    setPreflightOpen(false);
  }

  function downloadValidCSV() {
    const valid = massResults.filter(r => r.exists).map(r => r.phone);
    if (!valid.length) return;
    const blob = new Blob([valid.join("\n")], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "valid_contacts.csv";
    a.click();
    window.URL.revokeObjectURL(url);
  }

  const progressDone = typeof bulkOp.progress?.done === "number" ? bulkOp.progress.done : 0;
  const progressTotal = typeof bulkOp.progress?.total === "number" ? bulkOp.progress.total : 0;
  const checkedPhoneSet = new Set(massResults.map((r) => r.phone));
  const pendingMassCount = massPhones.filter((p) => !checkedPhoneSet.has(p)).length;
  const dailyWait = bulkOp.progress?.type === "daily_schedule_wait"
    ? bulkOp.progress
    : null;
  const dailyCheckLimit = weeklyToDailyLimit(checkWeeklyLimit);
  const visibleMassPhones = isAccordionOpen ? massPhones : massPhones.slice(0, 12);
  const hiddenMassPhonesCount = Math.max(0, massPhones.length - visibleMassPhones.length);
  const estimatedPlanDays = pendingMassCount > 0
    ? Math.ceil(pendingMassCount / dailyCheckLimit)
    : 0;
  const scheduleDraftDailyLimit = weeklyToDailyLimit(scheduleDraftLimit);
  const scheduleDraftPlanDays = pendingMassCount > 0
    ? Math.ceil(pendingMassCount / scheduleDraftDailyLimit)
    : 0;
  const scheduleDraftRows = buildCheckPlanRows(pendingMassCount, scheduleDraftLimit, 10);

  function openScheduleModal() {
    setScheduleDraftLimit(checkWeeklyLimit);
    setScheduleModalOpen(true);
  }

  function saveScheduleModal() {
    const normalized = Math.max(1, Math.min(100000, Math.floor(scheduleDraftLimit || DEFAULT_WEEKLY_CHECK_LIMIT)));
    setCheckWeeklyLimit(normalized);
    setScheduleModalOpen(false);
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text flex items-center gap-2">
          <UserCheck className="h-6 w-6 text-text-muted" strokeWidth={2} aria-hidden="true" />
          Проверка номеров
        </h1>
        <p className="text-text-muted text-sm mt-1">Управление контактами</p>
      </div>

      {/* Anti-ban warning — лимиты MAX по проверке номеров.
          Источник: https://max-catalog24.ru/limits.html и наш собственный кейс
          с баном на 150 проверках. Проверка номеров — самая рискованная
          операция в MAX, лимит ~20/день для прогретого аккаунта. */}
      <div className="rounded-2xl border border-warning/30 bg-warning-bg p-4 flex items-start gap-3">
        <AlertTriangle
          className="h-5 w-5 mt-0.5 text-warning shrink-0"
          strokeWidth={2}
          aria-hidden="true"
        />
        <div className="space-y-1.5 text-sm text-warning">
          <strong className="block">Проверка номеров — самая рискованная операция в MAX</strong>
          <ul className="text-xs space-y-1 list-disc ml-4 opacity-90">
            <li>Безопасный дневной лимит — <strong>не более 20 проверок</strong> для прогретого аккаунта</li>
            <li>Свежие аккаунты (&lt; 7 дней) — только единичные проверки, иначе мгновенный бан</li>
            <li>Не делайте массовые проверки подряд — чередуйте с другими действиями</li>
            <li>Если номер не найден в MAX — <strong>не повторяйте запрос</strong> (повторы триггерят бан)</li>
          </ul>
          <div className="text-xs pt-1">
            Состояние аккаунта и осталось проверок:{" "}
            <Link href="/dashboard/health" className="underline font-medium">
              /dashboard/health
            </Link>
          </div>
        </div>
      </div>

      {/* Check single contact */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <Search className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Проверка номера
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={checkPhone}
            onChange={(e) => setCheckPhone(e.target.value)}
            placeholder="79001234567"
            className="flex-1 px-4 py-2.5 bg-bg/50 border border-border rounded-xl text-sm text-text placeholder:text-text-muted
                       focus:outline-none focus:border-accent/50 transition-colors"
            onKeyDown={(e) => e.key === "Enter" && checkContact()}
          />
          <button
            onClick={checkContact}
            disabled={checking}
            className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all
                       disabled:opacity-50 active:scale-95"
          >
            {checking ? "..." : "Проверить"}
          </button>
        </div>
        {checkResult && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-center gap-2 ${checkResult.exists ? "bg-success-bg border border-success/20 text-success" : "bg-error-bg border border-error/20 text-error"}`}>
            {checkResult.exists ? (
              <>
                <Check className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                <span>Найден! chatId: {checkResult.chatId}</span>
              </>
            ) : (
              <>
                <X className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                <span>Не зарегистрирован в WhatsApp</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Mass Check */}
      <div className="contact-section glass rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          <BarChart3 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Массовая проверка
        </h3>
        <div className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-3 text-xs text-text-secondary space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <strong className="text-text">Планирование проверки:</strong>{" "}
              очередь проверяется порциями по выбранному недельному лимиту.
            </div>
            <button
              type="button"
              onClick={openScheduleModal}
              disabled={bulkOp.active}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent text-bg text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              <CalendarClock className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Планирование
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-bg/70 border border-border/70 px-3 py-2">
              <div className="text-text-muted">В неделю</div>
              <div className="text-text font-semibold">{checkWeeklyLimit}</div>
            </div>
            <div className="rounded-lg bg-bg/70 border border-border/70 px-3 py-2">
              <div className="text-text-muted">В день</div>
              <div className="text-text font-semibold">≈ {dailyCheckLimit}</div>
            </div>
            <div className="rounded-lg bg-bg/70 border border-border/70 px-3 py-2">
              <div className="text-text-muted">В очереди</div>
              <div className="text-text font-semibold">{pendingMassCount}</div>
            </div>
            <div className="rounded-lg bg-bg/70 border border-border/70 px-3 py-2">
              <div className="text-text-muted">Срок</div>
              <div className="text-text font-semibold">{estimatedPlanDays || 0} дн.</div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-text-muted">Вводите номера</label>
          <div className="flex gap-2 rounded-xl bg-bg/50 border border-border px-3 py-2 focus-within:border-accent/50 transition-colors">
            <input
              type="text"
              value={massInput}
              onChange={(e) => setMassInput(e.target.value)}
              onKeyDown={handleMassKeyDown}
              placeholder="Вводите номера, затем Enter или запятая"
              disabled={bulkOp.active}
              className="flex-1 min-w-0 bg-transparent text-sm text-text placeholder:text-text-muted outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => addMassPhone(massInput)}
              disabled={!massInput.trim() || bulkOp.active}
              className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-40"
            >
              Добавить
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-bg/50 border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => setIsAccordionOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface/60 transition-colors"
          >
            <span>
              <span className="block text-sm font-medium text-text">Загруженные номера</span>
              <span className="block text-xs text-text-muted">
                Всего: {massPhones.length}. {isAccordionOpen ? "Список раскрыт со скроллом." : "Список свернут, чтобы не мешал вводу."}
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 text-text-muted transition-transform ${isAccordionOpen ? "rotate-180" : ""}`}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
          <div className={`border-t border-border p-3 ${isAccordionOpen ? "max-h-72 overflow-y-auto" : ""}`}>
            {massPhones.length === 0 ? (
              <div className="text-xs text-text-muted py-2">Номера ещё не добавлены. Ввод находится выше, CSV можно загрузить ниже.</div>
            ) : (
              <div className="flex flex-wrap gap-2 min-h-[40px]">
                {visibleMassPhones.map((p, i) => (
                  <span key={`${p}-${i}`} className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent/15 border border-accent/20 rounded-lg text-xs text-accent-light">
                    {p}
                    <button
                      type="button"
                      onClick={() => setMassPhones((ph) => ph.filter((_, idx) => idx !== i))}
                      disabled={bulkOp.active}
                      className="hover:text-error transition-colors disabled:opacity-40"
                      aria-label={`Удалить номер ${p}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {!isAccordionOpen && hiddenMassPhonesCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setIsAccordionOpen(true)}
                    className="px-2.5 py-1 rounded-lg text-xs bg-surface border border-border text-text-secondary hover:border-accent/40 transition-colors"
                  >
                    ещё {hiddenMassPhonesCount}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-between items-center">
          <div className="flex gap-3">
            <label className={`flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-xl text-xs text-text-secondary transition-colors ${massCsvLoading ? "opacity-60 cursor-wait" : "cursor-pointer hover:border-accent/40"}`}>
              {massCsvLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
              ) : (
                <FolderOpen className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              )}
              {massCsvLoading ? "Загрузка..." : "Загрузить CSV"}
              <input type="file" accept=".csv,text/csv" onChange={handleMassCSV} disabled={massCsvLoading} className="hidden" />
            </label>
            <button
              onClick={() => {
                setMassPhones([]);
                setMassResults([]);
              }}
              disabled={(!massPhones.length && !massResults.length) || bulkOp.active}
              className="px-4 py-2 bg-surface border border-border rounded-xl text-xs text-error hover:border-error/40 transition-colors disabled:opacity-40"
            >
              Очистить
            </button>
          </div>
          <div className="flex items-center gap-3">
            {bulkOp.active && (
              <StopButton onStop={bulkOp.stop} active={bulkOp.active} />
            )}
            <button
              onClick={openPreflight}
              disabled={!massPhones.length || bulkOp.active}
              className="px-5 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
            >
              {bulkOp.active ? "Проверка..." : `Проверить ${massPhones.length} номеров`}
            </button>
          </div>
        </div>

        {massCsvError && (
          <div role="alert" className="px-4 py-3 rounded-xl text-sm bg-error-bg border border-error/20 text-error">
            CSV: {massCsvError}
          </div>
        )}

        {bulkOp.error && (
          <div role="alert" className="px-4 py-3 rounded-xl text-sm bg-error-bg border border-error/20 text-error">
            {bulkOp.error}
          </div>
        )}

        {dailyWait && (
          <div className="px-4 py-3 rounded-xl text-sm bg-warning-bg border border-warning/20 text-warning">
            Дневной лимит достигнут. Следующая автоподача начнётся после сброса лимита: {String(dailyWait.next_start_at ?? "завтра")}.
          </div>
        )}

        {(massResults.length > 0 || bulkOp.active) && (
          <div className="mt-4 p-4 bg-bg/50 rounded-xl space-y-3 border border-border">
            <div className="flex justify-between items-center">
              <div className="text-sm font-medium">
                Результат: {massResults.filter(r => r.exists).length} найдено / {massResults.length} проверено
              </div>
              <button
                onClick={downloadValidCSV}
                disabled={!massResults.some(r => r.exists)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-success/20 text-success text-xs font-medium rounded-lg hover:bg-success/30 transition-colors disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Скачать валидные (CSV)
              </button>
            </div>
            {progressTotal > 0 && (
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(progressDone / progressTotal) * 100}%` }} />
              </div>
            )}
            <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
              {massResults.map((r, i) => (
                <div key={i} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                  <span className="font-mono">{r.phone}</span>
                  <span className={`inline-flex items-center gap-1 ${r.exists ? "text-success" : "text-error"}`}>
                    {r.exists ? (
                      <>
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                        Есть
                      </>
                    ) : (
                      <>
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                        Нет
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {scheduleModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="check-schedule-title"
        >
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-bg-elevated shadow-2xl overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h3 id="check-schedule-title" className="text-base font-semibold text-text flex items-center gap-2">
                  <CalendarClock className="h-5 w-5 text-accent" strokeWidth={2} aria-hidden="true" />
                  Подробное планирование проверки
                </h3>
                <p className="mt-1 text-xs text-text-muted">
                  Настройте недельный объём. Большой список останется в очереди, а проверка будет идти по дневным порциям.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="rounded-lg p-1 text-text-muted hover:bg-surface hover:text-text transition-colors"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-5">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <label className="block text-sm font-medium text-text mb-2">
                    Сколько номеров проверять в неделю
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={scheduleDraftLimit}
                    onChange={(e) => setScheduleDraftLimit(Math.max(1, Number(e.target.value) || DEFAULT_WEEKLY_CHECK_LIMIT))}
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-text focus:outline-none focus:border-accent/50 font-mono"
                    autoFocus
                  />
                </div>
                <div className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-text-secondary">
                  <div className="text-xs text-text-muted">Получится в день</div>
                  <div className="text-xl font-semibold text-text">≈ {scheduleDraftDailyLimit}</div>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-text-muted mb-2">Быстрый выбор</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[140, 210, 350, 700].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setScheduleDraftLimit(value)}
                      className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                        scheduleDraftLimit === value
                          ? "border-accent bg-accent/15 text-accent-light"
                          : "border-border bg-bg text-text-secondary hover:border-accent/40"
                      }`}
                    >
                      <span className="block text-sm font-semibold">{value}/нед</span>
                      <span className="block text-xs opacity-80">≈ {weeklyToDailyLimit(value)}/день</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <div className="text-xs text-text-muted">Номеров в очереди</div>
                  <div className="text-lg font-semibold text-text">{pendingMassCount}</div>
                </div>
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <div className="text-xs text-text-muted">Дневная порция</div>
                  <div className="text-lg font-semibold text-text">{scheduleDraftDailyLimit}</div>
                </div>
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <div className="text-xs text-text-muted">Примерный срок</div>
                  <div className="text-lg font-semibold text-text">{scheduleDraftPlanDays || 0} дней</div>
                </div>
              </div>

              <div className="rounded-xl border border-warning/25 bg-warning-bg px-4 py-3 text-xs text-warning space-y-1">
                <strong className="block text-sm">Антибан-подсказка</strong>
                <p>140 в неделю это примерно 20 в день. Для свежих или слабых аккаунтов лучше не увеличивать лимит резко.</p>
              </div>

              <div className="rounded-xl border border-border bg-bg overflow-hidden">
                <div className="px-4 py-3 border-b border-border text-sm font-medium text-text">
                  Предпросмотр ближайших дней
                </div>
                {scheduleDraftRows.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-text-muted">Добавьте номера, чтобы увидеть план.</div>
                ) : (
                  <div className="divide-y divide-border/70">
                    {scheduleDraftRows.map((row, index) => (
                      <div key={`${row.label}-${index}`} className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 text-sm">
                        <span className="text-text">{row.label}</span>
                        <span className="font-semibold text-accent-light">{row.count}</span>
                        <span className="text-xs text-text-muted">останется {row.remainingAfter}</span>
                      </div>
                    ))}
                    {pendingMassCount > scheduleDraftRows.reduce((sum, row) => sum + row.count, 0) && (
                      <div className="px-4 py-2.5 text-xs text-text-muted">
                        Остальные дни будут продолжены по той же дневной порции.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-surface transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={saveScheduleModal}
                className="px-5 py-2 rounded-lg bg-accent text-bg text-sm font-medium hover:bg-accent-hover transition-colors"
              >
                Сохранить план
              </button>
            </div>
          </div>
        </div>
      )}

      <PreFlightModal
        open={preflightOpen}
        kind="check"
        total={pendingPhones.length}
        config={antiBanConfig}
        onConfirm={handlePreflightConfirm}
        onCancel={handlePreflightCancel}
      />
    </div>
  );
}
