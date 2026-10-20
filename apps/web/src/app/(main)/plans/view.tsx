"use client";
import { t, tf } from "@/lib/i18n";
import * as React from "react";
import { usePlans } from "@/lib/hooks";
import { client } from "@/lib/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { setPageTitle } from "@/components/page-title";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Plan = {
  id: number;
  name: string;
  price: number;
  billing_cycle: string;
  traffic: number;
  tunnel_count: number;
  stock: number | null;
};

const CYCLE: Record<string, string> = { month: t("zh_ccf97f"), quarter: t("zh_51e67e"), half_year: t("zh_89b172"), year: t("zh_1017de"), lifetime: t("zh_409752") };

export default function PlansPage() {
  const { data, isLoading, error } = usePlans(1, 50);
  React.useEffect(() => setPageTitle(t("nav.plans2")), []);

  const plans = (data?.data ?? []) as unknown as Plan[];
  const [coupon, setCoupon] = React.useState("");
  const [detail, setDetail] = React.useState<Plan | null>(null);

  const checkCoupon = async () => {
    if (!coupon.trim()) return toast.error(t("zh_98b5c8"));
    const res = await client.plan.coupon.$get({ query: { code: coupon.trim() } });
    if (!res.ok) return;
    const body = (await res.json()) as { value?: number; type?: string };
    toast.success(tf("value_19107e", { value: body.type === "percentage" ? `${body.value}%` : `¥${body.value}` }));
  };

  const openDetail = async (plan: Plan) => {
    const res = await client.plan[String(plan.id)].detail.$get({ param: { id: plan.id } });
    if (res.ok) setDetail((await res.json()) as Plan);
    else setDetail(plan);
  };

  if (error) return <p className="text-destructive text-sm">{t("zh_f6b7a4")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{t("nav.plans2")}</h2>
        <div className="ml-auto flex items-center gap-2">
          <Input className="h-8 w-40" placeholder={t("zh_d7d38a")} value={coupon} onChange={(e) => setCoupon(e.target.value)} />
          <Button size="sm" variant="outline" onClick={() => void checkCoupon()}>
            {t("app.validate")}
          </Button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)
          : plans.map((p) => (
              <Card key={p.id}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    {p.name}
                    <span className="text-lg">¥{p.price}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <div className="text-muted-foreground">
                    {CYCLE[p.billing_cycle] ?? p.billing_cycle} {t("zh_ad7328")} {p.traffic} {t("zh_4b15f9")} {p.tunnel_count}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void openDetail(p)}>
                    {t("app.details")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={p.stock !== null && p.stock <= 0}
                    onClick={() => {
                      // upstream: balance is debited directly, no payment gateway hop
                      void (async () => {
                        const { client } = await import("@/lib/client");
                        await client.plan[String(p.id)].subscribe.$post({ param: { id: p.id } });
                      })();
                    }}
                  >
                    {p.stock !== null && p.stock <= 0 ? t("zh_389d5f") : t("zh_1314a1")}
                  </Button>
                </CardContent>
              </Card>
            ))}
      </div>

      {detail ? (
        <Dialog open onOpenChange={(v: boolean) => !v && setDetail(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>{detail.name} {t("zh_8a54fc")}</DialogTitle></DialogHeader>
            <div className="grid gap-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("admin.plans.price")}</span><span>¥{detail.price}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("app.billingCycle")}</span><span>{CYCLE[detail.billing_cycle] ?? detail.billing_cycle}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("admin.plans.traffic")}</span><span>{detail.traffic}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("app.tunnels")}</span><span>{detail.tunnel_count}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("admin.plans.stock")}</span><span>{detail.stock ?? t("app.unlimited")}</span></div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
