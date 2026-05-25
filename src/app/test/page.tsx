"use client";

import { useState, useCallback } from "react";
import { useSession } from "@/modules/auth/client";
import { getProfile } from "@/app/actions/profile";

// ============ 类型 ============

interface LogEntry {
  time: string;
  type: "info" | "success" | "error";
  message: string;
}

// ============ 主页面 ============

export default function TestPage() {
  const { data: session, isPending: sessionLoading, refetch: refetchSession } = useSession();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [meResult, setMeResult] = useState<string>("");
  const [profileResult, setProfileResult] = useState<string>("");
  const [socialSignupResult, setSocialSignupResult] = useState<string>("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  // 社交注册测试表单
  const [socialEmail, setSocialEmail] = useState("");
  const [socialPassword, setSocialPassword] = useState("");
  const [socialName, setSocialName] = useState("");
  const [socialProvider, setSocialProvider] = useState("wechat");
  const [socialOpenid, setSocialOpenid] = useState("");
  const [socialNickname, setSocialNickname] = useState("");
  const [socialAvatar, setSocialAvatar] = useState("");

  const addLog = useCallback((type: LogEntry["type"], message: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev: LogEntry[]) => [...prev.slice(-49), { time, type, message }]);
  }, []);

  // ============ 注册 ============

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const email = fd.get("email") as string;
    const password = fd.get("password") as string;
    const name = (fd.get("name") as string) || email.split("@")[0];

    setLoadingAction("register");
    addLog("info", `注册中... ${email}`);

    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const json = await res.json();
      if (res.ok) {
        addLog("success", `注册成功: ${email}`);
        form.reset();
        refetchSession();
      } else {
        addLog("error", `注册失败: ${json.message || JSON.stringify(json)}`);
      }
    } catch (err: unknown) {
      addLog("error", `注册异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 登录 ============

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const email = fd.get("email") as string;
    const password = fd.get("password") as string;

    setLoadingAction("login");
    addLog("info", `登录中... ${email}`);

    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (res.ok) {
        addLog("success", `登录成功: ${email}`);
        form.reset();
        refetchSession();
      } else {
        addLog("error", `登录失败: ${json.message || JSON.stringify(json)}`);
      }
    } catch (err: unknown) {
      addLog("error", `登录异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 登出 ============

  async function handleLogout() {
    setLoadingAction("logout");
    addLog("info", "登出中...");

    try {
      const res = await fetch("/api/auth/sign-out", { method: "POST" });
      if (res.ok) {
        addLog("success", "登出成功");
        refetchSession();
      } else {
        const json = await res.json();
        addLog("error", `登出失败: ${json.message || JSON.stringify(json)}`);
      }
    } catch (err: unknown) {
      addLog("error", `登出异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 查询 /api/me ============

  async function handleGetMe() {
    setLoadingAction("me");
    addLog("info", "GET /api/me");

    try {
      const res = await fetch("/api/me");
      const json = await res.json();
      setMeResult(JSON.stringify(json, null, 2));
      addLog("success", `/api/me 返回: ${res.status}`);
    } catch (err: unknown) {
      setMeResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      addLog("error", `/api/me 异常`);
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 测试 Server Action ============

  async function handleGetProfile() {
    setLoadingAction("profile");
    addLog("info", "调用 getProfile() server action");

    try {
      const result = await getProfile();
      setProfileResult(JSON.stringify(result, null, 2));
      addLog("success", "getProfile() 返回成功");
    } catch (err: unknown) {
      setProfileResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      addLog("error", `getProfile() 异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 社交注册测试 ============

  async function handleSocialSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoadingAction("social-signup");
    addLog("info", `社交注册测试: ${socialProvider} - ${socialEmail}`);

    try {
      const res = await fetch("/api/auth/social-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: socialEmail,
          password: socialPassword,
          name: socialName || socialEmail.split("@")[0],
          social: {
            provider: socialProvider,
            providerOpenid: socialOpenid,
            profileData: {
              nickname: socialNickname || socialName,
              avatar: socialAvatar,
              gender: "",
            },
          },
        }),
      });
      const json = await res.json();
      setSocialSignupResult(JSON.stringify(json, null, 2));
      if (res.ok) {
        addLog("success", `社交注册成功 (${socialProvider})`);
        refetchSession();
      } else {
        addLog("error", `失败: ${json.error || JSON.stringify(json)}`);
      }
    } catch (err: unknown) {
      setSocialSignupResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      addLog("error", "社交注册异常");
    } finally {
      setLoadingAction(null);
    }
  }

  // ============ 获取 Session ============

  async function handleGetSession() {
    setLoadingAction("session");
    addLog("info", "GET /api/auth/get-session");

    try {
      const res = await fetch("/api/auth/get-session");
      const json = await res.json();
      setMeResult(JSON.stringify(json, null, 2));
      addLog("success", `get-session 返回: ${res.status}`);
    } catch (err: unknown) {
      setMeResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      addLog("error", "get-session 异常");
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* ===== 顶部状态栏 ===== */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">🧪 认证测试面板</h1>
            {sessionLoading ? (
              <span className="text-sm text-zinc-400">加载会话中...</span>
            ) : session ? (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
                已登录: {session.user?.email ?? session.user?.name ?? session.user?.id}
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                未登录
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/protected"
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              去受保护页 →
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ===== 左列：表单 ===== */}
          <div className="space-y-6">
            {/* 注册 */}
            <Card title="📝 注册 (Sign Up)">
              <form onSubmit={handleRegister} className="space-y-3">
                <Input name="name" placeholder="用户名 (可选)" />
                <Input name="email" type="email" placeholder="邮箱" required />
                <Input name="password" type="password" placeholder="密码" required />
                <button
                  type="submit"
                  disabled={loadingAction === "register"}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loadingAction === "register" ? "注册中..." : "注册"}
                </button>
              </form>
            </Card>

            {/* 登录 */}
            <Card title="🔑 登录 (Sign In)">
              <form onSubmit={handleLogin} className="space-y-3">
                <Input name="email" type="email" placeholder="邮箱" required />
                <Input name="password" type="password" placeholder="密码" required />
                <button
                  type="submit"
                  disabled={loadingAction === "login"}
                  className="w-full rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {loadingAction === "login" ? "登录中..." : "登录"}
                </button>
              </form>
            </Card>

            {/* 登出 */}
            <Card title="🚪 登出 (Sign Out)">
              <button
                onClick={handleLogout}
                disabled={loadingAction === "logout" || !session}
                className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {loadingAction === "logout" ? "登出中..." : "登出"}
              </button>
            </Card>

            {/* 社交注册测试 */}
            <Card title="🔗 社交注册模拟">
              <form onSubmit={handleSocialSignup} className="space-y-2">
                <input
                  name="socialProvider"
                  placeholder="Provider (如 wechat, google)"
                  value={socialProvider}
                  onChange={(e) => setSocialProvider(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  required
                />
                <input
                  name="socialEmail"
                  type="email"
                  placeholder="邮箱"
                  value={socialEmail}
                  onChange={(e) => setSocialEmail(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  required
                />
                <input
                  name="socialPassword"
                  type="password"
                  placeholder="密码（至少6位）"
                  value={socialPassword}
                  onChange={(e) => setSocialPassword(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  required
                />
                <input
                  name="socialName"
                  placeholder="用户名"
                  value={socialName}
                  onChange={(e) => setSocialName(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <input
                  name="socialOpenid"
                  placeholder="Platform OpenID"
                  value={socialOpenid}
                  onChange={(e) => setSocialOpenid(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  required
                />
                <input
                  name="socialNickname"
                  placeholder="昵称"
                  value={socialNickname}
                  onChange={(e) => setSocialNickname(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <input
                  name="socialAvatar"
                  placeholder="头像 URL"
                  value={socialAvatar}
                  onChange={(e) => setSocialAvatar(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  disabled={loadingAction === "social-signup"}
                  className="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loadingAction === "social-signup" ? "注册中..." : "社交注册"}
                </button>
              </form>
            </Card>
          </div>

          {/* ===== 右列：API 测试 + 结果 ===== */}
          <div className="space-y-6">
            {/* API 测试按钮 */}
            <Card title="🔌 API 测试">
              <div className="flex flex-wrap gap-2">
                <TestButton
                  label="GET /api/me"
                  loading={loadingAction === "me"}
                  onClick={handleGetMe}
                  color="indigo"
                />
                <TestButton
                  label="GET /api/auth/get-session"
                  loading={loadingAction === "session"}
                  onClick={handleGetSession}
                  color="purple"
                />
                <TestButton
                  label="Server Action: getProfile()"
                  loading={loadingAction === "profile"}
                  onClick={handleGetProfile}
                  color="amber"
                />
              </div>
            </Card>

            {/* 当前 Session */}
            <Card title="👤 当前 Session (useSession hook)">
              <pre className="max-h-48 overflow-auto rounded bg-zinc-800 p-3 text-xs text-green-300">
                {sessionLoading
                  ? "加载中..."
                  : session
                    ? JSON.stringify(session, null, 2)
                    : "无会话 (null)"}
              </pre>
            </Card>

            {/* /api/me 结果 */}
            <Card title="📡 /api/me 或 get-session 结果">
              <pre className="max-h-48 overflow-auto rounded bg-zinc-800 p-3 text-xs text-cyan-300">
                {meResult || "点击上方按钮测试 →"}
              </pre>
            </Card>

            {/* Server Action 结果 */}
            <Card title="⚡ Server Action: getProfile() 结果">
              <pre className="max-h-48 overflow-auto rounded bg-zinc-800 p-3 text-xs text-yellow-300">
                {profileResult || "点击上方按钮测试 →"}
              </pre>
            </Card>

            {/* 社交注册结果 */}
            <Card title="🔗 社交注册结果">
              <pre className="max-h-48 overflow-auto rounded bg-zinc-800 p-3 text-xs text-blue-300">
                {socialSignupResult || "在左侧表单测试 →"}
              </pre>
            </Card>
          </div>
        </div>

        {/* ===== 日志区 ===== */}
        <Card className="mt-6" title="📋 操作日志">
          <div className="max-h-64 overflow-auto rounded bg-zinc-900 p-3 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <span className="text-zinc-500">等待操作...</span>
            ) : (
              logs.map((log: LogEntry, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-zinc-600">[{log.time}]</span>
                  <span
                    className={
                      log.type === "error"
                        ? "text-red-400"
                        : log.type === "success"
                          ? "text-green-400"
                          : "text-zinc-300"
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </main>
    </div>
  );
}

// ============ 子组件 ============

function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      <h2 className="mb-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">{title}</h2>
      {children}
    </section>
  );
}

function Input({ name, type = "text", placeholder, required }: {
  name: string;
  type?: string;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <input
      name={name}
      type={type}
      placeholder={placeholder}
      required={required}
      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
    />
  );
}

const colorMap: Record<string, string> = {
  indigo: "bg-indigo-600 hover:bg-indigo-700",
  purple: "bg-purple-600 hover:bg-purple-700",
  amber: "bg-amber-600 hover:bg-amber-700",
};

function TestButton({
  label,
  loading,
  onClick,
  color,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
  color: string;
}) {
  const bg = colorMap[color] ?? "bg-zinc-600 hover:bg-zinc-700";
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 ${bg}`}
    >
      {loading ? "请求中..." : label}
    </button>
  );
}
