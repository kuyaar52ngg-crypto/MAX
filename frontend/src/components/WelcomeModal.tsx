"use client";

import { useEffect, useState } from "react";
import {
  KeyRound,
  Megaphone,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const STORAGE_PREFIX = "max:welcome-seen:";

interface WelcomeModalProps {
  /**
   * If provided, the modal is bound to this user id. Otherwise we fetch the
   * current user once on mount.
   */
  userId?: string | null;
}

/**
 * Первый экран, который видит пользователь после регистрации/первого входа.
 * Кратко рассказывает, что умеет MAX, и закрывается кнопкой «Начать».
 *
 * Хранение факта показа — в localStorage, ключ привязан к user.id, чтобы
 * разные аккаунты в одном браузере получали приветствие независимо.
 */
export function WelcomeModal({ userId: providedUserId }: WelcomeModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(providedUserId ?? null);

  useEffect(() => {
    if (providedUserId !== undefined) {
      setResolvedUserId(providedUserId ?? null);
      return;
    }
    const supabase = createClient();
    supabase.auth
      .getUser()
      .then((result: { data: { user: { id?: string | null } | null } }) => {
        setResolvedUserId(result.data.user?.id ?? null);
      })
      .catch(() => setResolvedUserId(null));
  }, [providedUserId]);

  useEffect(() => {
    if (!resolvedUserId) return;
    if (typeof window === "undefined") return;
    try {
      const seen = window.localStorage.getItem(STORAGE_PREFIX + resolvedUserId);
      if (!seen) setOpen(true);
    } catch {
      // localStorage может быть недоступен (private mode, политика домена) —
      // просто не показываем модалку, чтобы не падать.
    }
  }, [resolvedUserId]);

  function close() {
    setOpen(false);
    if (resolvedUserId && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + resolvedUserId, "1");
      } catch {
        // ignore
      }
    }
  }

  function handleStart() {
    close();
    router.push("/dashboard/settings");
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={close} aria-hidden="true" />
      <div className="glass-strong relative w-full max-w-lg max-h-[calc(100vh-3rem)] overflow-y-auto rounded-3xl">
        <div className="absolute top-0 left-0 right-0 h-1 rounded-t-3xl bg-gradient-to-r from-transparent via-accent-light to-transparent pointer-events-none" />
        <button
          onClick={close}
          aria-label="Закрыть"
          className="absolute top-4 right-4 p-1.5 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <div className="p-8 space-y-6">
          <div className="flex items-center gap-3">
            <span className="p-2 rounded-xl bg-accent-subtle text-accent-light">
              <Sparkles className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
            </span>
            <h2 className="text-xl font-bold text-text">Добро пожаловать в MAX</h2>
          </div>

          <p className="text-sm leading-6 text-text-secondary">
            MAX — это рабочее пространство для бизнес-коммуникаций в WhatsApp на базе GREEN-API.
            Отвечайте на сообщения, ведите рассылки и проверяйте контакты в одном окне.
          </p>

          <ul className="space-y-3">
            <Feature
              icon={<MessageCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
              title="Мессенджер"
              text="Все ваши чаты и группы WhatsApp с историей сообщений, медиа, локациями и контактами."
            />
            <Feature
              icon={<Megaphone className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
              title="Рассылки и шаблоны"
              text="CSV-импорт, переменные в тексте, прогресс в реальном времени и журнал доставки."
            />
            <Feature
              icon={<ShieldCheck className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
              title="Проверка номеров"
              text="Перед массовой отправкой убедитесь, что получатели зарегистрированы в WhatsApp."
            />
            <Feature
              icon={<KeyRound className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
              title="GREEN-API"
              text="Интеграция работает по вашему ключу. Подключите инстанс в настройках в один клик."
            />
          </ul>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={close}
              className="px-4 py-2.5 bg-surface hover:bg-surface-hover text-text font-bold rounded-xl border border-border transition-colors"
            >
              Пропустить
            </button>
            <button
              type="button"
              onClick={handleStart}
              className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg font-bold rounded-xl shadow-md transition-colors"
            >
              Начать
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 flex h-9 w-9 items-center justify-center rounded-xl bg-bg-elevated text-text">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-text">{title}</div>
        <p className="text-xs leading-5 text-text-muted mt-0.5">{text}</p>
      </div>
    </li>
  );
}

export default WelcomeModal;
