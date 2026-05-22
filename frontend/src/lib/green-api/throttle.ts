/**
 * `ThrottleGate` — in-memory mutex per-instance.
 *
 * Гарантирует:
 *   1. Не более одного in-flight вызова для одного `instanceId`
 *      (Property 3 / Requirement 6.6).
 *   2. Минимальный интервал `minIntervalMs` (по умолчанию 1.5 сек) между
 *      двумя последовательными вызовами для одного `instanceId`
 *      (Property 2 / Requirement 6.7).
 *   3. Если ожидание в очереди превышает `maxQueueWaitMs`, бросает
 *      `ThrottleTimeoutError`.
 *
 * Ленивая регистрация lane: запись в `lanes` создаётся при первом обращении
 * и далее переиспользуется.
 */

interface InstanceLane {
  /** Цепочка in-flight вызовов: каждый next.then() ждёт предыдущего. */
  mutex: Promise<void>;
  /** Время завершения предыдущего вызова, ms (через `nowFn`). */
  lastCallTimestamp: number;
}

export class ThrottleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ThrottleGate: queue wait exceeded ${timeoutMs}ms`);
    this.name = "ThrottleTimeoutError";
  }
}

export class ThrottleGate {
  private readonly lanes = new Map<string, InstanceLane>();

  constructor(
    private readonly minIntervalMs: number = 1500,
    private readonly maxQueueWaitMs: number = 5000,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Сериализует вызов `fn` для данного `instanceId`. Возвращает результат `fn`.
   *
   * Алгоритм:
   *   1. Получить или создать lane для instanceId.
   *   2. Дождаться завершения предыдущего цикла (race с queue-timeout).
   *   3. Подождать минимальный интервал между вызовами.
   *   4. Выполнить `fn`, обновить `lastCallTimestamp`.
   *   5. Уступить lane следующему ожидающему.
   */
  async withGate<T>(instanceId: bigint | string, fn: () => Promise<T>): Promise<T> {
    const key = String(instanceId);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { mutex: Promise.resolve(), lastCallTimestamp: 0 };
      this.lanes.set(key, lane);
    }
    const prev = lane.mutex;

    // Заранее «застолбим» свой шаг в цепочке так, чтобы следующий вызов
    // ждал именно нас.
    let releaseSlot!: () => void;
    const slot = new Promise<void>((res) => {
      releaseSlot = res;
    });
    lane.mutex = slot;

    try {
      // Ждём предыдущий вызов. Если он завис дольше, чем maxQueueWaitMs — бросаем.
      await this.waitWithTimeout(prev, this.maxQueueWaitMs);

      // Дотянуть min-interval.
      const now = this.nowFn();
      const wait = Math.max(0, lane.lastCallTimestamp + this.minIntervalMs - now);
      if (wait > 0) {
        await this.sleepFn(wait);
      }

      // Сам вызов.
      try {
        const result = await fn();
        lane.lastCallTimestamp = this.nowFn();
        return result;
      } catch (err) {
        // Даже на ошибку обновляем timestamp, чтобы не задавать GREEN-API
        // следующим запросом меньше чем через 1.5s.
        lane.lastCallTimestamp = this.nowFn();
        throw err;
      }
    } finally {
      releaseSlot();
    }
  }

  /** Гонка между промисом и таймером. Если первым «выигрывает» таймер — бросаем. */
  private async waitWithTimeout(p: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const winner = await Promise.race([p.then(() => "ok" as const), timeoutPromise]);
      if (winner === "timeout") {
        throw new ThrottleTimeoutError(timeoutMs);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
