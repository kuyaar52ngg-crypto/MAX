"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  KeyRound,
  Loader2,
  Megaphone,
  MessageCircle,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { nxGet, nxPost } from "@/lib/api";

interface ProfileResponse {
  display_name: string;
  welcomed_at: string | null;
  has_credentials: boolean;
}

export default function WelcomePage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [userName, setUserName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (error) throw error;
        if (cancelled) return;
        if (!data.user) {
          router.replace("/login");
          return;
        }
        const md = (data.user.user_metadata || {}) as Record<string, unknown>;
        const seedName =
          (typeof md.full_name === "string" && md.full_name) ||
          (typeof md.name === "string" && md.name) ||
          (data.user.email ? data.user.email.split("@")[0] : "");
        setUserName(seedName);

        // Если юзер уже видел онбординг — отправляем сразу в дашборд.
        try {
          const profile = await nxGet<ProfileResponse>("/api/profile/credentials");
          if (!cancelled && profile.welcomed_at) {
            router.replace("/dashboard");
            return;
          }
        } catch {
          // Профиль может быть недоступен (редкий случай) — не блокируем
          // отображение лендинга, юзер просто увидит онбординг ещё раз.
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Не удалось загрузить профиль");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function handleStart(target: "/dashboard/settings" | "/dashboard") {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await nxPost("/api/profile/welcome", {});
    } catch (err: unknown) {
      // Не блокируем переход на дашборд из-за оборванного флага.
      console.warn("welcome flag failed:", err instanceof Error ? err.message : err);
    } finally {
      router.replace(target);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-text-muted">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg text-text">
      {/* Background flourishes — same vibe as login */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-accent-light/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 -right-32 w-80 h-80 bg-info/20 rounded-full blur-[100px] pointer-events-none" />
      <div
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(17,17,17,0.18) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(17,17,17,0.18) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-12">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-text-secondary shadow-sm">
          <Sparkles className="h-3.5 w-3.5 text-accent-light" strokeWidth={2.2} aria-hidden="true" />
          Добро пожаловать в MAX
        </div>

        <h1 className="text-center text-4xl font-black leading-[1.05] tracking-[-0.04em] text-text sm:text-5xl lg:text-6xl">
          {userName ? <>Привет, {userName.split(" ")[0]}.</> : "Добро пожаловать."}
          <br />
          <span className="gradient-text">Соберите бизнес-чат в один пульт.</span>
        </h1>

        <p className="mt-5 max-w-2xl text-center text-base leading-7 text-text-muted">
          MAX — рабочее пространство поверх WhatsApp на базе GREEN-API. Чаты, рассылки,
          проверка контактов и шаблоны в одном окне. Это займёт пару минут на настройку.
        </p>

        <div className="mt-10 grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
          <Feature
            icon={<MessageCircle className="h-5 w-5" strokeWidth={2.2} aria-hidden="true" />}
            title="Мессенджер"
            text="Все чаты и группы WhatsApp с историей сообщений, медиа, локациями и контактами."
          />
          <Feature
            icon={<Megaphone className="h-5 w-5" strokeWidth={2.2} aria-hidden="true" />}
            title="Рассылки"
            text="CSV-импорт, переменные в тексте, прогресс в реальном времени и журнал доставки."
          />
          <Feature
            icon={<ShieldCheck className="h-5 w-5" strokeWidth={2.2} aria-hidden="true" />}
            title="Проверка номеров"
            text="Очистите базу до отправки — узнайте, кто из получателей реально в WhatsApp."
          />
          <Feature
            icon={<KeyRound className="h-5 w-5" strokeWidth={2.2} aria-hidden="true" />}
            title="Свой GREEN-API"
            text="Подключайте свой инстанс. Ключи хранятся у вас в профиле, никаких посредников."
          />
        </div>

        {error && (
          <div className="mt-6 max-w-md rounded-xl bg-error-bg border border-error/20 px-4 py-2 text-sm text-error">
            {error}
          </div>
        )}

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
          <button
            type="button"
            onClick={() => handleStart("/dashboard/settings")}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-7 py-3.5 text-base font-bold text-bg shadow-lg transition-all hover:bg-accent-hover hover:shadow-glow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Settings className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
            )}
            Подключить GREEN-API и начать
          </button>
          <button
            type="button"
            onClick={() => handleStart("/dashboard")}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm font-semibold text-text transition-all hover:border-border-focus hover:bg-surface-hover disabled:opacity-50"
          >
            Перейти в дашборд
            <ArrowRight className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <p className="mt-8 text-center text-xs text-text-muted">
          Можно вернуться к этой странице через настройки в любой момент.
        </p>
      </div>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-glow">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-elevated text-text">
        {icon}
      </div>
      <div className="mt-4 text-sm font-bold text-text">{title}</div>
      <p className="mt-1.5 text-xs leading-5 text-text-muted">{text}</p>
    </div>
  );
}
