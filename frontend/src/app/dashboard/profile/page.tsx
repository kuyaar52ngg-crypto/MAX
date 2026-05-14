"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Camera,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { clearAllCredentials, nxGet, nxPost } from "@/lib/api";

interface ProfileState {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  provider: string;
  createdAt: string | null;
}

interface ProfileApiResponse {
  display_name: string;
  avatar_url: string | null;
  green_api_id: string;
  green_api_token: string;
  green_api_url: string;
  has_credentials: boolean;
}

export default function ProfilePage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [avatarInput, setAvatarInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
          (typeof md.user_name === "string" && md.user_name) ||
          (data.user.email ? data.user.email.split("@")[0] : "");
        const seedAvatar =
          (typeof md.avatar_url === "string" && md.avatar_url) ||
          (typeof md.picture === "string" && md.picture) ||
          null;

        let displayName = seedName;
        let avatarUrl: string | null = seedAvatar;

        // Параллельно тянем профиль из Prisma — там может быть имя/аватар,
        // которые юзер сохранил руками. Игнорируем 401/500 — это не блокирует
        // отображение страницы.
        try {
          const dbProfile = await nxGet<ProfileApiResponse>("/api/profile/credentials");
          if (dbProfile.display_name) displayName = dbProfile.display_name;
          if (dbProfile.avatar_url) avatarUrl = dbProfile.avatar_url;
        } catch {
          // ignore
        }

        const next: ProfileState = {
          id: data.user.id,
          email: data.user.email || "",
          displayName,
          avatarUrl,
          provider:
            (typeof data.user.app_metadata?.provider === "string" && data.user.app_metadata.provider) ||
            "email",
          createdAt: data.user.created_at || null,
        };
        if (cancelled) return;
        setProfile(next);
        setName(next.displayName);
        setAvatarInput(next.avatarUrl || "");
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

  async function handleSave() {
    if (!profile) return;
    const trimmedName = name.trim();
    const trimmedAvatar = avatarInput.trim();
    if (!trimmedName) {
      setError("Имя не может быть пустым");
      return;
    }
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      // Сохраняем в нашу БД (Prisma profiles).
      const updated = await nxPost<ProfileApiResponse>("/api/profile/credentials", {
        display_name: trimmedName,
        avatar_url: trimmedAvatar,
      });

      // Дублируем имя в supabase user_metadata.full_name, чтобы шапка
      // (которая читает оттуда) тоже обновилась без перелогина.
      try {
        await supabase.auth.updateUser({
          data: {
            full_name: trimmedName,
            ...(trimmedAvatar ? { avatar_url: trimmedAvatar } : {}),
          },
        });
      } catch {
        // не критично — БД сохранена
      }

      setProfile({
        ...profile,
        displayName: updated.display_name || trimmedName,
        avatarUrl: updated.avatar_url || (trimmedAvatar || null),
      });
      setName(updated.display_name || trimmedName);
      setAvatarInput(updated.avatar_url || trimmedAvatar);
      setSavedAt(Date.now());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить профиль");
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    clearAllCredentials();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const formattedCreatedAt = useMemo(() => {
    if (!profile?.createdAt) return "—";
    const d = new Date(profile.createdAt);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("ru", { day: "2-digit", month: "long", year: "numeric" });
  }, [profile?.createdAt]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="flex items-center justify-center py-20 text-text-muted">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="px-4 py-3 rounded-xl bg-error-bg border border-error/20 text-error text-sm">
          {error || "Профиль недоступен"}
        </div>
      </div>
    );
  }

  const previewAvatar = avatarInput.trim() || profile.avatarUrl;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-8 lg:px-8 lg:py-10">
      <div>
        <h1 className="text-2xl font-bold text-text flex items-center gap-2">
          <UserCircle className="h-6 w-6 text-text-muted" strokeWidth={2} aria-hidden="true" />
          Личный кабинет
        </h1>
        <p className="text-text-muted text-sm mt-1">Профиль и аккаунт</p>
      </div>

      <div className="glass rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <div className="h-20 w-20 rounded-full overflow-hidden bg-gradient-to-br from-accent to-accent-light flex items-center justify-center text-2xl font-bold text-white shadow-md">
              {previewAvatar ? (
                <img
                  src={previewAvatar}
                  alt=""
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                (profile.displayName || profile.email || "M").charAt(0).toUpperCase()
              )}
            </div>
            {!previewAvatar && (
              <span className="absolute bottom-0 right-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface border border-border text-text-muted">
                <Camera className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-text truncate">
              {profile.displayName || "Без имени"}
            </div>
            <div className="text-xs text-text-muted truncate flex items-center gap-1.5 mt-0.5">
              <Mail className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              {profile.email || "—"}
            </div>
            <div className="text-[11px] text-text-muted mt-1.5">
              Регистрация: {formattedCreatedAt}
            </div>
          </div>
        </div>

        <div className="space-y-4 border-t border-border pt-5">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">
              Отображаемое имя
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              className="w-full px-4 py-2.5 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all"
              placeholder="Как к вам обращаться"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">
              Ссылка на аватар
            </label>
            <input
              type="url"
              value={avatarInput}
              onChange={(e) => setAvatarInput(e.target.value)}
              className="w-full px-4 py-2.5 bg-bg-elevated border border-border rounded-xl text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all"
              placeholder="https://..."
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Если вы вошли через Google, аватар подставлен автоматически. Можно заменить на любую ссылку или очистить поле.
            </p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-bg border border-error/20 text-error text-xs">
              {error}
            </div>
          )}
          {savedAt && !error && (
            <div className="px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-success text-xs">
              Сохранено
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-bold rounded-xl shadow-md transition-colors disabled:opacity-40 disabled:shadow-none"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Сохранить
            </button>
            <span className="inline-flex items-center gap-1 text-xs text-text-muted">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Способ входа: {profile.provider === "google" ? "Google" : "email и пароль"}
            </span>
          </div>
        </div>
      </div>

      <div className="glass rounded-2xl p-6 space-y-3">
        <h3 className="text-sm font-semibold text-text-secondary">Сессия</h3>
        <p className="text-xs text-text-muted">
          Выход завершит сессию в этом браузере. Это не удалит ваши данные.
        </p>
        <button
          type="button"
          onClick={handleLogout}
          className="inline-flex items-center gap-2 px-4 py-2 bg-error-bg text-error border border-error/20 rounded-xl text-sm font-bold hover:bg-error hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}
