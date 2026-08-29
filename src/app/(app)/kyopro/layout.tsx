import { redirect } from "next/navigation";
import { isKyoproTenant } from "@/lib/kyopro-server";

/**
 * 京プロ 撮影会派遣はリージーの事業。
 * Luma タブ・全社ビューで URL を直打ちされても入れないようにする。
 */
export default async function KyoproLayout({ children }: { children: React.ReactNode }) {
  if (!(await isKyoproTenant())) redirect("/dashboard");
  return <>{children}</>;
}
