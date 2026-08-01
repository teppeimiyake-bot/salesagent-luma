import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export const PM_STAFF_ROLES = ["pm", "director", "camera", "editor"] as const;
export type PmStaffRole = (typeof PM_STAFF_ROLES)[number];

/**
 * GET /api/pm-staff
 *   PM管理タブのプルダウン用にスタッフマスタを返す。
 *   ?includeInactive=true で無効分も含む（管理画面用）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const staff = await prisma.pmStaff.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ role: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ staff });
}

const createSchema = z.object({
  role: z.enum(PM_STAFF_ROLES),
  name: z.string().min(1).max(60),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  // 追加は user 権限以上（PM現場で人員を足せるように admin 限定にしない）。
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { role, name } = parsed.data;
  const exists = await prisma.pmStaff.findFirst({ where: { role, name } });
  if (exists) {
    // 既存（無効化済みかもしれない）→ 有効化して返す（重複作成を避ける）
    if (!exists.active) {
      const reactivated = await prisma.pmStaff.update({
        where: { id: exists.id },
        data: { active: true },
      });
      return NextResponse.json({ staff: reactivated, reactivated: true });
    }
    return NextResponse.json({ error: "同じ役割に同名のスタッフが既に存在します" }, { status: 409 });
  }
  const created = await prisma.pmStaff.create({
    data: {
      role,
      name,
      active: parsed.data.active ?? true,
      sortOrder: parsed.data.sortOrder ?? 0,
    },
  });
  return NextResponse.json({ staff: created });
}
