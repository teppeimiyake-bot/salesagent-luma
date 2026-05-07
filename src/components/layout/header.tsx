import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GlobalSearch } from "@/components/layout/global-search";
import { UserMenu } from "@/components/layout/user-menu";

export async function Header({
  title,
  subtitle,
  right,
  hideSearch,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  hideSearch?: boolean;
}) {
  const s = await getSession();
  const user = s
    ? await prisma.user.findUnique({
        where: { id: s.userId },
        select: { name: true, email: true, avatarColor: true, avatarUrl: true, permission: true },
      })
    : null;
  return (
    <header className="border-b border-zinc-200 bg-white px-8 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-xs text-zinc-500 mt-0.5 truncate">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {!hideSearch && <GlobalSearch />}
        {right}
        {user && (
          <UserMenu
            user={{
              name: user.name,
              email: user.email,
              avatarColor: user.avatarColor,
              avatarUrl: user.avatarUrl,
              permission: (user.permission ?? "viewer") as "admin" | "user" | "viewer",
            }}
          />
        )}
      </div>
    </header>
  );
}
