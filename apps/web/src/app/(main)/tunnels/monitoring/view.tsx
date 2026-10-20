"use client";
import { t } from "@/lib/i18n";
/**
 * 隧道监控 — 3 tabs (流量统计 / 隧道流量 / 隧道状态) + traffic & traffic_cost bars.
 * Upstream polls every OBSERVER_PERIOD seconds (default 5, reports/10 U4).
 */
import * as React from "react";
import useSWR from "swr";
import { client } from "@/lib/client";
import { BarSeries, ChartCard } from "@/components/charts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { setPageTitle } from "@/components/page-title";

type Point = { date: string; traffic?: number; traffic_cost?: number; total?: number };

export default function TunnelMonitoringPage() {
  const { data: period } = useSWR(["/system/config", "OBSERVER_PERIOD"], async () => {
    const res = await client.system.config.$get({ query: { name: "OBSERVER_PERIOD" } });
    return (await res.json()) as Record<string, unknown>;
  });
  const interval = Number(period?.OBSERVER_PERIOD ?? 5) * 1000;

  const traffic = useSWR(
    ["/tunnel/traffic/stats"],
    async () => {
      const res = await client.tunnel.traffic.stats.$get({ query: { aggregate_by: "day" } });
      return (await res.json()) as Point[] | { data: Point[] };
    },
    { refreshInterval: interval },
  );

  const stats = useSWR(
    ["/tunnel/stats"],
    async () => {
      const res = await client.tunnel.stats.$get({ query: {} });
      return (await res.json()) as Point[] | { data: Point[] };
    },
    { refreshInterval: interval },
  );

  React.useEffect(() => setPageTitle(t("nav.tunnelMonitoring")), []);

  const norm = (v: unknown): Point[] =>
    Array.isArray(v) ? (v as Point[]) : ((v as { data?: Point[] })?.data ?? []);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("nav.tunnelMonitoring")}</h2>
        <p className="text-muted-foreground text-xs">
          {t("zh_7757f7")} {interval / 1000} {t("observer_period_c22e3b")}
        </p>
      </div>
      <Tabs defaultValue="traffic-stats">
        <TabsList>
          <TabsTrigger value="traffic-stats">{t("admin.overview.trafficStats")}</TabsTrigger>
          <TabsTrigger value="traffic">{t("app.tunnelTraffic")}</TabsTrigger>
          <TabsTrigger value="stats">{t("app.tunnelStatus")}</TabsTrigger>
        </TabsList>
        <TabsContent value="traffic-stats">
          <ChartCard title={t("zh_ec0cf3")} description={t("zh_c07069")}>
            <BarSeries
              data={norm(traffic.data)}
              keys={[
                { key: "traffic", label: t("admin.plans.traffic") },
                { key: "traffic_cost", label: t("app.cost") },
              ]}
            />
          </ChartCard>
        </TabsContent>
        <TabsContent value="traffic">
          <ChartCard title={t("app.tunnelTraffic")}>
            <BarSeries
              data={norm(traffic.data)}
              keys={[{ key: "traffic", label: t("admin.plans.traffic") }]}
            />
          </ChartCard>
        </TabsContent>
        <TabsContent value="stats">
          <ChartCard title={t("app.tunnelStatus")}>
            <BarSeries data={norm(stats.data)} keys={[{ key: "total", label: t("zh_b9ae89") }]} />
          </ChartCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
