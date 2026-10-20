"use client";
import { t, tf } from "@/lib/i18n";
/** Cell renderers shared by all 30 list pages (render kinds come from artifacts/columns.json). */
import * as React from "react";
import { Copy, ExternalLink, QrCode } from "lucide-react";
import { toast } from "sonner";
import { BadgeStatus } from "./ui/badge-status";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { formatDate } from "@/lib/utils";
import { money, num, signedMoney, trafficGiB } from "@/lib/format";
import { cn } from "@/lib/utils";

export function DateCell({ value, empty = "—" }: { value: unknown; empty?: string }) {
  if (!value) return <span className="text-muted-foreground">{empty}</span>;
  return <span className="text-muted-foreground text-xs whitespace-nowrap">{formatDate(String(value))}</span>;
}

export function StatusCell({ value }: { value: unknown }) {
  return <BadgeStatus status={String(value ?? "")} />;
}

export function MoneyCell({ value }: { value: unknown }) {
  return <span className="tabular-nums">{money(value)}</span>;
}

export function SignedMoneyCell({ value }: { value: unknown }) {
  const n = Number(value);
  return (
    <span className={cn("tabular-nums", n > 0 && "text-green-600", n < 0 && "text-red-600")}>
      {signedMoney(value)}
    </span>
  );
}

export function TrafficCell({ value }: { value: unknown }) {
  return <span className="tabular-nums">{trafficGiB(value)}</span>;
}

export function NumCell({ value, fallback }: { value: unknown; fallback?: string }) {
  if ((value === null || value === undefined) && fallback) {
    return <span className="text-muted-foreground">{fallback}</span>;
  }
  return <span className="tabular-nums">{num(value)}</span>;
}

export function CopyCell({ value, label }: { value: unknown; label?: string }) {
  const text = String(value ?? "");
  return (
    <span className="flex items-center gap-1">
      <span className="max-w-[16rem] truncate">{text || "—"}</span>
      {text ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={tf("label_fbac75", { label: label ?? "" })}
                onClick={() => {
                  void navigator.clipboard.writeText(text).then(
                    () => toast.success(t("zh_e381a5")),
                    () => toast.error(t("zh_f2c6b5")),
                  );
                }}
              >
                <Copy className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("misc.label.copy")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </span>
  );
}

/** Multi-value column: upstream shows a Popover list; a count + tooltip is enough here. */
export function MultiCell({ value }: { value: unknown }) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  if (list.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default underline decoration-dotted">
            {list.length} {t("zh_12de8e")}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="flex flex-col gap-0.5">
            {list.slice(0, 8).map((v, i) => (
              <span key={i}>{String(v)}</span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function QrCell({ onClick }: { onClick?: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="size-7" aria-label={t("zh_2d0366")} onClick={onClick}>
      <QrCode className="size-3.5" />
    </Button>
  );
}

export function LinkCell({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline"
    >
      {children} <ExternalLink className="size-3" />
    </a>
  );
}
