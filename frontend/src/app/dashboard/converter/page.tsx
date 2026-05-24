"use client";

/**
 * `/dashboard/converter` — конвертер «номер телефона → MAX chat ID».
 *
 * Преимущество над Sheiker: у них bulk-чек подряд, который мы знаем
 * приводит к бану на 20+ запросах. У нас — единичная проверка с
 * явным дневным счётчиком, блокировкой при превышении дневного
 * лимита (20 по документации MAX) и автоматическим cooldown между
 * запросами (30 секунд).
 *
 * Используется когда нужен ID конкретного контакта — например, для
 * массовой рассылки по чатам, где требуется ID, а не номер.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  Phone,
  Search,
  XCircle,
} from "lucide-react";
import Link from "next/link";

import { apiPost } from "@/lib/api";
import { useAccountHealth } from "@/lib/hooks/useAccountHealth";

interface ConvertResult {
  phone: string;
  exists: boolean;
  chatId?: string;
  checkedAt: number; // Date.now()
}

interface CheckResponse {
  exists: boolean;
  chatId?: string;
}

const MIN_INTERVAL_SECONDS = 30;
const HISTORY_KEY = "converter:history";

export default function ConverterPage() {
  const { primary, refetch: refetchHealth } = useAccountHealth(60_000);
  const [phone, setPhone] = useState("");
  const [history, setHistory] = useState<ConvertResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedChatId, setCopiedChatId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Ticker для cooldown countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Восстанавливаем историю из sessionStorage.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      /* */
    }
  }, []);

  // Сохраняем историю.
  useEffect(() => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* */
    }
  }, [history]);

  const lastCheckAt = history[0]?.checkedAt ?? 0;
  const elapsed = Math.floor((now - lastCheckAt) / 1000);
  const cooldownRemaining = Math.max(0, MIN_INTERVAL_SECONDS - elapsed);

  const dailyUsed = primary?.checks_last_24h ?? 0;
  const dailyLimit = primary?.recommended_daily_check_limit ?? 0;
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const dailyExceeded = dailyLimit > 0 && dailyRemaining <= 0;

  const status = primary?.status ?? "unknown";
  const hardBlocked = status === "blocked" || status === "cooldown";

  const cleanPhone = phone.replace(/\D+/g, "");
  const isValid = cleanPhone.length >= 10 && cleanPhone.length <= 15;

  const canCheck =
    isValid &&
    !loading &&
    cooldownRemaining === 0 &&
    !hardBlocked &&
    !dailyExceeded;

  async function check() {
    if (!canCheck) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiPost<CheckResponse>("/api/check-contact", {
        phone: cleanPhone,
      });
      const entry: ConvertResult = {
        phone: cleanPhone,
        exists: res.exists,
        chatId: res.chatId,
        checkedAt: Date.now(),
      };
      setHistory((prev) => {
        // Удаляем старую запись для этого же номера если есть.
        const filtered = prev.filter((p) => p.phone !== cleanPhone);
        return [entry, ...filtered].slice(0, 50);
      });
      setPhone("");
      refetchHealth();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка проверки");
    } finally {
      setLoading(false);
    }
  }

  async function copyChatId(chatId: string) {
    try {
      await navigator.clipboard.writeText(chatId);
      setCopiedChatId(chatId);
      setTimeout(() => setCopiedChatId(null), 1500);
    } catch {
      /* */
    }
  }

  function clearHistory() {
    setHistory([]);
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <Phone className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          Конвертер номеров
        </h1>
        <p className="text-text-muted text-sm mt-1 max-w-2xl">
          По одному номеру за раз, с задержкой 30 секунд между запросами.
          Строгий дневной лимит — 20 проверок (по документации MAX).
          Массовая bulk-проверка доступна на странице{" "}
          <Link href="/dashboard/contacts" className="text-accent underline">
            Проверка контактов
          </Link>
          .
        </p>
      </header>

      {/* Daily quota */}
      <section className="rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-text">Дневной лимит проверок</span>
          <span className="text-text-muted font-mono">
            {dailyUsed} / {dailyLimit > 0 ? dailyLimit : "—"}
          </span>
        </div>
        {dailyLimit > 0 && (
          <div className="mt-2 h-2 rounded-full bg-bg-elevated overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                dailyExceeded
                  ? "bg-error/80"
                  : dailyRemaining < dailyLimit / 4
                    ? "bg-warning/70"
                    : "bg-accent/60"
              }`}
              style={{
                width: `${Math.min(100, (dailyUsed / dailyLimit) * 100)}%`,
              }}
            />
          </div>
        )}
        {dailyExceeded && (
          <div className="mt-2 text-xs text-error inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Дневной лимит исчерпан. Подождите до сброса (24ч от первой
            проверки) или используйте другой инстанс.
          </div>
        )}
        {hardBlocked && (
          <div className="mt-2 text-xs text-error inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Аккаунт в статусе «{status}». Проверки заблокированы системой
            защиты.{" "}
            <Link href="/dashboard/health" className="underline">
              Подробнее
            </Link>
          </div>
        )}
      </section>

      {/* Input */}
      <section className="rounded-2xl border border-border bg-surface p-5 space-y-3">
        <div className="flex gap-2">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="79991234567"
            disabled={hardBlocked || dailyExceeded}
            className="flex-1 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text font-mono focus:outline-none focus:border-accent/50 disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === "Enter") check();
            }}
          />
          <button
            type="button"
            onClick={check}
            disabled={!canCheck}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-lg disabled:opacity-50 transition-all active:scale-95"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
            ) : (
              <Search className="h-3.5 w-3.5" strokeWidth={2.5} />
            )}
            Найти
          </button>
        </div>
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}
        {cooldownRemaining > 0 && history.length > 0 && (
          <div className="text-xs text-text-muted inline-flex items-center gap-1.5">
            <Clock className="h-3 w-3" strokeWidth={2} />
            Следующая проверка через {cooldownRemaining}с
          </div>
        )}
      </section>

      {/* History */}
      {history.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-5 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-text">
              История проверок ({history.length})
            </h2>
            <button
              type="button"
              onClick={clearHistory}
              className="text-xs text-text-muted hover:text-error transition-colors"
            >
              Очистить
            </button>
          </div>
          <div className="space-y-1.5">
            {history.map((entry) => (
              <HistoryRow
                key={entry.checkedAt + entry.phone}
                entry={entry}
                isCopied={entry.chatId === copiedChatId}
                onCopy={() => entry.chatId && copyChatId(entry.chatId)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  isCopied,
  onCopy,
}: {
  entry: ConvertResult;
  isCopied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
        entry.exists
          ? "border-success/30 bg-success-bg/30"
          : "border-border bg-bg-elevated/50"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {entry.exists ? (
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" strokeWidth={2} />
        ) : (
          <XCircle className="h-4 w-4 text-text-muted shrink-0" strokeWidth={2} />
        )}
        <div className="min-w-0">
          <div className="font-mono text-sm text-text">+{entry.phone}</div>
          {entry.exists ? (
            <div className="text-xs text-text-muted font-mono truncate">
              {entry.chatId}
            </div>
          ) : (
            <div className="text-xs text-text-muted">Не найден в MAX</div>
          )}
        </div>
      </div>
      {entry.exists && entry.chatId && (
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-accent hover:bg-accent/10 transition-colors"
        >
          <Copy className="h-3 w-3" strokeWidth={2.5} />
          {isCopied ? "Скопировано" : "ID"}
        </button>
      )}
    </div>
  );
}
