import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const upsertSchema = z.object({
  platform: z.enum(["YOUTUBE", "INSTAGRAM", "TIKTOK"]),
  accountId: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  profileUrl: z.string().nullable().optional(),
  miyakePcLogin: z.boolean().optional(),
});

function norm(s: string | null | undefined): string | null | undefined {
  if (s === undefined) return undefined;
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

/**
 * PUT /api/pm/[id]/sns-accounts
 * SNS媒体別アカウント(YouTube/Instagram/TikTok)を platform 単位で upsert。
 * user 権限以上のみ（password を扱うため）。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // プロジェクト存在チェック
  const project = await prisma.productionProject.findUnique({ where: { id }, select: { id: true } });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = {
    accountId: norm(d.accountId),
    password: norm(d.password),
    profileUrl: norm(d.profileUrl),
    ...(d.miyakePcLogin !== undefined ? { miyakePcLogin: d.miyakePcLogin } : {}),
  };

  const account = await prisma.snsAccount.upsert({
    where: { productionProjectId_platform: { productionProjectId: id, platform: d.platform } },
    create: { productionProjectId: id, platform: d.platform, ...data },
    update: data,
  });

  return NextResponse.json({ account });
}
