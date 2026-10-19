import { getCurrentPermission, getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GlobalSearch } from "@/components/layout/global-search";
import { UserMenu } from "@/components/layout/user-menu";

export async function Header({
  title,
  subtitle,
  right,
  hideSearch,
  compactOnMobile = false,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  hideSearch?: boolean;
  compactOnMobile?: boolean;
}) {
  const s = await getSession();
  const user = s
    ? await prisma.user.findUnique({
        where: { id: s.userId },
        select: { name: true, email: true, avatarColor: true, avatarUrl: true },
      })
    : null;
  // 右上に出す権限は、操作中の会社での権限（全社共通の User.permission ではない）。全社統合ビューは閲覧のみ。
  const tenantPermission = s ? await getCurrentPermission() : null;
  // md 未満はどのページでもサイドバーが左上のボタン（fixed left-3 top-4）に畳まれるので、左に余白を空ける。
  return (
    <header className={`border-b border-zinc-200 bg-white py-3 flex items-center justify-between gap-2 pl-14 pr-3 md:gap-4 md:px-8`}>
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-xs text-zinc-500 mt-0.5 truncate">{subtitle}</p>}
      </div>
      <div className={`flex items-center shrink-0 ${compactOnMobile ? "gap-1.5 sm:gap-3" : "gap-1.5 md:gap-3"}`}>
        {!hideSearch && <GlobalSearch compactOnMobile={compactOnMobile} />}
        {right}
        {user && (
          <UserMenu
            compactOnMobile={compactOnMobile}
            user={{
              name: user.name,
              email: user.email,
              avatarColor: user.avatarColor,
              avatarUrl: user.avatarUrl,
              permission: tenantPermission ?? "viewer",
            }}
          />
        )}
      </div>
    </header>
  );
}
