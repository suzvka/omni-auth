import { getAuthContext } from "@/modules/auth";
import { redirect } from "next/navigation";

export default async function ProtectedPage() {
  const { account, authUserId } = await getAuthContext();

  if (!authUserId) {
    redirect("/login");
  }

  return (
    <div>
      <h1>受保护页面</h1>
      {account ? (
        <p>欢迎，{account.displayName}</p>
      ) : (
        <p>账户信息缺失</p>
      )}
    </div>
  );
}
