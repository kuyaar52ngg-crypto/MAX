import { type NextRequest, NextResponse } from "next/server";

/**
 * Lightweight auth proxy — checks for the presence of a Supabase auth cookie.
 * No @supabase/ssr import, no async, no network calls → instant compile + runtime.
 *
 * Detailed session validation happens client-side in dashboard/layout.tsx
 * (onAuthStateChange) and via Supabase JS calls in protected pages.
 */
export function proxy(request: NextRequest) {
  // Supabase stores the session in a cookie like `sb-<project-ref>-auth-token`
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.endsWith("-auth-token"));

  const path = request.nextUrl.pathname;
  const isAuthRoute = path.startsWith("/login");
  const isProtectedRoute = path.startsWith("/dashboard") || path === "/";

  if (!hasAuthCookie && isProtectedRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (hasAuthCookie && isAuthRoute) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
