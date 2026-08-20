// ============================================================
// 会话 Cookie 辅助（Next.js）— 认证域私有
//
// cookie 名沿用历史宿主约定（omni-auth.token），
// 供宿主 middleware / route 无感接入会话校验。
// ============================================================

import { cookies } from "next/headers";
import { SESSION_TTL_MS } from "../core/session";

/** 会话 cookie 名（历史约定，保持兼容） */
export const SESSION_COOKIE = "omni-auth.token";

/** 从 cookie 读取会话令牌（无 cookies() 环境的 middleware 请直接读 request.cookies） */
export async function getSessionTokenFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

/** 将会话 cookie 写入 Response（HttpOnly / SameSite=Lax / 生产加 Secure） */
export function setSessionCookie(response: Response, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`
  );
}

/** 清除会话 cookie */
export function clearSessionCookie(response: Response): void {
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}
