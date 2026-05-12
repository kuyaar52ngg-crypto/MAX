import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; prismaPool: Pool };

const rawConnectionString = process.env.DATABASE_URL || "";

if (!rawConnectionString) {
  throw new Error("DATABASE_URL is not set. Add it to frontend/.env.local");
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(rawConnectionString);
} catch {
  throw new Error("DATABASE_URL is invalid. Use a valid PostgreSQL connection string from Supabase.");
}

if (!parsedUrl.password) {
  throw new Error("DATABASE_URL is missing password. Replace [YOUR-PASSWORD] with your real Supabase database password.");
}

const sslRequired = parsedUrl.searchParams.get("sslmode") === "require";
parsedUrl.searchParams.delete("sslmode");
const connectionString = parsedUrl.toString();

const pool = globalForPrisma.prismaPool || new Pool({
  connectionString,
  max: 1,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  ssl: sslRequired ? { rejectUnauthorized: false } : false,
});

pool.on("error", (error) => {
  console.warn("Postgres pool error:", error.message);
});

globalForPrisma.prismaPool = pool;

const adapter = new PrismaPg(pool);

export const prisma = globalForPrisma.prisma || new PrismaClient({ adapter });

globalForPrisma.prisma = prisma;

function isTransientDbError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Connection terminated unexpectedly") ||
    message.includes("timeout exceeded") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("EPIPE")
  );
}

export async function prismaRetry<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  throw lastError;
}

export default prisma;
