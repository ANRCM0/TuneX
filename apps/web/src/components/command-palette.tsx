"use client";
/**
 * 全局命令面板（复刻上游 cmdk 用法）：⌘K / Ctrl+K 打开，跳页面 + 快捷动作。
 * 上游用 cmdk 包；这里用轻量实现，交互一致（输入过滤、↑↓ 选择、Enter 执行、Esc 关闭）。
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "./ui/dialog";
import { t } from "@/lib/i18n";

export type CommandItem = { id: string; label: string; group?: string; href?: string; run?: () => void };

export function CommandPalette({ items }: { items: CommandItem[] }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const router = useRouter();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q) || (i.group ?? "").toLowerCase().includes(q)) : items;
  }, [items, query]);

  React.useEffect(() => setIndex(0), [query, open]);

  const run = (item: CommandItem) => {
    setOpen(false);
    setQuery("");
    if (item.href) router.push(item.href);
    item.run?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="text-muted-foreground size-4" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && filtered[index]) {
                e.preventDefault();
                run(filtered[index]);
              }
            }}
            placeholder={t("cmd.placeholder")}
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center text-xs">{t("cmd.empty")}</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(item)}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm",
                  i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <span>{item.label}</span>
                {item.group ? <span className="text-muted-foreground text-[11px]">{item.group}</span> : null}
              </button>
            ))
          )}
        </div>
        <div className="text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-[11px]">
          <span>↑↓ {t("cmd.navigate")}</span>
          <span>↵ {t("cmd.select")}</span>
          <span>esc {t("cmd.close")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
