/**
 * API clients:
 * - apiGet / apiPost / apiDelete / apiUpload / apiSSE → Flask backend (GREEN-API)
 * - nxGet / nxPost / nxDelete → Next.js API routes (Prisma / DB)
 * Flask requests include per-user GREEN-API credentials loaded from Supabase/Postgres.
 */

import { clearInvalidAuthSession, createClient, isInvalidRefreshTokenError } from "@/lib/supabase/client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

type GreenCredentials = {
  green_api_id: string;
  green_api_token: string;
  green_api_url: string;
  has_credentials: boolean;
};

let _cachedHeaders: HeadersInit | null = null;
let _cacheExpiry = 0;
let _cachedCredentials: GreenCredentials | null = null;
let _credentialsExpiry = 0;

async function getAuthHeaders(): Promise<HeadersInit> {
  if (_cachedHeaders && Date.now() < _cacheExpiry) {
    return _cachedHeaders;
  }
  const supabase = createClient();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data.session;
  } catch (error) {
    if (isInvalidRefreshTokenError(error)) {
      await clearInvalidAuthSession();
      _cachedHeaders = headers;
      _cacheExpiry = Date.now() + 1_000;
      return headers;
    }
    throw error;
  }
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  _cachedHeaders = headers;
  _cacheExpiry = Date.now() + 60_000;
  return headers;
}

async function getGreenCredentials(): Promise<GreenCredentials | null> {
  if (_cachedCredentials && Date.now() < _credentialsExpiry) {
    return _cachedCredentials;
  }
  const headers = await getAuthHeaders();
  const res = await fetch("/api/profile/credentials", { headers });
  if (!res.ok) {
    _cachedCredentials = null;
    _credentialsExpiry = 0;
    return null;
  }
  const credentials = await res.json() as GreenCredentials;
  _cachedCredentials = credentials;
  _credentialsExpiry = Date.now() + 60_000;
  return credentials;
}

/**
 * Build the Flask request headers (Authorization + GREEN-API credentials).
 * Exposed for hooks/components that issue their own `fetch` to Flask
 * (e.g. `useBulkOperation`, which needs the same `X-Green-Api-*` headers
 * as `apiUpload` but cannot reuse it because it owns the SSE lifecycle).
 *
 * Pass `json = false` for `multipart/form-data` requests so the browser
 * sets the boundary itself.
 */
export async function getFlaskHeaders(json = true): Promise<HeadersInit> {
  const authHeaders = await getAuthHeaders();
  const headers: Record<string, string> = { ...(authHeaders as Record<string, string>) };
  if (!json) {
    delete headers["Content-Type"];
  }

  const credentials = await getGreenCredentials();
  if (!credentials?.green_api_id || !credentials?.green_api_token) {
    throw new Error("GREEN-API credentials are not configured");
  }

  headers["X-Green-Api-Id"] = credentials.green_api_id;
  headers["X-Green-Api-Token"] = credentials.green_api_token;
  headers["X-Green-Api-Url"] = credentials.green_api_url || "https://api.green-api.com";

  return headers;
}

/** Drops the JWT header cache. */
export function invalidateAuthCache() {
  _cachedHeaders = null;
  _cacheExpiry = 0;
}

/** Drops cached GREEN-API credentials so the next Flask request re-reads Supabase/Postgres. */
export function invalidateCredentialsCache() {
  _cachedCredentials = null;
  _credentialsExpiry = 0;
}

export function clearAllCredentials() {
  invalidateAuthCache();
  invalidateCredentialsCache();
}

// ── Flask (GREEN-API) ──────────────────────────────────────────────────────

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await getFlaskHeaders();
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getFlaskHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers = await getFlaskHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const headers = await getFlaskHeaders(false);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export function apiSSE(
  path: string,
  onMessage: (data: Record<string, unknown>) => void,
  onError?: (err: Error) => void
): () => void {
  const source = new EventSource(`${API_BASE}${path}`);
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch {
      /* ignore parse errors */
    }
  };
  source.onerror = () => {
    onError?.(new Error("SSE connection error"));
    source.close();
  };
  return () => source.close();
}

// ── Next.js API routes (Prisma / DB) ─────────────────────────────────────

export async function nxGet<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function nxPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(path, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function nxDelete<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(path, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
