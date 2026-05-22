"use client";

/**
 * `AntiBanWizard` — упрощённый «мастер 3 шагов» для anti-ban.
 *
 * Идея: вместо 24 параметров пользователь отвечает на 3 простых вопроса —
 * `Цель`, `Объём в сутки`, `Темп` — и мы сами вычисляем безопасный
 * `Partial<AntiBanConfig>` и передаём его в форму.
 *
 * После применения мастер сворачивается, и пользователь возвращается к
 * полной форме (или может остаться в Простом режиме).
 */

import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  MessageSquare,
  Rabbit,
  Search,
  Settings2,
  Shield,
  Snail,
  Sparkles,
  Zap,
} from "lucide-react";

import type { AntiBanConfig } from "@/lib/anti-ban";

type Goal = "check" | "broadcast" | "both";
type Pace = "safe" | "balanced" | "fast";

export interface AntiBanWizardProps {
  /** Применить вычисленный патч в родительскую форму. */
  onApply(patch: Partial<AntiBanConfig>): void;
  /** Закрыть мастер (вернуться в обычный режим). */
  onClose(): void;
}

const VOLUME_PRESETS: { value: number; label: string }[] = [
  { value: 100, label: "100 в сутки" },
  { value: 300, label: "300 в сутки" },
  { value: 500, label: "500 в сутки" },
  { value: 1000, label: "1000 в сутки" },
  { value: 2000, label: "2000+ в сутки" },
];

const PACE_OPTIONS: {
  id: Pace;
  label: string;
  description: string;
  icon: typeof Snail;
}[] = [
  {
    id: "safe",
    label: "Бережно",
    description: "Минимальный риск, медленнее",
    icon: Snail,
  },
  {
    id: "balanced",
    label: "Сбалансированно",
    description: "Рекомендуется для большинства",
    icon: Shield,
  },
  {
    id: "fast",
    label: "Быстро",
    description: "Максимальная скорость, риск выше",
    icon: Rabbit,
  },
];

const GOAL_OPTIONS: {
  id: Goal;
  label: string;
  description: string;
  icon: typeof Search;
}[] = [
  {
    id: "check",
    label: "Проверка номеров",
    description: "checkAccount-вызовы",
    icon: Search,
  },
  {
    id: "broadcast",
    label: "Рассылки",
    description: "Отправка сообщений",
    icon: MessageSquare,
  },
  {
    id: "both",
    label: "И то и другое",
    description: "Универсально",
    icon: Sparkles,
  },
];

/**
 * Конструктор патча на основе ответов мастера.
 * Базовые значения = «balanced»; целевая нагрузка влияет на лимиты,
 * темп — на длительность пауз и размер батча.
 */
function buildPatch(goal: Goal, volume: number, pace: Pace): Partial<AntiBanConfig> {
  const base: Partial<AntiBanConfig> = {
    delay_min: 3.0,
    delay_max: 7.0,
    batch_size: 50,
    long_pause_every_n: 50,
    long_pause_seconds: 60.0,
    broadcast_delay_min: 5.0,
    broadcast_jitter_max: 3.0,
    max_retries: 5,
    max_consecutive_429: 3,
  };

  if (pace === "safe") {
    base.delay_min = 5.0;
    base.delay_max = 15.0;
    base.batch_size = 25;
    base.long_pause_every_n = 25;
    base.long_pause_seconds = 120.0;
    base.broadcast_delay_min = 10.0;
    base.broadcast_jitter_max = 5.0;
    base.max_consecutive_429 = 2;
  } else if (pace === "fast") {
    base.delay_min = 2.0;
    base.delay_max = 5.0;
    base.batch_size = 80;
    base.long_pause_every_n = 80;
    base.long_pause_seconds = 30.0;
    base.broadcast_delay_min = 3.0;
    base.broadcast_jitter_max = 2.0;
    base.max_consecutive_429 = 3;
  }

  // Лимиты в сутки/час — из объёма
  const dailyMessageLimit = Math.max(100, volume);
  // Часовой = ~1/6 от дневного, минимум 30
  const hourlyCheckLimit = Math.max(30, Math.floor(dailyMessageLimit / 6));
  // Дневной лимит проверок — обычно 2× от сообщений (проверки дешевле)
  const dailyCheckLimit = goal === "broadcast"
    ? Math.max(500, dailyMessageLimit)
    : dailyMessageLimit * 2;

  return {
    ...base,
    daily_message_limit: dailyMessageLimit,
    hourly_check_limit: hourlyCheckLimit,
    daily_check_limit: dailyCheckLimit,
  };
}

export function AntiBanWizard({ onApply, onClose }: AntiBanWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [goal, setGoal] = useState<Goal>("both");
  const [volume, setVolume] = useState<number>(500);
  const [pace, setPace] = useState<Pace>("balanced");

  function apply() {
    onApply(buildPatch(goal, volume, pace));
    onClose();
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent-subtle/30 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-bg">
            <Zap className="h-4 w-4" strokeWidth={2.2} />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-text">Простой режим</h4>
            <p className="text-xs text-text-muted">
              Ответьте на 3 вопроса — мы сами подберём 24 параметра
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-text-muted hover:text-text underline-offset-2 hover:underline transition-colors"
        >
          Эксперт-режим
        </button>
      </div>

      {/* Stepper dots */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              n <= step ? "bg-accent" : "bg-border"
            }`}
          />
        ))}
        <span className="text-xs text-text-muted ml-2">{step}/3</span>
      </div>

      {/* Step 1: Goal */}
      {step === 1 && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-text">
            1. Что вы планируете делать чаще?
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {GOAL_OPTIONS.map((g) => {
              const Icon = g.icon;
              const active = goal === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGoal(g.id)}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${
                    active
                      ? "border-accent bg-accent/10 ring-1 ring-accent/40"
                      : "border-border bg-surface hover:border-border-focus"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 mt-0.5 ${active ? "text-accent" : "text-text-muted"}`}
                    strokeWidth={2}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text">
                      {g.label}
                    </div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {g.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-bg text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              Далее
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Volume */}
      {step === 2 && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-text">
            2. Сколько сообщений / проверок планируете в сутки?
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {VOLUME_PRESETS.map((p) => {
              const active = volume === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setVolume(p.value)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    active
                      ? "bg-accent text-bg ring-1 ring-accent/40"
                      : "bg-surface border border-border text-text-secondary hover:border-accent/40"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Или задайте точное число
            </label>
            <input
              type="number"
              min={50}
              max={5000}
              step={50}
              value={volume}
              onChange={(e) =>
                setVolume(
                  Math.max(50, Math.min(5000, Number(e.target.value) || 500)),
                )
              }
              className="w-32 px-3 py-2 bg-bg border border-border rounded-lg text-sm text-text focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-3 py-2 text-xs text-text-muted hover:text-text"
            >
              ← Назад
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-bg text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              Далее
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Pace */}
      {step === 3 && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-text">
            3. Какой темп предпочитаете?
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PACE_OPTIONS.map((p) => {
              const Icon = p.icon;
              const active = pace === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPace(p.id)}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${
                    active
                      ? "border-accent bg-accent/10 ring-1 ring-accent/40"
                      : "border-border bg-surface hover:border-border-focus"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 mt-0.5 ${active ? "text-accent" : "text-text-muted"}`}
                    strokeWidth={2}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text">
                      {p.label}
                    </div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {p.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary">
            <Settings2 className="inline h-3.5 w-3.5 mr-1 text-text-muted" />
            Будут установлены: пауза {pace === "safe" ? "5–15" : pace === "fast" ? "2–5" : "3–7"}{" "}
            сек, дневной лимит {volume}, длинная пауза каждые{" "}
            {pace === "safe" ? "25" : pace === "fast" ? "80" : "50"} запросов.
          </div>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="px-3 py-2 text-xs text-text-muted hover:text-text"
            >
              ← Назад
            </button>
            <button
              type="button"
              onClick={apply}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-bg text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
              Применить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AntiBanWizard;
