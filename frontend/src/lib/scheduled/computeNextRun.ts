/**
 * Вычисление `next_run_at` для scheduled broadcast.
 *
 * Та же логика дублируется на стороне Flask-планировщика
 * (`scheduler.py::compute_next_recurring_run` / quiet hours), но мы
 * делаем расчёт и здесь, чтобы при создании задачи через UI первое
 * значение `next_run_at` было корректным сразу — без ожидания первого
 * Flask-tick. После выполнения задачи планировщик сам перепланирует
 * следующий запуск.
 */

import type {
  CreateScheduledBroadcastInput,
  ScheduleType,
  RecurringKind,
} from "./types";

interface ComputeArgs {
  schedule_type: ScheduleType;
  scheduled_for?: string | null;
  recurring_kind?: RecurringKind | null;
  recurring_hour?: number | null;
  recurring_minute?: number | null;
  recurring_day_of_week?: number | null;
  recurring_day_of_month?: number | null;
  recurring_until?: string | null;
  user_tz?: string;
}

/**
 * Возвращает Date или null, если задачу нельзя запланировать
 * (некорректные параметры). Возвращаемое значение — UTC ISO datetime.
 */
export function computeNextRunAt(input: ComputeArgs): Date | null {
  const now = new Date();
  if (input.schedule_type === "once" || input.schedule_type === "drip") {
    if (input.scheduled_for) {
      const d = new Date(input.scheduled_for);
      if (!Number.isFinite(d.getTime())) return null;
      // Если время уже прошло, запустим сейчас (≈ ASAP).
      return d.getTime() < now.getTime() ? now : d;
    }
    return null;
  }

  if (input.schedule_type === "recurring") {
    return computeNextRecurringRun({
      kind: input.recurring_kind ?? "daily",
      hour: input.recurring_hour ?? 10,
      minute: input.recurring_minute ?? 0,
      dayOfWeek: input.recurring_day_of_week ?? null,
      dayOfMonth: input.recurring_day_of_month ?? null,
      userTz: input.user_tz ?? "UTC",
      after: now,
    });
  }
  return null;
}

interface RecurringArgs {
  kind: RecurringKind;
  hour: number;
  minute: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  userTz: string;
  after: Date;
}

/**
 * Считаем следующий запуск с учётом таймзоны пользователя через
 * `Intl.DateTimeFormat` (без зависимостей вроде date-fns/luxon).
 *
 * Алгоритм:
 *   1. Берём `after` в UTC, конвертируем в user_tz через формат.
 *   2. Строим candidate = "сегодня в HH:MM в tz пользователя".
 *   3. Если candidate <= now (в той же tz) — сдвигаем на следующий день/неделю/месяц.
 *   4. Конвертируем обратно в UTC через предположение, что
 *      `Intl.DateTimeFormat` даёт нам разницу в минутах.
 *
 * Чтобы избежать тонкостей DST, используем простой трюк: берём
 * candidate как "naive local datetime" + выясняем offset через
 * формат "GMT+05:00".
 */
function computeNextRecurringRun(args: RecurringArgs): Date | null {
  const { kind, hour, minute, dayOfWeek, dayOfMonth, userTz, after } = args;

  // Получаем компоненты "after" в user_tz
  const parts = getZonedParts(after, userTz);

  let year = parts.year;
  let month = parts.month; // 1..12
  let day = parts.day;
  const targetWeekday =
    dayOfWeek !== null && dayOfWeek !== undefined ? dayOfWeek : null;

  // Базовый candidate "сегодня"
  let candidateLocal = naiveDate(year, month, day, hour, minute);

  if (kind === "daily") {
    if (
      isBeforeOrEqual(candidateLocal, naiveDate(parts.year, parts.month, parts.day, parts.hour, parts.minute))
    ) {
      candidateLocal = addDaysNaive(candidateLocal, 1);
    }
  } else if (kind === "weekly") {
    if (targetWeekday === null) return null;
    // Mon=0..Sun=6 — приведём к Date.getDay() (Sun=0..Sat=6)
    const jsTargetDow = (targetWeekday + 1) % 7;
    const currentDow = naiveWeekday(candidateLocal);
    let delta = (jsTargetDow - currentDow + 7) % 7;
    candidateLocal = addDaysNaive(candidateLocal, delta);
    if (
      isBeforeOrEqual(
        candidateLocal,
        naiveDate(parts.year, parts.month, parts.day, parts.hour, parts.minute),
      )
    ) {
      candidateLocal = addDaysNaive(candidateLocal, 7);
    }
  } else if (kind === "monthly") {
    if (dayOfMonth === null || dayOfMonth === undefined) return null;
    candidateLocal = naiveDate(year, month, Math.min(dayOfMonth, 28), hour, minute);
    if (
      isBeforeOrEqual(
        candidateLocal,
        naiveDate(parts.year, parts.month, parts.day, parts.hour, parts.minute),
      )
    ) {
      // Следующий месяц
      let nextMonth = month + 1;
      let nextYear = year;
      if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
      }
      candidateLocal = naiveDate(
        nextYear,
        nextMonth,
        Math.min(dayOfMonth, 28),
        hour,
        minute,
      );
    }
  } else {
    return null;
  }

  // Конвертируем naive local datetime → UTC через offset в user_tz
  const utc = naiveToUtc(candidateLocal, userTz);
  return utc;
}

/** Возвращает компоненты Date в указанной таймзоне. */
function getZonedParts(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // "24:xx" приходит как 24
    minute: get("minute"),
  };
}

/** "Naive datetime" без таймзоны — храним как Date.UTC(...) для сравнений. */
function naiveDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function naiveWeekday(d: Date): number {
  return d.getUTCDay();
}

function addDaysNaive(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function isBeforeOrEqual(a: Date, b: Date): boolean {
  return a.getTime() <= b.getTime();
}

/**
 * Преобразование naive local datetime в UTC. Узнаём offset
 * пользовательской tz в этот момент через formatToParts с
 * `timeZoneName: "shortOffset"` (поддержка с Node 18+ / современных браузеров).
 */
function naiveToUtc(naiveLocal: Date, tz: string): Date {
  // Берём Date с тем же "wall clock", вычисляем offset, корректируем.
  // Алгоритм: trial = naive Date.UTC; смотрим, как Intl видит этот момент в tz;
  // разница между "wall clock в tz" и "wall clock из naive" — offset.
  const asUtc = naiveLocal.getTime();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(asUtc));
  const get = (t: string) =>
    parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const seenAsUtcMillis = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  const offsetMillis = seenAsUtcMillis - asUtc;
  return new Date(asUtc - offsetMillis);
}

/**
 * Базовая валидация payload до записи в БД.
 * Возвращает массив проблем; пустой массив = ok.
 */
export function validateScheduleInput(input: CreateScheduledBroadcastInput): string[] {
  const errors: string[] = [];
  if (!input.message?.trim() && !input.file_url) {
    errors.push("Текст сообщения или файл обязательны");
  }
  if (!Array.isArray(input.contacts) || input.contacts.length === 0) {
    errors.push("Список получателей пуст");
  }
  if (!["once", "drip", "recurring"].includes(input.schedule_type)) {
    errors.push("Неизвестный тип расписания");
  }
  if (input.schedule_type === "once" && !input.scheduled_for) {
    errors.push("Для разового запуска укажите дату и время");
  }
  if (input.schedule_type === "drip") {
    if (!input.scheduled_for) {
      errors.push("Для drip-кампании укажите время старта");
    }
    if (!input.drip_batch_size || input.drip_batch_size < 1) {
      errors.push("Размер волны должен быть ≥ 1");
    }
    if (!input.drip_interval_minutes || input.drip_interval_minutes < 1) {
      errors.push("Интервал между волнами должен быть ≥ 1 минуты");
    }
  }
  if (input.schedule_type === "recurring") {
    const kind = input.recurring_kind;
    if (!kind || !["daily", "weekly", "monthly"].includes(kind)) {
      errors.push("Укажите тип повторения (daily/weekly/monthly)");
    }
    if (
      input.recurring_hour === null ||
      input.recurring_hour === undefined ||
      input.recurring_hour < 0 ||
      input.recurring_hour > 23
    ) {
      errors.push("Час повторения должен быть в диапазоне 0..23");
    }
    if (
      input.recurring_minute === null ||
      input.recurring_minute === undefined ||
      input.recurring_minute < 0 ||
      input.recurring_minute > 59
    ) {
      errors.push("Минута повторения должна быть в диапазоне 0..59");
    }
    if (kind === "weekly" && (input.recurring_day_of_week === null || input.recurring_day_of_week === undefined)) {
      errors.push("Для еженедельного повтора укажите день недели");
    }
    if (kind === "monthly" && (input.recurring_day_of_month === null || input.recurring_day_of_month === undefined)) {
      errors.push("Для ежемесячного повтора укажите число месяца");
    }
  }
  if (input.quiet_hours_enabled) {
    const s = input.quiet_hours_start ?? 22;
    const e = input.quiet_hours_end ?? 8;
    if (s < 0 || s > 23 || e < 0 || e > 23) {
      errors.push("Тихие часы вне диапазона 0..23");
    }
  }
  return errors;
}
