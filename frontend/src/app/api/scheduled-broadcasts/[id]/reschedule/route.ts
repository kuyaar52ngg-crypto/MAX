/**
 * `POST /api/scheduled-broadcasts/[id]/reschedule` — атомарное
 * перепланирование остатка рассылки на новое время.
 *
 * Поведение и контракт задаются Requirement 11.5 / 11.6 / 11.7 / 11.8 / 11.9
 * спецификации `broadcast-scheduling-suite`:
 *
 *   11.5 Body `{ scheduled_for: ISOString }`. Если оригинал в
 *        `{running, paused}` — снапшот pending-получателей,
 *        создание новой `ScheduledBroadcast` с этими телефонами,
 *        копирование `message`, `personalized_messages`,
 *        `use_typing`, `delay_seconds`, `file_url`, `file_name`,
 *        `instance_id`, `adaptive_throttle`, `quiet_hours_*`,
 *        `respect_recipient_tz`, `user_tz`. Оригинал →
 *        `completed` (если были sent) либо `cancelled` (если pending пусто).
 *   11.6 Новый broadcast получает `parent_broadcast_id = original.id`.
 *   11.7 `follow_up_chain_id` копируется bit-for-bit без преобразований
 *        (включая `null`).
 *   11.8 `scheduled_for <= now()` → 400 `RESCHEDULE_IN_PAST`,
 *        обе записи остаются неизменными.
 *   11.9 `status not in {running, paused}` → 409 `RESCHEDULE_INVALID_STATUS`,
 *        новая рассылка не создаётся.
 *
 * Реализация — прямой Prisma transaction в TypeScript, зеркалирующий
 * Python-операцию `scheduling/reschedule_op.py::execute()`. Этот
 * паттерн совпадает с `enhanced-broadcast-scheduling` (snooze, approve,
 * reject) — все CRUD-эндпоинты scheduled-broadcasts работают через
 * Prisma напрямую, а Flask занимается только Green-API I/O.
 *
 * Транзакция:
 *   1. `SELECT ... FOR UPDATE` на исходной строке (raw SQL, ownership
 *      check встроен в WHERE) — блокирует параллельные
 *      reschedule/pause/resume/snooze.
 *   2. Status guard.
 *   3. Snapshot pending recipients через линковку
 *      `operation_runs.payload->>'scheduled_broadcast_id'` (та же
 *      связь, что использует `scheduling/reschedule_op.py`).
 *   4. INSERT новой записи + UPDATE оригинала, либо просто UPDATE
 *      на `cancelled` если pending пусто.
 *   5. COMMIT.
 *
 * Response: `{ new_broadcast_id, original_status_after }`. При пустом
 * pending — `new_broadcast_id` равен `null`.
 */

import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Статусы, при которых reschedule разрешён (Req 11.5/11.9). */
const RESCHEDULE_VALID_STATUSES = new Set(["running", "paused"]);

interface RescheduleRequestBody {
  scheduled_for?: unknown;
}

/**
 * Минимальный набор колонок исходной рассылки, нужный для (a) ownership/status
 * guard и (b) копирования полей в новую запись. Сознательно явный список —
 * чтобы изменения схемы (новые колонки) не ломали поведение reschedule
 * без явного обновления контракта.
 */
type OriginalRow = {
  id: bigint;
  user_id: string;
  name: string | null;
  message: string;
  contacts: Prisma.JsonValue;
  personalized_messages: Prisma.JsonValue | null;
  use_typing: boolean;
  delay_seconds: number;
  file_url: string | null;
  file_name: string | null;
  schedule_type: string;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  respect_recipient_tz: boolean;
  user_tz: string;
  status: string;
  instance_id: bigint | null;
  adaptive_throttle: boolean;
  follow_up_chain_id: bigint | null;
};

/**
 * Извлечь номер из элемента `contacts`-JSONB. Совпадает с правилами,
 * принятыми в `scheduling/reschedule_op.py::_extract_phone` и в
 * `BroadcastContact` фронт-энде:
 *   • dict с ключом `phone`        → значение этого ключа
 *   • строка                       → сама строка
 *   • любой другой тип             → пустая строка (отбрасывается)
 */
function extractPhone(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object" && "phone" in value) {
    const phone = (value as { phone?: unknown }).phone;
    if (typeof phone === "string") return phone.trim();
    if (phone !== null && phone !== undefined) return String(phone).trim();
  }
  return "";
}

/**
 * Дедуплицированный список телефонов из `original.contacts`. Используется
 * как fallback, если broadcast никогда не запускался worker'ом
 * (нет ни одной linked `recipients`-строки) — в этом случае все
 * исходные контакты считаются pending. Это явное поведение из
 * `reschedule_op.py` (см. модульный docstring там же).
 */
function phonesFromContacts(rawContacts: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(rawContacts)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawContacts) {
    const phone = extractPhone(item);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    let jobId: bigint;
    try {
      jobId = BigInt(id);
    } catch {
      return jsonResponse({ error: "Invalid id" }, { status: 400 });
    }

    let body: RescheduleRequestBody;
    try {
      body = (await req.json()) as RescheduleRequestBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    // ── Body validation ────────────────────────────────────────────
    if (typeof body.scheduled_for !== "string" || !body.scheduled_for) {
      return jsonResponse(
        {
          error: "scheduled_for is required (ISO 8601 string)",
          error_code: "RESCHEDULE_BODY_INVALID",
        },
        { status: 400 },
      );
    }
    const scheduledFor = new Date(body.scheduled_for);
    if (Number.isNaN(scheduledFor.getTime())) {
      return jsonResponse(
        {
          error: "scheduled_for is not a valid ISO 8601 datetime",
          error_code: "RESCHEDULE_BODY_INVALID",
        },
        { status: 400 },
      );
    }

    // ── Req 11.8: scheduled_for must be strictly in the future ─────
    // Проверяем ДО открытия транзакции — гарантирует Property 23
    // (rejecting past timestamps оставляет обе записи неизменными).
    const now = new Date();
    if (scheduledFor.getTime() <= now.getTime()) {
      return jsonResponse(
        {
          error: `scheduled_for=${scheduledFor.toISOString()} <= now=${now.toISOString()}`,
          error_code: "RESCHEDULE_IN_PAST",
        },
        { status: 400 },
      );
    }

    // ── Атомарная транзакция ───────────────────────────────────────
    // Используем interactive transaction Prisma'и, чтобы держать
    // явный `SELECT ... FOR UPDATE` на исходной строке между чтениями
    // и записями. Это зеркалит поведение Python-операции
    // (`reschedule_op.execute`) и защищает от гонок с worker'ом и
    // конкурирующими pause/resume на том же broadcast.
    let outcome:
      | {
          kind: "not_found";
        }
      | {
          kind: "invalid_status";
          status: string;
        }
      | {
          kind: "cancelled";
          originalId: bigint;
        }
      | {
          kind: "rescheduled";
          originalId: bigint;
          newBroadcastId: bigint;
          pendingCount: number;
        };

    try {
      outcome = await prismaRetry(() =>
        prisma.$transaction(async (tx) => {
          // 1. SELECT FOR UPDATE на исходной строке (с ownership check
          //    встроенным в WHERE). Возвращает 0 строк, если broadcast
          //    не существует ИЛИ принадлежит другому пользователю —
          //    в обоих случаях отвечаем 404 (defence-in-depth).
          const lockedRows = await tx.$queryRaw<OriginalRow[]>`
            SELECT id,
                   user_id,
                   name,
                   message,
                   contacts,
                   personalized_messages,
                   use_typing,
                   delay_seconds,
                   file_url,
                   file_name,
                   schedule_type,
                   quiet_hours_enabled,
                   quiet_hours_start,
                   quiet_hours_end,
                   respect_recipient_tz,
                   user_tz,
                   status,
                   instance_id,
                   adaptive_throttle,
                   follow_up_chain_id
              FROM scheduled_broadcasts
             WHERE id = ${jobId}
               AND user_id = ${user.id}::uuid
             FOR UPDATE
          `;

          if (lockedRows.length === 0) {
            return { kind: "not_found" as const };
          }
          const original = lockedRows[0];

          // 2. Req 11.9: status guard. Возвращаем без записей —
          //    транзакция всё равно завершится COMMIT'ом без эффекта,
          //    потому что мы ничего не пишем.
          if (!RESCHEDULE_VALID_STATUSES.has(original.status)) {
            return {
              kind: "invalid_status" as const,
              status: original.status,
            };
          }

          // 3. Snapshot pending recipients. Линковка
          //    scheduled_broadcasts → recipients идёт через
          //    operation_runs.payload->>'scheduled_broadcast_id'
          //    (см. scheduler.py:602-612). Этот же запрос лежит в
          //    `scheduling/reschedule_op.py::_SELECT_LINKED_RECIPIENTS_SQL`.
          //
          //    Возвращаем все статусы (не только pending), чтобы
          //    отличить «broadcast никогда не стартовал» (нет строк)
          //    от «все уже отправлены» (есть строки, но pending = 0).
          const recipientRows = await tx.$queryRaw<
            { phone: string; status: string }[]
          >`
            SELECT r.phone   AS phone,
                   r.status  AS status
              FROM recipients r
             WHERE r.broadcast_id IN (
                      SELECT DISTINCT opr.broadcast_id
                        FROM operation_runs opr
                       WHERE opr.broadcast_id IS NOT NULL
                         AND opr.user_id = ${user.id}::uuid
                         AND opr.payload::jsonb ->> 'scheduled_broadcast_id'
                             = ${String(jobId)}
                   )
          `;

          let pendingPhones: string[];
          if (recipientRows.length === 0) {
            // Broadcast никогда не запускался worker'ом (типичный
            // случай status='paused' сразу после create) — все
            // исходные контакты pending.
            pendingPhones = phonesFromContacts(original.contacts);
          } else {
            const seen = new Set<string>();
            pendingPhones = [];
            for (const row of recipientRows) {
              if (
                String(row.status ?? "")
                  .trim()
                  .toLowerCase() !== "pending"
              ) {
                continue;
              }
              const phone = String(row.phone ?? "").trim();
              if (!phone || seen.has(phone)) continue;
              seen.add(phone);
              pendingPhones.push(phone);
            }
          }

          // 4a. Pending пусто → original.status = 'cancelled', новая
          //     рассылка не создаётся (Req 11.5(c) "if there were none").
          if (pendingPhones.length === 0) {
            await tx.scheduledBroadcast.update({
              where: { id: original.id },
              data: {
                status: "cancelled",
                last_run_at: now,
                next_run_at: null,
              },
            });
            return {
              kind: "cancelled" as const,
              originalId: original.id,
            };
          }

          // 4b. Pending есть → INSERT новой ScheduledBroadcast +
          //     UPDATE original = 'completed'.
          //     Все копируемые поля заданы Req 11.5; parent_broadcast_id
          //     (Req 11.6) и follow_up_chain_id (Req 11.7, exact-value copy)
          //     добавляются явно.
          const newBroadcast = await tx.scheduledBroadcast.create({
            data: {
              user_id: original.user_id,
              name: original.name,
              message: original.message,
              contacts: pendingPhones.map((phone) => ({
                phone,
              })) as unknown as Prisma.InputJsonValue,
              personalized_messages:
                original.personalized_messages === null
                  ? Prisma.JsonNull
                  : (original.personalized_messages as Prisma.InputJsonValue),
              use_typing: original.use_typing,
              delay_seconds: original.delay_seconds,
              file_url: original.file_url,
              file_name: original.file_name,
              schedule_type: original.schedule_type,
              scheduled_for: scheduledFor,
              quiet_hours_enabled: original.quiet_hours_enabled,
              quiet_hours_start: original.quiet_hours_start,
              quiet_hours_end: original.quiet_hours_end,
              respect_recipient_tz: original.respect_recipient_tz,
              user_tz: original.user_tz,
              status: "scheduled",
              next_run_at: scheduledFor,
              instance_id: original.instance_id,
              adaptive_throttle: original.adaptive_throttle,
              // Req 11.7 / Property 21: bit-for-bit copy включая null,
              // без преобразований, regeneration или wrapping.
              follow_up_chain_id: original.follow_up_chain_id,
              // Req 11.6: связь с оригиналом.
              parent_broadcast_id: original.id,
            },
          });

          await tx.scheduledBroadcast.update({
            where: { id: original.id },
            data: {
              status: "completed",
              last_run_at: now,
              next_run_at: null,
            },
          });

          return {
            kind: "rescheduled" as const,
            originalId: original.id,
            newBroadcastId: newBroadcast.id,
            pendingCount: pendingPhones.length,
          };
        }),
      );
    } catch (txError: unknown) {
      const message =
        txError instanceof Error ? txError.message : "Unknown error";
      console.error("scheduled-broadcasts/[id]/reschedule TX:", message);
      return jsonResponse(
        {
          error: `DB error during reschedule: ${message}`,
          error_code: "RESCHEDULE_DB_ERROR",
        },
        { status: 500 },
      );
    }

    // ── Response shaping ───────────────────────────────────────────
    if (outcome.kind === "not_found") {
      return jsonResponse(
        {
          error: "Scheduled broadcast not found",
          error_code: "RESCHEDULE_NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (outcome.kind === "invalid_status") {
      return jsonResponse(
        {
          error: `Cannot reschedule a broadcast in status "${outcome.status}"`,
          error_code: "RESCHEDULE_INVALID_STATUS",
        },
        { status: 409 },
      );
    }
    if (outcome.kind === "cancelled") {
      // Pending был пуст: новая рассылка не создавалась, оригинал
      // переведён в `cancelled`. Контракт: `new_broadcast_id = null`.
      return jsonResponse({
        new_broadcast_id: null,
        original_status_after: "cancelled",
        pending_recipient_count: 0,
      });
    }
    return jsonResponse({
      new_broadcast_id: Number(outcome.newBroadcastId),
      original_status_after: "completed",
      pending_recipient_count: outcome.pendingCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("scheduled-broadcasts/[id]/reschedule POST:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
