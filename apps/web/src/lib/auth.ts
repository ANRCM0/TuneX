/**
 * Server-side session lookup for the Next `proxy` gate.
 *
 * The panel asks the backend who the cookie belongs to; it never verifies the token
 * itself. That works for both auth modes (`AUTH_MODE=local` in this replica, StackAuth
 * upstream) because the backend owns the cookie contract.
 */
export type SessionUser = { id: number; email: string; emailVerified: boolean };

const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:3000";

export function devBypassAuth(): boolean {
  return process.env.DEV_BYPASS_AUTH === "1";
}

/**
 * Read the session from the backend with the incoming Cookie header.
 *
 * `cookieHeader` must be forwarded verbatim: the access token lives in `stack-access` as a
 * percent-encoded JSON pair, which only the backend knows how to unpack.
 */
export async function getSessionUser(cookieHeader: string | null): Promise<SessionUser | null> {
  if (devBypassAuth()) {
    return { id: 0, email: "dev@localhost", emailVerified: true };
  }
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${BACKEND}/auth/me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { id: number; email: string; email_verified?: boolean };
    };
    if (!body.user?.id || !body.user.email) return null;
    return { id: body.user.id, email: body.user.email, emailVerified: body.user.email_verified ?? false };
  } catch {
    // Backend down: treat as anonymous rather than crashing the gate.
    return null;
  }
}
