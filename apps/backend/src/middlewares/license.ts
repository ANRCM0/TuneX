import { HTTPException } from "hono/http-exception";
import { instance, TOKENS } from "../container";
import type { LicenseService } from "../services/license";
import type { AppEnv } from "../types";
import type { Context, Next } from "hono";

/**
 * Upstream: src/middlewares/license.ts (14 lines).
 *
 * Note the recovered semantics: only an *explicitly fetched* non-business license is
 * rejected. When the license cannot be fetched (`license === null`) the guard lets the
 * request through. That is preserved verbatim — see docs/BEHAVIOUR_NOTES.md.
 */
export const businessLicenseRequired = async (c: Context<AppEnv>, next: Next) => {
  const licenseService = instance.resolve<LicenseService>(TOKENS.License);
  const license = await licenseService.getLicense();
  if (license && license.type !== "business") {
    throw new HTTPException(403, { message: "请购买商业授权" });
  }
  return next();
};
