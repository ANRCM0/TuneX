import { defineConfig } from "vitest/config";

/**
 * Unit/E2E test configuration.
 *
 * `testTimeout` is deliberately larger than Vitest's 5 s default: several suites build a
 * full database fixture (users, plans, node groups, tunnels) before asserting, and
 * `scripts/verify.sh` runs the suite right after Prisma generation, which makes the first
 * handful of cases several times slower than a warm run. A cold, loaded machine was hitting
 * the 5 s budget on otherwise-correct tests; 30 s keeps the signal (a real hang still fails)
 * without masking slow assertions.
 */
export default defineConfig({
  // No `include`: each package keeps Vitest's default discovery, so running the suite from
  // `apps/license-server` still finds its own `tests/`. Only the budgets are overridden.
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
