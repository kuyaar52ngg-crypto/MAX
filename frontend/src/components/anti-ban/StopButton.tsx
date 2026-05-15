"use client";

import { useEffect, useRef, useState } from "react";

export interface StopButtonProps {
  /** Callback to invoke (typically `useBulkOperation.stop`). */
  onStop: () => void | Promise<void>;
  /** Whether the operation is still active; auto-resets the locked-out state when this becomes false. */
  active?: boolean;
  /** Optional className for layout overrides. */
  className?: string;
  /** Optional label override; defaults to "Стоп". */
  label?: string;
}

const RELEASE_TIMEOUT_MS = 5000;

export function StopButton({ onStop, active = true, className, label = "Стоп" }: StopButtonProps) {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Release the disabled state when the operation finishes (active flips to false).
  useEffect(() => {
    if (!active && pending) {
      setPending(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [active, pending]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = () => {
    if (pending) return;
    setPending(true);
    // Endpoint is idempotent — double-click is safe even if the timer triggers first.
    Promise.resolve(onStop()).catch(() => {
      // Errors are surfaced via the parent hook's `error` field; just release the lock.
    });
    timerRef.current = setTimeout(() => {
      setPending(false);
      timerRef.current = null;
    }, RELEASE_TIMEOUT_MS);
  };

  return (
    <button
      type="button"
      disabled={pending || !active}
      onClick={handleClick}
      className={[
        "px-3 py-1.5 rounded text-sm font-medium",
        "bg-red-600 text-white hover:bg-red-700",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-label={label}
    >
      {pending ? "Останавливаем..." : label}
    </button>
  );
}

export default StopButton;
