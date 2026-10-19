/**
 * Documentation link guard.
 *
 * The repo's docs are part of the deliverable: README, CONVENTIONS, PARITY,
 * DEVIATIONS, AGENT, VERIFY and COVERAGE cross-reference each other and source files.
 * A rename that leaves a dangling relative link is silent otherwise; this suite walks
 * every Markdown file in the repo and asserts that each relative target exists.
 *
 * External links (http/https/mailto) are not fetched.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOC_FILES = ["README.md", "docs/AGENT.md", "docs/COVERAGE.md", "docs/CONVENTIONS.md", "docs/DEPLOY.md", "docs/DEVIATIONS.md", "docs/PARITY.md", "docs/REPLICATION.md", "docs/VERIFY.md"];

interface Link {
  file: string;
  target: string;
  resolved: string;
}

function relativeLinks(file: string): Link[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const links: Link[] = [];
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split("#")[0];
    if (!target) continue;
    links.push({
      file,
      target: raw,
      resolved: normalize(join(ROOT, dirname(file), target)),
    });
  }
  return links;
}

describe("documentation links", () => {
  it("keeps every documented page present", () => {
    const missing = DOC_FILES.filter((file) => !existsSync(join(ROOT, file)));
    expect(missing).toEqual([]);
  });

  it("resolves every relative link in the docs", () => {
    const broken: string[] = [];
    for (const file of DOC_FILES) {
      for (const link of relativeLinks(file)) {
        if (!existsSync(link.resolved)) {
          broken.push(`${file}: ${link.target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("points the acceptance index at suites that exist", () => {
    const coverage = readFileSync(join(ROOT, "docs/COVERAGE.md"), "utf8");
    const suites = [...coverage.matchAll(/`((?:tests\/|apps\/|packages\/|scripts\/|internal\/)[^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(suites.length).toBeGreaterThan(10);
    // Go package paths in the index are relative to apps/agent.
    const exists = (suite: string) =>
      existsSync(join(ROOT, suite)) || existsSync(join(ROOT, "apps/agent", suite));
    const missing = suites.filter((suite) => !exists(suite));
    expect(missing).toEqual([]);
  });
});
