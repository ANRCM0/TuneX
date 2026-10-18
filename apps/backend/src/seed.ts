/**
 * Database seed.
 *
 * Upstream ships no decompiled seed module, so this is a faithful reconstruction of what
 * it must do: make sure at least one super admin exists (`authRequired` auto-promotes the
 * first account it ever sees, but a fresh database also needs a usable API key) and
 * materialise the `SystemConfig` defaults so the admin UI has rows to render.
 *
 * Usage: pnpm seed
 */
import { prisma } from "./db";
import { DefaultConfig } from "./services/system_config";
import { SystemConfigName } from "@prisma/client";

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@relayx.local";
  // Deterministic by default so a fresh clone (db:reset → db:push → seed) has a known
  // admin key for `tests/e2e/smoke.test.ts`. Override with SEED_ADMIN_API_KEY.
  const apiKey =
    process.env.SEED_ADMIN_API_KEY ?? "a34d563e-9efe-4047-9e20-05a9678ef5fb";

  const existing = await prisma.user.findFirst({
    where: { super_admin: true },
  });

  const admin = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { super_admin: true, status: "active" },
      })
    : await prisma.user.create({
        data: { api_key: apiKey, email, super_admin: true, status: "active" },
      });

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
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
