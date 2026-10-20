"use client";
import { t, tf } from "@/lib/i18n";
/** List page: 充值记录 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { useListFilters, type FilterDef } from "@/components/list-filters";
import {
  CopyCell,
  DateCell,
  MoneyCell,
  QrCell,
  SignedMoneyCell,
  StatusCell,
  TrafficCell,
} from "@/components/cells";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { labelEnum } from "@/lib/format";
import { makeDelete, makePatch, makePatcher } from "@/lib/actions";
import useSWR from "swr";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [
  { key: "order_id", label: t("zh_459868"), variant: "text" },
  { key: "payment.name", label: t("zh_a87078"), variant: "select" },
  { key: "status", label: t("misc.label.status"), variant: "select" },
];

function TopupCreateDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const { data: activities } = useSWR(["/topup/activities"], async () => {
    if (!open) return null;
    const res = await client.topup.activities.$get({ query: {} });
    return (await res.json()) as { data?: { type?: string; value?: number; min_amount?: number }[] } | null;
  });
  const { data: channels } = useSWR(["/pay"], async () => {
    if (!open) return null;
    const res = await client.pay.$get({ query: {} });
    return (await res.json()) as { data?: { name?: string; method?: string }[] } | null;
  });
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("alipay");
  const submit = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return toast.error(t("zh_686a7b"));
    const res = await client.topup.$post({ json: { amount: n, type: method } });
    if (res.ok) {
      const body = (await res.json()) as { pay_url?: string; url?: string };
      toast.success(t("zh_4fe9ee"));
      const url = body.pay_url ?? body.url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      onOpenChange(false);
      setAmount("");
      onDone();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("account.topUp")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("misc.label.amount")}</Label>
            <Input
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t("10_12a7f6")}
            />
          </div>
          {activities?.data?.length ? (
            <div className="bg-muted/60 rounded-md p-2 text-xs">
              {t("zh_eb6d3f")}
              {activities.data.map((a, i) => (
                <span key={i} className="ml-1">
                  {a.type === "percentage"
                    ? tf("value_69449e", { value: a.value ?? 0 })
                    : tf("value_5d7604", { value: a.value ?? 0 })}
                  {a.min_amount ? tf("value_a420b0", { value: a.min_amount }) : ""}
                </span>
              ))}
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_a87078")}</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(channels?.data?.length ?? 0) > 0 ? (
                  channels!.data!.map((c, i) => (
                    <SelectItem key={i} value={c.method ?? String(i)}>
                      {c.name ?? c.method ?? tf("n_d65cc9", { n: i + 1 })}
                    </SelectItem>
                  ))
                ) : (
                  <>
                    <SelectItem value="alipay">{t("zh_66f117")}</SelectItem>
                    <SelectItem value="wxpay">{t("zh_68406d")}</SelectItem>
                    <SelectItem value="usdt">USDT</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("misc.label.cancel")}
          </Button>
          <Button size="sm" onClick={() => void submit()}>
            {t("zh_5ac849")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function View() {
  const [topupOpen, setTopupOpen] = React.useState(false);
  const router = useRouter();
  const search = useSearchParams();

  /** 回跳判定：上游用 ?trade_status=TRADE_SUCCESS 判断支付结果并刷新订单。 */
  React.useEffect(() => {
    const status = search.get("trade_status");
    if (!status) return;
    if (status === "TRADE_SUCCESS") {
      toast.success(t("topup.paid"));
      void mutate();
    } else {
      toast.error(tf("topup.failed", { status }));
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("trade_status");
    router.replace(url.pathname + (url.search || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/topup", page, perPage, status],
    () => client.topup.$get,
    { page, perPage, status, ...filterParams },
  );
  const patch = makePatch(client.topup, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "order_id",
        header: t("zh_459868"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "price",
        header: t("misc.label.amount"),
        enableSorting: true,
        cell: (r) => <MoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "balance",
        header: t("misc.label.balance"),
        enableSorting: true,
        cell: (r) => <MoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "bonus",
        header: t("zh_662dc8"),
        enableSorting: true,
        cell: (r) => <MoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "payment.name",
        header: t("zh_a87078"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "status",
        header: t("misc.label.status"),
        enableSorting: false,
        cell: (r) => <span>{labelEnum(r.getValue())}</span>,
      },
      {
        accessorKey: "created_at",
        header: t("misc.label.created"),
        enableSorting: true,
        cell: (r) => <DateCell value={r.getValue()} />,
      },

      {
        id: "actions",
        header: "",
        cell: (c) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("misc.label.actions")}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  const row = c.row.original as { pay_url?: string; url?: string };
                  const url = row.pay_url ?? row.url;
                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                  else toast.error(t("topup.noPayUrl"));
                }}
              >
                {t("app.payNow")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void (async () => {
                    const res = await client.topup[":id"].cancel.$patch({
                      param: { id: String(c.row.original.id) },
                      json: {},
                    });
                    if (res.ok) {
                      toast.success(t("zh_da518e"));
                      await mutate();
                    }
                  })()
                }
              >
                {t("app.cancelOrder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setTopupOpen(true)}>
          {t("account.topUp")}
        </Button>
      </div>
      <ListPage<Row>
        title={t("admin.overview.topUps")}
        description={t("8_pay_url_pending_badges_ba8455")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        filters={filterControls}
        searchPlaceholder={t("zh_85a4f1")}
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{String(row.order_id ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("zh_459868")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
      />
      <TopupCreateDialog open={topupOpen} onOpenChange={setTopupOpen} onDone={() => void mutate()} />
    </div>
  );
}
