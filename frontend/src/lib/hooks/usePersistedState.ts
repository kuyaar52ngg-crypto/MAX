"use client";

/**
 * `usePersistedState` — `useState`-аналог, который автоматически
 * синхронизирует значение с `window.sessionStorage` под заданным ключом.
 *
 * Зачем: Next.js App Router размонтирует компоненты страниц при
 * навигации между маршрутами, из-за чего обычный `useState` теряет
 * введённые пользователем данные (список номеров, текст рассылки,
 * настройки CSV-импорта и т.п.). Этот хук подменяет `useState` так,
 * чтобы при возврате на ту же страницу в той же вкладке состояние
 * восстанавливалось.
 *
 * Используется `sessionStorage`, а не `localStorage`, чтобы:
 *   - данные не "залипали" между разными пользователями в одном
 *     браузере;
 *   - закрытие вкладки очищало черновики (это ожидаемое поведение
 *     для UX рассылки/проверки);
 *   - `localStorage` Vercel-edge может быть недоступен / противоречить
 *     приватности в публичных машинах.
 *
 * SSR-совместимость: на сервере `window` отсутствует, поэтому
 * первый рендер всегда возвращает `initial`, а гидрация на клиенте
 * подхватывает сохранённое значение в `useEffect`.
 *
 * Сериализация: только то, что переживает `JSON.stringify`/`parse`.
 * Объекты `File`, `Blob`, `Map`, `Set`, функции — НЕ персистятся
 * (используйте обычный `useState` для них).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UsePersistedStateOptions {
  /**
   * Версия схемы. Если значение в storage записано под другой версией,
   * оно игнорируется и применяется `initial`. Полезно при изменении
   * формы данных без миграций — старые черновики не будут ломать UI.
   */
  version?: number;
}

interface StoredEnvelope<T> {
  v: number;
  d: T;
}

const DEFAULT_VERSION = 1;

function readStorage<T>(
  key: string,
  version: number,
): { ok: true; value: T } | { ok: false } {
  if (typeof window === "undefined") return { ok: false };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw == null) return { ok: false };
    const parsed = JSON.parse(raw) as StoredEnvelope<T>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.v !== version
    ) {
      return { ok: false };
    }
    return { ok: true, value: parsed.d };
  } catch {
    return { ok: false };
  }
}

function writeStorage<T>(key: string, version: number, value: T): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: StoredEnvelope<T> = { v: version, d: value };
    window.sessionStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Quota exceeded / private mode — silently ignore.
  }
}

/**
 * Persisted analogue of `useState`. The signature matches `useState`
 * exactly except for the required `key` and the optional `options`.
 *
 * @example
 *   const [draft, setDraft] = usePersistedState<string>(
 *     "broadcast:draft",
 *     "",
 *   );
 */
export function usePersistedState<T>(
  key: string,
  initial: T | (() => T),
  options: UsePersistedStateOptions = {},
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const version = options.version ?? DEFAULT_VERSION;

  // First render: always `initial` to keep server and client markup in
  // sync. Hydration runs the effect below and replaces the value with
  // whatever lives in storage.
  const [value, setValue] = useState<T>(initial);

  // Track whether we have hydrated from storage so the persistence
  // effect doesn't write the initial value back on first mount.
  const hydratedRef = useRef<boolean>(false);

  // Hydrate on mount.
  useEffect(() => {
    const result = readStorage<T>(key, version);
    if (result.ok) {
      setValue(result.value);
    }
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on every change after hydration.
  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStorage(key, version, value);
  }, [key, version, value]);

  return [value, setValue];
}

/**
 * Imperatively drop a persisted entry. Useful after a successful
 * action that should clear the draft (e.g. broadcast finished —
 * forget the in-progress message draft).
 */
export function clearPersistedState(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export default usePersistedState;
