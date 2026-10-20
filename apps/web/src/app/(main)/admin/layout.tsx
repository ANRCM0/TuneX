"use client";
/**
 * Admin shell. Upstream renders the admin sidebar inside the (main) group, so it is
 * nested here too. Items are filtered by the RBAC resource key — the same rule as
 * module 466707's useEffectiveAccess + ADMIN_RESOURCES lookup.
 */
import * as React from "react";
import { ADMIN_NAV, Sidebar, useSidebarState } from "@/components/sidebar";
import { useAdminTickets, useAdminWithdraw } from "@/lib/admin-hooks";
import { useLicense, useSiteConfig, useUser } from "@/lib/hooks";
import { effectiveAccess } from "@/lib/permissions";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { open, mobileOpen, setMobileOpen } = useSidebarState();
  const { data: site } = useSiteConfig();
  const { data: license } = useLicense();
  const { data: user } = useUser();

  const access = React.useMemo(() => effectiveAccess(user, license), [user, license]);
  const visible = (key: string) => access[key] !== undefined;

  const tickets = useAdminTickets(1, 1, "open", visible("tickets"));
  const withdraw = useAdminWithdraw(1, 1, "pending", visible("withdraw"));

  const groups = React.useMemo(
    () =>
      ADMIN_NAV(visible, {
        tickets: (tickets.data as { total?: number } | undefined)?.total ?? 0,
        withdraw: (withdraw.data as { total?: number } | undefined)?.total ?? 0,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [access, tickets.data, withdraw.data],
  );

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      <Sidebar
        groups={groups}
        siteName={site?.SITE_NAME || "RelayX"}
        open={open}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
