// ============================================================
// PrismaDatabaseAdapter — DatabaseAdapter 内置实现
//
// 基于 Prisma ORM，支持 Better Auth 标准表 + 业务扩展表。
// ============================================================

import type { PrismaClient } from "@prisma/client";
import type { DatabaseAdapter } from "../../adapters/database";

export interface PrismaAdapterOptions {
  /** 用户提供的 PrismaClient 实例 */
  prisma: PrismaClient;
}

/**
 * 创建 Prisma 数据库适配器。
 *
 * 使用方式：
 * ```ts
 * import { PrismaAdapter } from "changfeng-auth/adapters/prisma";
 * const adapter = PrismaAdapter({ prisma });
 * ```
 */
export function PrismaAdapter(options: PrismaAdapterOptions): DatabaseAdapter {
  const { prisma } = options;

  const client = prisma as unknown as Record<string, { create?: Function; findFirst?: Function; findMany?: Function; update?: Function; updateMany?: Function; delete?: Function; deleteMany?: Function }>;

  return {
    async create({ model, data }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.create !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 create 操作`);
      }
      return delegate.create({ data });
    },

    async findOne({ model, where }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.findFirst !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 findFirst 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      for (const cond of where) {
        prismaWhere[cond.field] = cond.value;
      }

      return delegate.findFirst({ where: prismaWhere });
    },

    async findMany({ model, where, limit, offset }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.findMany !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 findMany 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      if (where) {
        for (const cond of where) {
          prismaWhere[cond.field] = cond.value;
        }
      }

      return delegate.findMany({
        where: Object.keys(prismaWhere).length > 0 ? prismaWhere : undefined,
        take: limit,
        skip: offset,
      });
    },

    async updateOne({ model, where, update }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.update !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 update 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      for (const cond of where) {
        prismaWhere[cond.field] = cond.value;
      }

      return delegate.update({
        where: prismaWhere,
        data: update,
      });
    },

    async updateMany({ model, where, update }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.updateMany !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 updateMany 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      for (const cond of where) {
        prismaWhere[cond.field] = cond.value;
      }

      const result = await delegate.updateMany({
        where: prismaWhere,
        data: update,
      }) as { count: number };
      return result.count;
    },

    async deleteOne({ model, where }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.delete !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 delete 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      for (const cond of where) {
        prismaWhere[cond.field] = cond.value;
      }

      return delegate.delete({ where: prismaWhere });
    },

    async deleteMany({ model, where }) {
      const delegate = client[model];
      if (!delegate || typeof delegate.deleteMany !== "function") {
        throw new Error(`PrismaAdapter: 模型 "${model}" 不支持 deleteMany 操作`);
      }

      const prismaWhere: Record<string, unknown> = {};
      for (const cond of where) {
        prismaWhere[cond.field] = cond.value;
      }

      const result = await delegate.deleteMany({
        where: prismaWhere,
      }) as { count: number };
      return result.count;
    },

    async init() {
      // Prisma 连接管理由用户自行控制
    },

    async disconnect() {
      await prisma.$disconnect();
    },
  };
}
