"use client";
import { t, tf } from "@/lib/i18n";
/** List page: 用户管理 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { adminClient, client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { useListFilters, type FilterDef } from "@/components/list-filters";
import { CopyCell, DateCell, MoneyCell, QrCell, SignedMoneyCell, StatusCell, TrafficCell } from "@/components/cells";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { labelEnum } from "@/lib/format";
import { makeDelete, makePatch, makePatcher } from "@/lib/actions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [{"key": "email", "label": t("misc.label.email"), "variant": "text"}, {"key": "status", "label": t("misc.label.status"), "variant": "select"}, {"key": "super_admin", "label": t("zh_6f22a7"), "variant": "select"}];


/** 三个管理动作：余额调整 / 佣金调整 / 模拟登录（POST /admin/user/:id/*）。 */
function UserActionDialog({
  action,
  userId,
  onClose,
  onDone,
}: {
  action: "balance" | "commission" | "password" | null;
  userId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [pwd, setPwd] = React.useState("");

  React.useEffect(() => {
    setAmount("");
    setReason("");
    setPwd("");
  }, [action, userId]);

  if (!action || userId == null) return null;

  const submit = async () => {
    if (action === "password") {
      if (pwd.length < 8) return toast.error(t("8_67ac94"));
      const res = await adminClient.user[":id"].password.$patch({ param: { id: userId }, json: { password: pwd } });
      if (res.ok) {
        toast.success(t("zh_eb5719"));
        onClose();
        onDone();
      }
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return toast.error(t("zh_1003d5"));
    const res =
      action === "balance"
        ? await adminClient.user[":id"].balance.adjust.$post({ param: { id: userId }, json: { amount: n, reason } })
        : await adminClient.user[":id"].commission.adjust.$post({ param: { id: userId }, json: { amount: n, reason } });
    if (res.ok) {
      toast.success(t("zh_1ea071"));
      onClose();
      onDone();
    }
  };

  const title = action === "balance" ? t("admin.users.adjustBalance") : action === "commission" ? t("app.adjustCommission") : t("misc.label.resetPassword");

  return (
    <Dialog open onOpenChange={(v: boolean) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          {action === "password" ? (
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("zh_d22c9c")}</Label>
              <Input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("zh_43bb99")}</Label>
                <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder={t("10_5_e264c9")} />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("zh_e03614")}</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("zh_53e328")} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t("misc.label.cancel")}</Button>
          <Button size="sm" onClick={() => void submit()}>{t("misc.label.submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserEditDialog({
  open,
  onOpenChange,
  user,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user: Record<string, unknown> | null;
  onDone: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [status, setStatus] = React.useState("active");
  const [balance, setBalance] = React.useState("");
  const [commission, setCommission] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setEmail(String(user?.email ?? ""));
    setPassword("");
    setStatus(String(user?.status ?? "active"));
    setBalance(user?.balance != null ? String(user.balance) : "");
    setCommission(user?.commission != null ? String(user.commission) : "");
  }, [open, user]);

  const submit = async () => {
    if (!email.trim()) return toast.error(t("zh_f2dc24"));
    const json: Record<string, unknown> = { email: email.trim(), status };
    if (password) json.password = password;
    if (balance !== "") json.balance = Number(balance);
    if (commission !== "") json.commission = Number(commission);
    const res = user
      ? await adminClient.user[":id"].$put({ param: { id: String(user.id) }, json })
      : await adminClient.user.$post({ json });
    if (res.ok) {
      toast.success(t("zh_7e68eb"));
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{user ? t("zh_2b8f00") : t("admin.users.newUser")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("misc.label.email")}</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("admin.users.password")}</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={user ? t("zh_33236a") : t("8_bfd5e7")} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("misc.label.status")}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t("zh_d4e9ca")}</SelectItem>
                <SelectItem value="inactive">{t("zh_be70be")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("misc.label.balance")}</Label>
              <Input value={balance} inputMode="decimal" onChange={(e) => setBalance(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("app.commission")}</Label>
              <Input value={commission} inputMode="decimal" onChange={(e) => setCommission(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("misc.label.cancel")}</Button>
          <Button size="sm" onClick={() => void submit()}>{t("admin.roles.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function View() {
  const [editOpen, setEditOpen] = React.useState(false);
  const [editUser, setEditUser] = React.useState<Record<string, unknown> | null>(null);
  const [action, setAction] = React.useState<"balance" | "commission" | "password" | null>(null);
  const [target, setTarget] = React.useState<number | null>(null);

  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(["/admin/user", page, perPage, status], () => adminClient.user.$get, { page, perPage, status, ...filterParams });
  const remove = makeDelete(adminClient.user, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
    { accessorKey: "email", header: t("misc.label.email"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "status", header: t("misc.label.status"), enableSorting: false, cell: (r) => <StatusCell value={r.getValue()} /> },
    { accessorKey: "super_admin", header: t("zh_6f22a7"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "admin_roles", header: t("admin.users.role"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "balance", header: t("misc.label.balance"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "commission_balance", header: t("zh_9d493c"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "auto_renew", header: t("zh_efe6de"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "referral_commission_rate", header: t("zh_3191b8"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "referral_first_only", header: t("zh_f4720d"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "tg_id", header: "Telegram ID", enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "note", header: t("zh_e03614"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "created_at", header: t("misc.label.created"), enableSorting: true, cell: (r) => <DateCell value={r.getValue()} /> },
    { accessorKey: "updated_at", header: t("misc.label.updated"), enableSorting: true, cell: (r) => <DateCell value={r.getValue()} /> },
      {
        id: "actions",
        header: "",
        cell: (c) => {
          const id = Number(c.row.original.id);
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t("misc.label.actions")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">

                <DropdownMenuItem onClick={() => { setEditUser(c.row.original as Record<string, unknown>); setEditOpen(true); }}>{t("misc.label.edit")}</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void (async () => {
                      const res = await adminClient.node.group.user[":user_id"].summary.$get({ param: { user_id: String(id) } });
                      if (!res.ok) return;
                      const body = await res.json();
                      toast.success(tf("result_0453d4", { result: JSON.stringify(body).slice(0, 120) }));
                    })()
                  }
                >
                  {t("zh_72c060")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setTarget(id); setAction("balance"); }}>{t("admin.users.adjustBalance")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setTarget(id); setAction("commission"); }}>{t("app.adjustCommission")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setTarget(id); setAction("password"); }}>{t("misc.label.resetPassword")}</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void (async () => {
                      const res = await adminClient.user[":id"].impersonate.$post({ param: { id } });
                      if (res.ok) {
                        const body = (await res.json()) as { token?: string };
                        if (body.token) window.open(`/home?impersonation=${body.token}`, "_blank", "noopener,noreferrer");
                      }
                    })()
                  }
                >
                  {t("app.impersonate")}
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => void remove([id])}>{t("misc.label.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.users")}
        description={t("15_10_dropdownmenu_3_imp_a843e9")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        filters={filterControls}
        searchPlaceholder={t("zh_85a4f1")}
        toolbarExtra={
          <Button size="sm" onClick={() => { setEditUser(null); setEditOpen(true); }}>
            {t("admin.users.newUser")}
          </Button>
        }
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{String(row.email ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("misc.label.email")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
        bulkActions={(rows, clear) => (<Button variant="destructive" size="sm" onClick={() => void remove(rows.map((r) => Number(r.id))).then(clear)}>{t("misc.label.deleteSelected")}</Button>)}
      />
      <UserEditDialog open={editOpen} onOpenChange={setEditOpen} user={editUser} onDone={() => void mutate()} />
      <UserActionDialog
        action={action}
        userId={target}
        onClose={() => { setAction(null); setTarget(null); }}
        onDone={() => void mutate()}
      />
    </div>
  );
}
