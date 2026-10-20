import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/stack";

/**
 * Server-side login gate, reconstructed from the shipped build
 * (relayx-web/reports/04-auth-session-rbac.md §2.3; original bytes verified).
 *
 * Upstream logic, in order:
 *   1. /handler and /handler/*  -> pass (auth pages must stay reachable)
 *   2. no session:  "/" -> pass, everything else -> 307 /handler/sign-in (carry ?ref)
 *   3. email verified:   /verify-email -> 307 /home ; otherwise pass
 *   4. email unverified: /verify-email -> pass ; otherwise -> 307 /verify-email
 *
 * NOTE: this gate only covers "signed in" and "email verified". RBAC and the business
 * licence are enforced by the backend, never here.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|privacy-policy|terms-of-service|socket.io|api).*)",
  ],
};

export async function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname === "/handler" || pathname.startsWith("/handler/")) {
    return NextResponse.next();
  }

  const user = await getSessionUser();

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
