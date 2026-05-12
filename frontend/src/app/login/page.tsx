"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        router.replace("/dashboard");
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
      <div className="login-orb-1 absolute top-1/4 -left-32 w-96 h-96 bg-accent/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="login-orb-2 absolute bottom-1/4 -right-32 w-80 h-80 bg-accent-light/8 rounded-full blur-[100px] pointer-events-none" />

      {/* Grid background pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(124,58,237,0.3) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(124,58,237,0.3) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 w-full max-w-md px-6">
        {/* Logo */}
        <div className="login-logo text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/20 border border-accent/30 mb-4 glow-accent">
            <span className="text-3xl font-bold gradient-text">M</span>
          </div>
          <h1 className="text-2xl font-bold text-text">MAX Messenger</h1>
          <p className="text-text-muted mt-1 text-sm">Business Dashboard</p>
        </div>

        {/* Card */}
        <div className="login-card glass-strong rounded-2xl p-8 shadow-lg">
          {/* Tabs */}
          <div className="flex gap-1 bg-bg/50 rounded-xl p-1 mb-6">
            <button
              onClick={() => { setMode("login"); setError(null); setSuccess(null); }}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === "login"
                  ? "bg-accent text-white shadow-md"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Вход
            </button>
            <button
              onClick={() => { setMode("register"); setError(null); setSuccess(null); }}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === "register"
                  ? "bg-accent text-white shadow-md"
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
                className="w-full px-4 py-3 bg-bg/60 border border-border rounded-xl text-text placeholder:text-text-muted
                           focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all duration-200"
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
                className="w-full px-4 py-3 bg-bg/60 border border-border rounded-xl text-text placeholder:text-text-muted
                           focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all duration-200"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="login-btn w-full py-3 bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl
                         transition-all duration-200 hover:shadow-glow-lg disabled:opacity-50 disabled:cursor-not-allowed
                         active:scale-[0.98]"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
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
            className="login-btn w-full py-3 bg-bg/60 border border-border rounded-xl text-text font-medium
                       hover:border-accent/40 hover:bg-surface-hover transition-all duration-200
                       disabled:opacity-50 flex items-center justify-center gap-3 active:scale-[0.98]"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
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
