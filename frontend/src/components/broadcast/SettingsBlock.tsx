"use client";

/**
 * `Settings_Block` — presentational block hosting the broadcast send-time
 * settings (per-recipient delay and typing simulation flag).
 *
 * The component owns no state of its own: the parent (`Broadcast_Page`) keeps
 * the canonical `delay` / `useTyping` values, and this block emits patches
 * through `onChange`. The delay value reported through the patch is clamped
 * to the inclusive range 1..30, matching the bounds enforced by the existing
 * markup (`min=1` / `max=30`) and by the Flask backend.
 *
 * Visual styling reuses the same `glass rounded-xl ...` container chrome as
 * the other broadcast blocks for a consistent look.
 *
 * Validates: Requirement 1.2 (Settings_Block lives in the left column,
 * underneath Recipients_Block).
 */

import { Keyboard, Settings2 } from "lucide-react";

/** Inclusive lower bound for the per-recipient delay (seconds). */
const DELAY_MIN_SECONDS = 1;
/** Inclusive upper bound for the per-recipient delay (seconds). */
const DELAY_MAX_SECONDS = 30;

export interface SettingsBlockProps {
  /** Current per-recipient delay in seconds. */
  delay: number;
  /** Whether typing simulation is enabled before each message. */
  useTyping: boolean;
  /**
   * Called with a partial patch whenever any field changes. The parent is
   * expected to merge the patch into its state.
   */
  onChange(patch: Partial<{ delay: number; useTyping: boolean }>): void;
}

/**
 * Clamps `value` to the inclusive `[DELAY_MIN_SECONDS, DELAY_MAX_SECONDS]`
 * range. Non-finite inputs (NaN from an empty `<input type="number">`,
 * `Infinity`, etc.) collapse to the lower bound so we never propagate an
 * invalid number upstream.
 */
function clampDelay(value: number): number {
  if (!Number.isFinite(value)) return DELAY_MIN_SECONDS;
  if (value < DELAY_MIN_SECONDS) return DELAY_MIN_SECONDS;
  if (value > DELAY_MAX_SECONDS) return DELAY_MAX_SECONDS;
  // Trim sub-second precision to match the integer expectation of the field.
  return Math.trunc(value);
}

export function SettingsBlock({ delay, useTyping, onChange }: SettingsBlockProps) {
  return (
    <div className="broadcast-section glass rounded-xl p-6 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
        <Settings2 className="h-4 w-4 text-accent-light" strokeWidth={2} />
        Настройки
      </h3>
      <div className="flex flex-wrap gap-6">
        <div>
          <label className="text-xs text-text-muted" htmlFor="settings-delay">
            Задержка (сек)
          </label>
          <input
            id="settings-delay"
            type="number"
            value={delay}
            onChange={(e) => onChange({ delay: clampDelay(Number(e.target.value)) })}
            min={DELAY_MIN_SECONDS}
            max={DELAY_MAX_SECONDS}
            className="mt-1 w-20 px-3 py-2 bg-surface border border-border rounded-xl text-sm text-text text-center focus:outline-none focus:border-border-focus"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer self-end">
          <input
            type="checkbox"
            checked={useTyping}
            onChange={(e) => onChange({ useTyping: e.target.checked })}
            className="accent-accent"
          />
          <Keyboard className="h-4 w-4 text-text-muted" strokeWidth={2} />
          <span className="text-sm text-text-secondary">Имитация набора</span>
        </label>
      </div>
    </div>
  );
}

export default SettingsBlock;
