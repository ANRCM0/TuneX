/**
 * StackAuth adapter.
 *
 * Upstream builds one server app (module 486306) with tokenStore "nextjs-cookie" and
 * urls { accountSettings:"/account-settings", home:"/home" }, and ships the public bits
 * to the browser through RSC props (never NEXT_PUBLIC_*).
 *
 * DEVIATION: this checkout has no StackAuth project, so the real SDK is optional.
 *  - when STACK_PROJECT_ID / STACK_PUBLISHABLE_CLIENT_KEY are set, wire @stackframe/stack here
 *  - otherwise the app falls back to a local viewer stub so pages and the proxy can run
 *    with DEV_BYPASS_AUTH=1
 */
export type SessionUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
};

export type StackConfig = {
  projectId?: string;
  publishableClientKey?: string;
  baseUrl?: string;
};

export function stackConfig(): StackConfig {
  return {
    projectId: process.env.STACK_PROJECT_ID,
    publishableClientKey: process.env.STACK_PUBLISHABLE_CLIENT_KEY,
    baseUrl: process.env.STACK_API_URL,
  };
}

export function stackConfigured(): boolean {
  const c = stackConfig();
  return Boolean(c.projectId && c.publishableClientKey);
}

export function devBypassAuth(): boolean {
  return process.env.DEV_BYPASS_AUTH === "1";
}

/**
 * Server-side session read used by src/proxy.ts.
 * With the real SDK this becomes: stackServerApp.getUser({ or: "return-null" }).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (devBypassAuth()) {
    return { id: "dev", email: "dev@localhost", emailVerified: true };
  }
  // Real implementation (requires a StackAuth project):
  //   const user = await stackServerApp.getUser({ or: "return-null" })
  //   return user ? { id: user.id, email: user.primaryEmail, emailVerified: !!user.primaryEmailVerified } : null
  return null;
}
