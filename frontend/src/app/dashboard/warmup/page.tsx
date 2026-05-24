"use client";

/**
 * `/dashboard/warmup` — страница прогрева MAX-аккаунта.
 *
 * MAX отслеживает «pure outbound» паттерн (только исходящие, нет ответов).
 * Аккаунт без двусторонней истории — это спам-сигнал, который ведёт к
 * быстрой блокировке. Прогрев — обязательный шаг перед массовой работой.
 *
 * Эта страница помогает оператору организовать прогрев:
 *   - визуальный план на 7 дней с рекомендованными активностями
 *   - текущий прогресс (сколько входящих/исходящих за 24ч/7д)
 *   - проверка готовности к массовой работе (≥7 дней + ≥5 incoming)
 */

import { useMemo } from "react";
import {
  Calendar,
  CheckCircle2,
  Flame,
  Loader2,
  Target,
} from "lucide-react";
import Link from "next/link";

import { useAccountHealth } from "@/lib/hooks/useAccountHealth";

interface WarmUpDay {
  day: number;
  title: string;
  goals: string[];
  outgoingTarget: { min: number; max: number };
  incomingTarget: { min: number; max: number };
}

const WARMUP_PLAN: WarmUpDay[] = [
  {
    day: 1,
    title: "Стартовая активность",
    goals: [
      "Отправить 1–2 личных сообщения близким контактам",
      "Заполнить профиль (имя, фото, био)",
      "Добавить 5–10 контактов в адресную книгу",
      "Прочитать пару чатов / каналов",
    ],
    outgoingTarget: { min: 1, max: 3 },
    incomingTarget: { min: 0, max: 2 },
  },
  {
    day: 2,
    title: "Первые ответы",
    goals: [
      "Отправить 3–5 сообщений (получить хотя бы 1 ответ)",
      "Вступить в 1–2 чата по интересам",
      "Обновить статус / историю",
    ],
    outgoingTarget: { min: 3, max: 6 },
    incomingTarget: { min: 1, max: 5 },
  },
  {
    day: 3,
    title: "Двусторонний трафик",
    goals: [
      "Отправить 5–10 сообщений с разными формулировками",
      "Получить минимум 3 ответа (response ratio > 30%)",
      "Реакции на сообщения в чатах",
    ],
    outgoingTarget: { min: 5, max: 12 },
    incomingTarget: { min: 3, max: 10 },
  },
  {
    day: 4,
    title: "Расширение",
    goals: [
      "10–15 сообщений в день, разные темы",
      "Активное общение в групповых чатах",
      "Отправка медиа (фото, документы)",
    ],
    outgoingTarget: { min: 10, max: 20 },
    incomingTarget: { min: 5, max: 15 },
  },
  {
    day: 5,
    title: "Активный пользователь",
    goals: [
      "20–30 сообщений / день",
      "Ответы на чужие сообщения в течение часа",
      "Создание собственного чата (опционально)",
    ],
    outgoingTarget: { min: 20, max: 30 },
    incomingTarget: { min: 10, max: 25 },
  },
  {
    day: 6,
    title: "Тест безопасных лимитов",
    goals: [
      "Можно начать единичные проверки номеров (до 5 в сутки)",
      "30–40 сообщений в день",
      "Проверка через PreFlight без warning-ов",
    ],
    outgoingTarget: { min: 30, max: 50 },
    incomingTarget: { min: 15, max: 30 },
  },
  {
    day: 7,
    title: "Готов к массовой работе",
    goals: [
      "Открыть «Состояние аккаунта» — должен показать «Здоров»",
      "Тестовая рассылка 10–20 сообщениям",
      "Тестовая проверка 10 номеров",
    ],
    outgoingTarget: { min: 50, max: 100 },
    incomingTarget: { min: 25, max: 50 },
  },
];

export default function WarmupPage() {
  const { primary, loading: healthLoading } = useAccountHealth(60_000);

  const currentDay = useMemo(() => {
    if (!primary) return 1;
    return Math.min(7, Math.max(1, primary.age_days + 1));
  }, [primary]);

  const isReady = useMemo(() => {
    if (!primary) return false;
    return primary.age_days >= 7 && primary.total_incoming >= 5;
  }, [primary]);

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <Flame className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          Прогрев аккаунта
        </h1>
        <p className="text-text-muted text-sm mt-1 max-w-2xl">
          MAX блокирует аккаунты, которые сразу бросаются на массовую работу
          без истории. Прогрев — 7-дневный план двустороннего общения, который
          превращает «ботоподобный» аккаунт в «настоящий».
        </p>
      </header>

      {/* Status */}
      {healthLoading ? (
        <div className="flex items-center gap-3 text-text-muted text-sm">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Загрузка статуса…
        </div>
      ) : !primary ? (
        <div className="rounded-2xl border border-warning/30 bg-warning-bg p-4 text-sm text-warning">
          Подключите GREEN-API инстанс в{" "}
          <Link href="/dashboard/settings/instances" className="underline">
            настройках
          </Link>
          , чтобы начать отслеживать прогрев.
        </div>
      ) : isReady ? (
        <div className="rounded-2xl border border-success/30 bg-success-bg p-5 flex items-start gap-3">
          <CheckCircle2 className="h-6 w-6 text-success mt-0.5" strokeWidth={2} />
          <div>
            <h3 className="text-sm font-semibold text-success">
              Аккаунт прогрет!
            </h3>
            <p className="text-xs text-success/90 mt-1">
              Возраст: {primary.age_days} дн. Входящих за всё время: {primary.total_incoming}.
              Можно запускать массовую работу. Соблюдайте лимиты:{" "}
              <Link href="/dashboard/health" className="underline">
                /dashboard/health
              </Link>
              .
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-accent/30 bg-accent/10 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <Target className="h-6 w-6 text-accent mt-0.5" strokeWidth={2} />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-text">
                День {currentDay} из 7
              </h3>
              <p className="text-xs text-text-muted mt-1">
                Сейчас аккаунту {primary.age_days} дн. Получено{" "}
                {primary.total_incoming} входящих. До готовности —{" "}
                {Math.max(0, 7 - primary.age_days)} дней и{" "}
                {Math.max(0, 5 - primary.total_incoming)} входящих.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ProgressBar
              label="Возраст"
              value={primary.age_days}
              max={7}
              suffix="/ 7 дней"
            />
            <ProgressBar
              label="Входящих"
              value={primary.total_incoming}
              max={5}
              suffix="/ 5 ответов"
            />
          </div>
        </div>
      )}

      {/* Plan */}
      <section className="rounded-2xl border border-border bg-surface p-5 space-y-4">
        <h2 className="text-base font-semibold text-text inline-flex items-center gap-2">
          <Calendar className="h-4 w-4 text-accent" strokeWidth={2} /> План на 7 дней
        </h2>
        <div className="space-y-3">
          {WARMUP_PLAN.map((day) => {
            const isActive = day.day === currentDay;
            const isPast = day.day < currentDay;
            return (
              <div
                key={day.day}
                className={`rounded-xl border px-4 py-3 ${
                  isActive
                    ? "border-accent bg-accent/10"
                    : isPast
                      ? "border-success/30 bg-success-bg/50"
                      : "border-border bg-bg-elevated/50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        isPast
                          ? "bg-success text-bg"
                          : isActive
                            ? "bg-accent text-bg"
                            : "bg-bg-elevated text-text-muted border border-border"
                      }`}
                    >
                      {isPast ? <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} /> : day.day}
                    </span>
                    <h3 className="font-semibold text-text">{day.title}</h3>
                  </div>
                  <span className="text-xs text-text-muted font-mono">
                    {day.outgoingTarget.min}–{day.outgoingTarget.max} исх. ·{" "}
                    {day.incomingTarget.min}–{day.incomingTarget.max} вх.
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-text-secondary ml-8">
                  {day.goals.map((g, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-text-muted">·</span>
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ProgressBar({
  label,
  value,
  max,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
}) {
  const pct = Math.min(100, (value / Math.max(1, max)) * 100);
  const reached = value >= max;
  return (
    <div className="rounded-lg bg-bg-elevated/60 border border-border px-3 py-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-text">{label}</span>
        <span className="text-text-muted font-mono">
          {value} {suffix ?? `/ ${max}`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-bg overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${reached ? "bg-success" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
