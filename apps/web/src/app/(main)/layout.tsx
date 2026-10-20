"use client";
import { t } from "@/lib/i18n";
/**
 * User shell. Server-side login lives in src/proxy.ts (the Next 16 `proxy`),
 * exactly like upstream — this layout only renders chrome.
 */
import * as React from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar, USER_NAV, useSidebarState } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { useLicense, useSiteConfig, useUser } from "@/lib/hooks";
import { usePageTitle } from "@/components/page-title";
import { CommandPalette, type CommandItem } from "@/components/command-palette";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { open, toggle, mobileOpen, setMobileOpen } = useSidebarState();
  const { data: site } = useSiteConfig();
  const { data: license } = useLicense();
  const { data: user } = useUser();
  const title = usePageTitle();

  const business = license?.type !== "personal";
  const allowCustom =
    Boolean(user?.user_plan?.plan?.allow_custom_in_node_group) ||
    Boolean(user?.user_plan?.plan?.allow_custom_out_node_group);

  const groups = React.useMemo(
    () => USER_NAV({ business, allowCustomNodeGroups: allowCustom }),
    [business, allowCustom],
  );

  const commandItems: CommandItem[] = React.useMemo(
    () => [
      ...groups.flatMap((g) =>
        g.items.map((it) => ({ id: it.url, label: it.title, group: g.title, href: it.url })),
      ),
      { id: "new-tunnel", label: t("plans.newPlan"), group: t("nav.tunnels"), href: "/tunnels" },
      { id: "topup", label: t("app.topUp"), group: t("nav.topUps"), href: "/topups" },
      { id: "tickets", label: t("nav.tickets"), group: t("nav.more"), href: "/tickets/new" },
    ],
    [groups],
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar
        groups={groups}
        siteName={site?.SITE_NAME || "RelayX"}
        open={open}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t("zh_99aaea")}
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={t("zh_37b948")}
            onClick={toggle}
          >
            <Menu className="size-4" />
          </Button>
          <h1 className="flex-1 truncate text-sm font-semibold">{title}</h1>
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        <CommandPalette items={commandItems} />
      </div>
    </div>
  );
}
