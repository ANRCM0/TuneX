import axios, { isAxiosError, type AxiosInstance } from "axios";
import { HTTPException } from "hono/http-exception";
import { STACK_API_URL, STACK_PROJECT_ID, STACK_SECRET_SERVER_KEY } from "../config";
import { logger } from "../services/logger";
import { service, TOKENS } from "../container";

/** Upstream: src/services/stackauth.ts (67 lines) — ported verbatim. */
export class StackAuthService {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: STACK_API_URL,
      headers: {
        "Content-Type": "application/json",
        "X-Stack-Access-Type": "server",
        "X-Stack-Project-Id": STACK_PROJECT_ID,
        "X-Stack-Secret-Server-Key": STACK_SECRET_SERVER_KEY,
      },
    });
  }

  async createUser(data: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.http.post("/api/v1/users", data);
      return response.data;
    } catch (error) {
      const message = isAxiosError(error)
        ? ((error.response?.data as { message?: string } | undefined)?.message ?? "创建用户失败")
        : "创建用户失败";
      throw new HTTPException(400, { message });
    }
  }

  async updateUser(uid: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.http.patch(`/api/v1/users/${uid}`, data);
    } catch (error) {
      const message = isAxiosError(error)
        ? ((error.response?.data as { message?: string } | undefined)?.message ?? "更新用户失败")
        : "更新用户失败";
      throw new HTTPException(400, { message });
    }
  }

  async getUserMe(accessToken: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.http.get("/api/v1/users/me", {
        headers: { "x-stack-access-token": accessToken },
      });
      return response.data;
    } catch (error) {
      logger.error(`failed to get user me: ${error}`);
      throw new HTTPException(401, { message: "Unauthorized" });
    }
  }

  getJWKSUrl(): string {
    return `${STACK_API_URL}/api/v1/projects/${STACK_PROJECT_ID}/.well-known/jwks.json`;
  }
}

/** Self-registration. */
export const stackAuthService = service<StackAuthService>(TOKENS.StackAuth, () => new StackAuthService());
