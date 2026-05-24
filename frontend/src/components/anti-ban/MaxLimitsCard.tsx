"use client";

/**
 * `MaxLimitsCard` — образовательная карточка про реальные лимиты MAX.
 *
 * Источник: https://max-catalog24.ru/limits.html (Sheiker community).
 * Эти значения — не теория, а результат практических тестов команды
 * Sheiker. Их превышение приводит к немедленному бану аккаунта на
 * стороне MAX (не GREEN-API).
 *
 * Используется в /dashboard/health и /dashboard/contacts для
 * информирования пользователя ДО запуска операций.
 */

import { Activity, MessageSquare, Phone, UserPlus } from "lucide-react";

const LIMITS = [
  {
    icon: MessageSquare,
    title: "Сообщения новым пользователям",
    safe: "до 50 в день (после прогрева)",
    danger: "более 100 = бан",
    hint: "Персонализация + задержка ≥15с",
    tone: "warning" as const,
  },
  {
    icon: UserPlus,
    title: "Вступление в чаты",
    safe: "до 500 в день",
    danger: "более 500 = риск",
    hint: "Задержка ≥10с",
    tone: "info" as const,
  },
  {
    icon: Activity,
    title: "Инвайтинг в чаты",
    safe: "100–300 приглашений",
    danger: "более 1000 = бан",
    hint: "Без прогрева — высокий шанс. Задержка ≥15с",
    tone: "warning" as const,
  },
  {
    icon: Phone,
    title: "Проверка номеров",
    safe: "1–10 единичных, не более 20 в день",
    danger: "более 20 = немедленный бан",
    hint: "Не подряд, чередовать с другими действиями",
    tone: "error" as const,
  },
];

const TONE_BG = {
  info: "bg-accent/10 border-accent/30 text-accent",
  warning: "bg-warning-bg border-warning/30 text-warning",
  error: "bg-error-bg border-error/30 text-error",
} as const;

export function MaxLimitsCard() {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">
          Реальные лимиты MAX
        </h3>
        <p className="text-xs text-text-muted mt-1">
          Официальных лимитов MAX не публикует. Цифры основаны на практических
          тестах сообщества Sheiker. Их превышение особенно на свежих
          аккаунтах ведёт к немедленному бану.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {LIMITS.map((limit) => {
          const Icon = limit.icon;
          return (
            <div
              key={limit.title}
              className={`rounded-xl border px-4 py-3 ${TONE_BG[limit.tone]}`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Icon className="h-4 w-4" strokeWidth={2} />
                {limit.title}
              </div>
              <div className="text-xs mt-2 space-y-1">
                <div>
                  <span className="opacity-75">Безопасно:</span> {limit.safe}
                </div>
                <div className="font-medium">{limit.danger}</div>
                <div className="opacity-90 italic">{limit.hint}</div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-text-muted">
        Источник: <a href="https://max-catalog24.ru/limits.html" target="_blank" rel="noopener noreferrer" className="text-accent underline">max-catalog24.ru/limits.html</a>
      </p>
    </div>
  );
}
