import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { prisma } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await getSession();
  if (!s) redirect("/login");
  const user = await prisma.user.findUnique({
    where: { id: s.userId },
    select: { id: true, name: true, email: true, avatarColor: true, avatarUrl: true, permission: true },
  });
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50">
      <Sidebar user={user} />
      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
    </div>
  );
}
