/**
 * Database seed.
 *
 * Upstream ships no decompiled seed module, so this is a faithful reconstruction of what
 * it must do: make sure at least one super admin exists and materialise the
 * `SystemConfig` defaults so the admin UI has rows to render.
 *
 * Credentials:
 *   - a new admin gets a random API key unless SEED_ADMIN_API_KEY is set;
 *   - an existing super admin keeps its key (`SEED_ADMIN_ROTATE_KEY=1` replaces it).
 *
 * The key is printed once on the line after the email — capture it, it is the bearer
 * credential for the admin API.
 *
 * Usage: pnpm seed
 */
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { DefaultConfig } from "./services/system_config";
import { SystemConfigName } from "@prisma/client";

const DEFAULT_ADMIN_EMAIL = "admin@relayx.local";

async function main(): Promise<void> {
  const production = (process.env.NODE_ENV ?? "production") === "production";
  const email = process.env.SEED_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL;
  if (production && email === DEFAULT_ADMIN_EMAIL) {
    console.warn(
      `[seed] SEED_ADMIN_EMAIL is unset: creating the placeholder admin ${DEFAULT_ADMIN_EMAIL}. ` +
        "Set a real address before exposing the panel.",
    );
  }

  const existing = await prisma.user.findFirst({ where: { super_admin: true } });
  const rotate = process.env.SEED_ADMIN_ROTATE_KEY === "1";
  const requestedKey = process.env.SEED_ADMIN_API_KEY;

  let admin;
  let generatedKey = false;
  if (existing) {
    const apiKey = requestedKey ?? (rotate ? randomUUID() : undefined);
    admin = await prisma.user.update({
      where: { id: existing.id },
      data: {
        super_admin: true,
        status: "active",
        ...(apiKey ? { api_key: apiKey } : {}),
      },
    });
    generatedKey = Boolean(rotate && !requestedKey);
  } else {
    const apiKey = requestedKey ?? randomUUID();
    generatedKey = !requestedKey;
    admin = await prisma.user.create({
      data: { api_key: apiKey, email, super_admin: true, status: "active" },
    });
  }

  // `createMany({ skipDuplicates: true })` is not supported on SQLite, so upsert each row.
  for (const [name, value] of Object.entries(DefaultConfig)) {
    const key = name as SystemConfigName;
    await prisma.systemConfig.upsert({
      where: { name: key },
      create: { name: key, value: JSON.stringify(value) },
      update: {},
    });
  }

  console.log("seeded super admin:", admin.email);
  console.log("api_key:", admin.api_key);
  if (generatedKey) {
    console.log("[seed] this key was generated now and will not be shown again; store it securely");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
