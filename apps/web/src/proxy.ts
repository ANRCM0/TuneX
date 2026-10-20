import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";

/**
 * Server-side login gate (Next 16 `proxy`, formerly middleware), reconstructed from the
 * shipped build — see relayx-web/reports/04 §2.3. Upstream order:
 *
 *   1. /handler and /handler/*  -> pass (the auth pages must stay reachable)
 *   2. no session:  "/" -> pass, everything else -> 307 /handler/sign-in (carry ?ref)
 *   3. email verified:   /verify-email -> 307 /home ; otherwise pass
 *   4. email unverified: /verify-email -> pass ; otherwise -> 307 /verify-email
 *
 * The session itself is resolved by the backend (`GET /auth/me`), so this gate is identical
 * under `AUTH_MODE=local` and StackAuth.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|privacy-policy|terms-of-service|socket.io|api).*)"],
};

export async function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname === "/handler" || pathname.startsWith("/handler/")) {
    return NextResponse.next();
  }

  const user = await getSessionUser(req.headers.get("cookie"));

  if (!user) {
    if (pathname === "/") return NextResponse.next();
    const url = new URL("/handler/sign-in", req.url);
    const ref = searchParams.get("ref");
    if (ref) url.searchParams.set("ref", ref);
    return NextResponse.redirect(url);
  }

  if (user.emailVerified) {
    if (pathname === "/verify-email") return NextResponse.redirect(new URL("/home", req.url));
    return NextResponse.next();
  }

  if (pathname === "/verify-email") return NextResponse.next();
  return NextResponse.redirect(new URL("/verify-email", req.url));
}
