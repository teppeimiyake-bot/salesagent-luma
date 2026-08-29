"use client";
import { useState } from "react";
import { ShootDrawer } from "@/components/kyopro/shoot-drawer";

/**
 * サーバーコンポーネント（カレンダー）から撮影会詳細を開くための薄い入れ物。
 * チップの見た目はそのまま children として渡す。
 */
export function ShootDrawerLauncher({
  shootId,
  canEdit,
  className,
  style,
  title,
  children,
}: {
  shootId: string;
  canEdit: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} style={style} title={title}>
        {children}
      </button>
      {open && <ShootDrawer shootId={shootId} canEdit={canEdit} onClose={() => setOpen(false)} />}
    </>
  );
}
