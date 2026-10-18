import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { service, TOKENS } from "../container";
import { stackAuthService, type StackAuthService } from "./stackauth";

/**
 * Upstream: src/services/user.ts (53 lines) — ported 1:1.
 *
 * `stackAuthService.createUser` is typed `Promise<unknown>` in the replica (the
 * decompiled original used a typed `hc()` client), so the caller-facing return type is
 * narrowed here to the `{ id }` the admin create-user route reads.
 */
export class UserService {
  constructor(private readonly stackAuthService: StackAuthService) {}

  async getSuperAdmins() {
    return await db.user.findMany({
      where: {
        super_admin: true,
      },
    });
  }

  async createUserWithPassword(email: string, password: string): Promise<{ id: string }> {
    const userData = await this.stackAuthService.createUser({
      primary_email: email,
      password,
      primary_email_auth_enabled: true,
    });
    return userData as { id: string };
  }

  async changePassword(userId: number, password: string): Promise<void> {
    const user = await db.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    if (!user.uid) {
      throw new HTTPException(400, {
        message: "用户未关联Stack Auth账户，请退出重新登录",
      });
    }
    await this.stackAuthService.updateUser(user.uid, {
      password,
    });
  }
}

/**
 * Self-registration: `instance.resolve(TOKENS.User)` / `userService` proxy.
 *
 * The dependency is injected as the `stackAuthService` proxy rather than through
 * `instance.resolve(TOKENS.StackAuth)`: nothing else in the replica value-imports the
 * StackAuth module (upstream's `@injectable()` decorator registered it implicitly), so
 * importing it here is what actually registers `TOKENS.StackAuth` for the whole app,
 * including `authRequired`'s cookie path.
 */
export const userService = service<UserService>(TOKENS.User, () => new UserService(stackAuthService));
