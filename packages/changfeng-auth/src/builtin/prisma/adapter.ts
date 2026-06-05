// ============================================================
// PrismaDatabaseAdapter — DatabaseAdapter 内置实现
//
// 基于 Prisma ORM，支持 Better Auth 标准表 + 业务扩展表。
// 同时暴露 _prisma / _provider 以供 createQuickAuth 自动构造
// better-auth 原生适配器，消除用户双适配器配置。
// ============================================================

import type { PrismaClient } from "@prisma/client";
import type { DatabaseAdapter } from "../../adapters/database";

export interface PrismaAdapterOptions {
  /** 用户提供的 PrismaClient 实例 */
  prisma: PrismaClient;
  /**
   * 数据库 provider，用于自动构造 better-auth 兼容适配器。
   *
   * 提供后，createQuickAuth 会自动内部使用
   * @better-auth/prisma-adapter 构造 Better Auth 原生适配器，
   * 无需用户手动配置 betterAuthDatabase。
   *
   * @example
   * ```ts
   * PrismaAdapter({ prisma, provider: "postgresql" })
   * ```
   */
  provider?: "sqlite" | "cockroachdb" | "mysql" | "postgresql" | "sqlserver" | "mongodb";
}

/** PrismaAdapter 返回的适配器类型（DatabaseAdapter + 元信息） */
export interface PrismaAdapterInstance extends DatabaseAdapter {
  /** 内部持有的 PrismaClient 引用 */
  _prisma: PrismaClient;
  /** 数据库 provider（如果构造时提供） */
  _provider?: string;
}

/**
 * 创建 Prisma 数据库适配器。
 *
 * @example
 * ```ts
 * import { PrismaAdapter } from "changfeng-auth/adapters/prisma";
 * const adapter = PrismaAdapter({ prisma, provider: "postgresql" });
 * ```
 */
export function PrismaAdapter(options: PrismaAdapterOptions): PrismaAdapterInstance {
  const { prisma, provider } = options;

  const client = prisma as unknown as Record<string, { create?: Function; findFirst?: Function; findMany?: Function; update?: Function; updateMany?: Function; delete?: Function; deleteMany?: Function }>;

  return {
    // 元信息：供 createQuickAuth 自动构造 better-auth 原生适配器
    _prisma: prisma,
    _provider: provider,

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
