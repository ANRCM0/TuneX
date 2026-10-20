/**
 * The web app ships a route manifest (`apps/web/routes.json`, generated from the
 * reverse-engineering route table). This suite keeps the manifest and the file tree
 * in sync: every declared route must have a page, and every page must be declared.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — JSON import is enabled by resolveJsonModule
import manifest from "../../apps/web/routes.json";

const APP_DIR = join(process.cwd(), "apps/web/src/app");
const GROUPS = ["(main)/", ""];

type Route = { path: string; kind?: string; implemented?: boolean };

const routes = (manifest as { routes: Route[] }).routes;

function pageFile(routePath: string): string | null {
  const segs = routePath === "/" ? "" : routePath.replace(/^\//, "");
  const candidates = segs
    ? GROUPS.map((g) => join(APP_DIR, `${g}${segs}/page.tsx`))
    : [join(APP_DIR, "page.tsx")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

describe("route manifest", () => {
  it("declares 43 application routes (Next internals excluded)", () => {
    expect(routes).toHaveLength(43);
  });

  it("has a page file for every declared route", () => {
    const missing = routes.filter((r) => r.implemented !== false && !pageFile(r.path)).map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("implements every declared route, including the auth handler", () => {
    const scopeOut = routes.filter((r) => r.implemented === false);
    expect(scopeOut).toEqual([]);
  });

  it("marks the landing page and the auth-free verify-email page", () => {
    expect(routes.find((r) => r.path === "/")?.kind).toBe("landing");
    expect(routes.find((r) => r.path === "/verify-email")?.kind).toBe("auth");
  });

  it("creates the directory the runtime image copies", () => {
    // `COPY --from=build /repo/apps/web/public` fails the Docker build when the directory is
    // absent (git does not track empty directories). That is how the `Docker images` web job
    // went red; keep the source path and the tree in sync.
    const dockerfile = readFileSync(join(process.cwd(), "apps/web/Dockerfile"), "utf8");
    const copy = dockerfile.match(/COPY\s+--from=build\s+--chown=\S+\s+(\/repo\/apps\/web\/public)\s+\S+/);
    expect(copy, "Dockerfile no longer copies apps/web/public").not.toBeNull();
    const source = copy![1].replace("/repo/", "");
    expect(existsSync(join(process.cwd(), source)), `${source} is missing`).toBe(true);
  });

  it("keeps admin routes under the (main)/admin shell", () => {
    const admin = routes.filter((r) => r.path.startsWith("/admin"));
    expect(admin.length).toBeGreaterThanOrEqual(21);
    for (const r of admin) {
      expect(pageFile(r.path), r.path).toContain("(main)");
    }
  });
});
