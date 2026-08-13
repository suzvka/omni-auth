// ============================================================
// 进程级初始化（instrumentation）
//
// Next.js 服务器实例启动时调用一次 register()。
// M2 阶段：定时清理过期 AuthToken + Verification 记录（每 6 小时）。
// 使用 auth.db（DatabaseAdapter）直接执行 deleteMany，无需导入 token 模块。
// ============================================================

export async function register() {
  // 仅在 Node.js runtime 执行（Edge 无长驻定时器）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // 跳过构建阶段（next build 不会执行清理）
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6 小时

  const cleanup = async () => {
    try {
      const { auth } = await import("@/lib/auth");
      const now = new Date().toISOString();
      const tokenCount = await auth.db.deleteMany({
        model: "authToken",
        where: [{ field: "expiresAt", value: now, operator: "lt" }],
      });
      const verifCount = await auth.db.deleteMany({
        model: "verification",
        where: [{ field: "expiresAt", value: now, operator: "lt" }],
      });
      if (tokenCount > 0 || verifCount > 0) {
        console.log(`[cleanup] 已清理 ${tokenCount} 条过期 AuthToken, ${verifCount} 条过期 Verification`);
      }
    } catch (err) {
      console.error("[cleanup] 过期记录清理失败:", err);
    }
  };

  const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  // 不阻塞进程退出（类型上兼容 Node Timeout / DOM number）
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  // 启动时立即执行一次，避免首次清理等待一个周期
  void cleanup();
}
