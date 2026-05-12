import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const connectionString = process.env.DATABASE_URL?.replace("sslmode=require", "");

const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  ssl: {
    rejectUnauthorized: false,
  },
});

const adapter = new PrismaPg(pool);

export const prisma = globalForPrisma.prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
} else {
  globalForPrisma.prisma = prisma;
}

export default prisma;
