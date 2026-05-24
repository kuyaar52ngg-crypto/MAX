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
 *   - готовые тексты «дружественных» сообщений (рандомизация {a|b|c})
 *   - проверка готовности к массовой работе (≥7 дней + ≥5 incoming)
 *   - кнопка «Отправить тестовое сообщение» (вызывает существующий
 *     endpoint /api/send-message)
 *
 * Отличие от Sheiker: у нас не «AI-чат между своими аккаунтами»
 * (это очень палевно — MAX легко детектит бота-к-боту), а **умный
 * план реального двустороннего взаимодействия** + готовые тексты.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Copy,
  Flame,
  Loader2,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import Link from "next/link";

import { apiPost } from "@/lib/api";
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
      "Открыть `/dashboard/health` — должен показать «Здоров»",
      "Тестовая рассылка 10–20 сообщениям",
      "Тестовая проверка 10 номеров",
    ],
    outgoingTarget: { min: 50, max: 100 },
    incomingTarget: { min: 25, max: 50 },
  },
];

const SAMPLE_MESSAGES: { context: string; text: string }[] = [
  {
    context: "Знакомым",
    text: "{Привет|Здравствуй|Привет, как дела} {!|? }Давно не общались, как у тебя {жизнь|дела|прошёл день}?",
  },
  {
    context: "Поздравление с праздником",
    text: "{С праздником|Хорошего дня|Поздравляю}! {Пусть всё будет хорошо|Мирного неба|Удачи во всём} 🌸",
  },
  {
    context: "Деловой контакт",
    text: "Доброго дня! Хотел уточнить — {актуально ли|в силе ли|на повестке ли} наше {предложение|обсуждение|сотрудничество}?",
  },
  {
    context: "Возобновление общения",
    text: "{Привет|Доброго времени суток}! Вспомнил про тебя — {как поживаешь|как дела|чем занят сейчас}?",
  },
];

interface SendTestState {
  phone: string;
  loading: boolean;
  error: string | null;
  ok: boolean;
}

export default function WarmupPage() {
  const { primary, loading: healthLoading } = useAccountHealth(60_000);
  const [sendTest, setSendTest] = useState<SendTestState>({
    phone: "",
    loading: false,
    error: null,
    ok: false,
  });
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const currentDay = useMemo(() => {
    if (!primary) return 1;
    return Math.min(7, Math.max(1, primary.age_days + 1));
  }, [primary]);

  const isReady = useMemo(() => {
    if (!primary) return false;
    return primary.age_days >= 7 && primary.total_incoming >= 5;
  }, [primary]);

  async function copyText(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      /* */
    }
  }

  async function sendTestMessage() {
    const phone = sendTest.phone.replace(/\D+/g, "");
    if (phone.length < 10) {
      setSendTest((s) => ({ ...s, error: "Введите номер целиком (10+ цифр)" }));
      return;
    }
    setSendTest((s) => ({ ...s, loading: true, error: null, ok: false }));
    try {
      // Сначала найдём chatId через /api/check-contact
      const check = await apiPost<{ exists: boolean; chatId?: string }>(
        "/api/check-contact",
        { phone },
      );
      if (!check.exists || !check.chatId) {
        setSendTest((s) => ({
          ...s,
          loading: false,
          error: "Номер не найден в MAX",
        }));
        return;
      }
      await apiPost("/api/send-message", {
        chatId: check.chatId,
        message:
          "Привет! Это тестовое сообщение для прогрева аккаунта. Игнорируй или ответь как есть 🙂",
      });
      setSendTest((s) => ({ ...s, loading: false, ok: true, error: null }));
    } catch (e: unknown) {
      setSendTest((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : "Не удалось отправить",
      }));
    }
  }

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

      {/* Sample messages */}
      <section className="rounded-2xl border border-border bg-surface p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-text inline-flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" strokeWidth={2} /> Готовые тексты для прогрева
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Рандомизация через <code className="font-mono text-text">{"{a|b|c}"}</code>{" "}
            — каждый получатель получит свой вариант. Это снижает «спам-paтерн»
            одинаковых текстов.
          </p>
        </div>
        <div className="space-y-2">
          {SAMPLE_MESSAGES.map((m, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-border bg-bg-elevated p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-muted inline-flex items-center gap-1">
                  <Users className="h-3 w-3" strokeWidth={2} /> {m.context}
                </span>
                <button
                  type="button"
                  onClick={() => copyText(m.text, idx)}
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <Copy className="h-3 w-3" strokeWidth={2.5} />
                  {copiedIdx === idx ? "Скопировано" : "Копировать"}
                </button>
              </div>
              <pre className="text-sm text-text whitespace-pre-wrap font-mono break-words">
                {m.text}
              </pre>
            </div>
          ))}
        </div>
      </section>

      {/* Send test message */}
      <section className="rounded-2xl border border-border bg-surface p-5 space-y-3">
        <h2 className="text-base font-semibold text-text">
          Отправить тестовое сообщение
        </h2>
        <p className="text-xs text-text-muted">
          Быстрая отправка одного сообщения на свой номер или знакомому.
          Учитывается в счётчике activity и помогает прогреву.
        </p>
        <div className="flex gap-2">
          <input
            type="tel"
            value={sendTest.phone}
            onChange={(e) =>
              setSendTest((s) => ({ ...s, phone: e.target.value, ok: false, error: null }))
            }
            placeholder="79991234567"
            className="flex-1 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text font-mono focus:outline-none focus:border-accent/50"
          />
          <button
            type="button"
            onClick={sendTestMessage}
            disabled={sendTest.loading || sendTest.phone.replace(/\D+/g, "").length < 10}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-medium rounded-lg disabled:opacity-50 transition-all active:scale-95"
          >
            {sendTest.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
            ) : (
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />
            )}
            Отправить
          </button>
        </div>
        {sendTest.ok && (
          <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs text-success inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
            Сообщение отправлено. Через минуту обнови `/dashboard/health` — счётчики
            активности обновятся.
          </div>
        )}
        {sendTest.error && (
          <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-xs text-error inline-flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.5} />
            {sendTest.error}
          </div>
        )}
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
