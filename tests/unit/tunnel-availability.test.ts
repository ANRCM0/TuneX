/**
 * `TunnelService.filterAvailableTunnels` — the quota and node-group gate that
 * decides which tunnels reach an agent's config push.
 *
 * This is pure logic over already-loaded rows (`052__src__services__tunnel.ts:590-635`
 * upstream, `apps/backend/src/services/tunnel.ts:915` here), but a mistake in it is
 * expensive in both directions: exporting a tunnel the plan does not cover, or
 * silently exporting none (the failure `scripts/e2e-local.sh` guards against by
 * seeding a plan at all). No database is touched.
 */
import { describe, expect, it } from "vitest";
import { TunnelService } from "../../apps/backend/src/services/tunnel";

type Tunnel = Parameters<TunnelService["filterAvailableTunnels"]>[0][number];

const service = new TunnelService({} as never, {} as never, {} as never, {} as never);

interface PlanOverrides {
  max_tunnels?: number | null;
  traffic?: number | null;
  all_in_node_groups?: boolean;
  all_out_node_groups?: boolean;
  node_groups?: { node_group_id: number }[];
}

function makeTunnel(options: {
  id: number;
  userId?: number;
  inGroupOwner?: number | null;
  outGroupOwner?: number | null;
  trafficUsed?: number;
  noPlan?: boolean;
  userMaxTunnels?: number | null;
  userTraffic?: number | null;
  plan?: PlanOverrides;
}): Tunnel {
  const plan = {
    max_tunnels: 10,
    traffic: 100,
    all_in_node_groups: false,
    all_out_node_groups: false,
    node_groups: [] as { node_group_id: number }[],
    ...options.plan,
  };
  return {
    id: options.id,
    user_id: options.userId ?? 1,
    in_node_group: { user_id: options.inGroupOwner ?? (options.userId ?? 1) },
    out_node_group:
      options.outGroupOwner === undefined
        ? null
        : options.outGroupOwner === null
          ? null
          : { user_id: options.outGroupOwner },
    user: {
      user_plan: options.noPlan
        ? null
        : {
            traffic_used: options.trafficUsed ?? 0,
            max_tunnels: options.userMaxTunnels ?? null,
            traffic: options.userTraffic ?? null,
            plan,
          },
    },
  } as unknown as Tunnel;
}

const ids = (tunnels: Tunnel[], inGroup?: number, outGroup?: number) =>
  service.filterAvailableTunnels(tunnels, inGroup, outGroup).map((t) => t.id);

describe("filterAvailableTunnels: plan and quota", () => {
  it("keeps a tunnel inside its quota", () => {
    expect(ids([makeTunnel({ id: 1, trafficUsed: 0 })])).toEqual([1]);
  });

  it("drops every tunnel of a user without a plan", () => {
    expect(ids([makeTunnel({ id: 1, noPlan: true }), makeTunnel({ id: 2, noPlan: true })])).toEqual([]);
  });

  it("drops a tunnel once traffic is exactly at the plan limit", () => {
    expect(ids([makeTunnel({ id: 1, trafficUsed: 100 })])).toEqual([]);
  });

  it("treats a null traffic limit as unlimited", () => {
    expect(ids([makeTunnel({ id: 1, trafficUsed: 10_000, plan: { traffic: null } })])).toEqual([1]);
  });

  it("prefers the per-user traffic override over the plan value", () => {
    const tunnel = makeTunnel({ id: 1, trafficUsed: 60, userTraffic: 50, plan: { traffic: 100 } });
    expect(ids([tunnel])).toEqual([]);
  });

  it("caps tunnels per user at max_tunnels, keeping input order", () => {
    const tunnels = [
      makeTunnel({ id: 1, plan: { max_tunnels: 1 } }),
      makeTunnel({ id: 2, plan: { max_tunnels: 1 } }),
    ];
    expect(ids(tunnels)).toEqual([1]);
  });

  it("treats max_tunnels 0 as unlimited", () => {
    const tunnels = [
      makeTunnel({ id: 1, plan: { max_tunnels: 0 } }),
      makeTunnel({ id: 2, plan: { max_tunnels: 0 } }),
    ];
    expect(ids(tunnels)).toEqual([1, 2]);
  });

  it("applies the cap per user, not globally", () => {
    const tunnels = [
      makeTunnel({ id: 1, userId: 1, plan: { max_tunnels: 1 } }),
      makeTunnel({ id: 2, userId: 1, plan: { max_tunnels: 1 } }),
      makeTunnel({ id: 3, userId: 2, plan: { max_tunnels: 1 } }),
      makeTunnel({ id: 4, userId: 2, plan: { max_tunnels: 1 } }),
    ];
    expect(ids(tunnels)).toEqual([1, 3]);
  });

  it("prefers the per-user max_tunnels override", () => {
    const tunnels = [
      makeTunnel({ id: 1, userMaxTunnels: 1, plan: { max_tunnels: 10 } }),
      makeTunnel({ id: 2, userMaxTunnels: 1, plan: { max_tunnels: 10 } }),
    ];
    expect(ids(tunnels)).toEqual([1]);
  });
});

describe("filterAvailableTunnels: shared node groups", () => {
  it("drops a tunnel in someone else's in-group when the plan lists other groups but not this one", () => {
    const tunnel = makeTunnel({ id: 1, inGroupOwner: 2, plan: { node_groups: [{ node_group_id: 8 }] } });
    expect(ids([tunnel], 7)).toEqual([]);
  });

  it("treats an empty plan group list as unrestricted (recovered upstream quirk)", () => {
    // `nodeGroups.length > 0 &&` at 052:598 means `all_*_node_groups: false`
    // with no explicit list allows the shared group instead of denying it.
    const tunnel = makeTunnel({ id: 1, inGroupOwner: 2, plan: { node_groups: [] } });
    expect(ids([tunnel], 7)).toEqual([1]);
  });

  it("keeps it when the plan lists the group", () => {
    const tunnel = makeTunnel({ id: 1, inGroupOwner: 2, plan: { node_groups: [{ node_group_id: 7 }] } });
    expect(ids([tunnel], 7)).toEqual([1]);
  });

  it("keeps it when the plan covers all in-groups", () => {
    const tunnel = makeTunnel({ id: 1, inGroupOwner: 2, plan: { all_in_node_groups: true } });
    expect(ids([tunnel], 7)).toEqual([1]);
  });

  it("does not consult the plan when the group belongs to the tunnel's user", () => {
    const tunnel = makeTunnel({ id: 1, userId: 1, inGroupOwner: 1 });
    expect(ids([tunnel], 7)).toEqual([1]);
  });

  it("drops a tunnel in someone else's out-group when the plan lists other groups but not this one", () => {
    const tunnel = makeTunnel({ id: 1, outGroupOwner: 2, plan: { node_groups: [{ node_group_id: 8 }] } });
    expect(ids([tunnel], undefined, 9)).toEqual([]);
  });

  it("treats an empty plan group list as unrestricted for out-groups too", () => {
    const tunnel = makeTunnel({ id: 1, outGroupOwner: 2, plan: { node_groups: [] } });
    expect(ids([tunnel], undefined, 9)).toEqual([1]);
  });

  it("keeps it when the plan lists the out-group", () => {
    const tunnel = makeTunnel({ id: 1, outGroupOwner: 2, plan: { node_groups: [{ node_group_id: 9 }] } });
    expect(ids([tunnel], undefined, 9)).toEqual([1]);
  });

  it("keeps a tunnel with no out-group", () => {
    expect(ids([makeTunnel({ id: 1 })], undefined, 9)).toEqual([1]);
  });

  it("keeps a tunnel whose in-group is owned by the user even when out-group filtering is off", () => {
    const tunnels = [makeTunnel({ id: 1, userId: 1, inGroupOwner: 1, outGroupOwner: null })];
    expect(ids(tunnels, 7, undefined)).toEqual([1]);
  });
});
