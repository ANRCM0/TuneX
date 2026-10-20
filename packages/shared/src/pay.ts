/**
 * packages/shared/src/pay.ts
 *
 * Evidence: relayx-analysis/work/shared/003__packages__shared__src__pay.ts:1-333
 *
 * Payment gateway adapters shared by the backend. Everything here is a faithful port of
 * the recovered bundle, including the deliberately preserved oddities:
 *   - `getRealPrice` applies `fixed_fee` BEFORE the percentage fee and rounds the
 *     percentage result UP to the nearest cent (Math.ceil on micro-rounded float);
 *   - `getSignContent` drops null/empty values and sorts parameters by key;
 *   - `generateJsonBase64Sign` escapes every `/` to `\/` before Base64 (Heleket);
 *   - `moneyInCents` rejects amounts carrying a non-zero digit past the 2nd decimal.
 */
import crypto, { randomInt } from "node:crypto";
import { isIPv6 } from "node:net";
import axios, { type AxiosInstance } from "axios";
import { format } from "date-fns";

export type PaymentMethod = "epay" | "bepusdt" | "heleket";

export interface PaymentConfig {
  api_key?: string;
  pid?: string | number;
  merchant_uuid?: string;
  merchant?: string;
  currency?: string;
  network?: string;
  to_currency?: string;
  [key: string]: unknown;
}

export interface Payment {
  id: number;
  fixed_fee?: number | null;
  percent_fee?: number | null;
  name: string;
  url: string;
  config: PaymentConfig;
  method: PaymentMethod;
  type?: string | null;
  status?: string;
  order_by?: number;
  notify_url?: string;
}

/** Order shape consumed by `validateOrder`. Mirrors the `topup_order` row. */
export interface PayableOrder {
  order_id: string;
  trade_id?: string | null;
  price: number;
  type?: string | null;
}

export function moneyInCents(value: string | number): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Invalid payment amount");
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || /[1-9]/.test((match[2] || "").slice(2))) {
    throw new Error("Invalid payment amount");
  }
  const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("Invalid payment amount");
  }
  return cents;
}

export abstract class BasePay {
  protected readonly payment: Payment;
  protected skipSignFields: string[] = [];
  protected signField = "";
  protected readonly apiKey: string;
  protected readonly url: string;
  protected readonly config: PaymentConfig;

  constructor(payment: Payment) {
    this.payment = payment;
    this.url = payment.url;
    this.config = payment.config;
    this.apiKey = `${this.config.api_key || ""}`.trim();
    if (!this.apiKey) {
      throw new Error("Payment API key is required");
    }
  }

  getSignContent(data: Record<string, unknown>): string {
    const filtered = Object.entries(data)
      .filter(([key, value]) => value !== null && value !== "" && !this.skipSignFields.includes(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const content: string[] = [];
    for (const [key, value] of filtered) {
      content.push(`${key}=${value}`);
    }
    return content.join("&") + this.apiKey;
  }

  generateSign(data: Record<string, unknown>): string {
    const content = this.getSignContent(data);
    return crypto.createHash("md5").update(content).digest("hex");
  }

  generateJsonBase64Sign(data: Record<string, unknown>): string {
    const json = JSON.stringify(data).replace(/\//g, "\\/");
    return crypto
      .createHash("md5")
      .update(Buffer.from(json).toString("base64") + this.apiKey)
      .digest("hex");
  }

  verifySign(data: Record<string, any>): boolean {
    const sign = data[this.signField];
    if (typeof sign !== "string" || !/^[a-f\d]{32}$/i.test(sign)) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(this.generateSign(data), "hex"), Buffer.from(sign, "hex"));
  }

  generateOrderNo(): string {
    const datetime = format(new Date(), "yyyyMMddHHmmss");
    const random = randomInt(1e4, 99999).toString();
    return `${datetime}${random}`;
  }

  getRealPrice(price: number): number {
    if (this.payment.fixed_fee) {
      price = price + this.payment.fixed_fee;
    }
    if (this.payment.percent_fee) {
      const rawCents = price * (1 + this.payment.percent_fee) * 100;
      const cents = Math.ceil(Math.round(rawCents * 1e6) / 1e6);
      price = cents / 100;
    }
    return price;
  }

  abstract pay(
    order_id: string,
    price: number,
    redirect_url: string,
    client_ip: string,
    pay_type?: string,
  ): Promise<[string, string]>;

  abstract notify(data: Record<string, any>): [string, string];

  validateOrder(data: Record<string, any>, order: PayableOrder): void {
    if (!order.trade_id || data.order_id !== order.order_id || data.trade_id !== order.trade_id) {
      throw new Error("Payment order identity does not match");
    }
    if (moneyInCents(data.amount) !== Math.round(this.getRealPrice(order.price) * 100)) {
      throw new Error("Payment amount does not match");
    }
  }

  async cancelOrder(_trade_id: string): Promise<void> {}
}

export class EPay extends BasePay {
  protected override skipSignFields = ["sign", "sign_type"];
  protected override signField = "sign";
  private readonly pid: string;
  private readonly client: AxiosInstance;

  constructor(payment: Payment) {
    super(payment);
    this.pid = `${this.config.pid || ""}`.trim();
    if (!/^[1-9]\d*$/.test(this.pid)) {
      throw new Error("EPay merchant pid is required");
    }
    this.client = axios.create({ baseURL: this.url, timeout: 30000 });
  }

  override async pay(
    order_id: string,
    price: number,
    redirect_url: string,
    client_ip: string,
    pay_type?: string,
  ): Promise<[string, string]> {
    const data: Record<string, unknown> = {
      pid: Number(this.pid),
      out_trade_no: order_id,
      clientip: isIPv6(client_ip) ? "127.0.0.1" : client_ip,
      notify_url: this.payment.notify_url,
      return_url: redirect_url,
      name: order_id,
      money: this.getRealPrice(price),
      device: "jump",
    };
    if (pay_type) {
      data["type"] = pay_type;
    }
    data["sign"] = this.generateSign(data);
    data["sign_type"] = "MD5";
    const response = await this.client.post("/mapi.php", data, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const ret = response.data;
    if (ret.code !== 1 && ret.code !== "1") {
      throw new Error(ret.msg);
    }
    return [ret.payurl, ret.trade_no];
  }

  override notify(data: Record<string, any>): [string, string] {
    if (!this.verifySign(data)) {
      throw new Error(`Invalid response signature, data: ${JSON.stringify(data)}`);
    }
    const tradeStatus = data.trade_status;
    if (tradeStatus !== "TRADE_SUCCESS") {
      throw new Error(`Trade status is not success, data: ${JSON.stringify(data)}`);
    }
    return [data.out_trade_no, "success"];
  }

  override validateOrder(data: Record<string, any>, order: PayableOrder): void {
    if (
      !order.trade_id ||
      data.out_trade_no !== order.order_id ||
      data.trade_no !== order.trade_id ||
      !["string", "number"].includes(typeof data.pid) ||
      String(data.pid) !== this.pid
    ) {
      throw new Error("Payment order identity does not match");
    }
    if (order.type && data.type !== order.type) {
      throw new Error("Payment type does not match");
    }
    const expectedCents = Math.round(this.getRealPrice(order.price) * 100);
    if (moneyInCents(data.money) !== expectedCents) {
      throw new Error("Payment amount does not match");
    }
  }

  async verifyPaidOrder(order: PayableOrder): Promise<void> {
    if (!order.trade_id) {
      throw new Error("Payment trade id is missing");
    }
    let result: any;
    try {
      const response = await this.client.get("/api.php", {
        params: { act: "order", pid: this.pid, key: this.apiKey, trade_no: order.trade_id },
        timeout: 1e4,
        maxRedirects: 0,
      });
      result = response.data;
    } catch {
      throw new Error("Payment gateway order query failed");
    }
    if (
      !result ||
      (result.code !== 1 && result.code !== "1") ||
      (result.status !== 1 && result.status !== "1")
    ) {
      throw new Error("Payment gateway has not confirmed payment");
    }
    this.validateOrder(result, order);
  }

  override async cancelOrder(_trade_id: string): Promise<void> {}
}

export class BEPUSDT extends BasePay {
  protected override skipSignFields = ["signature"];
  protected override signField = "signature";
  private readonly client: AxiosInstance;

  constructor(payment: Payment) {
    super(payment);
    this.client = axios.create({ baseURL: this.url, timeout: 30000 });
  }

  override async pay(
    order_id: string,
    price: number,
    redirect_url: string,
    _client_ip: string,
    pay_type?: string,
  ): Promise<[string, string]> {
    const amount = this.getRealPrice(price);
    const path = pay_type ? "/api/v1/order/create-transaction" : "/api/v1/order/create-order";
    const data: Record<string, unknown> = pay_type
      ? {
          trade_type: pay_type,
          order_id,
          amount,
          notify_url: this.payment.notify_url,
          redirect_url: `${redirect_url}?trade_status=TRADE_SUCCESS`,
          no_rate: false,
        }
      : {
          order_id,
          amount,
          notify_url: this.payment.notify_url,
          redirect_url: `${redirect_url}?trade_status=TRADE_SUCCESS`,
        };
    data["signature"] = this.generateSign(data);
    const response = await this.client.post(path, data);
    const ret = response.data;
    if (ret.status_code !== 200) {
      throw new Error(ret.message);
    }
    return [ret.data.payment_url, ret.data.trade_id];
  }

  override notify(data: Record<string, any>): [string, string] {
    if (!this.verifySign(data)) {
      throw new Error(`Invalid response signature, data: ${JSON.stringify(data)}`);
    }
    const status = data.status;
    if (status !== 2) {
      throw new Error(`Trade status is not success, data: ${JSON.stringify(data)}`);
    }
    return [data.order_id, "ok"];
  }

  override async cancelOrder(trade_id: string): Promise<void> {
    const path = "/api/v1/order/cancel-transaction";
    const data: Record<string, unknown> = { trade_id };
    data["signature"] = this.generateSign(data);
    const response = await this.client.post(path, data);
    const ret = response.data;
    if (ret.status_code !== 200) {
      if (!ret.message.includes("状态不允许取消")) {
        throw new Error(ret.message);
      }
    }
  }
}

export class Heleket extends BasePay {
  private readonly client: AxiosInstance;
  private readonly merchant: string;

  constructor(payment: Payment) {
    super(payment);
    this.merchant = `${this.config.merchant_uuid || this.config.merchant || ""}`.trim();
    if (!this.merchant) {
      throw new Error("Heleket merchant_uuid is required");
    }
    this.client = axios.create({ baseURL: this.url, timeout: 30000 });
  }

  override async pay(
    order_id: string,
    price: number,
    redirect_url: string,
    _client_ip: string,
    pay_type?: string,
  ): Promise<[string, string]> {
    const amount = this.getRealPrice(price).toFixed(2);
    const data: Record<string, unknown> = {
      amount,
      currency: this.config.currency || "USD",
      order_id,
      url_return: redirect_url,
      url_success: `${redirect_url}?trade_status=TRADE_SUCCESS`,
      url_callback: this.payment.notify_url,
    };
    if (this.config.network) {
      data.network = this.config.network;
    }
    if (this.config.to_currency) {
      data.to_currency = this.config.to_currency;
    }
    if (pay_type) {
      data.to_currency = pay_type;
    }
    const response = await this.client.post("/v1/payment", data, {
      headers: {
        merchant: this.merchant,
        sign: this.generateJsonBase64Sign(data),
        "Content-Type": "application/json",
      },
    });
    const ret = response.data;
    if (ret.state !== 0) {
      throw new Error(ret.message || JSON.stringify(ret.errors || ret));
    }
    return [ret.result.url, ret.result.uuid];
  }

  override notify(data: Record<string, any>): [string, string] {
    const sign = data.sign;
    if (!sign) {
      throw new Error(`Missing sign, data: ${JSON.stringify(data)}`);
    }
    const payload = { ...data };
    delete payload.sign;
    const expectedSign = this.generateJsonBase64Sign(payload);
    if (expectedSign.toUpperCase() !== `${sign}`.toUpperCase()) {
      throw new Error(`Invalid response signature, data: ${JSON.stringify(data)}`);
    }
    if (!["paid", "paid_over"].includes(data.status)) {
      throw new Error(`Trade status is not success, data: ${JSON.stringify(data)}`);
    }
    return [data.order_id, "ok"];
  }

  override validateOrder(data: Record<string, any>, order: PayableOrder): void {
    super.validateOrder({ ...data, trade_id: data.uuid }, order);
    if (data.currency !== (this.config.currency || "USD")) {
      throw new Error("Payment currency does not match");
    }
  }
}

export function getPay(payment: Payment): BasePay {
  switch (payment.method) {
    case "epay":
      return new EPay(payment);
    case "bepusdt":
      return new BEPUSDT(payment);
    case "heleket":
      return new Heleket(payment);
    default:
      return new EPay(payment);
  }
}
