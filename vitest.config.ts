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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Generated Prisma/Zod output is not hand-written logic and would drown the signal.
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.config.*",
        "**/generated/**",
        "apps/web/**", // covered by the web suites below, measured separately
        "apps/agent/**",
        "tests/**",
        "scripts/**",
        // Standalone `node` harnesses driven by CI (schema generation, MySQL smokes). They are
        // executed, not imported by the app, so no unit test can cover them; their correctness
        // is proven by the workflows that run them.
        "apps/*/scripts/**",
      ],
      // Ratchet, not an aspiration: set a few points under the measured baseline so a real
      // regression fails CI while refactors do not. Raise these when coverage improves.
      //   measured 2026-10-20 (after the ops/integration suites):
      //   statements 65.4 / branches 79.9 / functions 74.2 / lines 65.4
      thresholds: {
        statements: 64,
        branches: 78,
        functions: 72,
        lines: 64,
      },
    },
  },
});
