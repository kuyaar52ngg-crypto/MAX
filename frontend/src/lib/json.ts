import { NextResponse } from "next/server";

export function jsonResponse(data: unknown, init?: ResponseInit) {
  return new NextResponse(
    JSON.stringify(data, (_, value) => {
      if (typeof value === "bigint") return Number(value);
      if (value instanceof Date) return value.toISOString();
      return value;
    }),
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    }
  );
}
