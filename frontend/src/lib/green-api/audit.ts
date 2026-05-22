/**
 * Тонкая обёртка над `prisma.incidentLog.create` для событий, связанных
 * с GREEN-API инстансами (Requirement 9). Никогда не пробрасывает ошибки
 * наружу — попадание в `audit_log_write_failed` логируется и originating
 * action продолжает быть успешным (Requirement 9.6).
 */

import { Prisma } from "@prisma/client";
import { prisma, prismaRetry } from "@/lib/prisma";
import type { AuditEventDetails, AuditEventKind } from "./types/contracts";

export async function auditLog(
  eventKind: AuditEventKind,
  userId: string,
  details: AuditEventDetails,
): Promise<void> {
  try {
    await prismaRetry(() =>
      prisma.incidentLog.create({
        data: {
          user_id: userId,
          kind: eventKind,
          details: details as unknown as Prisma.InputJsonValue,
          operation_run_id: null,
        },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("audit_log_write_failed", { eventKind, userId, error: message });
  }
}
