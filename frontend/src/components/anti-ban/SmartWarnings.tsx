"use client";

/**
 * `SmartWarnings` — карточка с автоматическим анализом anti-ban
 * конфигурации. Показывает list проблем со severity-цветами и кнопкой
 * «Исправить», которая патчит конфиг одним кликом.
 *
 * Дополнительно отображает две агрегированные метрики:
 *   - Risk score 0..100
 *   - Human score 0..100 (имитация человеческого темпа)
 *
 * Если проблем нет — компактный «всё отлично» баннер.
 */

import { AlertTriangle, CheckCircle2, Info, ShieldAlert, Wand2 } from "lucide-react";

import {
  analyzeAntiBanConfig,
  type AnalysisResult,
  type AnalysisSeverity,
  type AnalyzerIssue,
} from "@/lib/anti-ban-analyzer";
import type { AntiBanConfig } from "@/lib/anti-ban";

export interface SmartWarningsProps {
  config: AntiBanConfig;
  /** Колбэк применения патча — родительская форма мержит и обновляет UI. */
  onApplyPatch(patch: Partial<AntiBanConfig>): void;
}

const SEVERITY_STYLE: Record<
  AnalysisSeverity,
  { box: string; icon: string; iconCmp: typeof AlertTriangle }
> = {
  info: {
    box: "border-blue-500/30 bg-blue-500/10",
    icon: "text-blue-400",
    iconCmp: Info,
  },
  warning: {
    box: "border-warning/30 bg-warning-bg",
    icon: "text-warning",
    iconCmp: AlertTriangle,
  },
  danger: {
    box: "border-error/30 bg-error-bg",
    icon: "text-error",
    iconCmp: ShieldAlert,
  },
};

export function SmartWarnings({ config, onApplyPatch }: SmartWarningsProps) {
  const result: AnalysisResult = analyzeAntiBanConfig(config);

  return (
    <div className="space-y-3">
      {/* Метрики */}
      <div className="grid grid-cols-2 gap-2">
        <ScoreCard
          label="Риск бана"
          score={result.riskScore}
          inverted
        />
        <ScoreCard
          label="Человечность"
          score={result.humanScore}
        />
      </div>

      {/* Список проблем */}
      {result.issues.length === 0 ? (
        <div className="rounded-xl border border-success/30 bg-success-bg px-4 py-3 flex gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
          <span>
            Конфигурация выглядит сбалансированной. Никаких опасных
            комбинаций не обнаружено.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {result.issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              onApply={() => onApplyPatch(issue.patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueCard({
  issue,
  onApply,
}: {
  issue: AnalyzerIssue;
  onApply(): void;
}) {
  const style = SEVERITY_STYLE[issue.severity];
  const Icon = style.iconCmp;
  return (
    <div className={`rounded-xl border ${style.box} px-4 py-3`}>
      <div className="flex gap-3">
        <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${style.icon}`} strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">{issue.title}</div>
          <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
            {issue.description}
          </div>
          <button
            type="button"
            onClick={onApply}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg/40 border border-border hover:border-accent/40 text-xs text-text font-medium transition-colors"
          >
            <Wand2 className="h-3 w-3" strokeWidth={2.5} />
            {issue.patchLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScoreCard({
  label,
  score,
  inverted = false,
}: {
  label: string;
  score: number;
  /** Если true — низкое значение хорошо (для риска). Иначе — высокое хорошо. */
  inverted?: boolean;
}) {
  // 0..100. Для inverted: <30=зелёный, 30-60=жёлтый, >60=красный.
  // Для прямого: >70=зелёный, 40-70=жёлтый, <40=красный.
  let color = "text-success";
  let bar = "bg-success";
  if (inverted) {
    if (score >= 60) {
      color = "text-error";
      bar = "bg-error";
    } else if (score >= 30) {
      color = "text-warning";
      bar = "bg-warning";
    }
  } else {
    if (score < 40) {
      color = "text-error";
      bar = "bg-error";
    } else if (score < 70) {
      color = "text-warning";
      bar = "bg-warning";
    }
  }

  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-3 py-2">
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-text-muted">{label}</span>
        <span className={`text-base font-bold ${color}`}>{score}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full rounded-full bg-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${bar}`}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
    </div>
  );
}

export default SmartWarnings;
