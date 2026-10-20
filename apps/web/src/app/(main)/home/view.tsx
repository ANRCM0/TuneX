"use client";
import { t as tr } from "@/lib/i18n";
import * as React from "react";
import { useLicense, useSystemConfig, useTunnels, useUser } from "@/lib/hooks";
import useSWR from "swr";
import { client } from "@/lib/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BadgeStatus } from "@/components/ui/badge-status";
import { Skeleton } from "@/components/ui/skeleton";
import { setPageTitle } from "@/components/page-title";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

export default function HomePage() {
  const { data: user, isLoading } = useUser();
  const { data: license } = useLicense();
  const { data: config } = useSystemConfig(["SITE_NAME", "NOTICE", "NOTICE_POPUP", "NOTICE_POPUP_INTERVAL_HOURS", "ENABLE_SUBSCRIPTION"]);
  const { data: tunnels } = useTunnels(1, 5, [{ id: "created_at", desc: true }]);

  // 汇总卡片数据：GET /tunnel/summary、/plan/summary、/node/group/summary
  const { data: summary } = useSWR(["/tunnel/summary"], async () => {
    const res = await client.tunnel.summary.$get({ query: {} });
    return (await res.json()) as { total?: number; active?: number; traffic?: number };
  });
  const { data: planSummary } = useSWR(["/plan/summary"], async () => {
    const res = await client.plan.summary.$get({ query: {} });
    return (await res.json()) as { total?: number; active?: number };
  });
  const { data: ngSummary } = useSWR(["/node/group/summary"], async () => {
    const res = await client.node.group.summary.$get({ query: {} });
    return (await res.json()) as { total?: number; online?: number };
  });

  React.useEffect(() => setPageTitle(tr("nav.home")), []);

  const notice = typeof config?.NOTICE === "string" ? config.NOTICE : "";

  /**
   * 弹窗公告：间隔小时数（0 = 每次进入都弹），localStorage 记录 {notice, shownAt}；
   * 公告内容变化时立即重弹。逻辑复刻 module 892123。
   */
  const [popupOpen, setPopupOpen] = React.useState(false);
  const popup = typeof config?.NOTICE_POPUP === "string" ? config.NOTICE_POPUP.trim() : "";
  React.useEffect(() => {
    if (!popup) {
      setPopupOpen(false);
      return;
    }
    const hours = Number(config?.NOTICE_POPUP_INTERVAL_HOURS);
    const interval = Number.isFinite(hours) && hours >= 0 ? hours : 24;
    const now = Date.now();
    const KEY = "relayx_notice_popup";
    let show = interval === 0;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { notice?: string; shownAt?: number };
        const changed = saved.notice !== popup;
        const elapsed = typeof saved.shownAt === "number" ? now - saved.shownAt : Infinity;
        show = show || changed || elapsed >= 60 * interval * 60_000;
      } else {
        show = true;
      }
    } catch {
      show = true;
    }
    if (show) {
      localStorage.setItem(KEY, JSON.stringify({ notice: popup, shownAt: now }));
      setPopupOpen(true);
    }
  }, [popup, config?.NOTICE_POPUP_INTERVAL_HOURS]);
  const business = license?.type !== "personal";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{tr("landing.account")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {isLoading ? <Skeleton className="h-4 w-32" /> : <span>{user?.email ?? tr("zh_e8041a")}</span>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{tr("admin.userPlans.plan")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{user?.user_plan?.plan?.name ?? tr("zh_e1997c")}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">License</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {license?.type ? (business ? tr("zh_7b6c3b") : tr("zh_af5013")) : tr("zh_f1ebc7")}
          </CardContent>
        </Card>
      </div>

      <Dialog open={popupOpen} onOpenChange={setPopupOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tr("app.announcement2")}</DialogTitle>
          </DialogHeader>
          <div className="text-muted-foreground max-h-[60vh] overflow-y-auto text-sm whitespace-pre-wrap">{popup}</div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{tr("app.announcement")}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm whitespace-pre-wrap">
          {notice || tr("app.noAnnouncement")}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">{tr("zh_b378ab")}</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {summary?.total ?? 0} {tr("zh_984e3e")} {summary?.active ?? 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{tr("misc.label.nodeGroups2")}</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {ngSummary?.total ?? 0} {tr("zh_4530ed")} {ngSummary?.online ?? 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{tr("admin.userPlans.plan")}</CardTitle></CardHeader>
          <CardContent className="text-sm">{planSummary?.active ? tr("zh_d60537") : tr("zh_e1997c")}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{tr("zh_430598")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {(tunnels?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">{tr("misc.empty.noData")}</p>
          ) : (
            (tunnels?.data as unknown as { id: number; name: string; status: string; created_at: string }[]).map((t) => (
              <div key={t.id} className="flex items-center justify-between border-b py-1 last:border-0">
                <span className="text-sm">{t.name}</span>
                <span className="flex items-center gap-2">
                  <BadgeStatus status={t.status} />
                  <span className="text-muted-foreground text-xs">{formatDate(t.created_at)}</span>
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
