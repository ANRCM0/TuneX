import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { IdSchema } from "../../schemas/request";
import { UserSchema, WithdrawRequestSchema } from "../../generated/zod";
import { WithdrawRequestQuerySchema, commissionService } from "../../services/commission";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/withdraw.ts (49 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

const WithdrawActionSchema = z.object({
  remark: z.string().optional(),
});

router.get(
  "",
  describeRoute({
    summary: "获取所有提现申请",
    tags: ["提现管理"],
    responses: {
      200: {
        description: "提现申请列表",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: z.array(WithdrawRequestSchema.extend({ user: UserSchema.pick({ email: true }) })),
                total: z.number(),
              }),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", WithdrawRequestQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await commissionService.getWithdrawRequests(query);
    return c.json(result);
  },
);

router.post(
  "/:id/approve",
  describeRoute({
    summary: "批准提现申请",
    tags: ["提现管理"],
    responses: {
      204: {
        description: "操作成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", WithdrawActionSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { remark } = c.req.valid("json");
    await commissionService.approveWithdraw(id, remark);
    return c.body(null, 204);
  },
);

router.post(
  "/:id/reject",
  describeRoute({
    summary: "拒绝提现申请",
    tags: ["提现管理"],
    responses: {
      204: {
        description: "操作成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", WithdrawActionSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { remark } = c.req.valid("json");
    await commissionService.rejectWithdraw(id, remark);
    return c.body(null, 204);
  },
);

export default router;
