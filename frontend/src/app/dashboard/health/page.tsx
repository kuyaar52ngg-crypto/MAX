"use client";

/**
 * `/dashboard/health` — страница состояния аккаунта.
 *
 * Показывает оценку health primary-инстанса, метрики, чеклист прогрева
 * и рекомендации. Открывается из dashboard-overview, ссылка с других
 * страниц (Settings → анти-бан, например).
 */

import { HeartPulse } from "lucide-react";
import Link from "next/link";

import { AccountHealthPanel } from "@/components/anti-ban/AccountHealthPanel";

export default function HealthPage() {
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <header>
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg shadow-sm">
          <HeartPulse className="h-5 w-5" strokeWidth={2.2} />
        </div>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-text">
          Состояние аккаунта
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Анализ риска бана для primary-инстанса GREEN-API. Если статус не
          «здоров», система блокирует или ограничивает массовые операции.
        </p>
      </header>

      <AccountHealthPanel />

      <section className="rounded-2xl border border-border bg-surface p-5 space-y-2">
        <h3 className="text-sm font-semibold text-text">Что делать при бане</h3>
        <ul className="text-sm text-text-secondary space-y-2">
          <li>
            <strong>Жёлтая карточка (yellowCard).</strong> Soft-бан GREEN-API.
            Не дёргайте инстанс 24 часа — статус снимется сам. Health-job
            проверяет каждые 5 минут.
          </li>
          <li>
            <strong>Заблокирован (blocked).</strong> Hard-бан. Откройте{" "}
            <a
              href="https://console.green-api.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              console.green-api.com
            </a>{" "}
            и попросите владельца аккаунта сделать reset инстанса. Иногда
            требуется новый idInstance.
          </li>
          <li>
            <strong>Бан самого MAX-аккаунта</strong> (приложение пишет «Аккаунт
            заблокирован»). Это блок VK Tech, не GREEN-API. Подождите 1–3 дня
            или используйте другой номер.{" "}
            <Link href="/dashboard/settings/instances" className="text-accent underline">
              Подключите второй инстанс
            </Link>
            , не теряя первый.
          </li>
        </ul>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 space-y-2">
        <h3 className="text-sm font-semibold text-text">Профилактика</h3>
        <ul className="text-sm text-text-secondary space-y-2">
          <li>
            Используйте preset «Бережный» в{" "}
            <Link href="/dashboard/settings" className="text-accent underline">
              настройках анти-бана
            </Link>{" "}
            — особенно для свежих аккаунтов и сразу после yellowCard.
          </li>
          <li>
            Не запускайте больше 100 проверок номеров в сутки на свежем
            аккаунте — даже если кажется, что «ничего не случится».
          </li>
          <li>
            Сначала прогрейте: 7 дней нормального общения с реальными контактами,
            минимум 5 входящих ответов, никаких массовых операций.
          </li>
          <li>
            Распределяйте нагрузку между несколькими инстансами через{" "}
            <Link href="/dashboard/settings/instances" className="text-accent underline">
              GREEN-API инстансы
            </Link>{" "}
            (до 5 одновременно).
          </li>
        </ul>
      </section>
    </div>
  );
}
