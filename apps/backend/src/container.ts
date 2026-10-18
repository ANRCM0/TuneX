/**
 * Minimal dependency-injection container.
 *
 * Upstream uses `tsyringe` and calls `instance.resolve(Service)` at module scope
 * (see relayx-analysis/work/modules/062__src__middlewares__auth.ts:1-8). tsyringe needs
 * `emitDecoratorMetadata`, which esbuild (behind tsx and vitest) does not emit, so the
 * replica swaps in this explicit registry with the same call shape.
 *
 * Deviation recorded in docs/DEVIATIONS.md.
 */

export const TOKENS = {
  Prisma: "Prisma",
  Redis: "Redis",
  Queue: "Queue",
  SystemConfig: "SystemConfigService",
  License: "LicenseService",
  StackAuth: "StackAuthService",
  Telegram: "TelegramService",
  User: "UserService",
  AdminRole: "AdminRoleService",
  NodeGroup: "NodeGroupService",
  Node: "NodeService",
  Tunnel: "TunnelService",
  Plan: "PlanService",
  PlanOrder: "PlanOrderService",
  Coupon: "CouponService",
  Topup: "TopupService",
  Payment: "PaymentService",
  Balance: "BalanceService",
  Commission: "CommissionService",
  Withdraw: "WithdrawService",
  Ticket: "TicketService",
  Dns: "DnsService",
  Traffic: "TrafficService",
  Stats: "StatsService",
  Socket: "SocketService",
  Mail: "MailService",
} as const;

export type Token = (typeof TOKENS)[keyof typeof TOKENS] | string;

const factories = new Map<string, () => unknown>();
const instances = new Map<string, unknown>();

/** Register (or replace) a lazy factory for `token`. */
export function register<T>(token: Token, factory: () => T): void {
  factories.set(token, factory as () => unknown);
  instances.delete(token);
}

/** Instantiate once and memoize. */
export function resolve<T>(token: Token): T {
  if (instances.has(token)) return instances.get(token) as T;
  const factory = factories.get(token);
  if (!factory) {
    throw new Error(`[container] nothing registered for token "${String(token)}"`);
  }
  const value = factory();
  instances.set(token, value);
  return value as T;
}

export function isRegistered(token: Token): boolean {
  return factories.has(token);
}

/**
 * Self-registering service helper — the replica's replacement for
 * `@injectable() class XService` + `instance.resolve(XService)`.
 *
 * Call it once at the bottom of a service module:
 *
 *   export const tunnelService = service<TunnelService>(
 *     TOKENS.Tunnel,
 *     () => new TunnelService(instance.resolve(TOKENS.Redis)),
 *   );
 *
 * The returned value is a lazily-resolving proxy, so call sites read exactly like
 * upstream (`tunnelService.getNodeConfig(...)`) while construction stays deferred and
 * survives circular imports. Method access is bound to the real instance, so `this` works.
 */
export function service<T extends object>(token: Token, factory: () => T): T {
  register(token, factory);
  return new Proxy({} as T, {
    get(_target, prop) {
      const inst = resolve<T>(token) as Record<PropertyKey, unknown>;
      const value = inst[prop as keyof T];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inst) : value;
    },
    set(_target, prop, value) {
      (resolve<T>(token) as Record<PropertyKey, unknown>)[prop as PropertyKey] = value;
      return true;
    },
    has(_target, prop) {
      return prop in (resolve<T>(token) as object);
    },
  });
}

/** Test helper: drop every memoized instance (factories survive). */
export function resetInstances(): void {
  instances.clear();
}

/** Test helper: drop factories and instances. */
export function resetAll(): void {
  factories.clear();
  instances.clear();
}

/** Upstream name for the container singleton. */
export const instance = { register, resolve, isRegistered, resetInstances, resetAll, service };
