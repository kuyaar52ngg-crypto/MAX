"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { invalidateAuthCache, clearAllCredentials } from "@/lib/api";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Обзор", icon: "📊" },
  { href: "/dashboard/messenger", label: "Мессенджер", icon: "💬" },
  { href: "/dashboard/groups", label: "Группы", icon: "👥" },
  { href: "/dashboard/broadcast", label: "Рассылка", icon: "📢" },
  { href: "/dashboard/contacts", label: "Проверка номеров", icon: "👤" },
  { href: "/dashboard/history", label: "История", icon: "📋" },
  { href: "/dashboard/templates", label: "Шаблоны", icon: "📝" },
  { href: "/dashboard/settings", label: "Настройки", icon: "⚙️" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Следим за изменением сессии — редирект на /login при выходе из любого браузера
  useEffect(() => {
    const supabase = createClient();
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

  async function handleLogout() {
    clearAllCredentials();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-64 flex flex-col border-r border-border bg-surface
          transform transition-transform duration-300 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
      >
        {/* Logo */}
        <div className="sidebar-logo flex items-center gap-3 px-5 py-5 border-b border-border">
          <div className="w-9 h-9 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center glow-accent">
            <span className="text-lg font-bold gradient-text">M</span>
          </div>
          <div>
            <h2 className="text-sm font-bold text-text">MAX Bot</h2>
            <p className="text-[10px] text-text-muted">Dashboard</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`nav-item flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group
                  ${isActive
                    ? "bg-accent/15 text-accent-light border border-accent/20 shadow-sm"
                    : "text-text-secondary hover:text-text hover:bg-surface-hover"
                  }`}
              >
                <span className={`text-lg transition-transform duration-200 ${isActive ? "scale-110" : "group-hover:scale-110"}`}>
                  {item.icon}
                </span>
                {item.label}
                {isActive && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-accent" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="px-3 py-4 border-t border-border">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium
                       text-text-muted hover:text-error hover:bg-error-bg transition-all duration-200"
          >
            <span className="text-lg">🚪</span>
            Выйти
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar (mobile) */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <svg className="w-5 h-5 text-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-text">MAX Bot</span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
