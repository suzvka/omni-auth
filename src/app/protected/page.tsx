import { routeHelpers } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function ProtectedPage() {
  const ctx = await routeHelpers.requireContext();
  if (!ctx.authUserId) {
    redirect("/login");
  }

  return (
    <div>
      <h1>受保护页面</h1>
      {ctx.account ? (
        <p>欢迎，{ctx.account.displayName}</p>
      ) : (
        <p>账户信息缺失</p>
      )}
    </div>
  );
}
