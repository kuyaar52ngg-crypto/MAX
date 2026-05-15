"use client";

import type { InstanceState } from "@/lib/anti-ban";

interface StateBadgeProps {
  state: InstanceState;
  className?: string;
}

const STATE_LABELS: Record<InstanceState, string> = {
  authorized: "Авторизован",
  yellowCard: "Yellow card",
  blocked: "Заблокирован",
  notAuthorized: "Не авторизован",
  starting: "Запускается",
  sleepMode: "Сон",
  unknown: "Неизвестно",
};

const STATE_COLORS: Record<InstanceState, string> = {
  authorized: "bg-green-100 text-green-800 border-green-300",
  yellowCard: "bg-yellow-100 text-yellow-800 border-yellow-300",
  blocked: "bg-red-100 text-red-800 border-red-300",
  notAuthorized: "bg-red-100 text-red-800 border-red-300",
  starting: "bg-blue-100 text-blue-800 border-blue-300",
  sleepMode: "bg-blue-100 text-blue-800 border-blue-300",
  unknown: "bg-gray-100 text-gray-700 border-gray-300",
};

export function StateBadge({ state, className }: StateBadgeProps) {
  const label = STATE_LABELS[state] ?? state;
  const color = STATE_COLORS[state] ?? STATE_COLORS.unknown;
  return (
    <span
      role="status"
      aria-label={`Instance state: ${label}`}
      className={[
        "inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border",
        color,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label}
    </span>
  );
}

export default StateBadge;
