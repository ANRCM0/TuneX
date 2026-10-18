import { PrismaClient } from "@prisma/client";
import { isProduction } from "./config";

/**
 * PrismaClient singleton.
 *
 * The generated client is produced from apps/backend/prisma/schema.prisma, a faithful
 * port of the recovered MySQL schema onto SQLite (see docs/DEVIATIONS.md §1).
 */
export const prisma = new PrismaClient({
  log: isProduction() ? ["warn", "error"] : ["warn", "error"],
});

/**
 * Upstream calls the client `db` (its `src/db.ts` default-exports the singleton as
 * `db_default`); the replica exposes that name as an alias so recovered call sites read
 * identically.
 */
export const db = prisma;

export type Db = typeof prisma;
export type { Prisma } from "@prisma/client";
