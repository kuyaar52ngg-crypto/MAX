"use client";

/**
 * `CooldownFilterCard` — UI-кнопка для удаления номеров, которым уже
 * отправлялись сообщения за последние N дней (по умолчанию 7).
 *
 * MAX отслеживает паттерн «спам по одной базе» — повторные отправки
 * тому же номеру в коротком окне поднимают шанс жёлтой карточки.
 * Этот компонент вызывает `POST /api/recipients/cooldown-filter`,
 * показывает разницу и предлагает удалить из списка получателей.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { nxPost } from "@/lib/api";

interface FilterResponse {
  fresh: string[];
  in_cooldown: string[];
  last_sent: { phone: string; sent_at: string }[];
  cooldown_days: number;
}

export interface CooldownFilterCardProps {
  /** Текущий список получателей. */
  phones: string[];
  /** Колбэк когда пользователь хочет удалить из списка in-cooldown номера. */
  onRemoveCooldown: (cooldownPhones: string[]) => void;
  /** По умолчанию 7 дней — соответствует анти-спам рекомендации MAX. */
  defaultCooldownDays?: number;
  className?: string;
}

export function CooldownFilterCard({
  phones,
  onRemoveCooldown,
  defaultCooldownDays = 7,
  className,
}: CooldownFilterCardProps) {
  const [days, setDays] = useState(defaultCooldownDays);
  const [result, setResult] = useState<FilterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Сбрасываем результат при изменении phones — устаревший snapshot опасен.
  const phonesKey = useMemo(() => phones.join(","), [phones]);
  useEffect(() => {
    setResult(null);
  }, [phonesKey]);

  async function check() {
    if (phones.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await nxPost<FilterResponse>(
        "/api/recipients/cooldown-filter",
        { phones, cooldown_days: days },
      );
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось проверить cooldown");
    } finally {
      setLoading(false);
    }
  }

  if (phones.length === 0) return null;

  return (
    <div
      className={`rounded-xl border border-border bg-bg-elevated p-4 space-y-3 ${className ?? ""}`}
    >
      <div className="flex items-start gap-2">
        <Clock className="h-4 w-4 mt-0.5 text-text-muted shrink-0" strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-text">
            Защита от повторных отправок
          </h4>
          <p className="text-xs text-text-muted mt-0.5">
            MAX считает спамом повторные сообщения одному номеру в коротком
            окне. Проверьте, кому из списка уже писали за последние N дней.
          </p>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs text-text-muted mb-1">
            Окно cooldown (дней)
          </label>
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 7)))}
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text font-mono focus:outline-none focus:border-accent/50"
          />
        </div>
        <button
          type="button"
          onClick={check}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-bg border border-border text-sm text-text-secondary hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
          ) : (
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />
          )}
          Проверить
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {result && (
        <ResultPanel
          result={result}
          totalRequested={phones.length}
          onRemove={onRemoveCooldown}
        />
      )}
    </div>
  );
}

function ResultPanel({
  result,
  totalRequested,
  onRemove,
}: {
  result: FilterResponse;
  totalRequested: number;
  onRemove: (phones: string[]) => void;
}) {
  const cooldownCount = result.in_cooldown.length;
  if (cooldownCount === 0) {
    return (
      <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs text-success">
        Все {totalRequested.toLocaleString("ru-RU")} получателей свежие — за
        последние {result.cooldown_days} дней им не отправлялось.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2 text-sm text-warning">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
        <div>
          <strong>{cooldownCount}</strong> из {totalRequested.toLocaleString("ru-RU")}{" "}
          получателей на cooldown {result.cooldown_days} дней. Им уже отправляли
          сообщения недавно — повторная рассылка повышает риск бана.
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRemove(result.in_cooldown)}
        className="inline-flex items-center gap-1 rounded-lg bg-warning text-bg px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-all active:scale-95"
      >
        <Trash2 className="h-3 w-3" strokeWidth={2.5} />
        Убрать {cooldownCount} {cooldownCount === 1 ? "номер" : "номеров"}
      </button>
    </div>
  );
}
