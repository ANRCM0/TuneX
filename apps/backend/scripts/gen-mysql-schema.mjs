#!/usr/bin/env node
/**
 * Derive the MySQL schema + baseline migration from the SQLite schema.
 *
 * Prisma requires the datasource provider to be a string literal, so one schema file cannot
 * serve both engines. MySQL therefore gets its own directory (Prisma keeps `migrations/`
 * next to the schema file):
 *
 *   prisma/mysql/schema.prisma                   generated
 *   prisma/mysql/migrations/0001_init/…           generated once, then owned like any migration
 *   prisma/mysql/migrations/migration_lock.toml   generated
 *
 * The `datasource` block is rewritten and the native column types the SQLite port had to drop
 * are restored from the recovered upstream schema (see NATIVE_TYPES). Every model, field,
 * default and relation otherwise stays identical to `prisma/schema.prisma` (which
 * `tests/unit/schema-parity.test.ts` pins to the decompiled upstream).
 *
 *   node scripts/gen-mysql-schema.mjs            # write schema + regenerate the baseline
 *   node scripts/gen-mysql-schema.mjs --check    # read-only: exit 1 when anything is stale
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "prisma");
const schemaPath = join(prismaDir, "schema.prisma");
const mysqlDir = join(prismaDir, "mysql");
const mysqlSchemaPath = join(mysqlDir, "schema.prisma");
const mysqlMigrations = join(mysqlDir, "migrations");
const BASELINE = "0001_init";
const LOCK_PATH = join(mysqlMigrations, "migration_lock.toml");
const BASELINE_PATH = join(mysqlMigrations, BASELINE, "migration.sql");
const MYSQL_URL = process.env.MYSQL_URL_FOR_DDL || "mysql://user:pass@127.0.0.1:3306/relayx";
const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const HEADER = `// RelayX data model — MySQL variant.
//
// GENERATED from ../schema.prisma by scripts/gen-mysql-schema.mjs. The datasource block and
// the native column types differ; everything else is identical to the SQLite schema.
`;

/**
 * Native column types recovered from the upstream MySQL schema
 * (relayx-analysis/work/prisma_schema.prisma). The SQLite port drops them because SQLite has
 * none, so the MySQL variant restores them here.
 *
 * Without this every `String` becomes `VARCHAR(191)` on MySQL: too short for the prose columns
 * upstream declared as TEXT (`Ticket.content`, `TicketReply.content`, `SystemConfig.value`,
 * `WithdrawRequest.account`/`remark`, `AdminRole.description`, `TopupOrder.pay_url`) and one
 * character narrower than upstream's `VARCHAR(255)` everywhere else. The backend suite running
 * on MySQL is what surfaced this (`P2000: the provided value for the column is too long`).
 */
const NATIVE_TYPES = {
  NodeGroup: {
    name: "VarChar(255)",
    port_range: "VarChar(255)",
    connect_ip: "VarChar(255)",
    bypass_list: "Json",
  },
  Node: {
    node_id: "VarChar(255)",
    connect_ip: "VarChar(255)",
    version: "VarChar(255)",
    custom_line: "VarChar(255)",
  },
  Tunnel: { name: "VarChar(255)" },
  AdminRole: { name: "VarChar(255)", description: "Text" },
  Plan: { name: "VarChar(255)" },
  TopupOrder: { pay_url: "Text", order_id: "VarChar(255)", trade_id: "VarChar(255)" },
  SystemConfig: { value: "Text" },
  Payment: { name: "VarChar(255)", url: "VarChar(255)", type: "VarChar(255)" },
  PlanCoupon: { code: "VarChar(255)" },
  WithdrawRequest: { method: "VarChar(255)", account: "Text", remark: "Text" },
  Ticket: { title: "VarChar(255)", content: "Text" },
  TicketReply: { content: "Text" },
  DNSProvider: { name: "VarChar(255)" },
};

/**
 * Append `@db.…` to the mapped fields, model block by model block.
 *
 * Text-level on purpose: the generator's job is a faithful textual variant, and a line-based
 * pass keeps every model, comment and blank line byte-identical to the SQLite schema.
 */
function applyNativeTypes(schema, { onMissing = () => {} } = {}) {
  const seen = new Set();
  let model = null;
  const lines = schema.split("\n").map((line) => {
    const opened = line.match(/^model (\w+) \{/);
    if (opened) {
      model = opened[1];
      return line;
    }
    if (/^\}/.test(line)) {
      model = null;
      return line;
    }
    if (!model || !NATIVE_TYPES[model]) return line;
    const field = line.match(/^(\s+)(\w+)(\s+)(String|Json)(\??)(.*)$/);
    if (!field) return line;
    const [, indent, name, gap, type, optional, rest] = field;
    const native = NATIVE_TYPES[model][name];
    if (!native) return line;
    seen.add(`${model}.${name}`);
    return `${indent}${name}${gap}${type}${optional} @db.${native}${rest}`;
  });
  for (const model of Object.keys(NATIVE_TYPES)) {
    for (const field of Object.keys(NATIVE_TYPES[model])) {
      if (!seen.has(`${model}.${field}`)) onMissing(`${model}.${field}`);
    }
  }
  return { schema: lines.join("\n"), seen };
}

const source = readFileSync(schemaPath, "utf8");
if (!/datasource db \{[^}]*\}/.test(source)) {
  console.error("schema.prisma has no datasource block");
  process.exit(1);
}

const body = applyNativeTypes(
  source
    .replace(
      /datasource db \{[^}]*\}/,
      `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}`,
    )
    .replace(/generator client \{[\s\S]*?\n\}\n\n/, ""),
  {
    // A mapped field disappearing means schema.prisma changed; fail loudly instead of
    // silently generating a MySQL variant that lost the column type again.
    onMissing: (field) => {
      console.error(`native type mapping references a missing field: ${field}`);
      process.exit(1);
    },
  },
).schema;

const mysqlSchema = `${HEADER}
generator client {
  provider = "prisma-client-js"
}

${body}`;

const LOCK = 'provider = "mysql"\n';

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

if (CHECK) {
  const problems = [];
  if (read(mysqlSchemaPath) !== mysqlSchema) {
    problems.push("prisma/mysql/schema.prisma is missing or stale (run pnpm db:mysql:generate)");
  }
  if (read(LOCK_PATH) !== LOCK) {
    problems.push("prisma/mysql/migrations/migration_lock.toml is missing or not mysql");
  }
  if (read(BASELINE_PATH) === null) {
    problems.push(`prisma/mysql/migrations/${BASELINE}/migration.sql is missing`);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("mysql schema and baseline migration are up to date");
  process.exit(0);
}

mkdirSync(join(mysqlMigrations, BASELINE), { recursive: true });
writeFileSync(mysqlSchemaPath, mysqlSchema);
writeFileSync(LOCK_PATH, LOCK);
console.log(`wrote ${mysqlSchemaPath}`);

// The baseline is generated once; after that it is a normal migration that may be edited.
if (!existsSync(BASELINE_PATH) || FORCE) {
  const ddl = execFileSync(
    join(here, "..", "..", "..", "node_modules", ".bin", "prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", mysqlSchemaPath, "--script"],
    { env: { ...process.env, DATABASE_URL: MYSQL_URL }, encoding: "utf8" },
  );
  writeFileSync(BASELINE_PATH, ddl);
  console.log(`wrote ${BASELINE_PATH}`);
} else {
  console.log(`kept ${BASELINE_PATH} (use --force to regenerate)`);
}
