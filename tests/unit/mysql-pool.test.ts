/**
 * The MySQL test-database pool, exercised without a MySQL server.
 *
 * `tests/helpers/temp-db.ts` gives every vitest process a database of its own so files can run
 * in parallel. The part that can silently go wrong is the slot claim, which is pure
 * filesystem: two processes must never believe they own the same slot, a slot owned by a dead
 * process must be reusable, and a busy pool must degrade instead of hanging the run.
 *
 * These cases drive `claimSlot`/`releaseSlot` directly against a temp directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimSlot,
  poolDatabaseName,
  poolRoot,
  poolSize,
  releaseSlot,
  schemaDigest,
  testDialect,
} from "../helpers/temp-db";

const URL_A = "mysql://root:pass@127.0.0.1:3306/relayx_ci";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "relayx-pool-test-"));
  roots.push(dir);
  return dir;
}

/** A pid that certainly does not exist any more: spawn it, let it exit, keep its number. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof child.pid !== "number") throw new Error("could not spawn a throwaway process");
  return child.pid;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("mysql test pool", () => {
  it("is opt-in, sized for the machine, and keyed on server plus schema", () => {
    // Assert the switch instead of the ambient value, so the suite is valid in a
    // RELAYX_TEST_DIALECT=mysql run too.
    vi.stubEnv("RELAYX_TEST_DIALECT", "");
    expect(testDialect()).toBe("sqlite");
    vi.stubEnv("RELAYX_TEST_DIALECT", "mysql");
    expect(testDialect()).toBe("mysql");
    vi.unstubAllEnvs();
    expect(poolSize()).toBeGreaterThanOrEqual(4);
    expect(poolSize()).toBeLessThanOrEqual(16);
    expect(schemaDigest()).toMatch(/^[0-9a-f]{10}$/);
    expect(poolRoot(URL_A)).not.toBe(poolRoot("mysql://root:pass@127.0.0.1:3307/relayx_ci"));
    expect(poolDatabaseName(3, URL_A)).toMatch(/^relayx_t_s3_[0-9a-f]{8}$/);
  });

  it("hands out one slot per live claim and reuses a released one", () => {
    const root = tempRoot();
    const first = claimSlot(root, URL_A);
    const second = claimSlot(root, URL_A);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.database).not.toBe(second!.database);
    expect(readFileSync(first!.lockPath, "utf8")).toMatch(new RegExp(`^${process.pid} `));

    releaseSlot(first!);
    const third = claimSlot(root, URL_A);
    expect(third!.database).toBe(first!.database);
    releaseSlot(second!);
    releaseSlot(third!);
  });

  it("takes over a slot whose owner is gone", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const lockPath = join(root, "slot-0.lock");
    writeFileSync(lockPath, `${deadPid()} 1\n`);

    const slot = claimSlot(root, URL_A);
    expect(slot?.database).toBe(poolDatabaseName(0, URL_A));
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid} `));
    releaseSlot(slot!);
  });

  it("does not steal a lock that a live process is still writing", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    // Empty content, fresh mtime: the owner may be between open() and write().
    const emptyLock = join(root, "slot-0.lock");
    writeFileSync(emptyLock, "");

    const slot = claimSlot(root, URL_A);
    expect(slot?.database).toBe(poolDatabaseName(1, URL_A));
    releaseSlot(slot!);
    rmSync(emptyLock, { force: true });
  });

  it("reclaims an owner-less lock that is older than the write grace window", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const staleLock = join(root, "slot-0.lock");
    writeFileSync(staleLock, "");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(staleLock, longAgo, longAgo);

    const slot = claimSlot(root, URL_A);
    expect(slot?.database).toBe(poolDatabaseName(0, URL_A));
    releaseSlot(slot!);
  });

  it("returns null instead of blocking when every slot is held", () => {
    const root = tempRoot();
    const held = [];
    for (;;) {
      const slot = claimSlot(root, URL_A);
      if (!slot) break;
      held.push(slot);
    }
    expect(held).toHaveLength(poolSize());
    // The caller falls back to a private database at this point, it does not wait.
    expect(claimSlot(root, URL_A)).toBeNull();
    for (const slot of held) releaseSlot(slot);
  });
});
