import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { IdSchema } from "../../schemas/request";
import { AdminRoleSchema } from "../../generated/zod";
import { roleService } from "../../services/role";
import type { AppEnv } from "../../types";

const router = new Hono<AppEnv>();

const PermissionsSchema = z.record(z.string(), z.enum(["read", "write"]));

const RoleBodySchema = z.object({
  name: z.string().min(1, "名称不能为空").max(255),
  description: z.string().nullish(),
  permissions: PermissionsSchema,
});

const RoleResponseSchema = AdminRoleSchema.extend({
  permissions: PermissionsSchema,
  _count: z.object({ users: z.number() }),
});

router.get(
  "/",
  describeRoute({
    summary: "获取所有角色",
    tags: ["管理员角色"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": { schema: resolver(z.array(RoleResponseSchema)) },
        },
      },
    },
  }),
  async (c) => {
    return c.json(await roleService.list());
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建角色",
    tags: ["管理员角色"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", RoleBodySchema),
  async (c) => {
    const { name, description, permissions } = c.req.valid("json");
    await roleService.createRole(name, description ?? null, permissions);
    return c.body(null, 204);
  },
);

router.put(
  "/:id",
  describeRoute({
    summary: "更新角色",
    tags: ["管理员角色"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", RoleBodySchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { name, description, permissions } = c.req.valid("json");
    await roleService.updateRole(id, name, description ?? null, permissions);
    return c.body(null, 204);
  },
);

router.delete(
  "/:id",
  describeRoute({
    summary: "删除角色",
    tags: ["管理员角色"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    await roleService.deleteRole(id);
    return c.body(null, 204);
  },
);

export default router;
