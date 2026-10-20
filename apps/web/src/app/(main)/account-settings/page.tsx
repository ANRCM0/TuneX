"use client";
import { t } from "@/lib/i18n";
/**
 * 账号设置 — upstream delegates this page to StackAuth's handler in an embedded frame
 * (`urls.accountSettings = "/account-settings"`). Without a StackAuth project we expose the
 * account operations our backend actually supports instead of a dead frame.
 */
import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { setPageTitle } from "@/components/page-title";
import { useUser } from "@/lib/hooks";

export default function AccountSettingsPage() {
  const { data: user } = useUser();
  React.useEffect(() => setPageTitle(t("zh_7a66bc")), []);

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t("zh_7a66bc")}</h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("zh_836ffe")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("misc.label.email")}</span>
            <span>{user?.email ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("admin.users.role")}</span>
            <span>
              {user?.super_admin
                ? t("zh_6f22a7")
                : user?.admin_roles?.length
                  ? t("zh_ef84e7")
                  : t("misc.label.users")}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("stackauth_api_key_mfa_st_78d55a")}{" "}
            <Link className="underline" href="/account">
              {t("nav.profile")}
            </Link>{" "}
            {t("api_key_70e5fa")}
          </p>
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/account">{t("zh_2335cd")}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a href="/handler/sign-out">{t("zh_094774")}</a>
        </Button>
      </div>
    </div>
  );
}
