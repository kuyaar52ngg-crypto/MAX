"use client";

/**
 * `OnboardingChecklist` — приветственный баннер на главной dashboard.
 *
 * Показывает 4 ключевых шага для нового пользователя:
 *   1. Подключить GREEN-API инстанс
 *   2. Прогреть аккаунт (≥7 дней + ≥5 incoming)
 *   3. Импортировать первые контакты
 *   4. Сделать первую тестовую рассылку
 *
 * Шаги автоматически отмечаются как выполненные при успехе. Пользователь
 * может закрыть баннер локально через `dismissed:onboarding` в localStorage —
 * или он сам пропадает, когда все 4 шага закрыты.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Flame,
  Megaphone,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import type { AccountHealthData } from "@/lib/anti-ban/health";

const DISMISS_KEY = "onboarding:dismissed";

export interface OnboardingChecklistProps {
  /** primary health-snapshot пользователя (null если ничего не подключено). */
  health: AccountHealthData | null;
  /** Сколько раз пользователь запускал рассылку (broadcasts_started). */
  broadcastsStarted24h: number;
  /** Total broadcasts ever — нужен чтобы понять, была ли когда-либо рассылка. */
  hasEverBroadcast: boolean;
}

interface Step {
  id: string;
  title: string;
  description: string;
  icon: typeof ShieldCheck;
  href: string;
  cta: string;
  done: boolean;
}

export function OnboardingChecklist({
  health,
  broadcastsStarted24h,
  hasEverBroadcast,
}: OnboardingChecklistProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      /* */
    }
  }, []);

  const steps: Step[] = useMemo(() => {
    // Шаг 1: подключить инстанс — primary health не null
    const step1Done = health !== null;
    // Шаг 2: прогреть аккаунт — status "ok" или возраст ≥7 дней с total_incoming ≥5
    const step2Done =
      health !== null &&
      (health.status === "ok" ||
        (health.age_days >= 7 && health.total_incoming >= 5));
    // Шаг 3: импортировать контакты — нет точного метрика, поэтому считаем сделанным,
    // если когда-либо была рассылка ИЛИ пользователь сам закрыл онбординг
    const step3Done = hasEverBroadcast;
    // Шаг 4: первая рассылка
    const step4Done = hasEverBroadcast;

    return [
      {
        id: "instance",
        title: "Подключите GREEN-API инстанс",
        description:
          "idInstance + apiTokenInstance. Если у вас нет своих — попросите у владельца аккаунта.",
        icon: ShieldCheck,
        href: "/dashboard/settings/instances",
        cta: "К настройкам инстансов",
        done: step1Done,
      },
      {
        id: "warmup",
        title: "Прогрейте аккаунт",
        description:
          "Минимум 7 дней реального общения и 5 входящих сообщений. Без прогрева MAX банит за 100+ массовых действий.",
        icon: Flame,
        href: "/dashboard/warmup",
        cta: "Открыть план прогрева",
        done: step2Done,
      },
      {
        id: "contacts",
        title: "Импортируйте контакты",
        description:
          "CSV или ручной ввод. Затем фильтруйте через cooldown-чекер, чтобы не написать кому-то дважды.",
        icon: ClipboardList,
        href: "/dashboard/broadcast",
        cta: "Открыть рассылку",
        done: step3Done,
      },
      {
        id: "first-broadcast",
        title: "Первая тестовая рассылка",
        description:
          "Начните с 5–10 знакомых номеров. PreFlight проверит health и подскажет лимиты.",
        icon: Megaphone,
        href: "/dashboard/broadcast",
        cta: "Запустить рассылку",
        done: step4Done,
      },
    ];
  }, [health, hasEverBroadcast]);

  const allDone = steps.every((s) => s.done);
  const completedCount = steps.filter((s) => s.done).length;

  // Не показываем если всё сделано или явно скрыто пользователем.
  if (allDone || dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* */
    }
    setDismissed(true);
  }

  // Подсветим первый невыполненный шаг как «следующий».
  const nextStepIdx = steps.findIndex((s) => !s.done);

  return (
    <section className="relative rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/10 via-bg to-bg-elevated p-5 lg:p-6 overflow-hidden">
      <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-accent/20 blur-3xl" />
      <button
        type="button"
        onClick={dismiss}
        aria-label="Скрыть"
        className="absolute right-3 top-3 z-10 p-1 rounded-lg text-text-muted hover:bg-bg/50 transition-colors"
      >
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-4 w-4 text-accent" strokeWidth={2.5} />
          <span className="text-xs font-bold uppercase tracking-wider text-accent">
            Первые шаги · {completedCount} / {steps.length}
          </span>
        </div>
        <h2 className="text-xl font-bold text-text">
          Запустите свою первую безопасную рассылку
        </h2>
        <p className="text-sm text-text-muted mt-1 max-w-2xl">
          Этот чек-лист сильно снижает шанс бана MAX-аккаунта. Шаги отмечаются
          автоматически при выполнении.
        </p>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            const isNext = idx === nextStepIdx;
            return (
              <Link
                key={step.id}
                href={step.href}
                className={`block rounded-xl border p-4 transition-all hover:-translate-y-0.5 ${
                  step.done
                    ? "border-success/30 bg-success-bg/40 opacity-75"
                    : isNext
                      ? "border-accent/40 bg-bg shadow-glow"
                      : "border-border bg-bg-elevated/50 hover:border-accent/30"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                      step.done
                        ? "bg-success text-bg"
                        : isNext
                          ? "bg-accent text-bg"
                          : "bg-bg-elevated text-text-muted"
                    }`}
                  >
                    {step.done ? (
                      <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} />
                    ) : (
                      <Icon className="h-4 w-4" strokeWidth={2} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3
                        className={`text-sm font-semibold ${step.done ? "text-success line-through" : "text-text"}`}
                      >
                        {step.title}
                      </h3>
                      {isNext && (
                        <span className="text-[10px] uppercase tracking-wider font-bold text-accent">
                          Дальше
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      {step.description}
                    </p>
                    {!step.done && (
                      <div className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent">
                        {step.cta}
                        <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {broadcastsStarted24h > 0 && (
          <p className="mt-4 text-xs text-text-muted italic">
            Сегодня уже было {broadcastsStarted24h}{" "}
            {broadcastsStarted24h === 1 ? "рассылка" : "рассылок"}. Так держать.
          </p>
        )}
      </div>
    </section>
  );
}
