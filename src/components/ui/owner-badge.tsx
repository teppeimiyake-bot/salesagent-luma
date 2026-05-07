import { cn } from "@/lib/utils";

/** 担当者：アイコン＋名前を並列表示 */
export function OwnerBadge({
  owner,
  size = "md",
  showRole = false,
  className,
}: {
  owner: { name: string; avatarColor: string | null; avatarUrl?: string | null; role?: string | null } | null;
  size?: "sm" | "md" | "lg";
  showRole?: boolean;
  className?: string;
}) {
  if (!owner) {
    return <span className={cn("text-zinc-400 text-sm", className)}>未割当</span>;
  }
  const sizes = {
    sm: { box: "w-6 h-6 text-[10px]", text: "text-xs" },
    md: { box: "w-8 h-8 text-xs", text: "text-sm" },
    lg: { box: "w-10 h-10 text-sm", text: "text-base" },
  }[size];

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      {owner.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={owner.avatarUrl}
          alt={owner.name}
          className={cn(
            "rounded-full object-cover shadow-sm shrink-0 border border-zinc-200",
            sizes.box,
          )}
        />
      ) : (
        <div
          className={cn(
            "rounded-full text-white font-bold flex items-center justify-center shadow-sm shrink-0",
            sizes.box,
          )}
          style={{ background: owner.avatarColor ?? "#6366f1" }}
        >
          {owner.name.charAt(0)}
        </div>
      )}
      <div className="min-w-0">
        <p className={cn("font-semibold truncate", sizes.text)}>{owner.name}</p>
        {showRole && owner.role && (
          <p className="text-xs text-zinc-500 truncate">{owner.role}</p>
        )}
      </div>
    </div>
  );
}
