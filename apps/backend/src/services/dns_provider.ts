import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { service } from "../container";
import {
  DNSProviderQuerySchema,
  DNSProviderRequestSchema,
} from "../schemas/request";

/**
 * Upstream: src/services/dns_provider.ts (module 094) — ported 1:1.
 *
 * CRUD over the `dns_provider` table. Config is stored as a plaintext JSON object.
 */

export type DNSProviderData = z.infer<typeof DNSProviderRequestSchema>;
export type DNSProviderQuery = z.infer<typeof DNSProviderQuerySchema>;

export class DNSProviderService {
  async createDNSProvider(user_id: number, data: DNSProviderData) {
    return await db.dNSProvider.create({
      data: {
        name: data.name,
        type: data.type,
        config: data.config,
        user_id,
      },
    });
  }

  async getDNSProviders(user_id: number, query: DNSProviderQuery) {
    const { page, perPage, sort, name, type: type2 } = query;
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({
      [sort2.id]: sort2.desc ? "desc" : "asc",
    })) as Prisma.DNSProviderOrderByWithRelationInput[] | undefined;
    const where: Prisma.DNSProviderWhereInput = { user_id };
    if (name) {
      where.name = { contains: name };
    }
    if (type2) {
      where.type = type2;
    }
    return await db.$transaction(async (tx) => {
      const data = await tx.dNSProvider.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ id: "desc" }],
      });
      const total = await tx.dNSProvider.count({ where });
      return { data, total };
    });
  }

  async getDNSProviderById(id: number) {
    return await db.dNSProvider.findUnique({ where: { id } });
  }

  async updateDNSProvider(user_id: number, id: number, data: DNSProviderData) {
    return await db.dNSProvider.update({
      where: { id, user_id },
      data: {
        name: data.name,
        type: data.type,
        config: data.config,
      },
    });
  }

  async deleteDNSProviders(user_id: number, ids: number[]) {
    await db.$transaction(async (tx) => {
      await tx.inNodeGroupDNS.deleteMany({
        where: {
          dns_provider_id: { in: ids },
          dns_provider: { user_id },
        },
      });
      await tx.dNSProvider.deleteMany({
        where: { id: { in: ids }, user_id },
      });
    });
  }

  async getDNSProviderSummary(user_id: number) {
    return await db.dNSProvider.findMany({
      where: { user_id },
      select: { id: true, name: true, type: true },
      orderBy: [{ id: "desc" }],
    });
  }
}

/** Self-registration (container has no dedicated DNS-provider token). */
export const dnsProviderService = service<DNSProviderService>(
  "DNSProviderService",
  () => new DNSProviderService(),
);
