import { instance, TOKENS } from "../container";
import type { PlanService } from "../services/plan";
import type { AppEnv } from "../types";
import type { Context, Next } from "hono";

/**
 * Upstream: src/middlewares/plan.ts (9 lines).
 * Resolves the caller's plan and stores it as `plan` for downstream handlers.
 */
export const planRequired = async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  const planService = instance.resolve<PlanService>(TOKENS.Plan);
  const plan = await planService.checkUserPlan(user);
  c.set("plan", plan);
  await next();
};
