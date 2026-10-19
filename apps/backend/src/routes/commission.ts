import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../openapi";
import { WithdrawRequestSchema } from "../generated/zod";
import { WithdrawRequestQuerySchema, commissionService } from "../services/commission";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/commission.ts (67 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

const TransferSchema = z.object({
  amount: z.number().positive("划转金额必须大于0"),
});

const WithdrawCreateSchema = z.object({
  amount: z.number().positive("提现金额必须大于0"),
  method: z.string().min(1),
  account: z.string().min(1),
});

router.post(
  "/transfer",
  describeRoute({
    summary: "佣金余额划转到余额",
    tags: ["佣金"],
    responses: {
      204: {
        description: "划转成功",
      },
    },
  }),
  zValidator("json", TransferSchema),
  async (c) => {
    const { amount } = c.req.valid("json");
    const user = c.get("user");
    await commissionService.transferToBalance(user.id, amount);
    return c.body(null, 204);
  },
);

router.post(
  "/withdraw",
  describeRoute({
    summary: "申请佣金提现",
    tags: ["佣金"],
    responses: {
      201: {
        description: "提现申请创建成功",
        content: {
          "application/json": {
            schema: resolver(WithdrawRequestSchema),
          },
        },
      },
    },
  }),
  zValidator("json", WithdrawCreateSchema),
  async (c) => {
    const { amount, method, account } = c.req.valid("json");
    const user = c.get("user");
    const result = await commissionService.createWithdrawRequest(user.id, amount, method, account);
    return c.json(result, 201);
  },
);

router.get(
  "/withdraw",
  describeRoute({
    summary: "获取提现记录",
    tags: ["佣金"],
    responses: {
      200: {
        description: "提现记录列表",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: z.array(WithdrawRequestSchema),
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
    const user = c.get("user");
    const result = await commissionService.getWithdrawRequests(query, user.id);
    return c.json(result);
  },
);

export default router;
