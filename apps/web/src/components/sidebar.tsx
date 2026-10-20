"use client";
/**
 * Sidebar shell. Groups/items/conditions come from reports/02 §3.2–3.3 and
 * reports/09 §3.3:
 *   user side  — 6 groups, filtered by licence type and the plan's allow_custom_* flags
 *   admin side — 6 groups / 19 items, filtered by RBAC resource keys, with badges
 * Plus: cookie `sidebar_state` (7 days), Ctrl/Cmd+B, 16rem / 3rem widths, mobile Sheet.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, Banknote, ChartLine, ChevronDown, CircuitBoard, Coins, CreditCard, Gift, Globe,
  History, House, Key, Lock, Package, Server, Settings, ShieldCheck, ShoppingCart, TicketCheck, UserRound, Wallet, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { LocaleSwitch } from "./locale-switch";
import { Avatar, AvatarFallback } from "./avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { Badge } from "./ui/badge";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";

export type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  badge?: number;
  external?: boolean;
  exactMatch?: boolean;
};

export type NavGroup = { title: string; items: NavItem[] };

export const USER_NAV = (opts: { business: boolean; allowCustomNodeGroups: boolean }): NavGroup[] => [
  { title: t("nav.overview"), items: [{ title: t("nav.home"), url: "/home", icon: House }] },
  {
    title: t("nav.tunnels"),
    items: [
      { title: t("nav.tunnelManagement"), url: "/tunnels", icon: CircuitBoard },
      { title: t("nav.tunnelMonitoring"), url: "/tunnels/monitoring", icon: ChartLine },
    ],
  },
  {
    title: t("nav.nodes2"),
    items: [
      ...(opts.allowCustomNodeGroups ? [{ title: t("nav.nodeGroups"), url: "/node-groups", icon: Server }] : []),
      { title: t("nav.nodeStatus"), url: "/node-stats", icon: Activity },
    ],
  },
  {
    title: "DNS",
    items: [
      { title: t("nav.inboundKeepAlive"), url: "/in-node-group-dns", icon: Globe },
      { title: t("dns.credentials"), url: "/auth-configs", icon: Lock },
    ],
  },
  {
    title: t("nav.accountBilling"),
    items: [
      { title: t("nav.profile"), url: "/account", icon: UserRound },
      { title: t("nav.plans2"), url: "/plans", icon: ShoppingCart },
      ...(opts.business ? [{ title: t("admin.overview.topUps"), url: "/topups", icon: Wallet }] : []),
      { title: t("nav.orders"), url: "/orders", icon: History },
      { title: t("nav.balanceHistory"), url: "/balance-logs", icon: Wallet },
    ],
  },
  ...(opts.business
    ? [
        {
          title: t("misc.label.more"),
          items: [
            { title: t("nav.referral2"), url: "/referral", icon: Gift },
            { title: t("nav.myTickets"), url: "/tickets", icon: TicketCheck },
            { title: t("nav.apiDocs"), url: "/docs", icon: Key, external: true },
          ],
        },
      ]
    : []),
];

export const ADMIN_NAV = (visible: (key: string) => boolean, badges: { tickets?: number; withdraw?: number }): NavGroup[] =>
  [
    { title: t("nav.overview"), items: [{ title: t("nav.home"), url: "/admin", icon: House, exactMatch: true }] },
    {
      title: t("nav.basics"),
      items: [
        { title: t("misc.label.nodeGroups"), url: "/admin/node-groups", icon: Server },
        { title: t("nav.nodes"), url: "/admin/nodes", icon: Server },
        { title: t("nav.plans"), url: "/admin/plans", icon: Package },
      ],
    },
    {
      title: t("nav.finance"),
      items: [
        { title: t("nav.coupons"), url: "/admin/plan_coupons", icon: TicketCheck, key: "plan_coupons" },
        { title: t("nav.payments"), url: "/admin/payments", icon: CreditCard },
        { title: t("admin.overview.topUps"), url: "/admin/topups", icon: Wallet },
        { title: t("account.topUpActivity"), url: "/admin/topup_activities", icon: Gift },
        { title: t("nav.orders"), url: "/admin/orders", icon: History },
        { title: t("nav.balanceHistory"), url: "/admin/balance-logs", icon: Wallet },
      ],
    },
    {
      title: t("nav.referral"),
      items: [
        { title: t("nav.commissionHistory"), url: "/admin/commission-logs", icon: Coins },
        { title: t("nav.withdrawals"), url: "/admin/withdraw", icon: Banknote, badge: badges.withdraw ?? 0 },
      ],
    },
    {
      title: t("misc.label.users"),
      items: [
        { title: t("nav.users"), url: "/admin/users", icon: UserRound },
        { title: t("nav.roles"), url: "/admin/roles", icon: ShieldCheck },
        { title: t("nav.userPlans"), url: "/admin/user_plans", icon: Package },
        { title: t("nav.userTunnels"), url: "/admin/tunnels", icon: CircuitBoard },
        { title: t("nav.tunnelStats"), url: "/admin/tunnels/stats", icon: ChartLine },
        { title: t("nav.tickets"), url: "/admin/tickets", icon: TicketCheck, badge: badges.tickets ?? 0 },
      ] as NavItem[],
    },
    {
      title: t("nav.system"),
      items: [
        { title: t("nav.settings"), url: "/admin/settings", icon: Settings },
        { title: t("nav.license"), url: "/admin/license", icon: Key },
      ],
    },
  ].map((g) => ({
    ...g,
    items: g.items.filter((it) => {
      const key = (it as NavItem & { key?: string }).key;
      return !key || visible(key as string);
    }),
  }));

const COOKIE = "sidebar_state";

export function useSidebarState() {
  const [open, setOpen] = React.useState(true);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const isMobile = React.useState(() => false);

  React.useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)sidebar_state=(true|false)/);
    if (m) setOpen(m[1] === "true");
  }, []);

  const toggle = React.useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      document.cookie = `${COOKIE}=${next}; path=/; max-age=604800`;
      return next;
    });
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { open, setOpen, toggle, mobileOpen, setMobileOpen, isMobile: isMobile[0] };
}

export function Sidebar({
  groups,
  siteName,
  logoText = "R",
  open,
  mobileOpen,
  onMobileOpenChange,
}: {
  groups: NavGroup[];
  siteName: string;
  logoText?: string;
  open: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (v: boolean) => void;
}) {
  const pathname = usePathname();
  const body = (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center gap-2 px-2 py-3">
        <Avatar className="size-8">
          <AvatarFallback>{logoText}</AvatarFallback>
        </Avatar>
        <Link href="/home" className="text-lg font-bold">
          {siteName}
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {groups.map((group) => (
          <Collapsible key={group.title} defaultOpen>
            <CollapsibleTrigger className="hover:bg-accent flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium">
              {group.title}
              <ChevronDown className="size-3.5 transition-transform data-[state=closed]:-rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="flex flex-col gap-0.5 py-1">
                {group.items.map((item) => {
                  const active = item.exactMatch
                    ? pathname === item.url
                    : pathname === item.url || pathname.startsWith(item.url + "/");
                  const Icon = item.icon;
                  return (
                    <li key={item.url}>
                      <Link
                        href={item.url}
                        target={item.external ? "_blank" : undefined}
                        rel={item.external ? "noopener noreferrer" : undefined}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                          active ? "bg-accent text-accent-foreground font-medium" : "hover:bg-accent/60",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="flex-1 truncate">{item.title}</span>
                        {item.badge ? <Badge variant="destructive">{item.badge}</Badge> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </nav>
      <div className="flex items-center justify-between px-2">
        <LocaleSwitch />
      </div>
      <div className="text-muted-foreground px-2 py-2 text-xs">
        {t("zh_2b86dd")} <a className="underline" href="https://docs.relayx.cc" target="_blank" rel="noreferrer">RelayX</a> {t("zh_976d81")}
      </div>
    </div>
  );

  return (
    <>
      <aside
        data-state={open ? "expanded" : "collapsed"}
        style={{ width: open ? "16rem" : "3rem" }}
        className="bg-sidebar text-sidebar-foreground hidden shrink-0 border-r md:block"
      >
        <div className={cn("h-full", !open && "pointer-events-none opacity-0")}>{body}</div>
      </aside>
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="p-0">
          <SheetTitle className="sr-only">{t("zh_c7ed24")}</SheetTitle>
          {body}
        </SheetContent>
      </Sheet>
    </>
  );
}
