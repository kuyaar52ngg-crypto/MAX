"use client";

import { useState } from "react";
import {
  AntiBanConfig,
  computeEta,
  computeRisk,
} from "@/lib/anti-ban";

export interface PreFlightModalProps {
  open: boolean;
  kind: "check" | "broadcast";
  total: number;
  config: AntiBanConfig;
  onConfirm: () => void;
  onCancel: () => void;
}

const RISK_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
};

const RISK_COLOR: Record<"low" | "medium" | "high", string> = {
  low: "text-green-700",
  medium: "text-yellow-700",
  high: "text-red-700",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${remSec.toString().padStart(2, "0")} сек`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours} ч ${remMin.toString().padStart(2, "0")} мин`;
}

export function PreFlightModal({
  open,
  kind,
  total,
  config,
  onConfirm,
  onCancel,
}: PreFlightModalProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  if (!open) return null;

  const eta = computeEta(config, total);
  const risk = computeRisk(total);
  const title = kind === "check" ? "Массовая проверка номеров" : "Рассылка сообщений";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preflight-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 m-4">
        <h2 id="preflight-title" className="text-lg font-semibold mb-4">
          {title}
        </h2>
        <div className="space-y-3 text-sm">
          <div>
            <span className="font-medium">Количество:</span> {total}
          </div>
          <div>
            <span className="font-medium">Расчётная длительность:</span>{" "}
            {formatDuration(eta)}
          </div>
          <div>
            <span className="font-medium">Риск:</span>{" "}
            <span className={`font-semibold ${RISK_COLOR[risk]}`}>
              {RISK_LABEL[risk]}
            </span>
          </div>
        </div>

        <label className="flex items-start gap-2 mt-6 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span className="text-sm">Я понимаю риски запуска массовой операции</span>
        </label>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-50"
            onClick={() => {
              setAcknowledged(false);
              onCancel();
            }}
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={!acknowledged}
            className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700"
            onClick={() => {
              if (acknowledged) {
                setAcknowledged(false);
                onConfirm();
              }
            }}
          >
            Запустить
          </button>
        </div>
      </div>
    </div>
  );
}

export default PreFlightModal;
