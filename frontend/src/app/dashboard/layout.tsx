"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  BarChart3,
  Bot,
  ChevronDown,
  ClipboardList,
  FileText,
  LogOut,
  Megaphone,
  MessageCircle,
  Settings,
  UserCheck,
  UserCircle,
  Users,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { invalidateAuthCache, clearAllCredentials } from "@/lib/api";

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard", label: "Обзор", icon: BarChart3 },
  { href: "/dashboard/messenger", label: "Мессенджер", icon: MessageCircle },
  { href: "/dashboard/groups", label: "Группы", icon: Users },
  { href: "/dashboard/broadcast", label: "Рассылка", icon: Megaphone },
  { href: "/dashboard/contacts", label: "Проверка", icon: UserCheck },
  { href: "/dashboard/history", label: "История", icon: ClipboardList },
  { href: "/dashboard/templates", label: "Шаблоны", icon: FileText },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [accountOpen, setAccountOpen] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const userInitial = useMemo(() => (userEmail || "M").trim().charAt(0).toUpperCase(), [userEmail]);

  // Следим за изменением сессии — редирект на /login при выходе из любого браузера
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then((result: { data: { user: { email?: string | null } | null } }) => {
      setUserEmail(result.data.user?.email || "");
    }).catch(() => {});
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: string) => {
      if (event === "SIGNED_OUT") {
        clearAllCredentials();
        router.replace("/login");
      } else {
        // TOKEN_REFRESHED, INITIAL_SESSION, etc — only refresh JWT cache,
        // keep GREEN-API credentials intact
        invalidateAuthCache();
      }
    });
    return () => subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    setAccountOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleScroll() {
      setScrolled(window.scrollY > 24);
    }

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  async function handleLogout() {
    clearAllCredentials();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="sticky top-0 z-50 px-3 py-3">
        <div
          className={`mx-auto grid grid-cols-[48px_minmax(0,1fr)_minmax(190px,auto)] items-center gap-6 px-4 transition-all duration-300 lg:px-5 ${
            scrolled
              ? "max-w-5xl rounded-xl border border-border bg-surface/95 py-2 shadow-lg backdrop-blur-2xl"
              : "max-w-7xl border-b border-border bg-bg/90 py-1 backdrop-blur-2xl"
          }`}
        >
          <Link
            href="/dashboard"
            aria-label="MAX Bot"
            className={`group flex shrink-0 items-center justify-center rounded-xl bg-accent text-bg shadow-sm transition-all hover:-rotate-3 ${
              scrolled ? "h-8 w-8" : "h-10 w-10"
            }`}
          >
            <Bot className={scrolled ? "h-4 w-4" : "h-5 w-5"} strokeWidth={2.2} />
          </Link>

          <nav className="no-scrollbar flex min-w-0 justify-center gap-1.5 overflow-x-auto">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 font-medium transition-all ${
                    scrolled ? "py-1.5 text-xs" : "py-2 text-sm"
                  }
                    ${isActive
                      ? "bg-accent text-bg shadow-sm"
                      : "text-text-muted hover:bg-surface-hover hover:text-text"
                    }`}
                >
                  <Icon className="h-4 w-4" strokeWidth={2} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="relative justify-self-end">
            <button
              type="button"
              onClick={() => setAccountOpen((value) => !value)}
              aria-expanded={accountOpen}
              className={`inline-flex items-center gap-3 rounded-xl border px-2.5 text-left transition-all hover:border-border-focus hover:bg-surface-hover ${
                scrolled ? "h-9" : "h-10"
              } ${
                pathname.startsWith("/dashboard/settings")
                  ? "border-accent bg-accent text-bg"
                  : "border-border bg-surface text-text"
              }`}
            >
              <span className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold ${
                pathname.startsWith("/dashboard/settings")
                  ? "bg-bg text-accent"
                  : "bg-bg-elevated text-text"
              }`}>
                {userInitial}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block text-xs font-bold leading-4">Личный кабинет</span>
                <span className={`block max-w-[170px] truncate text-[11px] leading-4 ${
                  pathname.startsWith("/dashboard/settings") ? "text-bg/70" : "text-text-muted"
                }`}>
                  {userEmail || "Профиль MAX"}
                </span>
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${accountOpen ? "rotate-180" : ""}`} strokeWidth={2} />
            </button>

            {accountOpen && (
              <div className="absolute right-0 top-full z-[80] mt-3 w-72 overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-lg">
                <div className="rounded-xl bg-bg-elevated p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-bg">
                      <UserCircle className="h-5 w-5" strokeWidth={2.2} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-text">Личный кабинет</div>
                      <div className="truncate text-xs text-text-muted">{userEmail || "Аккаунт MAX Bot"}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
                  <Link
                    href="/dashboard/settings"
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    <Settings className="h-4 w-4" strokeWidth={2} />
                    Настройки
                  </Link>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-error-bg hover:text-error"
                  >
                    <LogOut className="h-4 w-4" strokeWidth={2} />
                    Выйти
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main>
        {children}
      </main>
    </div>
  );
}
