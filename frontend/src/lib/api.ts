/**
 * API clients:
 * - apiGet / apiPost / apiDelete / apiUpload / apiSSE → Flask backend (GREEN-API)
 * - nxGet / nxPost / nxDelete → Next.js API routes (Prisma / DB)
 * All requests include Supabase JWT for authentication.
 */

import { createClient } from "@/lib/supabase/client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

// Cache auth headers for up to 60 seconds
let _cachedHeaders: HeadersInit | null = null;
let _cacheExpiry = 0;

async function getAuthHeaders(): Promise<HeadersInit> {
  if (_cachedHeaders && Date.now() < _cacheExpiry) {
    return _cachedHeaders;
  }
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  _cachedHeaders = headers;
  _cacheExpiry = Date.now() + 60_000;
  return headers;
}

/** Drops the JWT header cache. */
export function invalidateAuthCache() {
  _cachedHeaders = null;
  _cacheExpiry = 0;
}

export const clearAllCredentials = invalidateAuthCache;

// ── Flask (GREEN-API) ──────────────────────────────────────────────────────

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeaders();
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
  const headers = await getAuthHeaders();
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
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const headers: HeadersInit = {};
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }
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
