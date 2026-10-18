import { HTTPException } from "hono/http-exception";
import { isAdminResourceKey } from "@relayx/shared/permissions";
import { db } from "../db";
import { service, TOKENS } from "../container";

/** `read` / `write` per admin resource key, as stored in `AdminRole.permissions`. */
export type RolePermissions = Record<string, "read" | "write">;

/**
 * Upstream: src/services/role.ts (74 lines) — ported 1:1.
 *
 * `sanitizePermissions` drops unknown resource keys and any level other than
 * `read` / `write`, which is what keeps a hand-crafted request body from widening an
 * admin role's access.
 */
export class RoleService {
  async list() {
    return await db.adminRole.findMany({
      orderBy: { id: "desc" },
      include: { _count: { select: { users: true } } },
    });
  }

  sanitizePermissions(input: RolePermissions): RolePermissions {
    const result: RolePermissions = {};
    for (const [key, level] of Object.entries(input)) {
      if (!isAdminResourceKey(key)) {
        continue;
      }
      if (level === "read" || level === "write") {
        result[key] = level;
      }
    }
    return result;
  }

  async createRole(name: string, description: string | null, perms: RolePermissions) {
    const exist = await db.adminRole.findUnique({ where: { name } });
    if (exist) {
      throw new HTTPException(409, { message: "角色名称已存在" });
    }
    return await db.adminRole.create({
      data: {
        name,
        description,
        permissions: this.sanitizePermissions(perms),
      },
    });
  }

  async updateRole(id: number, name: string, description: string | null, perms: RolePermissions) {
    const role = await db.adminRole.findUnique({ where: { id } });
    if (!role) {
      throw new HTTPException(404, { message: "角色不存在" });
    }
    const duplicate = await db.adminRole.findFirst({
      where: { name, NOT: { id } },
    });
    if (duplicate) {
      throw new HTTPException(409, { message: "角色名称已存在" });
    }
    return await db.adminRole.update({
      where: { id },
      data: {
        name,
        description,
        permissions: this.sanitizePermissions(perms),
      },
    });
  }

  async deleteRole(id: number) {
    const count = await db.user.count({
      where: { admin_roles: { some: { id } } },
    });
    if (count > 0) {
      throw new HTTPException(409, {
        message: `该角色仍被 ${count} 个用户使用，请先解除分配`,
      });
    }
    await db.adminRole.delete({ where: { id } });
  }
}

/** Self-registration: `instance.resolve(TOKENS.AdminRole)` / `roleService` proxy. */
export const roleService = service<RoleService>(TOKENS.AdminRole, () => new RoleService());
