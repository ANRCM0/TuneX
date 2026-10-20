"use client";
import { t as tr } from "@/lib/i18n";
/**
 * 节点状态 — upstream renders a hand-writen <Table> grouped by node group
 * (reports/11: node-stats is NOT a DataTable page). Data: GET /node/sysinfo.
 */
import * as React from "react";
import useSWR from "swr";
import { client } from "@/lib/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BadgeStatus } from "@/components/ui/badge-status";
import { setPageTitle } from "@/components/page-title";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Sysinfo = {
  node_id?: number;
  node_name?: string;
  node_group_name?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  uptime?: number;
  status?: string;
  version?: string;
};

export default function NodeStatsPage() {
  const { data, isLoading, mutate } = useSWR(["/node/sysinfo"], async () => {
    const res = await client.node.sysinfo.$get({ query: {} });
    return (await res.json()) as Sysinfo[];
  });
  React.useEffect(() => setPageTitle(tr("nav.nodeStatus")), []);
  // poll every 10s, matching the shipped page
  React.useEffect(() => {
    const t = setInterval(() => void mutate(), 10_000);
    return () => clearInterval(t);
  }, [mutate]);

  const { data: nodeList, mutate: mutateNodes } = useSWR(["/node"], async () => {
    const res = await client.node.$get({ query: { page: "1", perPage: "50" } });
    return (await res.json()) as { data?: { id: number; name?: string; status?: string }[] };
  });

  const rows = Array.isArray(data) ? data : ((data as unknown as { data?: Sysinfo[] })?.data ?? []);

  const upgradeAll = async () => {
    const ids = (nodeList?.data ?? []).map((n) => n.id);
    if (ids.length === 0) return toast.error(tr("zh_92bc7a"));
    const res = await client.node.upgrade.$post({ json: { node_ids: ids } });
    if (res.ok) {
      toast.success(tr("zh_4b4de2"));
      await mutateNodes();
    }
  };

  const toggleStatus = async (id: number, status: string) => {
    const res = await client.node[":id"].$patch({
      param: { id: String(id) },
      json: { status: status === "active" ? "inactive" : "active" },
    });
    if (res.ok) {
      toast.success(tr("zh_fd9803"));
      await mutateNodes();
    }
  };

  const removeNode = async (id: number) => {
    const res = await client.node.$delete({ query: { ids: String(id) } });
    if (res.ok) {
      toast.success(tr("zh_fb5fe1"));
      await mutateNodes();
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{tr("nav.nodeStatus")}</h2>
          <p className="text-muted-foreground text-xs">{tr("10_get_node_sysinfo_6e9d36")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void upgradeAll()}>
            {tr("app.upgradeAll")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void Promise.all([mutate(), mutateNodes()])}>
            {tr("app.refresh")}
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("nav.nodes2")}</TableHead>
              <TableHead>{tr("misc.label.nodeGroups2")}</TableHead>
              <TableHead>{tr("misc.label.status")}</TableHead>
              <TableHead>CPU</TableHead>
              <TableHead>{tr("zh_d014ab")}</TableHead>
              <TableHead>{tr("zh_79a168")}</TableHead>
              <TableHead>{tr("zh_989d1a")}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground h-24 text-center">
                  {tr("app.loading")}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  {tr("misc.empty.noData")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.node_id ?? r.node_name}>
                  <TableCell>{r.node_name ?? r.node_id ?? "—"}</TableCell>
                  <TableCell>{r.node_group_name ?? "—"}</TableCell>
                  <TableCell>
                    <BadgeStatus status={r.status ?? "unknown"} />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.cpu != null ? `${r.cpu.toFixed(1)}%` : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.memory != null ? `${r.memory.toFixed(1)}%` : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.disk != null ? `${r.disk.toFixed(1)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{r.version ?? "—"}</TableCell>
                  <TableCell>
                    {r.node_id != null ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={tr("misc.label.actions")}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => void toggleStatus(Number(r.node_id), String(r.status ?? "active"))}
                          >
                            {tr("app.enableDisable")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              const cmd = "curl -sSL https://dl.relayx.cc/uninstall.sh | sh -s -- -y";
                              void navigator.clipboard.writeText(cmd).then(
                                () => toast.success(tr("zh_23cea6")),
                                () => toast.error(tr("zh_f2c6b5")),
                              );
                            }}
                          >
                            {tr("zh_269e70")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => void removeNode(Number(r.node_id))}
                          >
                            {tr("app.deleteNode")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
