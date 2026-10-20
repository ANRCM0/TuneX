import { t } from "@/lib/i18n";
export default function VerifyEmailPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">{t("zh_dd6ebb")}</h1>
      <p className="text-muted-foreground text-sm">{t("zh_53a9ef")}</p>
    </div>
  );
}
