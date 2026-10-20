/**
 * Payment helpers (`packages/shared/src/pay.ts`, ported from
 * `relayx-analysis/work/shared/003__packages__shared__src__pay.ts`).
 *
 * Money math and signing are the parts of the payment gateways that can be
 * tested without a gateway: amount parsing, the fee formula, the signing string
 * and the two signature schemes. The deliberately preserved oddities are pinned
 * here so a later "cleanup" cannot silently change what merchants receive:
 *
 *   - `getRealPrice` adds `fixed_fee` first, then multiplies by `1 + percent_fee`
 *     and rounds **up** to the next cent;
 *   - `moneyInCents` rejects a third non-zero decimal digit but accepts trailing
 *     zeros beyond two;
 *   - `generateJsonBase64Sign` escapes `/` to `\/` before Base64 (Heleket).
 *
 * Signature vectors below were computed independently (Python `hashlib`), not by
 * re-running the implementation.
 */
import { describe, expect, it } from "vitest";
import {
  BasePay,
  BEPUSDT,
  EPay,
  Heleket,
  getPay,
  moneyInCents,
  type PayableOrder,
  type Payment,
} from "../../packages/shared/src/pay";

class TestPay extends BasePay {
  protected override skipSignFields = ["sign", "sign_type"];
  protected override signField = "sign";

  override async pay(): Promise<[string, string]> {
    return ["", ""];
  }

  override notify(): [string, string] {
    return ["", ""];
  }
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 1,
    name: "test",
    url: "https://pay.example.test",
    method: "epay",
    config: { api_key: "KEY" },
    fixed_fee: null,
    percent_fee: null,
    ...overrides,
  };
}

describe("moneyInCents", () => {
  const cases: { input: string | number; expected: number }[] = [
    { input: 10, expected: 1000 },
    { input: "10", expected: 1000 },
    { input: "10.5", expected: 1050 },
    { input: "10.05", expected: 1005 },
    { input: "10.050", expected: 1005 },
    { input: "0.01", expected: 1 },
    { input: "10.000", expected: 1000 },
  ];

  for (const { input, expected } of cases) {
    it(`parses ${JSON.stringify(input)} as ${expected} cents`, () => {
      expect(moneyInCents(input)).toBe(expected);
    });
  }

  const invalid: (string | number)[] = ["", "abc", "-1", "1e3", "0", "0.00", "10.005", "10.999", "1.2.3"];
  for (const input of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => moneyInCents(input)).toThrow("Invalid payment amount");
    });
  }

  it("rejects non string/number values", () => {
    expect(() => moneyInCents(null as unknown as number)).toThrow("Invalid payment amount");
  });
});

describe("getRealPrice", () => {
  it("returns the price unchanged without fees", () => {
    expect(new TestPay(payment()).getRealPrice(10.005)).toBe(10.005);
  });

  it("adds the fixed fee first", () => {
    expect(new TestPay(payment({ fixed_fee: 0.5 })).getRealPrice(100)).toBe(100.5);
  });

  it("applies the percentage fee and rounds up to the cent", () => {
    expect(new TestPay(payment({ percent_fee: 0.03 })).getRealPrice(100)).toBe(103);
    expect(new TestPay(payment({ percent_fee: 0.03 })).getRealPrice(33.33)).toBe(34.33);
  });

  it("applies the fixed fee before the percentage fee", () => {
    expect(new TestPay(payment({ fixed_fee: 0.5, percent_fee: 0.1 })).getRealPrice(100)).toBe(110.55);
  });
});

describe("signing", () => {
  it("drops null/empty values, skips sign fields and sorts by key", () => {
    const pay = new TestPay(payment());
    expect(
      pay.getSignContent({ b: "2", a: "1", empty: "", nil: null, sign: "deadbeef", sign_type: "MD5" }),
    ).toBe("a=1&b=2KEY");
  });

  it("produces the documented md5 signature", () => {
    const pay = new TestPay(payment());
    expect(pay.generateSign({ b: "2", a: "1", empty: "", nil: null, sign: "deadbeef" })).toBe(
      "c5b3153ba616141a0bf58e29ad4cbb3f",
    );
  });

  it("escapes slashes before Base64 for the JSON signature", () => {
    const pay = new TestPay(payment());
    expect(pay.generateJsonBase64Sign({ url: "http://a/b", n: 1 })).toBe("f287a48c2317bfcf174aa21ee513829c");
  });

  it("verifies a well-formed signature and rejects malformed ones", () => {
    const pay = new TestPay(payment());
    const data = { b: "2", a: "1" };
    const sign = pay.generateSign(data);
    expect(pay.verifySign({ ...data, sign })).toBe(true);
    expect(pay.verifySign({ ...data, sign: "not-hex" })).toBe(false);
    expect(pay.verifySign({ ...data, sign: sign.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).toBe(false);
  });

  it("generates an order number of 18-19 digits", () => {
    const order = new TestPay(payment()).generateOrderNo();
    expect(order).toMatch(/^\d{18,19}$/);
  });
});

describe("validateOrder", () => {
  const order: PayableOrder = { order_id: "A1", trade_id: "T1", price: 100 };

  it("accepts a matching amount after fees", () => {
    const pay = new TestPay(payment({ percent_fee: 0.03 }));
    expect(() => pay.validateOrder({ order_id: "A1", trade_id: "T1", amount: "103" }, order)).not.toThrow();
  });

  it("rejects a mismatched amount", () => {
    const pay = new TestPay(payment({ percent_fee: 0.03 }));
    expect(() => pay.validateOrder({ order_id: "A1", trade_id: "T1", amount: "100" }, order)).toThrow(
      "Payment amount does not match",
    );
  });

  it("rejects a mismatched identity", () => {
    const pay = new TestPay(payment());
    expect(() => pay.validateOrder({ order_id: "A2", trade_id: "T1", amount: "100" }, order)).toThrow(
      "Payment order identity does not match",
    );
    expect(() =>
      pay.validateOrder({ order_id: "A1", trade_id: "T1", amount: "100" }, { ...order, trade_id: null }),
    ).toThrow("Payment order identity does not match");
  });
});

describe("gateway construction", () => {
  it("requires an API key for every gateway", () => {
    expect(() => new TestPay(payment({ config: {} }))).toThrow("Payment API key is required");
  });

  it("requires a numeric EPay pid", () => {
    expect(() => new EPay(payment())).toThrow("EPay merchant pid is required");
    expect(() => new EPay(payment({ config: { api_key: "K", pid: "007" } }))).toThrow(
      "EPay merchant pid is required",
    );
    expect(new EPay(payment({ config: { api_key: "K", pid: 7 } }))).toBeInstanceOf(EPay);
  });

  it("requires a Heleket merchant", () => {
    expect(() => new Heleket(payment({ method: "heleket" }))).toThrow("Heleket merchant_uuid is required");
    expect(
      new Heleket(payment({ method: "heleket", config: { api_key: "K", merchant_uuid: "m-1" } })),
    ).toBeInstanceOf(Heleket);
  });

  it("dispatches on the payment method and falls back to EPay", () => {
    expect(getPay(payment({ config: { api_key: "K", pid: 1 } }))).toBeInstanceOf(EPay);
    expect(getPay(payment({ method: "bepusdt" }))).toBeInstanceOf(BEPUSDT);
    expect(getPay(payment({ method: "heleket", config: { api_key: "K", merchant: "m" } }))).toBeInstanceOf(
      Heleket,
    );
    expect(
      getPay(payment({ method: "unknown" as Payment["method"], config: { api_key: "K", pid: 1 } })),
    ).toBeInstanceOf(EPay);
  });
});
