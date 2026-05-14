"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { GoogleIcon } from "@/components/icons/GoogleIcon";
import { clearInvalidAuthSession, createClient, isInvalidRefreshTokenError } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");

    if (authError === "auth_failed") {
      setError("Не удалось войти через Google. Попробуйте ещё раз.");
      window.history.replaceState(null, "", window.location.pathname);
    }

    async function redirectAuthenticatedUser() {
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.replace("/dashboard");
        }
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          await clearInvalidAuthSession();
          return;
        }
        throw error;
      }
    }

    redirectAuthenticatedUser();
  }, [router, supabase]);

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/dashboard");
        router.refresh();
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setSuccess("Проверьте почту для подтверждения аккаунта");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Произошла ошибка";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleAuth() {
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: {
            prompt: "select_account",
          },
        },
      });

      if (error) throw error;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Не удалось начать вход через Google";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-bg">
      {/* Animated background orbs */}
      <div className="login-orb-1 absolute top-1/4 -left-32 w-96 h-96 bg-accent-light/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="login-orb-2 absolute bottom-1/4 -right-32 w-80 h-80 bg-info/20 rounded-full blur-[100px] pointer-events-none" />

      {/* Grid background pattern */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: `linear-gradient(rgba(17,17,17,0.18) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(17,17,17,0.18) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 w-full max-w-md px-6">
        {/* Logo */}
        <div className="login-logo text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-bg-elevated border border-border mb-4 glow-accent">
            <span className="text-3xl font-bold text-accent">M</span>
          </div>
          <h1 className="text-2xl font-bold text-text">MAX Messenger</h1>
          <p className="text-text-muted mt-1 text-sm">Business Dashboard</p>
        </div>

        {/* Card */}
        <div className="login-card glass-strong rounded-2xl p-8">
          {/* Tabs */}
          <div className="flex gap-1 bg-bg-elevated rounded-xl p-1 mb-6">
            <button
              onClick={() => { setMode("login"); setError(null); setSuccess(null); }}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === "login"
                  ? "bg-accent text-bg shadow-md"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Вход
            </button>
            <button
              onClick={() => { setMode("register"); setError(null); setSuccess(null); }}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === "register"
                  ? "bg-accent text-bg shadow-md"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Регистрация
            </button>
          </div>

          {/* Error / Success */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-error-bg border border-error/20 text-error text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-success-bg border border-success/20 text-success text-sm">
              {success}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleEmailAuth} className="space-y-4">
            <div className="login-field">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-text placeholder:text-text-muted
                           focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all duration-200"
              />
            </div>

            <div className="login-field">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-text placeholder:text-text-muted
                           focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-accent-light/25 transition-all duration-200"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="login-btn w-full py-3 bg-accent hover:bg-accent-hover text-bg font-semibold rounded-lg
                         transition-all duration-200 hover:shadow-glow-lg disabled:opacity-50 disabled:cursor-not-allowed
                         active:scale-[0.98]"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {mode === "login" ? "Вход..." : "Регистрация..."}
                </span>
              ) : (
                mode === "login" ? "Войти" : "Зарегистрироваться"
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-surface px-3 text-text-muted">или</span>
            </div>
          </div>

          {/* Google OAuth */}
          <button
            onClick={handleGoogleAuth}
            disabled={loading}
            className="login-btn w-full py-3 bg-surface border border-border rounded-lg text-text font-medium
                       hover:border-border-focus hover:bg-surface-hover transition-all duration-200
                       disabled:opacity-50 flex items-center justify-center gap-3 active:scale-[0.98]"
          >
            <GoogleIcon className="h-5 w-5" />
            Войти через Google
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-text-muted text-xs mt-6">
          MAX Messenger © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
