"use client";
import { t } from "@/lib/i18n";
/**
 * 角色管理 — 列表 + 角色编辑器（含 19 资源 × none/read/write 权限矩阵）。
 * 复刻自 module 525621：权限用 RadioGroup（none/read/write 三态），
 * 顶级模块的分组行可一次性套用到该组全部资源；提交 `{name, description, permissions}`。
 */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { adminClient } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { DateCell, NumCell } from "@/components/cells";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ADMIN_RESOURCES, ADMIN_RESOURCE_GROUPS } from "@/lib/permissions";
import { makePatcher } from "@/lib/actions";
import { cn } from "@/lib/utils";

type Row = Record<string, unknown>;
type Level = "none" | "read" | "write";
type Permissions = Record<string, Level>;

const LEVELS: Level[] = ["none", "read", "write"];
const LEVEL_LABEL: Record<Level, string> = {
  none: t("zh_720777"),
  read: t("zh_ffc1d0"),
  write: t("zh_26ae2c"),
};

function LevelPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: Level | undefined;
  onChange: (v: Level) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex shrink-0 gap-4" role="radiogroup">
      {LEVELS.map((level) => (
        <label key={level} className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            className="accent-primary size-3.5"
            name={idPrefix}
            id={`${idPrefix}-${level}`}
            value={level}
            checked={(value ?? "none") === level}
            onChange={() => onChange(level)}
          />
          <span className="text-xs">{LEVEL_LABEL[level]}</span>
        </label>
      ))}
    </div>
  );
}

function RoleDialog({
  open,
  onOpenChange,
  role,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  role: Row | null;
  onDone: () => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [perms, setPerms] = React.useState<Permissions>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(String(role?.name ?? ""));
    setDescription(String(role?.description ?? ""));
    setPerms({ ...((role?.permissions as Permissions | undefined) ?? {}) });
  }, [open, role]);

  const setGroup = (group: string, level: Level) => {
    setPerms((prev) => {
      const next = { ...prev };
      for (const r of ADMIN_RESOURCES) {
        if (r.group !== group) continue;
        if (level === "none") delete next[r.key];
        else next[r.key] = level;
      }
      return next;
    });
  };

  const groupValue = (group: string): Level | undefined => {
    const levels = ADMIN_RESOURCES.filter((r) => r.group === group).map((r) => perms[r.key] ?? "none");
    return levels.every((l) => l === levels[0]) ? levels[0] : undefined;
  };

  const submit = async () => {
    if (!name.trim()) return toast.error(t("zh_b7c17b"));
    setBusy(true);
    try {
      const json = { name: name.trim(), description: description.trim() || null, permissions: perms };
      const res = role
        ? await adminClient.role[":id"].$put({ param: { id: String(role.id) }, json })
        : await adminClient.role.$post({ json });
      if (res.ok) {
        toast.success(t("zh_7e68eb"));
        onOpenChange(false);
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? t("zh_b9dcd8") : t("admin.roles.newRole")}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_3aa1f0")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("zh_8fcacf")} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_412f54")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("zh_53e328")}
            />
          </div>

          <div className="grid gap-2">
            <Label className="text-xs">{t("zh_560165")}</Label>
            <p className="text-muted-foreground text-xs">{t("zh_ebeb50")}</p>
            <div className="overflow-hidden rounded-lg border">
              {ADMIN_RESOURCE_GROUPS.map((group, gi) => {
                const resources = ADMIN_RESOURCES.filter((r) => r.group === group);
                return (
                  <div key={group} className={cn(gi > 0 && "border-t")}>
                    <div className="bg-muted/60 flex items-center justify-between gap-4 px-3 py-2">
                      <span className="text-sm font-semibold">{group}</span>
                      <LevelPicker
                        idPrefix={`group-${gi}`}
                        value={groupValue(group)}
                        onChange={(level) => setGroup(group, level)}
                      />
                    </div>
                    {resources.map((r) => (
                      <div
                        key={r.key}
                        className="flex items-center justify-between gap-4 border-t border-dashed py-2 pr-3 pl-8"
                      >
                        <span className="text-sm">
                          {r.label}
                          <code className="text-muted-foreground ml-2 text-[11px]">{r.key}</code>
                        </span>
                        <LevelPicker
                          idPrefix={`res-${r.key}`}
                          value={perms[r.key]}
                          onChange={(level) =>
                            setPerms((prev) => {
                              const next = { ...prev };
                              if (level === "none") delete next[r.key];
                              else next[r.key] = level;
                              return next;
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("misc.label.cancel")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? t("zh_6644f0") : t("admin.roles.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/admin/role", page, perPage],
    () => adminClient.role.$get,
    {
      page,
      perPage,
    },
  );
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Row | null>(null);
  const doPatch = makePatcher(mutate);

  const remove = React.useCallback(
    async (id: number) => {
      const res = await adminClient.role[":id"].$delete({ param: { id: String(id) } });
      if (res.ok) {
        toast.success(t("zh_86e8d1"));
        await mutate();
      }
    },
    [mutate],
  );

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      { accessorKey: "name", header: t("zh_3aa1f0"), enableSorting: true },
      {
        accessorKey: "description",
        header: t("zh_412f54"),
        enableSorting: false,
        cell: (r) => (
          <span className="text-muted-foreground max-w-[22rem] truncate">{String(r.getValue() ?? "—")}</span>
        ),
      },
      {
        id: "perm_count",
        header: t("zh_32827c"),
        enableSorting: false,
        cell: (r) => {
          const perms = (r.row.original.permissions ?? {}) as Permissions;
          const write = Object.values(perms).filter((v) => v === "write").length;
          const read = Object.values(perms).filter((v) => v === "read").length;
          return (
            <span className="text-xs">
              {t("zh_26ae2c")} {write} {t("zh_208cd0")} {read}
            </span>
          );
        },
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
                  setEditing(c.row.original);
                  setOpen(true);
                }}
              >
                <Pencil className="size-3.5" /> {t("misc.label.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => void remove(Number(c.row.original.id))}
              >
                <Trash2 className="size-3.5" /> {t("misc.label.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [remove],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.roles")}
        description={t("19_read_write_license_ad_69183c")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        searchPlaceholder={t("zh_47d5b3")}
        toolbarExtra={
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            {t("admin.roles.newRole")}
          </Button>
        }
      />
      <RoleDialog open={open} onOpenChange={setOpen} role={editing} onDone={() => void mutate()} />
      <span className="hidden">{typeof doPatch}</span>
    </div>
  );
}
