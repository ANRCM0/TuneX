"use client";
import { t as tr } from "@/lib/i18n";
/**
 * 管理概览 — 4 BarChart cards. Upstream: /admin/stats, /admin/stats/user, /admin/stats/traffic
 * (+ plan/topup stats). Ranges default to the last 7 days (reports/07).
 */
import * as React from "react";
import useSWR from "swr";
import { adminClient } from "@/lib/client";
import { BarSeries, ChartCard } from "@/components/charts";
import { setPageTitle } from "@/components/page-title";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type StatRow = { date: string; total?: number; count?: number; traffic?: number; amount?: number };

export default function AdminOverviewPage() {
  const [range] = React.useState(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    return { start: start.toISOString(), end: end.toISOString() };
  });

  const overview = useSWR(["/admin/stats", range.start, range.end], async () => {
    const res = await adminClient.stats.$get({ query: { start_date: range.start, end_date: range.end } });
    return (await res.json()) as StatRow[] | { data: StatRow[] };
  });
  const traffic = useSWR(["/admin/stats/traffic", range.start, range.end], async () => {
    const res = await adminClient.stats.traffic.$get({ query: { start_date: range.start, end_date: range.end } });
    return (await res.json()) as StatRow[] | { data: StatRow[] };
  });
  const users = useSWR(["/admin/stats/user", range.start, range.end], async () => {
    const res = await adminClient.stats.user.$get({ query: { start_date: range.start, end_date: range.end } });
    return (await res.json()) as StatRow[] | { data: StatRow[] };
  });

  const planStats = useSWR(["/admin/plan/stats"], async () => {
    const res = await adminClient.plan.stats.$get({ query: {} });
    return (await res.json()) as { total?: number; active?: number; revenue?: number };
  });
  const topupStats = useSWR(["/admin/topup/stats"], async () => {
    const res = await adminClient.topup.stats.$get({ query: {} });
    return (await res.json()) as { total?: number; amount?: number };
  });
  const ngSummary = useSWR(["/admin/node/group/summary"], async () => {
    const res = await adminClient.node.group.summary.$get({ query: {} });
    return (await res.json()) as { total?: number; online?: number };
  });

  React.useEffect(() => setPageTitle(tr("nav.home")), []);

  const norm = (v: unknown): StatRow[] =>
    Array.isArray(v) ? (v as StatRow[]) : ((v as { data?: StatRow[] })?.data ?? []);

  const o = norm(overview.data);
  const t = norm(traffic.data);
  const u = norm(users.data);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{tr("nav.overview")}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard title={tr("admin.plans.traffic")} description={tr("7_f297b9")}>
          <BarSeries data={t} keys={[{ key: "traffic", label: tr("admin.plans.traffic") }]} />
        </ChartCard>
        <ChartCard title={tr("app.orders")} description={tr("7_f297b9")}>
          <BarSeries data={o} keys={[{ key: "total", label: tr("zh_084389") }, { key: "amount", label: tr("misc.label.amount") }]} />
        </ChartCard>
        <ChartCard title={tr("zh_6153a0")} description={tr("7_f297b9")}>
          <BarSeries data={u} keys={[{ key: "count", label: tr("zh_2cd9e6") }]} />
        </ChartCard>
        <Card>
          <CardHeader><CardTitle className="text-sm">{tr("zh_3824d4")}</CardTitle></CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">{tr("admin.userPlans.plan")}</span><span>{planStats.data?.total ?? 0} {tr("zh_88464f")} {planStats.data?.active ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{tr("account.topUp")}</span><span>{topupStats.data?.total ?? 0} {tr("zh_db2954")}{Number(topupStats.data?.amount ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{tr("misc.label.nodeGroups2")}</span><span>{ngSummary.data?.total ?? 0} {tr("zh_4530ed")} {ngSummary.data?.online ?? 0}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{tr("zh_26670d")}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            {tr("zh_21af80")} <code>/api/admin/stats*</code>{tr("zh_cf8352")}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
