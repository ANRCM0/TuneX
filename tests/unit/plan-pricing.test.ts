/**
 * Plan pricing (`computePlanPrice`, extracted from `PlanService.subscribePlan`).
 *
 * The rule is the money path of a plan purchase and comes straight from
 * `relayx-analysis/work/modules/038__src__services__plan.ts:136-152`: coupon first
 * (percentage or fixed), clamp at zero, then the setup fee unless the user already
 * holds the same plan. `priceBeforeSetupFee` is what the referral commission uses.
 *
 * The helper is pure; the surrounding purchase still runs in `subscribePlan`.
 */
import { describe, expect, it } from "vitest";
import {
  computePlanPrice,
  type PlanCouponTerms,
} from "../../apps/backend/src/services/plan";

// The Prisma enum values are plain strings; the helper only compares them.
const coupon = (type: "percentage" | "fixed", value: number): PlanCouponTerms => ({
  type: type as PlanCouponTerms["type"],
  value,
});

describe("computePlanPrice", () => {
  it("returns the list price without a coupon or setup fee", () => {
    expect(computePlanPrice({ price: 100, coupon: null, samePlan: false })).toEqual({
      price: 100,
      priceBeforeSetupFee: 100,
    });
  });

  it("applies a percentage coupon", () => {
    const result = computePlanPrice({
      price: 100,
      coupon: coupon("percentage", 10),
      samePlan: false,
    });
    expect(result.price).toBe(90);
    expect(result.priceBeforeSetupFee).toBe(90);
  });

  it("applies a fixed coupon", () => {
    const result = computePlanPrice({
      price: 100,
      coupon: coupon("fixed", 30),
      samePlan: false,
    });
    expect(result.price).toBe(70);
    expect(result.priceBeforeSetupFee).toBe(70);
  });

  it("clamps a fixed coupon larger than the price at zero", () => {
    const result = computePlanPrice({
      price: 100,
      coupon: coupon("fixed", 150),
      samePlan: false,
    });
    expect(result.price).toBe(0);
    expect(result.priceBeforeSetupFee).toBe(0);
  });

  it("adds the setup fee for a new plan", () => {
    expect(computePlanPrice({ price: 100, coupon: null, setup_fee: 5, samePlan: false })).toEqual({
      price: 105,
      priceBeforeSetupFee: 100,
    });
  });

  it("waives the setup fee when re-subscribing to the same plan", () => {
    expect(computePlanPrice({ price: 100, coupon: null, setup_fee: 5, samePlan: true })).toEqual({
      price: 100,
      priceBeforeSetupFee: 100,
    });
  });

  it("ignores a zero or missing setup fee", () => {
    expect(computePlanPrice({ price: 100, coupon: null, setup_fee: 0, samePlan: false }).price).toBe(100);
    expect(computePlanPrice({ price: 100, coupon: null, setup_fee: null, samePlan: false }).price).toBe(100);
  });

  it("adds the setup fee after the coupon, not before", () => {
    const result = computePlanPrice({
      price: 100,
      coupon: coupon("percentage", 10),
      setup_fee: 5,
      samePlan: false,
    });
    expect(result.price).toBe(95);
    expect(result.priceBeforeSetupFee).toBe(90);
  });

  it("charges only the setup fee when a 100% coupon zeroes the plan price", () => {
    const result = computePlanPrice({
      price: 100,
      coupon: coupon("percentage", 100),
      setup_fee: 5,
      samePlan: false,
    });
    expect(result.price).toBe(5);
    expect(result.priceBeforeSetupFee).toBe(0);
  });

  it("clamps before the setup fee, so a negative price never becomes a discount", () => {
    const result = computePlanPrice({
      price: 10,
      coupon: coupon("fixed", 20),
      setup_fee: 5,
      samePlan: false,
    });
    expect(result.price).toBe(5);
    expect(result.priceBeforeSetupFee).toBe(0);
  });
});
