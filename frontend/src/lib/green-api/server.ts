/**
 * Server-only singletone и утилиты для фичи `green-api-shared-instance-auth`.
 *
 * Внутри импортируется Prisma (через `audit.ts`) — этот модуль НЕЛЬЗЯ
 * импортировать из client-компонентов.
 */

import "server-only";

export { ThrottleGate, ThrottleTimeoutError } from "./throttle";
export { GreenAPIClient } from "./client";
export { auditLog } from "./audit";

import { ThrottleGate } from "./throttle";
import { GreenAPIClient } from "./client";

const globalForGate = globalThis as unknown as {
  __greenApiThrottleGate?: ThrottleGate;
  __greenApiClient?: GreenAPIClient;
};

export const throttleGate: ThrottleGate =
  globalForGate.__greenApiThrottleGate ?? new ThrottleGate();
export const greenApiClient: GreenAPIClient =
  globalForGate.__greenApiClient ?? new GreenAPIClient(throttleGate);

if (process.env.NODE_ENV !== "production") {
  globalForGate.__greenApiThrottleGate = throttleGate;
  globalForGate.__greenApiClient = greenApiClient;
}
