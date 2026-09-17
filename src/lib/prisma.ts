import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { config } from "../config/config";

// config.ts loads .env with override: true before this module code runs,
// so DATABASE_URL is always the value from .env regardless of shell env vars.

const globalForPrisma =
  globalThis as typeof globalThis & {
    __sewaguruPrisma?: PrismaClient;
  };

const connectionString = (
  process.env.DATABASE_URL ?? ""
).trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required to initialize Prisma."
  );
}

const poolConfig = {
  connectionString,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis:
    config.DATABASE_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis:
    config.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  allowExitOnIdle:
    config.NODE_ENV !== "production",
};

const createPrismaClient = () => {
  const adapter = new PrismaPg(
    poolConfig
  );

  return new PrismaClient({
    adapter,
  });
};

const prisma =
  globalForPrisma.__sewaguruPrisma ??
  createPrismaClient();

if (config.NODE_ENV !== "production") {
  globalForPrisma.__sewaguruPrisma =
    prisma;
}

export { prisma };
