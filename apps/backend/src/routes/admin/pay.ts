import { PaymentMethod, Prisma, Status } from "@prisma/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { IdSchema, PaymentRequestSchema, TableRequestSchema } from "../../schemas/request";
import { PaymentResponseSchema } from "../../schemas/response";
import { paymentService } from "../../services/pay";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/pay.ts (134 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取所有支付配置",
    tags: ["支付管理"],
    responses: {
      200: {
        description: "成功获取所有支付配置",
        content: {
          "application/json": {
            schema: resolver(PaymentResponseSchema),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      name: z.string().optional(),
      method: z.nativeEnum(PaymentMethod).optional(),
      status: z.nativeEnum(Status).optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, name, method, status } = c.req.valid("query");
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({ [sort2.id]: sort2.desc ? "desc" : "asc" }));
    const where = {
      name: name ? { contains: name } : undefined,
      method: method ? method : undefined,
      status: status ? status : undefined,
    };
    const [data, total] = await db.$transaction([
      db.payment.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        where,
        orderBy: (orderBy as Prisma.PaymentOrderByWithRelationInput[] | undefined) || [
          { order_by: "desc" },
          { id: "desc" },
        ],
      }),
      db.payment.count({ where }),
    ]);
    return c.json({ data, total });
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建新支付配置",
    tags: ["支付管理"],
    responses: {
      200: {
        description: "支付配置创建成功",
      },
    },
  }),
  zValidator("json", PaymentRequestSchema),
  async (c) => {
    const { name, url, method, status, fixed_fee, percent_fee, type, config } = c.req.valid("json");
    await db.payment.create({
      data: {
        name,
        url,
        method,
        status,
        fixed_fee,
        percent_fee,
        type,
        config,
        order_by: (await db.payment.count()) * 1000,
      },
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/:id",
  describeRoute({
    summary: "删除支付配置",
    tags: ["支付管理"],
    responses: {
      200: {
        description: "支付配置删除成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    try {
      await db.payment.delete({
        where: { id },
      });
    } catch (error) {
      throw new HTTPException(409, { message: "该支付配置正在被使用，无法删除", cause: error });
    }
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "通过 ID 更新支付配置",
    tags: ["支付管理"],
    responses: {
      200: {
        description: "支付配置更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", PaymentRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { name, url, method, status, fixed_fee, percent_fee, type, config } = c.req.valid("json");
    await db.payment.update({
      where: { id },
      data: {
        name,
        url,
        method,
        status,
        fixed_fee,
        percent_fee,
        type,
        config,
      },
    });
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "通过 ID 更新支付方式顺序",
    tags: ["支付管理"],
    responses: {
      200: {
        description: "支付方式顺序更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", z.object({ order_by: z.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { order_by } = c.req.valid("json");
    await paymentService.updatePayOrder(id, order_by);
    return c.body(null, 204);
  },
);

export default router;
