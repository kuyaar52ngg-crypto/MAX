"use client";

/**
 * AI generator button — split-action with tone selector + 3 modes.
 *
 * Modes:
 *   - "generate" — write a marketing message from scratch (default)
 *   - "randomize" — wrap the user's text into {a|b|c} placeholders
 *   - "variants" — produce N distinct variants for A/B testing
 *
 * Tone presets (friendly / formal / sales / urgent / casual) are passed
 * to the system prompt and shape the result.
 *
 * Validates: Requirements 4.4, 4.7
 */

import { useState } from "react";
import {
  ChevronDown,
  Loader2,
  Shuffle,
  Sparkles,
  SplitSquareHorizontal,
} from "lucide-react";

import { AI_TONE_LABELS, type AiTone } from "@/lib/ai/marketer-prompt";

export type AiGenerateMode = "generate" | "randomize" | "variants";

export interface AIGeneratorButtonProps {
  pending: boolean;
  /** Default mode click. Receives current selected tone. */
  onClick: (mode: AiGenerateMode, tone: AiTone) => void;
  className?: string;
  disabled?: boolean;
  /** Hide modes that need an existing text (when message is empty). */
  hasText?: boolean;
}

const MODES: {
  id: AiGenerateMode;
  label: string;
  description: string;
  icon: typeof Sparkles;
  requiresText: boolean;
}[] = [
  {
    id: "generate",
    label: "Сгенерировать текст",
    description: "Написать готовое сообщение с нуля по вашему брифу",
    icon: Sparkles,
    requiresText: false,
  },
  {
    id: "randomize",
    label: "Уникализировать",
    description: "Обернуть мой текст в {a|b|c} — каждый получит свой вариант",
    icon: Shuffle,
    requiresText: true,
  },
  {
    id: "variants",
    label: "3 варианта для A/B",
    description: "Создать 3 разных версии одной идеи",
    icon: SplitSquareHorizontal,
    requiresText: false,
  },
];

const TONE_ORDER: AiTone[] = [
  "friendly",
  "formal",
  "sales",
  "urgent",
  "casual",
];

export function AIGeneratorButton({
  pending,
  onClick,
  className,
  disabled,
  hasText = false,
}: AIGeneratorButtonProps) {
  const [tone, setTone] = useState<AiTone>("friendly");
  const [menuOpen, setMenuOpen] = useState(false);

  const isDisabled = pending || Boolean(disabled);

  function trigger(mode: AiGenerateMode) {
    setMenuOpen(false);
    if (isDisabled) return;
    onClick(mode, tone);
  }

  return (
    <div className={`inline-flex items-stretch ${className ?? ""}`}>
      {/* Tone selector */}
      <select
        value={tone}
        onChange={(e) => setTone(e.target.value as AiTone)}
        disabled={isDisabled}
        aria-label="Тон сообщения"
        title="Тон сообщения"
        className="rounded-l-lg border border-border bg-bg-elevated text-xs text-text-secondary px-2 py-2 focus:outline-none focus:border-accent/50 disabled:opacity-40"
      >
        {TONE_ORDER.map((t) => (
          <option key={t} value={t}>
            {AI_TONE_LABELS[t]}
          </option>
        ))}
      </select>

      {/* Main action: generate-from-scratch */}
      <button
        type="button"
        onClick={() => trigger("generate")}
        disabled={isDisabled}
        aria-busy={pending ? "true" : undefined}
        className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-bg text-sm font-semibold border-y border-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Sparkles className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
        )}
        <span>AI</span>
      </button>

      {/* Dropdown for advanced modes */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={isDisabled}
          aria-label="Дополнительные режимы AI"
          aria-expanded={menuOpen}
          className="inline-flex items-center justify-center px-2 py-2 bg-accent hover:bg-accent-hover text-bg rounded-r-lg border border-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`}
            strokeWidth={2.2}
          />
        </button>
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-30"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-40 w-72 rounded-xl border border-border bg-surface shadow-lg overflow-hidden">
              <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-text-muted bg-bg-elevated/50">
                Тон: {AI_TONE_LABELS[tone]}
              </div>
              {MODES.map((m) => {
                const Icon = m.icon;
                const muted = m.requiresText && !hasText;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => trigger(m.id)}
                    disabled={muted || isDisabled}
                    className="w-full text-left px-3 py-2.5 hover:bg-bg-elevated transition-colors flex items-start gap-2.5 disabled:opacity-40 disabled:cursor-not-allowed border-b border-border last:border-b-0"
                  >
                    <Icon
                      className="h-4 w-4 mt-0.5 text-accent shrink-0"
                      strokeWidth={2}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text">
                        {m.label}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {muted
                          ? "Сначала напишите свой текст"
                          : m.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AIGeneratorButton;
