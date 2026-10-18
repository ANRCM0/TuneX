import type { AdminRole, NodeGroup, Plan, User, UserPlan } from "@prisma/client";

/** A user row hydrated with the admin roles the permission guards need. */
export type SessionUser = User & { admin_roles: AdminRole[] };

/** `c.get("plan")` payload set by the plan middleware. */
export type SessionPlan = (UserPlan & { plan: Plan }) | null;

/** The node group an agent socket registered with (attached by the socket handlers). */
export type SocketNodeGroup = NodeGroup;

export type AppEnv = {
  Variables: {
    ip: string;
    user: SessionUser;
    plan: SessionPlan;
  };
};
