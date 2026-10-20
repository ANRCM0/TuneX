"use client";
/**
 * Auth pages: /handler/sign-in, /handler/sign-up, /handler/sign-out, /handler/verify-email.
 *
 * Upstream hands this subtree to StackAuth's handler component. This replica talks to the
 * backend's local auth endpoints instead (POST /api/auth/*), which issue the same
 * `stack-access` cookie the gate and the middleware read. Unknown sub-paths fall through to
 * the sign-in card, like StackAuth's handler does for unrecognised aliases.
 */
import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/i18n";

type Mode = "sign-in" | "sign-up" | "sign-out" | "verify-email";

function resolveMode(stack: string[] | undefined): Mode {
  const first = (stack ?? [])[0] ?? "sign-in";
  if (first.startsWith("sign-up") || first === "register") return "sign-up";
  if (first.startsWith("sign-out") || first === "logout") return "sign-out";
  if (first.startsWith("verify-email") || first.startsWith("email-verification")) return "verify-email";
  return "sign-in";
}

export default function HandlerPage() {
  const params = useParams<{ stack: string[] }>();
  const router = useRouter();
  const search = useSearchParams();
  const mode = resolveMode(params?.stack);
  const ref = search.get("ref");

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `HTTP ${res.status}`);
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (!email.includes("@")) return toast.error(t("auth.invalidEmail"));
    if (password.length < 8) return toast.error(t("auth.shortPassword"));
    setBusy(true);
    try {
      if (ref) document.cookie = `ref=${encodeURIComponent(ref)}; path=/; max-age=600`;
      const ok = await post(mode === "sign-up" ? "sign-up" : "sign-in", { email, password });
      if (!ok) return;
      toast.success(mode === "sign-up" ? t("auth.registered") : t("auth.signedIn"));
      router.push(mode === "sign-up" ? "/verify-email" : "/home");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (mode === "sign-out") {
    return (
      <Shell title={t("auth.signOut")}>
        <p className="text-muted-foreground text-sm">{t("auth.signOutHint")}</p>
        <Button
          className="w-full"
          onClick={async () => {
            await fetch("/api/auth/sign-out", { method: "POST" });
            toast.success(t("auth.signedOut"));
            router.push("/");
            router.refresh();
          }}
        >
          {t("auth.signOut")}
        </Button>
      </Shell>
    );
  }

  if (mode === "verify-email") {
    return (
      <Shell title={t("auth.verifyEmail")}>
        <p className="text-muted-foreground text-sm">{t("auth.verifyHint")}</p>
        <Button
          className="w-full"
          onClick={async () => {
            const res = await fetch("/api/auth/verify-email", { method: "POST" });
            if (res.ok) {
              toast.success(t("auth.verified"));
              router.push("/home");
              router.refresh();
            } else {
              toast.error(t("auth.verifyFailed"));
            }
          }}
        >
          {t("auth.verifyNow")}
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => router.push("/handler/sign-out")}>
          {t("auth.signOut")}
        </Button>
      </Shell>
    );
  }

  const isSignUp = mode === "sign-up";
  return (
    <Shell title={isSignUp ? t("auth.signUp") : t("auth.signIn")}>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("auth.email")}</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("auth.password")}</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder={t("auth.passwordHint")}
          />
        </div>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? t("auth.working") : isSignUp ? t("auth.signUp") : t("auth.signIn")}
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          {isSignUp ? t("auth.haveAccount") : t("auth.noAccount")}{" "}
          <Link className="underline" href={isSignUp ? "/handler/sign-in" : "/handler/sign-up"}>
            {isSignUp ? t("auth.signIn") : t("auth.signUp")}
          </Link>
        </p>
        <p className="text-muted-foreground text-center text-[11px]">
          {t("auth.termsPrefix")}{" "}
          <a className="underline" href="/terms-of-service.html">
            {t("auth.terms")}
          </a>{" "}
          {t("auth.and")}{" "}
          <a className="underline" href="/privacy-policy.html">
            {t("auth.privacy")}
          </a>
        </p>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-gray-50 to-white p-6 dark:from-neutral-950 dark:to-neutral-900">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-lg">RelayX</CardTitle>
          <p className="text-muted-foreground text-center text-sm">{title}</p>
        </CardHeader>
        <CardContent className="grid gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}
