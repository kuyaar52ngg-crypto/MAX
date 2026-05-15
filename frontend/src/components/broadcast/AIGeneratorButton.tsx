"use client";

import { Loader2, Sparkles } from "lucide-react";

/**
 * Props for `AI_Generator_Button`.
 *
 * Per design.md the canonical contract is `{ pending, onClick }`. The optional
 * `className` and `disabled` props are pure ergonomic conveniences for callers
 * (e.g. positioning the button in a flex layout, disabling it while the
 * surrounding form is in an invalid state). `pending` always implies
 * `disabled`: a busy button cannot be clicked again regardless of the prop.
 *
 * Validates: Requirements 4.4, 4.7
 */
export interface AIGeneratorButtonProps {
  /** Whether an AI request is currently in flight. */
  pending: boolean;
  /** Click handler. Not invoked while `pending` or `disabled` is true. */
  onClick(): void;
  /** Extra Tailwind classes appended to the button. */
  className?: string;
  /** Disable the button independently of `pending`. */
  disabled?: boolean;
}

/**
 * Single AI generator action button rendered inside `Message_Block`.
 *
 * Replaces the previous "Проверить текст" button and the variable/random
 * panel: there is now a single entry point for AI assistance. While a
 * generation request is in flight the button displays a spinner and exposes
 * `aria-busy="true"` so assistive technologies announce the wait state.
 */
export function AIGeneratorButton({
  pending,
  onClick,
  className,
  disabled,
}: AIGeneratorButtonProps) {
  const isDisabled = pending || Boolean(disabled);
  const baseClass =
    "inline-flex items-center justify-center gap-2 px-4 py-2.5 " +
    "bg-accent hover:bg-accent-hover text-bg text-sm font-semibold " +
    "rounded-lg shadow-md transition-colors " +
    "disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none";
  const merged = className ? `${baseClass} ${className}` : baseClass;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={pending ? "true" : undefined}
      aria-label="Использовать AI"
      className={merged}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Sparkles className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
      )}
      <span>Использовать AI</span>
    </button>
  );
}

export default AIGeneratorButton;
