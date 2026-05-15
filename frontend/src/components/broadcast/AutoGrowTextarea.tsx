"use client";

import {
  ChangeEvent,
  CSSProperties,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

import { TEXTAREA_MAX_LINES, TEXTAREA_MIN_LINES } from "./types";

/**
 * Props accepted by `Auto_Grow_Textarea`.
 *
 * The component is intentionally headless / presentational — `Broadcast_Page`
 * owns the `value` state and forwards changes via `onChange`. `className`
 * lets callers swap or extend the default Tailwind styling without forking
 * the component.
 */
export interface AutoGrowTextareaProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  /** Minimum visible lines. Defaults to `TEXTAREA_MIN_LINES` (5). */
  minLines?: number;
  /** Maximum visible lines. Defaults to `TEXTAREA_MAX_LINES` (20). */
  maxLines?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/**
 * Default Tailwind classes mirror the existing dashboard `glass`/`rounded`
 * styling used in `frontend/src/app/dashboard/broadcast/page.tsx` so the
 * textarea looks consistent with the rest of the broadcast UI when dropped
 * into `Message_Block`.
 */
const DEFAULT_CLASSNAME =
  "w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm " +
  "text-text placeholder:text-text-muted resize-none focus:outline-none " +
  "focus:border-border-focus transition-colors";

/**
 * Reads a CSS length (e.g. computed `lineHeight`, `padding`, `border`) and
 * returns its numeric pixel value. Falls back to `fallback` when the value
 * is `"normal"`, an empty string, or otherwise not parseable as a finite
 * number.
 */
function readPx(value: string, fallback: number): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Computes the effective `lineHeight` in pixels for `el`. Browsers report
 * `"normal"` for `getComputedStyle(el).lineHeight` when no explicit value
 * is set, which is not parseable; in that case we approximate with
 * `fontSize * 1.4` to keep the height calculation stable.
 */
function resolveLineHeight(style: CSSStyleDeclaration): number {
  const fontSize = readPx(style.fontSize, 14);
  const direct = parseFloat(style.lineHeight);
  if (Number.isFinite(direct)) return direct;
  return fontSize * 1.4;
}

/**
 * Auto_Grow_Textarea
 * ------------------
 * Textarea that recomputes its own height on every `value` change so the
 * caller never sees an internal vertical scrollbar between `minLines` and
 * `maxLines`. Above `maxLines` the height is pinned and `overflowY` is
 * switched to `"auto"`.
 *
 * Algorithm (runs inside `useLayoutEffect([value])`, before paint):
 *   1. Reset `el.style.height = "auto"` so `scrollHeight` reflects the
 *      intrinsic content height instead of the previously committed height.
 *   2. Read `lineHeight`, padding, and border from `getComputedStyle(el)`.
 *      Use `fontSize * 1.4` as the `lineHeight` fallback when the computed
 *      value is `"normal"`.
 *   3. Compute the chrome offset
 *      `chrome = paddingTop + paddingBottom + borderTop + borderBottom` and
 *      derive `minH = lineHeight * minLines + chrome` and
 *      `maxH = lineHeight * maxLines + chrome`.
 *   4. Set `el.style.height = clamp(scrollHeight, minH, maxH) + "px"`.
 *   5. Set `el.style.overflowY = scrollHeight > maxH ? "auto" : "hidden"`.
 *
 * No `focus`/`blur` listeners are attached: the height is a pure function
 * of `value` (and the layout `lineHeight`/padding/border) and therefore
 * stable across focus changes. This satisfies Requirement 5.6.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
export function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  minLines = TEXTAREA_MIN_LINES,
  maxLines = TEXTAREA_MAX_LINES,
  disabled,
  className,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: AutoGrowTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Recalculate height synchronously after every value change so the user
  // never sees a flicker / intermediate scrollbar between paints.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // 1. Reset so `scrollHeight` reflects the intrinsic content height.
    el.style.height = "auto";

    // 2. Resolve metrics from the computed style.
    const style = window.getComputedStyle(el);
    const lineHeight = resolveLineHeight(style);
    const paddingTop = readPx(style.paddingTop, 0);
    const paddingBottom = readPx(style.paddingBottom, 0);
    const borderTop = readPx(style.borderTopWidth, 0);
    const borderBottom = readPx(style.borderBottomWidth, 0);
    const chrome = paddingTop + paddingBottom + borderTop + borderBottom;

    // 3. Derive min/max heights from the line count caps.
    const minH = lineHeight * minLines + chrome;
    const maxH = lineHeight * maxLines + chrome;

    // 4. Clamp `scrollHeight` into [minH, maxH].
    const scrollHeight = el.scrollHeight;
    const nextHeight = Math.min(Math.max(scrollHeight, minH), maxH);
    el.style.height = `${nextHeight}px`;

    // 5. Toggle internal scrollbar only when content exceeds maxH.
    el.style.overflowY = scrollHeight > maxH ? "auto" : "hidden";
  }, [value, minLines, maxLines]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  // `rows` is set from `minLines` so the SSR-rendered textarea reserves
  // roughly the right space before hydration takes over. The
  // `useLayoutEffect` above will refine the height as soon as the
  // component mounts on the client.
  const baseStyle: CSSProperties = { overflowY: "hidden" };

  return (
    <textarea
      ref={textareaRef}
      id={id}
      name={name}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={minLines}
      style={baseStyle}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className={className ?? DEFAULT_CLASSNAME}
    />
  );
}

export default AutoGrowTextarea;
