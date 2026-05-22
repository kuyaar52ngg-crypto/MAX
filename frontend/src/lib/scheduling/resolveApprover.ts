/**
 * Resolve a value passed in `approval_user_id` to a Supabase auth user
 * UUID, accepting either a raw UUID or an email address (Req 7.5).
 *
 * The resolution path:
 *   1. If the value is already a UUID — return it as-is.
 *   2. If the value is an email — call the Supabase Auth Admin API to
 *      look up the user by that email.
 *   3. Anything else (including an email when service-role credentials
 *      are not configured, or an email that does not match a user) →
 *      `{ kind: "not_found" }`. The route handler converts this to
 *      HTTP 422 with `error_code = "APPROVAL_USER_NOT_FOUND"`.
 *
 * The service-role key is read from `SUPABASE_SERVICE_ROLE_KEY` (server-
 * only). When it is missing we cannot enumerate users — in that case
 * email lookups return `not_found` so callers cannot bypass approval
 * by handing over an arbitrary email string. UUIDs are still accepted
 * because they require no privileged lookup.
 */

import { createClient as createAdminClient } from "@supabase/supabase-js";

/** Discriminated result of `resolveApprover`. */
export type ResolveApproverResult =
  | { kind: "uuid"; userId: string }
  | { kind: "not_found" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quick syntactic check — does NOT verify that the UUID exists. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Quick syntactic email check — `local@domain.tld`, no whitespace. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 320) return false;
  if (/\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) return false;
  if (at === v.length - 1) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * Resolve a UUID or email to a Supabase user UUID. See module docstring
 * for the precedence rules.
 *
 * The function is `async` because the email branch hits Supabase Auth.
 */
export async function resolveApprover(
  raw: unknown,
): Promise<ResolveApproverResult> {
  if (typeof raw !== "string") return { kind: "not_found" };
  const value = raw.trim();
  if (!value) return { kind: "not_found" };

  if (isUuid(value)) {
    return { kind: "uuid", userId: value.toLowerCase() };
  }

  if (!looksLikeEmail(value)) return { kind: "not_found" };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    // Without privileged credentials we can't enumerate Supabase users.
    // We deliberately deny rather than silently allow — Req 7.5 wants
    // the email path to be a real lookup.
    return { kind: "not_found" };
  }

  // Admin client bypasses RLS; we MUST never use it from the browser.
  const admin = createAdminClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Supabase Auth doesn't expose a direct "lookup by email" endpoint
  // in the JS SDK; we paginate `listUsers` and match client-side. For
  // typical operator teams (≤ a few hundred members) this is cheap; if
  // it grows, swap to `auth.admin.getUserByEmail` once it lands in the
  // SDK.
  const lower = value.toLowerCase();
  const PAGE_SIZE = 200;
  for (let page = 1; page <= 50; page++) {
    let res;
    try {
      res = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    } catch {
      return { kind: "not_found" };
    }
    if (res.error) return { kind: "not_found" };
    const users = res.data?.users ?? [];
    for (const u of users) {
      if ((u.email ?? "").toLowerCase() === lower) {
        return { kind: "uuid", userId: u.id };
      }
    }
    if (users.length < PAGE_SIZE) break;
  }
  return { kind: "not_found" };
}
