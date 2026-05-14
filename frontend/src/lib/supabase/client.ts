import { createBrowserClient } from "@supabase/ssr";

let supabase: ReturnType<typeof createBrowserClient> | undefined;

export function createClient() {
  if (supabase) return supabase;
  
  supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  
  return supabase;
}

export function isInvalidRefreshTokenError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Invalid Refresh Token") || message.includes("Refresh Token Not Found");
}

export async function clearInvalidAuthSession() {
  try {
    await createClient().auth.signOut({ scope: "local" });
  } catch {
    /* ignore */
  }
}
